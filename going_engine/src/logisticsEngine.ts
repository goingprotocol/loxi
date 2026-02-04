import { ObjectId } from 'mongodb';
import * as h3 from 'h3-js';
import { Batch, GoingNetworkShipment, Coordinate } from './interfaces';
import { solveVrp, solveSwarmVrp } from './lib/vroomClient';
import { getDurationMatrix } from './lib/osrmClient';
import { ConfigService } from './services/configService';
import { DriverRepository } from './repositories/driverRepository';
import {
    calculateTotalWeight,
    calculateTotalVolume,
    calculateTripDistanceKm,
    latLngToCell,
    cellToLatLng,
    optimizeRouteOSRM,
    canVehicleCarryBatch,
    greatCircleDistance,
    gridDistance,
    determineRequiredVehicleType,
    calculateLifoMatrix,
    addVirtualStartToMatrix
} from './lib/routingUtils';

// Constants
const TRUNK_VOLUME_THRESHOLD_M3 = 2.0;
const TRUNK_DISTANCE_THRESHOLD_KM = 15.0;
const RELAY_LEG_MAX_DISTANCE_KM = 10.0;
const H3_RESOLUTION_GROUPING = 7; // Macro Zone (~1.2km radius)

// Moto Limits (If exceeded, MUST go to Van)
const MOTO_MAX_WEIGHT_KG = 25; // Updated to match user preference if needed, kept safe
const MOTO_MAX_VOLUME_M3 = 0.08;
const VAN_MAX_VOLUME_M3 = 3.0; // Standard Van Capacity

export class LogisticsEngine {

    /**
     * MAIN ENTRY POINT
     */
    static async processRedisBatch(
        shipments: GoingNetworkShipment[],
        laneKeySuffix: string,
        driverRepo?: any, // DriverRepository interface
        db?: any // Db interface
    ): Promise<Batch[]> {
        if (shipments.length === 0) return [];

        // [REINTEGRATED] Feeder Logic & SCHEDULE CHECK
        const effectiveShipments = shipments.filter(s => {
            // 1. Filtro de Tiempo (Vital: No procesar pedidos del futuro)
            if (s.scheduledDispatchTime && new Date(s.scheduledDispatchTime) > new Date()) {
                return false;
            }
            return true;
        }).map(s => {
            if (s.shippingType !== 'going_network') return s;
            const netShipment = s as GoingNetworkShipment;

            if (netShipment.legs && netShipment.legs.length > 0) {
                // Find the first pending leg
                const currentLeg = netShipment.legs.find(l => l.status === 'pending');
                if (currentLeg && currentLeg.sequenceNumber === 1) {
                    // This is the First Mile (Feeder)
                    const legDest = currentLeg.destination as any;
                    const hubLocation = legDest.location || legDest; // Handle NetworkNode or Address

                    // Temporarily rewrite deliveryAddress to the Hub for Batching/Routing purposes
                    return {
                        ...netShipment,
                        deliveryAddress: {
                            ...netShipment.deliveryAddress, // Keep original props
                            lat: hubLocation.lat,
                            lon: hubLocation.lon,
                            h3IndexL8: latLngToCell(hubLocation.lat, hubLocation.lon, 8) // Force update L8
                        }
                    };
                }
            }
            return netShipment;
        }) as GoingNetworkShipment[];

        // Use effective shipments for the rest of the logic
        shipments = effectiveShipments;

        // Parse Lane Key: "{OriginL8}:{DestL7}"
        const [originL8, destL7] = laneKeySuffix.split(':');

        // --- SPATIAL INTEGRITY FILTER (kRing / Neighbors) ---
        // New Logic: Check if shipment is in DestL7 OR any of its 6 neighbors (Ring 1)
        const targetNeighbors = h3.gridDisk(destL7, 1); // [destL7, n1, n2, ..., n6]

        const validShipments = shipments.filter(s => {
            // Calculate L7 of the shipment's delivery address
            // We use the delivery address to confirm it belongs in this cluster
            const shipmentDestL7 = latLngToCell(s.deliveryAddress.lat, s.deliveryAddress.lon, 7);

            // Check if shipment is in the Target Zone OR a neighbor
            return targetNeighbors.includes(shipmentDestL7);
        });

        const discardedCount = shipments.length - validShipments.length;
        if (discardedCount > 0) {
            console.warn(`[QueueEngine] ⚠️ SPATIAL FILTER: Discarded ${discardedCount} shipments NOT STRICTLY inside Zone ${destL7}.`);
        }

        if (validShipments.length === 0) {
            console.warn(`[QueueEngine] No valid shipments remain after strict L7 filter. Aborting.`);
            return [];
        }

        // Determine parent L7 of Origin
        const originL7 = h3.cellToParent(originL8, 7);

        console.log(`[QueueEngine] Processing ${validShipments.length} VALID shipments (Strict L7) for LANE ${originL8} -> ${destL7}`);

        // Use validShipments from now on
        shipments = validShipments;

        if (originL7 === destL7) {
            // --- INTRA-ZONAL (Hyper Local) ---
            // Origin is inside the Destination Zone.
            console.log(`[QueueEngine] Intra-Zonal Lane detected (${originL7}). Optimization Strategy: VROOM Local Mixed Fleet.`);
            return this.createIntraZonalBatch(shipments);
        } else {
            // --- INTER-ZONAL (Trunk / Relay) ---
            // Origin is inside the Destination Zone.
            console.log(`[QueueEngine] Inter-Zonal Lane detected (${originL7} -> ${destL7}). Optimization Strategy: Waterfall w/ Smart Assignment.`);
            return this.executeInterZonalWaterfall(shipments, driverRepo, db);
        }
    }

    // ... (Helper Methods) ...

    private static async executeInterZonalWaterfall(
        shipments: GoingNetworkShipment[],
        driverRepo?: any,
        db?: any
    ): Promise<Batch[]> {
        // CLEAN LOGIC: No more manual "Heavy" filtering.
        // We rely on VROOM Mixed Fleet (Motos + Vans) to decide.
        // However, the Waterfall decision (Trunk vs Relay) is about TOPOLOGY.

        // 1. Sort by FIFO (Oldest First)
        shipments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        // 2. Check for Heavy/Bulky Items (Must use Van)
        // User Rule: "Van should only be used for heavy/bulky items or Swarms."
        // We do NOT use Van just because "Total Volume" is high (e.g. 50 phones).
        const hasHeavyItems = shipments.some(s => {
            const w = calculateTotalWeight(s.items);
            const v = calculateTotalVolume(s.items);
            return w > MOTO_MAX_WEIGHT_KG || v > MOTO_MAX_VOLUME_M3;
        });

        if (hasHeavyItems) {
            console.log(`[QueueEngine] Decision: TRUNK (Hub & Spoke) - Heavy Items Detected. Using Van.`);
            // We pass ALL items to 'createTrunkBatch'. VROOM will assign Vans/Trucks.
            return this.createTrunkBatch(shipments);
        }

        // B. Dynamic Swarm vs Relay Decision (Physics-Based)
        // ------------------------------------------------------------------
        // Strategy: Profit Velocity + SLA Slack Time.
        // We do NOT use arbitrary % thresholds. We calculate:
        // 1. Cost Comparison (Relay vs Swarm)
        // 2. Physical Slack Time (Deadline - Now - TravelTime)
        // 3. Profit Accumulation Rate (Wait if getting better)

        const analysis = await this.evaluateOperationsTrigger(shipments, driverRepo, db);

        console.log(`[QueueEngine] Decision Analysis: ${analysis.decision} (Reason: ${analysis.reason})`);

        switch (analysis.decision) {
            case 'DISPATCH_SWARM':
                return this.createSwarmBatches(shipments, 1.0); // 1.0 is dummy efficiency, handled internally
            case 'DISPATCH_RELAY':
                return this.createRelayBatches(shipments);
            case 'WAIT':
                console.log(`[QueueEngine] WAITING to accumulate more orders. Profit Velocity is high or Van is too empty.`);
                return []; // Return empty to keep in queue
        }

        return [];
    }

    /**
     * CORE LOGIC: Determines whether to Dispatch Swarm, Dispatch Relay, or Wait.
     * Based on: Cost Delta, SLA Urgency, and Profit Velocity.
     */
    private static async evaluateOperationsTrigger(
        shipments: GoingNetworkShipment[],
        driverRepo: any,
        db: any
    ): Promise<{ decision: 'WAIT' | 'DISPATCH_SWARM' | 'DISPATCH_RELAY'; reason: string }> {

        // 1. PHYSICAL CONSTANTS (Pricing 2026 - Payouts to Driver)
        // [MODIFIED] Dynamic Pricing from MongoDB
        // We use 'AR' as default for now, but could pick from shipments[0].country
        // TBD: Extract country from shipment context.
        const rule = ConfigService.getInstance().getPricing('AR');
        const v = rule.vehicles;

        const PRICES = {
            MOTO_BASE: v.motorcycle.baseFee,
            MOTO_KM: v.motorcycle.costPerKm,
            VAN_BASE: v.van.baseFeeSmall, // Assume Small Van for base comparison
            VAN_KM: v.van.costPerKm,
            SAFETY_BUFFER_MIN: 15 // SLA Safety-only.
        };

        // 2. CALCULATE GEOGRAPHY & COSTS (Full Path Simulation)
        const pickupCentroid = this.calculateCentroid(shipments.map(s => s.pickupAddress));

        // --- SCENARIO A: RELAY (Direct or Point-to-Point) ---
        // Cost = Sum of individual trips from Pickup to Destination.
        // This simulates N independent motos doing the full job.
        let costRelay = 0;

        shipments.forEach(s => {
            const dist = calculateTripDistanceKm(s.pickupAddress, s.deliveryAddress);
            const payout = PRICES.MOTO_BASE + (dist * PRICES.MOTO_KM);
            costRelay += payout;
        });

        // --- SCENARIO B: SWARM (Hub & Spoke) ---
        // Cost = Sum of Feeders (Pickup -> Hub) + 1 Van (Hub -> Dest)

        let costFeeders = 0;
        shipments.forEach(s => {
            // Feeder Leg: Pickup -> Centroid (Hub)
            const distFeeder = calculateTripDistanceKm(s.pickupAddress, pickupCentroid);

            // UNIFIED PRICING: Feeders are just Motos doing short trips.
            // We pay them the standard market rate (Base + Km).
            let payout = PRICES.MOTO_BASE + (distFeeder * PRICES.MOTO_KM);
            costFeeders += payout;
        });

        // Trunk Leg: Centroid -> Delivery Zone (First shipment destination as proxy for L7 cluster)
        const destination = shipments[0].deliveryAddress;
        const trunkEnd: Coordinate = { lat: destination.lat, lon: destination.lon || 0 };
        const distTrunk = calculateTripDistanceKm(pickupCentroid, trunkEnd);
        const costTrunk = PRICES.VAN_BASE + (distTrunk * PRICES.VAN_KM);

        const costSwarm = costFeeders + costTrunk;

        // 3. DECISION LOGIC (Pure P&L)
        const savings = costRelay - costSwarm;
        const isSwarmCheaper = savings > 0;

        // SLA / URGENCY CHECK
        let minSlackMinutes = Infinity;
        const now = Date.now();
        // Estimated Max Path Time (Trunk Trip + 20 min handling)
        const estTravelTimeMin = (distTrunk * 2) + 20;

        shipments.forEach(s => {
            const created = new Date(s.createdAt).getTime();
            const deadline = created + (24 * 60 * 60 * 1000);
            const slack = (deadline - now) / 60000 - estTravelTimeMin - PRICES.SAFETY_BUFFER_MIN;
            if (slack < minSlackMinutes) minSlackMinutes = slack;
        });

        // CRITICAL URGENCY
        if (minSlackMinutes <= 0) {
            return {
                decision: isSwarmCheaper ? 'DISPATCH_SWARM' : 'DISPATCH_RELAY',
                reason: `URGENCY_SLA_EXPIRED (Slack ${minSlackMinutes.toFixed(0)} min)`
            };
        }

        if (isSwarmCheaper) {
            // [MODIFIED] PURE P&L DECISION (No Overhead)
            // Decision matches real financial gain (Payout Savings > 0).
            return {
                decision: 'DISPATCH_SWARM',
                reason: `OPTIMAL_SWARM (Savings $${savings.toFixed(0)} > 0)`
            };
        } else {
            return {
                decision: 'DISPATCH_RELAY',
                reason: `OPTIMAL_RELAY (Relay is cheaper by $${-savings.toFixed(0)})`
            };
        }
    }

    private static async createSwarmBatches(shipments: GoingNetworkShipment[], profitFill: number): Promise<Batch[]> {
        console.log(`[Swarm] Calculating Centroid for ${shipments.length} shipments...`);

        // 1. Calculate Centroid (Meeting Point)
        let totalLat = 0;
        let totalLon = 0;
        shipments.forEach(s => {
            totalLat += s.pickupAddress.lat;
            totalLon += s.pickupAddress.lon;
        });
        const meetingPoint: Coordinate = {
            lat: totalLat / shipments.length,
            lon: totalLon / shipments.length
        };

        console.log(`[Swarm] Hive Location (Centroid): ${meetingPoint.lat.toFixed(4)}, ${meetingPoint.lon.toFixed(4)}`);

        // 2. Solve Feeder VRP (Motos -> Hive)
        // [MODIFIED] COST-BENEFIT OPTIMIZATION (VROOM Delegate)
        const VIRTUAL_POOL_SIZE = 20;

        console.log(`[Swarm] Delegating optimization to VROOM with pool of ${VIRTUAL_POOL_SIZE} virtual feeders.`);

        const output = await solveSwarmVrp(shipments, meetingPoint, VIRTUAL_POOL_SIZE);

        if (!output.routes || output.routes.length === 0) {
            console.error("[Swarm] VROOM failed to route feeders. Falling back to direct trunk.");
            return this.createTrunkBatch(shipments);
        }

        const batches: Batch[] = [];
        const processId = new ObjectId().toString();

        // 3. Create Feeder Batches (Motos)
        // First Pass: Determine Visualization (Max Duration)
        let maxFeederDuration = 0;
        output.routes.forEach((route: any) => {
            if (route.duration > maxFeederDuration) maxFeederDuration = route.duration;
        });

        // Rendezvous is determined by the slowest leg
        const maxFeederTimeMs = maxFeederDuration * 1000;
        const rendezvousTimestamp = new Date(Date.now() + maxFeederTimeMs);

        // [MODIFIED] JIT SYNCHRONIZATION (Zero Wait)
        // Van departs exactly when the last feeder arrives.
        const vanDepartureTime = rendezvousTimestamp;

        console.log(`[Swarm] Synchronization: 
            - Rendezvous (Arrival): ${rendezvousTimestamp.toLocaleTimeString()}
            - Buffer: 0 min (JIT)
            - Van Departure: ${vanDepartureTime.toLocaleTimeString()}`);

        output.routes.forEach((route: any, idx: number) => {
            const batchId = new ObjectId().toString();
            // Map Steps to Items
            const batchShipments: GoingNetworkShipment[] = [];
            route.steps.forEach((step: any) => {
                if (step.type === 'job') {
                    const sIndex = (step.id || 0) - 1;
                    if (shipments[sIndex]) batchShipments.push(shipments[sIndex]);
                }
            });

            if (batchShipments.length > 0) {
                const routeDuration = route.duration || 0;

                // JIT CALCULATION:
                // Motos aim for 'rendezvousTimestamp' (Punctual Arrival).
                const scheduleStart = new Date(rendezvousTimestamp.getTime() - (routeDuration * 1000));

                batches.push({
                    batchId: batchId,
                    type: 'SWARM',
                    status: 'pending_assignment',
                    shipments: batchShipments, // Renamed from items
                    requiredVehicleType: 'motorcycle', // Renamed from vehicleType
                    hubLocation: {
                        lat: batchShipments[0].pickupAddress.lat,
                        lon: batchShipments[0].pickupAddress.lon
                    },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    metadata: {
                        swarmType: 'FEEDER',
                        profitFill: profitFill,
                        hiveLocation: meetingPoint,
                        processId: processId,
                        estimatedDurationSeconds: routeDuration,
                        scheduledStartTime: scheduleStart,
                        rendezvousTime: rendezvousTimestamp // Motos aim for Arrival Time
                    }
                } as any);
            }
        });

        // 4. Create Master Trunk Batch (Van)

        // [FIX] Reescribir pickupAddress para que la Van sepa que recoge en el Hub, no en las casas.
        const trunkShipments = shipments.map(s => ({
            ...s,
            pickupAddress: {
                ...s.pickupAddress, // Mantenemos nombre/teléfono del sender original
                lat: meetingPoint.lat,
                lon: meetingPoint.lon,
                street: "Punto de Encuentro Swarm", // Opcional: Indicador visual
                h3IndexL8: latLngToCell(meetingPoint.lat, meetingPoint.lon, 8)
            }
        }));

        batches.push({
            batchId: new ObjectId().toString(),
            type: 'SWARM',
            status: 'pending_assignment', // Trunk needs to be assignable too!
            shipments: trunkShipments as any, // <--- USAR LA VERSIÓN MODIFICADA
            requiredVehicleType: 'van', // Renamed from vehicleType
            hubLocation: meetingPoint, // Trunk starts at Hive
            createdAt: new Date(),
            updatedAt: new Date(),
            metadata: {
                swarmType: 'TRUNK',
                profitFill: profitFill,
                hiveLocation: meetingPoint,
                processId: processId,
                feederBatches: batches.map(b => b.batchId),
                rendezvousTime: rendezvousTimestamp,
                vanDepartureTime: vanDepartureTime
            }
        } as any);

        console.log(`[Swarm] Generated ${batches.length} batches (Feeders + 1 Trunk).`);
        return batches;
    }

    public static async createIntraZonalBatch(shipments: GoingNetworkShipment[]): Promise<Batch[]> {
        // [REPAIRED] Now delegates to the generic Direct Batch creator which uses VROOM
        console.log(`[IntraZonal] Delegate to createDirectBatch (VROOM Optimized).`);
        return this.createDirectBatch(shipments);
    }

    /**
     * Strategy A: TRUNK (Hub & Spoke)
     * Uses PHYSICAL HUBS (Parking Lots, Stores).
     */
    private static async createTrunkBatch(shipments: GoingNetworkShipment[]): Promise<Batch[]> {
        // TBD: Connect to a "HubRepository" to find real Parking Lots.
        // For MVP: We assume the centroid IS the parking lot location.
        const originHub = this.calculateCentroid(shipments.map(s => s.pickupAddress));

        console.log(`[TrunkBatch] Optimizing TRUNK Route for ${shipments.length} shipments using VROOM (Van).`);

        try {
            // [MODIFIED] LIFO ENFORCEMENT & OPEN START
            // 1. Calculate LIFO Matrix (Coupled Cost)
            const lifoMatrix = await calculateLifoMatrix(shipments);

            // 2. Augment with "Ghost Node" (Virtual Start)
            // This allows VROOM to pick the best "First Customer" at 0 cost.
            const augmentedMatrix = addVirtualStartToMatrix(lifoMatrix);
            const virtualStartIndex = shipments.length; // Index of the Ghost Node (at the end)

            // 3. Solve VRP
            const output = await solveVrp(
                shipments,
                [],
                augmentedMatrix as any,
                {
                    forceRoundTrip: false,
                    vehicleStartIndex: virtualStartIndex
                }
            );

            if (output.routes && output.routes.length > 0) {
                // Map back VROOM result
                // For simplified Trunk, we usually just want one big route.
                // If VROOM splits it (capacity), we return multiple batches.

                const batches: Batch[] = [];

                for (const route of output.routes) {
                    const batchShipments: GoingNetworkShipment[] = [];
                    route.steps.forEach((step: any) => {
                        if (step.type === 'job') {
                            const index = (step.id || 0) - 1;
                            if (shipments[index]) batchShipments.push(shipments[index]);
                        }
                    });

                    if (batchShipments.length > 0) {
                        batches.push({
                            batchId: new ObjectId().toString(),
                            type: 'HUB_AND_SPOKE',
                            status: 'pending_assignment',
                            shipments: batchShipments as any,
                            hubLocation: { lat: originHub.lat, lon: originHub.lon },
                            createdAt: new Date(),
                            totalWeightKg: calculateTotalWeight(batchShipments.flatMap(s => s.items)),
                            totalVolumeM3: calculateTotalVolume(batchShipments.flatMap(s => s.items)),
                            requiredVehicleType: 'van',
                            assignmentStrategy: 'VROOM_OPTIMIZED',
                            currentSearchLevel: 8
                        });
                    }
                }
                return batches;

            } else {
                console.warn('[TrunkBatch] VROOM returned no routes. Fallback to raw batch.');
                // Fallback: One big raw batch
                return [{
                    batchId: new ObjectId().toString(),
                    type: 'HUB_AND_SPOKE',
                    status: 'pending_assignment',
                    shipments: shipments as any,
                    hubLocation: { lat: originHub.lat, lon: originHub.lon },
                    createdAt: new Date(),
                    totalWeightKg: calculateTotalWeight(shipments.flatMap(s => s.items)),
                    totalVolumeM3: calculateTotalVolume(shipments.flatMap(s => s.items)),
                    requiredVehicleType: 'van',
                    assignmentStrategy: 'VROOM_OPTIMIZED',
                    currentSearchLevel: 8
                }];
            }
        } catch (e) {
            console.error('[TrunkBatch] VROOM failed', e);
            // Fallback
            return [{
                batchId: new ObjectId().toString(),
                type: 'HUB_AND_SPOKE',
                status: 'pending_assignment',
                shipments: shipments as any,
                hubLocation: { lat: originHub.lat, lon: originHub.lon },
                createdAt: new Date(),
                totalWeightKg: calculateTotalWeight(shipments.flatMap(s => s.items)),
                totalVolumeM3: calculateTotalVolume(shipments.flatMap(s => s.items)),
                requiredVehicleType: 'van',
                assignmentStrategy: 'VROOM_OPTIMIZED',
                currentSearchLevel: 8
            }];
        }
    }

    /**
     * Helper: Direct Van Delivery (for short distance heavy items)
     * e.g., Fridge moving 5km across town. No need for Hub.
     */
    private static async createDirectVanBatch(shipments: GoingNetworkShipment[]): Promise<Batch[]> {
        try {
            // Helper function logic mostly mirrors createDirectMotoBatches but enforcing Van
            return [{
                batchId: new ObjectId().toString(),
                type: 'HYPER_LOCAL', // Direct delivery within zone (Intra-Zonal)
                status: 'pending_assignment',
                shipments: shipments as any,
                hubLocation: shipments[0].pickupAddress,
                createdAt: new Date(),
                totalWeightKg: calculateTotalWeight(shipments.flatMap(s => s.items)),
                totalVolumeM3: calculateTotalVolume(shipments.flatMap(s => s.items)),
                requiredVehicleType: 'van',
                assignmentStrategy: 'VROOM_OPTIMIZED',
                currentSearchLevel: 8
            }];
        } catch (e) {
            console.error('[DirectVan] VROOM failed', e);
            throw e;
        }
    }

    /**
     * Strategy B: RELAY (H3 Virtual Chain)
     * Calculates intermediate "Virtual Hubs" using H3 Grid Path.
     */
    private static async createRelayBatches(shipments: GoingNetworkShipment[]): Promise<Batch[]> {
        const originCentroid = this.calculateCentroid(shipments.map(s => s.pickupAddress));
        const destCentroid = this.calculateCentroid(shipments.map(s => s.deliveryAddress));

        const airlineDistance = calculateTripDistanceKm(originCentroid, destCentroid);

        // If distance is short, just do direct delivery (Single Leg)
        if (airlineDistance <= RELAY_LEG_MAX_DISTANCE_KM) {
            console.log(`[Relay] Short distance (${airlineDistance.toFixed(1)}km), doing Direct Delivery`);
            return this.createDirectBatch(shipments);
        }

        // --- MULTI-LEG LOGIC ---
        console.log(`[Relay] Long distance (${airlineDistance.toFixed(1)}km), calculating H3 Intermediate Segments...`);

        const startCell = latLngToCell(originCentroid.lat, originCentroid.lon, 7);
        const endCell = latLngToCell(destCentroid.lat, destCentroid.lon, 7);

        let path: string[] = [];
        try {
            path = h3.gridPathCells(startCell, endCell);
        } catch (e) {
            console.warn('[Relay] H3 gridPath/Cells failed (cells too far?), fallback to direct.');
            return this.createDirectBatch(shipments);
        }

        const OPTIMAL_LEG_KM = 12.0;

        // Dynamic Split:
        // Legs = Ceil(25km / 12km) = 3 Legs? No.
        // If 25km: 25 / 12 = 2.08 -> 3 Legs (8.3km each). Safer against traffic.
        // If 20km: 20 / 12 = 1.66 -> 2 Legs (10km each).
        const numLegs = Math.max(1, Math.ceil(airlineDistance / OPTIMAL_LEG_KM));

        console.log(`[Relay] Dynamic Split: ${airlineDistance.toFixed(1)}km / ${OPTIMAL_LEG_KM}km = ${numLegs} Legs.`);

        // Find the index of the first Hub in the H3 Path array.
        // We want to split the path into 'numLegs' segments.
        // Hub 1 is at 1/numLegs of the path.
        // e.g. 3 Legs -> Hub 1 at 33% (1/3), Hub 2 is handled by next iteration.
        const firstHubPathIndex = Math.floor(path.length / numLegs);
        const safeIndex = Math.min(Math.max(1, firstHubPathIndex), path.length - 1);
        const firstHubCell = path[safeIndex];
        const [lat, lon] = h3.cellToLatLng(firstHubCell);

        console.log(`[Relay] Identified Virtual Hub 1 at ${lat.toFixed(4)}, ${lon.toFixed(4)} (Cell: ${firstHubCell}, Index: ${safeIndex}/${path.length})`);

        const batch1Id = new ObjectId().toString();
        const batch2Id = new ObjectId().toString();

        // Batch 1: Pickup -> Virtual Hub
        const batch1: Batch = {
            batchId: batch1Id,
            type: 'RELAY',
            status: 'pending_assignment',
            shipments: shipments as any,
            hubLocation: { lat, lon }, // Destination for D1
            createdAt: new Date(),
            totalWeightKg: calculateTotalWeight(shipments.flatMap(s => s.items)),
            totalVolumeM3: calculateTotalVolume(shipments.flatMap(s => s.items)),
            requiredVehicleType: 'motorcycle',
            assignmentStrategy: 'VROOM_OPTIMIZED',
            currentSearchLevel: 8,
            metadata: {
                nextBatchId: batch2Id,
                isRelayLeg: 1
            }
        };

        // Batch 2: Virtual Hub -> Delivery
        // We must modify the pickupAddress of these shipments to be the Hub,
        // so the assignment engine searches for drivers NEAR THE HUB.
        const leg2Shipments = shipments.map(s => ({
            ...s,
            pickupAddress: {
                ...s.pickupAddress,
                lat: lat,
                lon: lon,
                fullName: "Virtual Relay Point",
                street: "Relay Point",
                h3IndexL8: latLngToCell(lat, lon, 8)
            }
        }));

        const batch2: Batch = {
            batchId: batch2Id,
            type: 'RELAY',
            status: 'pending_inbound', // [CORRECTED] Locked until Leg 1 completes
            shipments: leg2Shipments as any,
            hubLocation: { lat, lon }, // Pickup Location for D2 (Technically D2 has no 'Hub' to go to, they go to Delivery. But 'hubLocation' often denotes the key point.)
            // IMPORTANT: In findBestDriverForBatch, it uses shipments[0].pickupAddress.
            // In findBestBatchForDriver, it uses batch.hubLocation. Ensure alignment.
            // batch.hubLocation is usually "Where the driver goes to get the stuff".
            // For D1, it touches Hub? No, D1 goes Pickup -> hubLocation.
            // For D2, D2 goes hubLocation -> Delivery.

            createdAt: new Date(),
            totalWeightKg: calculateTotalWeight(shipments.flatMap(s => s.items)),
            totalVolumeM3: calculateTotalVolume(shipments.flatMap(s => s.items)),
            requiredVehicleType: 'motorcycle',
            assignmentStrategy: 'VROOM_OPTIMIZED',
            currentSearchLevel: 8,
            metadata: {
                previousBatchId: batch1Id,
                isRelaySecondLeg: true,
                originalPickupAddress: shipments[0].pickupAddress // store for fallback reference
            }
        };

        return [batch1, batch2];
    }

    /**
     * Helper: Standard VROOM optimization for direct last-mile/short relays
     */
    /**
     * Helper: Standard VROOM optimization for direct last-mile/short relays
     */
    private static async createDirectBatch(shipments: GoingNetworkShipment[]): Promise<Batch[]> {
        try {
            // [MODIFIED] Hybrid Strategy: Anchor Loop vs Network Flow
            // If Volume is High (e.g. Celestino with > 15 items), prevent Deadheading/Stranding.
            // Force the driver to return to the Anchor Point (Start) to reload or check-in.
            // If Volume is Low (Standard Flow), use Open-Ended Routing to allow continuity to next zone.

            const isAnchorLoop = shipments.length >= 15; // "Celestino Trigger"

            if (isAnchorLoop) {
                console.log(`[QueueEngine] High Volume Batch (${shipments.length} items). Enforcing 'Round Trip' (Anchor Loop).`);
            }

            const output = await solveVrp(shipments, [], undefined, { forceRoundTrip: isAnchorLoop });

            if (!output.routes || output.routes.length === 0) {
                // Fallback if VROOM returns nothing (e.g. no valid route)
                console.warn('[DirectBatch] VROOM produced no routes. Using raw grouping.');
                // Just grouping logic here if needed...
                // return ...
                return []; // Better return empty and let retry logic handle it
            }

            // Map Routes to Batches
            const batches: Batch[] = [];

            for (const route of output.routes) {
                const batchShipments: GoingNetworkShipment[] = [];
                route.steps.forEach((step: any) => {
                    if (step.type === 'job') {
                        const index = (step.id || 0) - 1;
                        if (shipments[index]) batchShipments.push(shipments[index]);
                    }
                });

                if (batchShipments.length > 0) {
                    // DYNAMIC VEHICLE SELECTION
                    const allItems = batchShipments.flatMap(s => s.items);
                    const totalWeight = calculateTotalWeight(allItems);
                    const totalVolume = calculateTotalVolume(allItems);

                    // Helper: determine based on volume/weight
                    // If it fits in Moto, use Moto. If not, use Van.
                    let vehicleType: 'motorcycle' | 'van' | 'truck' | 'car' = 'motorcycle';

                    if (totalWeight > MOTO_MAX_WEIGHT_KG || totalVolume > MOTO_MAX_VOLUME_M3) {
                        vehicleType = 'van';  // Or car, if we had that distinction clearly
                    }
                    // Check if ridiculously big
                    if (totalVolume > VAN_MAX_VOLUME_M3) {
                        vehicleType = 'truck';
                    }

                    batches.push({
                        batchId: new ObjectId().toString(),
                        type: 'HYPER_LOCAL',
                        status: 'pending_assignment',
                        shipments: batchShipments as any,
                        hubLocation: batchShipments[0].pickupAddress,
                        createdAt: new Date(),
                        totalWeightKg: totalWeight,
                        totalVolumeM3: totalVolume,
                        requiredVehicleType: vehicleType,
                        assignmentStrategy: 'VROOM_OPTIMIZED',
                        currentSearchLevel: 8
                    });
                }
            }
            return batches;

        } catch (e) {
            console.error('[DirectBatch] VROOM failed', e);
            throw e;
        }
    }

    private static calculateAverageDistance(shipments: GoingNetworkShipment[]): number {
        let total = 0;
        for (const s of shipments) {
            total += calculateTripDistanceKm(s.pickupAddress, s.deliveryAddress);
        }
        return total / shipments.length;
    }

    private static calculateCentroid(coords: Coordinate[]): Coordinate {
        let lat = 0, lon = 0;
        for (const c of coords) { lat += c.lat; lon += c.lon; }
        return { lat: lat / coords.length, lon: lon / coords.length };
    }
    /**
     * ADAPTER: Startup Batch Creation (Bypasses Redis)
     * Groups shipments by Lane and calls processRedisBatch.
     */
    static async createStartupBatches(
        shipments: GoingNetworkShipment[],
        driverRepo?: any,
        db?: any
    ): Promise<Batch[]> {
        console.log(`[QueueEngine] Startup: Processing ${shipments.length} raw shipments...`);
        const batches: Batch[] = [];

        // 1. Group by Lane (OriginL8 -> DestL7)
        const laneGroups = new Map<string, GoingNetworkShipment[]>();

        for (const s of shipments) {
            const originL8 = s.pickupAddress.h3Index || latLngToCell(s.pickupAddress.lat, s.pickupAddress.lon, 8);
            const destL7 = s.deliveryAddress.h3Index
                ? h3.cellToParent(s.deliveryAddress.h3Index, 7)
                : latLngToCell(s.deliveryAddress.lat, s.deliveryAddress.lon, 7);

            const laneKey = `${originL8}:${destL7}`;
            if (!laneGroups.has(laneKey)) {
                laneGroups.set(laneKey, []);
            }
            laneGroups.get(laneKey)!.push(s);
        }

        // 2. Process each Lane
        for (const [laneKey, laneShipments] of laneGroups) {

            // RETRY LOGIC for Startup (VROOM/OSRM might be waking up)
            let attempts = 0;
            const maxAttempts = 10; // 50 seconds max wait

            while (attempts < maxAttempts) {
                try {
                    // [MODIFIED] Pass Repo/DB to verify availability on startup too
                    const laneBatches = await this.processRedisBatch(laneShipments, laneKey, driverRepo, db);
                    batches.push(...laneBatches);
                    break; // Success
                } catch (e) {
                    attempts++;
                    console.error(`[QueueEngine] Error processing startup lane ${laneKey} (Attempt ${attempts}/${maxAttempts})`, e);

                    if (attempts >= maxAttempts) {
                        console.error(`[QueueEngine] Failed to process lane ${laneKey} after ${maxAttempts} attempts. Moving on.`);
                    } else {
                        // Wait 5s before retry
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }
        }

        return batches;
    }

    // ===========================================================================
    // REINTEGRATED METHODS (Assignment & Optimization)
    // ===========================================================================

    /**
     * Finds the best driver for a specific batch using Cascade Strategy (L8 -> L7 -> L6).
     */
    public static async findBestDriverForBatch(
        batch: Batch,
        driverRepo: DriverRepository,
        initialSearchLevel: number = 8,
        db?: any
    ): Promise<string | null> {
        const searchLevels = [8, 7, 6];
        // Safe accessors
        const batchShips = batch.shipments || [];
        const anchor = batch.hubLocation || batchShips[0]?.pickupAddress;

        if (!anchor) return null;
        const { lat, lon } = anchor;

        for (const level of searchLevels) {
            const searchCell = latLngToCell(lat, lon, level);

            // Relaxed Radius for broader levels
            let radiusK = 1;
            if (level === 7) radiusK = 2;
            if (level === 6) radiusK = 10; // City-Wide

            const candidates = await driverRepo.findIdleInRadius(searchCell, radiusK);

            if (candidates.length === 0) continue;

            // Filter Candidates
            const compatibleCandidates = [];
            for (const driver of candidates) {
                const requiredType = batch.requiredVehicleType;
                const driverVehicle = driver.vehicle;

                if (!driverVehicle) continue;
                if (!canVehicleCarryBatch(driverVehicle, batch.totalWeightKg || 0, batch.totalVolumeM3 || 0)) continue;

                let compatible = true;
                if (requiredType === 'truck' && driverVehicle.type !== 'truck') compatible = false;
                if (requiredType === 'van' && !(driverVehicle.type === 'van' || driverVehicle.type === 'truck')) compatible = false;
                if (requiredType === 'car' && !(driverVehicle.type === 'car' || driverVehicle.type === 'van' || driverVehicle.type === 'truck')) compatible = false;
                if (requiredType === 'motorcycle' && !(driverVehicle.type === 'motorcycle' || driverVehicle.type === 'car' || driverVehicle.type === 'van' || driverVehicle.type === 'truck')) compatible = false;

                if (!compatible) continue;

                // ============================================================
                // LÓGICA DE RELEVO FORZADO (ANTI-CONTINUIDAD)
                // ============================================================
                try {
                    const lastBatch = await driverRepo.getLastBatch(driver.driverId);
                    if (lastBatch) {
                        const lastItems = lastBatch.shipments || [];
                        const currentItems = batchShips; // Ya lo obtuvimos arriba

                        if (lastItems.length > 0 && currentItems.length > 0) {
                            // Comparamos Zona de Destino (L7) del anterior vs el nuevo
                            const lastDest = lastItems[0].deliveryAddress;
                            const currentDest = currentItems[0].deliveryAddress;

                            const lastDestZone = latLngToCell(lastDest.lat, lastDest.lon, 7);
                            const currentDestZone = latLngToCell(currentDest.lat, currentDest.lon, 7);

                            // Si voy a la misma zona a la que fui recién, BLOQUEAR.
                            // Esto fuerza a que el 'Feeder' suelte la carga y otro haga el 'Last Mile'.
                            if (lastDestZone === currentDestZone) {
                                console.log(`[Assignment] Driver ${driver.driverId} saltado por Relevo Forzado (Destino repetido: Zona ${lastDestZone}).`);
                                continue;
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[Assignment] Error chequeando historial driver ${driver.driverId}`, err);
                }
                // ============================================================

                compatibleCandidates.push(driver);
            }

            if (compatibleCandidates.length > 0) {
                console.log(`[Assignment] Found ${compatibleCandidates.length} eligible drivers at Level ${level}. Assigning first match.`);
                return compatibleCandidates[0].driverId;
            }
        }
        return null;
    }

    /**
     * Finds the best pending batch for a driver who just came online or finished a job.
     */
    public static async findBestBatchForDriver(
        driverId: string,
        lat: number,
        lon: number,
        db: import('mongodb').Db,
        driverRepo: DriverRepository
    ): Promise<Batch | null> {
        // 1. Get Driver State
        const driverState = await driverRepo.get(driverId);
        if (!driverState || !driverState.vehicle) {
            console.warn(`[Assignment] Driver ${driverId} not found or has no vehicle.`);
            return null;
        }

        // 2. Cascade Search Strategy
        const searchLevels = [8, 7, 6];

        // Get pending batches
        // TODO: OPTIMIZE WITH GEOQUERY ($nearSphere) whenever '2dsphere' index is ready.
        // const pendingBatches = await db.collection<Batch>('batches').find({
        //    status: 'pending_assignment',
        //    hubLocation: { $nearSphere: { $geometry: { type: "Point", coordinates: [lon, lat] }, $maxDistance: 20000 } }
        // }).toArray();
        const pendingBatches = await db.collection<Batch>('batches').find({
            status: 'pending_assignment'
        }).toArray();

        // Precargar el último batch del driver UNA SOLA VEZ para no saturar la DB en el loop
        let lastDestZone: string | null = null;
        try {
            const lastBatch = await driverRepo.getLastBatch(driverId);
            if (lastBatch) {
                const lastItems = lastBatch.shipments || [];
                if (lastItems.length > 0) {
                    const d = lastItems[0].deliveryAddress;
                    lastDestZone = latLngToCell(d.lat, d.lon, 7);
                }
            }
        } catch (e) {
            console.warn('[Assignment] Failed to load driver history', e);
        }

        for (const level of searchLevels) {
            const searchCell = latLngToCell(lat, lon, level);

            // Filtro inicial por distancia (rápido)
            const nearbyBatches = pendingBatches.filter(b => {
                if (!b.hubLocation) return false;
                const batchCell = latLngToCell(b.hubLocation.lat, b.hubLocation.lon, level);

                let maxDistance = 1;
                if (level === 7) maxDistance = 2;
                if (level === 6) maxDistance = 10;

                try {
                    const dist = h3.gridDistance(batchCell, searchCell);
                    return dist <= maxDistance;
                } catch (e) {
                    return false;
                }
            });

            if (nearbyBatches.length === 0) continue;

            // Filtro complejo (Vehículo + Relevo Forzado)
            const compatibleBatches: Batch[] = [];

            for (const b of nearbyBatches) {
                // A. Check Capacidad
                const canCarry = canVehicleCarryBatch(driverState.vehicle!, b.totalWeightKg || 0, b.totalVolumeM3 || 0);

                // B. Check Tipo Vehículo
                const reqType = b.requiredVehicleType || 'motorcycle';
                const drvType = driverState.vehicle!.type;
                let typeMatch = true;
                if (reqType === 'truck' && drvType !== 'truck') typeMatch = false;
                if (reqType === 'van' && !(drvType === 'van' || drvType === 'truck')) typeMatch = false;
                if (reqType === 'car' && !(drvType === 'car' || drvType === 'van' || drvType === 'truck')) typeMatch = false;
                if (reqType === 'motorcycle' && !(drvType === 'motorcycle' || drvType === 'car' || drvType === 'van' || drvType === 'truck')) typeMatch = false;

                if (!canCarry || !typeMatch) continue;

                // C. LÓGICA DE RELEVO FORZADO (Check Anti-Continuidad)
                if (lastDestZone) {
                    const currentItems = b.shipments || [];
                    if (currentItems.length > 0) {
                        const d = currentItems[0].deliveryAddress;
                        const currentDestZone = latLngToCell(d.lat, d.lon, 7);

                        if (lastDestZone === currentDestZone) {
                            // Skip this batch
                            continue;
                        }
                    }
                }

                compatibleBatches.push(b);
            }

            if (compatibleBatches.length > 0) {
                // Sort by Distance
                compatibleBatches.sort((a, b) => {
                    const distA = calculateTripDistanceKm({ lat, lon }, a.hubLocation!);
                    const distB = calculateTripDistanceKm({ lat, lon }, b.hubLocation!);
                    return distA - distB;
                });
                return compatibleBatches[0];
            }
        }
        return null;
    }

    /**
     * Validates and Optimizes a Batch Sequence using OSRM.
     */
    public static async optimizeBatchSequence(
        batch: GoingNetworkShipment[],
        target: 'pickup' | 'delivery',
        referencePoint: Coordinate
    ): Promise<GoingNetworkShipment[]> {
        if (batch.length <= 1) return batch;

        const getPoint = (s: GoingNetworkShipment) => target === 'pickup' ? s.pickupAddress : s.deliveryAddress;

        if (target === 'pickup') {
            // Collection: Trust geometric sweep order.
            return batch;
        } else {
            // Distribution: Hub -> Outward
            const deliveryPointsWithIndex = batch.map((s, i) => ({ loc: s.deliveryAddress, originalIndex: i }));
            const reorderedPoints = deliveryPointsWithIndex.map(x => x.loc); // Simplified, skip the "Farthest" pre-sort for now to keep it robust

            try {
                const osrmResult = await optimizeRouteOSRM(referencePoint, reorderedPoints, { source: 'first', destination: 'any', timeout: 5000 });

                // Map sorted indices
                const sortedIndices = osrmResult.sortedIndices
                    .filter(idx => idx !== 0)
                    .map(idx => idx - 1);

                const finalBatch: GoingNetworkShipment[] = [];
                for (const idx of sortedIndices) {
                    if (deliveryPointsWithIndex[idx]) {
                        const originalIdx = deliveryPointsWithIndex[idx].originalIndex;
                        finalBatch.push(batch[originalIdx]);
                    }
                }
                return finalBatch;
            } catch (e) {
                console.warn('[LogisticsEngine] OSRM Optimization failed, returning original order.', e);
                return batch;
            }
        }
    }
}
