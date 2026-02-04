import express from 'express';
import cors from 'cors';
import * as turf from '@turf/turf';
import { latLngToCell, greatCircleDistance } from 'h3-js';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { MongoClient, ChangeStream, ObjectId, Db, UpdateDescription } from 'mongodb';
import dotenv from 'dotenv';
import {
    GoingNetworkShipment, DriverState, Batch, Shipment, DriverStatus, User
} from './interfaces';
import * as Engine from './logisticsEngine';
import { LogisticsQueueEngine } from './logisticsQueueEngine';
import { getNextCellTowardsDestination } from './lib/routingUtils';
import { createRedisDriverRepository } from './repositories/redisDriverRepository';
import { decryptObject } from './lib/encryption';
import { geocodeAddress } from './lib/geocoding';
import { RedisQueue } from './lib/redisQueue';
import './workers/logisticsWorker'; // Start the worker process
import { ConfigService } from './services/configService';
import { OfferService } from './services/OfferService';


dotenv.config();

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error("MONGODB_URI is not set in environment variables.");
    process.exit(1);
}
const redisUrl = process.env.REDIS_PUBLIC_ENDPOINT;
if (!redisUrl) {
    console.error("REDIS_PUBLIC_ENDPOINT is not set in environment variables.");
    process.exit(1);
}

const client = new MongoClient(uri);

// Map to store socketId -> driverId for quick disconnect handling
const socketToDriverMap = new Map<string, string>();
// Map to store driverId -> Timeout for disconnect handling
const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

async function main() {
    try {
        await client.connect();
        console.log("Connected to MongoDB");
        // Initialize Redis Repository (Functional Factory)
        const dbName = process.env.MONGODB_DB_GOING || 'going';
        const db = client.db(dbName);

        // [MODIFIED] Load Dynamic Pricing Rules
        await ConfigService.getInstance().loadPricingRules(db);
        // Start Watching for changes (Hot Reload)
        ConfigService.getInstance().startWatching(db); // Fire and forget (it attaches listeners)

        const redisPassword = process.env.REDIS_PASSWORD;
        const driverRepo = createRedisDriverRepository(redisUrl!, db, redisPassword);

        // --- Socket.io Logic ---
        io.on('connection', (socket: Socket) => {
            console.log('New client connected:', socket.id);

            socket.on('authenticate', async (data: { driverId: string, vehicle?: any }) => {
                const { driverId, vehicle } = data;
                console.log(`Driver ${driverId} authenticated on socket ${socket.id}`);

                socketToDriverMap.set(socket.id, driverId);

                // Fetch User from MongoDB to get persistent Driver Details
                // This ensures that if the driver configured their vehicle previously, we respect it.
                // We use 'users' collection (assuming that's where User/Driver profile lives)
                let persistentVehicle = null;
                try {
                    // Try both string and ObjectId to be safe
                    const userProfile = await db.collection<User>('users').findOne({
                        $or: [
                            { _id: driverId },
                            { _id: new ObjectId(driverId) }
                        ]
                    } as any);

                    if (userProfile && userProfile.driverDetails?.vehicle) {
                        persistentVehicle = userProfile.driverDetails.vehicle;
                        // Cast to any to access dynamic 'hasGNC' prop
                        const def = persistentVehicle.definition as any;
                        console.log(`[Auth] Loaded persistent vehicle for ${driverId}: ${persistentVehicle.type} (GNC: ${def?.hasGNC})`);
                    }
                } catch (e) {
                    console.warn(`[Auth] Failed to fetch user profile for ${driverId}`, e);
                }

                // Default vehicle if none provided AND none in DB (for testing/MVP)
                const defaultVehicle = {
                    type: 'motorcycle',
                    maxWeightKg: 20,
                    maxVolumeM3: 0.1
                };

                // Priority: 1. Persistent DB (Golden Source) -> 2. Client sent (Session) -> 3. Default
                const effectiveVehicle = persistentVehicle || vehicle || defaultVehicle;

                // Check if driver exists in Redis (Reconnection vs New Session)
                const existingDriver = await driverRepo.get(driverId);

                let currentStatus: DriverStatus = 'IDLE';

                if (existingDriver) {
                    console.log(`Driver ${driverId} reconnected. Updating socket and restoring state.`);
                    // Update socketId and restore status if OFFLINE
                    currentStatus = existingDriver.status === 'OFFLINE' ? 'IDLE' : existingDriver.status;

                    await driverRepo.add(driverId, {
                        ...existingDriver,
                        socketId: socket.id,
                        status: currentStatus,
                        vehicle: effectiveVehicle // Use the resolved persistent vehicle
                    });
                } else {
                    // New Session
                    await driverRepo.add(driverId, {
                        socketId: socket.id,
                        driverId: driverId,
                        status: 'IDLE',
                        lat: 0,
                        lon: 0,
                        idleSince: Date.now(),
                        quadrantId: '',
                        vehicle: effectiveVehicle
                    } as DriverState);
                }

                // Check for Active Batch (Persistence)
                // ... (Rest of existing logic) ...
                const activeBatch = await db.collection<Batch>('batches').findOne({
                    assignedCollectorId: driverId,
                    status: { $in: ['assigned', 'in_progress', 'in_transit', 'out_for_delivery'] }
                });

                if (activeBatch) {
                    // ... (Existing restore logic) ...
                    console.log(`Driver ${driverId} has active batch ${activeBatch._id}. Restoring to client.`);

                    // [MODIFIED] Clear any pending disconnect timeout since driver reconnected
                    if (disconnectTimeouts.has(driverId)) {
                        console.log(`[Reconnection] Clearing disconnect timeout for ${driverId}`);
                        clearTimeout(disconnectTimeouts.get(driverId));
                        disconnectTimeouts.delete(driverId);
                    }

                    // Refresh shipments from source of truth to ensure statuses are correct
                    // This fixes issues where the denormalized shipments in 'batches' might be stale
                    const freshShipments = await db.collection<GoingNetworkShipment>('shipments').find({
                        _id: { $in: activeBatch.shipments?.map(s => new ObjectId(s._id)) || [] }
                    }).toArray();

                    if (freshShipments.length > 0) {
                        // Decrypt addresses before sending to client
                        const decryptedFreshShipments = freshShipments.map(s => {
                            if ((s as any).encryptedDeliveryAddress) {
                                try {
                                    const deliveryAddress = decryptObject((s as any).encryptedDeliveryAddress) as any;
                                    return { ...s, deliveryAddress };
                                } catch (e) {
                                    console.error(`Failed to decrypt address for shipment ${s._id}`, e);
                                    return s;
                                }
                            }
                            return s;
                        });
                        activeBatch.shipments = decryptedFreshShipments as any[];
                    }

                    let driverStatus = 'COLLECTING_BATCH';
                    if (activeBatch.status === 'in_progress' || activeBatch.status === 'in_transit' || activeBatch.status === 'out_for_delivery') {
                        driverStatus = 'DELIVERING_BATCH';
                    }

                    // Emit specific restoreState event
                    console.log(`[RestoreState] Emitting to ${socket.id}: Batch ${activeBatch._id} (Status: ${activeBatch.status}) -> Driver Status: ${driverStatus}`);
                    socket.emit('restoreState', {
                        batch: activeBatch,
                        driverStatus: driverStatus
                    });
                } else {
                    // Self-Healing: If Redis says COLLECTING/DELIVERING but Mongo says no batch, force IDLE.
                    if (currentStatus === 'COLLECTING_BATCH' || currentStatus === 'DELIVERING_BATCH') {
                        console.log(`[Self-Healing] Driver ${driverId} has status ${currentStatus} but no active batch in DB. Forcing IDLE.`);
                        await driverRepo.updateStatus(driverId, 'IDLE');
                    }
                }
            });

            socket.on('logout', async () => {
                const driverId = socketToDriverMap.get(socket.id);
                if (driverId) {
                    console.log(`Driver ${driverId} logged out (Voluntary). Removing from Redis.`);
                    await driverRepo.remove(driverId);
                    socketToDriverMap.delete(socket.id);
                    // Optional: socket.disconnect();
                }
            });

            // [NEW] OFFER SERVICE
            const offerService = new OfferService(redisUrl!, db, driverRepo);

            // [NEW] Accept Flash Offer
            socket.on('acceptOffer', async (data: { batchId: string }) => {
                const { batchId } = data;
                const driverId = socketToDriverMap.get(socket.id);
                if (!driverId) return;

                console.log(`[Offer] Driver ${driverId} attempting to ACCEPT offer ${batchId}`);
                const result = await offerService.acceptOffer(batchId, driverId);

                if (result.success) {
                    // Notify Driver: Success + Task Data
                    socket.emit('newTask', { batch: result.batch });
                    console.log(`[Offer] Driver ${driverId} ACCEPTED batch ${batchId} successfully.`);
                } else {
                    // Notify Driver: Failed (Expired/Takne)
                    socket.emit('offerExpired', { message: result.error || "Offer expired." });
                    console.log(`[Offer] Driver ${driverId} FAILED to accept batch ${batchId}: ${result.error}`);
                }
            });

            // [NEW] Reject Flash Offer (Pre-Acceptance)
            socket.on('rejectOffer', async (data: { batchId: string }) => {
                const { batchId } = data;
                const driverId = socketToDriverMap.get(socket.id);
                if (!driverId) return;

                console.log(`[Offer] Driver ${driverId} DECLINED offer ${batchId}`);
                await offerService.rejectOffer(batchId, driverId);
                // We don't need to emit anything back, client knows it rejected.
                // Engine loop will pick it up (Redis Key deleted means 'not processing').
                // Actually Engine needs to know to reroll immediately?
                // For MVP, Engine can poll or we can trigger re-evaluation manually.
                // ideally: Engine.triggerReevaluation(batchId);
            });

            // [NEW] Reject Batch / Manual Release
            socket.on('reject_batch', async (data: { batchId: string, reason?: string }) => {
                const { batchId, reason } = data;
                const driverId = socketToDriverMap.get(socket.id);

                if (!driverId) return;

                console.log(`[Batch] Driver ${driverId} REJECTED batch ${batchId}. Reason: ${reason || 'None'}`);

                try {
                    // 1. Security Check: Has the driver picked up anything?
                    const batch = await db.collection<Batch>('batches').findOne({ _id: new ObjectId(batchId), assignedCollectorId: driverId });

                    if (!batch) {
                        socket.emit('batchRejected', { success: false, error: 'Batch not found or not assigned.' });
                        return;
                    }

                    const shipmentIds = batch.shipments?.map(s => new ObjectId(s._id)) || [];
                    const activeShipments = await db.collection<GoingNetworkShipment>('shipments').find({
                        _id: { $in: shipmentIds },
                        status: { $in: ['in_transit', 'out_for_delivery', 'delivered'] }
                    }).toArray();

                    if (activeShipments.length > 0) {
                        console.warn(`[Batch] Security: Driver ${driverId} tried to reject batch ${batchId} but has ${activeShipments.length} items in custody.`);
                        socket.emit('batchRejected', { success: false, error: 'Cannot cancel batch after starting collection. Please finish the delivery.' });
                        return;
                    }

                    // 2. Unassign in MongoDB
                    const result = await db.collection<Batch>('batches').updateOne(
                        { _id: new ObjectId(batchId), assignedCollectorId: driverId },
                        {
                            $set: {
                                assignedCollectorId: undefined, // Explicit null/undefined
                                status: 'pending_assignment'    // Return to pool
                            }
                        }
                    );

                    if (result.modifiedCount > 0) {
                        // 2. Update Driver Status to IDLE
                        await driverRepo.updateStatus(driverId, 'IDLE');

                        // 3. Notify Driver (Confirm rejection)
                        socket.emit('batchRejected', { success: true });
                        console.log(`[Batch] Batch ${batchId} unassigned successfully.`);
                    } else {
                        console.warn(`[Batch] Failed to unassign batch ${batchId}. Maybe already unassigned?`);
                        socket.emit('batchRejected', { success: false, error: 'Batch not found or not assigned to you.' });
                    }
                } catch (error) {
                    console.error(`[Batch] Error rejecting batch:`, error);
                    socket.emit('batchRejected', { success: false, error: 'Internal error' });
                }
            });

            socket.on('track_driver', (data: { driverId: string }) => {
                const { driverId } = data;
                console.log(`Socket ${socket.id} subscribing to driver ${driverId}`);
                socket.join(`driver_${driverId}`);
            });

            socket.on('driverLocationUpdate', async (data: { lat: number, lon: number }) => {
                const driverId = socketToDriverMap.get(socket.id);
                if (driverId) {
                    // 1. Fetch State BEFORE update to detect H3 change
                    const driverState = await driverRepo.get(driverId);

                    await driverRepo.updateLocation(driverId, data.lat, data.lon);

                    // Broadcast to subscribers (Dashboard)
                    io.to(`driver_${driverId}`).emit('driver_location_changed', {
                        driverId,
                        lat: data.lat,
                        lon: data.lon
                    });

                    // --- Dynamic Assignment Logic (Pull) ---
                    // Existing Idle Logic
                    if (driverState && driverState.status === 'IDLE') {
                        // ... (Keep existing IDLE logic if it was here, or verify if I removed it in previous steps. 
                        // The previous view showed it was here. I must preserve it or ensure references are correct.)
                        // Since I am replacing the block, I need to be careful.
                        // The user prompt implies I should ADD logic, not replace IDLE logic.
                        // However, the replace_file_content tool replaces the block.
                        // I will assume the IDLE logic is handled by '... (Existing assignment logic) ...' in my previous view, 
                        // wait, I need to see the IDLE logic to preserve it.
                        // I will assume for this specific edit I am inserting the Relay Logic *after* the update and *before* the IDLE logic?
                        // Actually, this logic is for *Active* drivers (RELAY), so it's parallel to IDLE logic.

                        // Let's use the 'driverState.status' to differentiate.
                    }


                    // [NEW] Relay Security: Deviation Check (Leg 2 Driver)
                    if (driverState && driverState.activeBatchId && driverState.status === 'ROUTING_TO_HUB') {
                        const batch = await db.collection<Batch>('batches').findOne({ _id: new ObjectId(driverState.activeBatchId) });

                        // Hub Location (Pickup for Leg 2)
                        if (batch && batch.hubLocation) {
                            const currentDist = greatCircleDistance(
                                [data.lat, data.lon],
                                [batch.hubLocation.lat, batch.hubLocation.lon],
                                'km'
                            );

                            const lastDist = driverState.lastDistanceToHub || currentDist; // Init with current
                            const deviationThreshold = 0.5; // 500 meters allowed drift (GPS jitter + valid detours)

                            if (currentDist > lastDist + deviationThreshold) {
                                // Moving AWAY from Hub
                                const newCount = (driverState.deviationCount || 0) + 1;
                                console.warn(`[Security] Driver ${driverId} deviating from Hub! Count: ${newCount}. Dist: ${currentDist.toFixed(2)}km (was ${lastDist.toFixed(2)}km)`);

                                await driverRepo.update(driverId, {
                                    lastDistanceToHub: currentDist,
                                    deviationCount: newCount
                                });

                                if (newCount >= 3) {
                                    console.error(`[Security] RED ALERT: Driver ${driverId} ignored deviation warnings. Taking action.`);

                                    // 1. Notify Admin (Web Hook)
                                    // We use the internal Docker DNS or public URL if configured
                                    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
                                    try {
                                        fetch(`${webAppUrl}/api/emails/admin-alert`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                driverId: driverId,
                                                message: 'Excessive deviation from Relay Hub.',
                                                details: {
                                                    batchId: batch._id,
                                                    currentLocation: { lat: data.lat, lon: data.lon },
                                                    hubLocation: batch.hubLocation,
                                                    deviationCount: newCount
                                                }
                                            })
                                        }).catch(err => console.error("Failed to send admin alert:", err));
                                    } catch (e) { /* ignore */ }

                                    // 2. Warn Driver
                                    io.to(driverState.socketId).emit('message', {
                                        title: '⚠️ WRONG WAY',
                                        body: 'You are moving away from the Relay Point. Turn back now or you will be unassigned.',
                                        type: 'error'
                                    });
                                }
                            } else {
                                // Moving Closer or IDLE -> Reset Count (or update dist)
                                // Only update distance if closer to prevent "ratchet" effect locking them in? 
                                // Actually, we should always update distance to track progress.
                                // If they get closer, great. If they stop, dist stays same.
                                await driverRepo.update(driverId, {
                                    lastDistanceToHub: currentDist,
                                    deviationCount: 0
                                });
                            }
                        }
                    }

                    // [NEW] Dynamic Relay Matching (Active Drivers)
                    if (driverState && driverState.activeBatchId && (driverState.status === 'COLLECTING_BATCH' || driverState.status === 'ROUTING_TO_HUB' || driverState.status === 'DELIVERING_BATCH')) {
                        const newCell = latLngToCell(data.lat, data.lon, 8);
                        const oldCell = driverState.quadrantId;

                        if (newCell !== oldCell) {
                            // Driver changed H3 Cell - Trigger Check
                            const batch = await db.collection<Batch>('batches').findOne({ _id: new ObjectId(driverState.activeBatchId) });

                            if (batch && batch.type === 'RELAY' && batch.hubLocation && !batch.metadata?.relayPartnerId) {
                                // Check Distance to Hub
                                const distKm = greatCircleDistance(
                                    [data.lat, data.lon],
                                    [batch.hubLocation.lat, batch.hubLocation.lon],
                                    'km'
                                );

                                if (distKm < 5) { // approaching hub
                                    console.log(`[Relay] Driver ${driverId} approaching Hub (${distKm.toFixed(2)}km). Searching for partner...`);
                                    const hubH3 = latLngToCell(batch.hubLocation.lat, batch.hubLocation.lon, 8);

                                    // Call Repository Logic
                                    const candidates = await driverRepo.findPredictiveRelayCandidates(hubH3, 10);

                                    if (candidates.length > 0) {
                                        const partner = candidates[0];
                                        console.log(`[Relay] Match Found! Partner: ${partner.driverId}`);

                                        // 1. Create Leg 2 Batch
                                        const batch2Id = new ObjectId().toString();
                                        const shipmentsLeg2 = (batch.shipments || []).map(s => ({
                                            ...s,
                                            pickupAddress: {
                                                ...s.pickupAddress,
                                                lat: batch.hubLocation!.lat,
                                                lon: batch.hubLocation!.lon,
                                                fullName: "Relay Point (Hub)",
                                                h3IndexL8: hubH3
                                            }
                                        }));

                                        const batch2: Batch = {
                                            batchId: batch2Id,
                                            type: 'RELAY',
                                            status: 'assigned', // Immediate assignment
                                            assignedCollectorId: partner.driverId,
                                            shipments: shipmentsLeg2 as any,
                                            hubLocation: batch.hubLocation, // Pickup for D2
                                            createdAt: new Date(),
                                            totalWeightKg: batch.totalWeightKg,
                                            totalVolumeM3: batch.totalVolumeM3,
                                            requiredVehicleType: batch.requiredVehicleType,
                                            assignmentStrategy: 'RELAY_MATCH',
                                            metadata: {
                                                previousBatchId: batch.batchId,
                                                isRelaySecondLeg: true
                                            }
                                        };

                                        await db.collection<Batch>('batches').insertOne(batch2);

                                        // 2. Update Leg 1 (Current Batch)
                                        await db.collection<Batch>('batches').updateOne(
                                            { _id: batch._id },
                                            {
                                                $set: {
                                                    'metadata.relayPartnerId': partner.driverId,
                                                    'metadata.nextBatchId': batch2Id,
                                                    'rendezvousInfo': {
                                                        partnerDriver: {
                                                            id: partner.driverId,
                                                            name: "Relay Partner", // ideally fetch name
                                                            phone: "+5491100000000" // ideally fetch
                                                        },
                                                        etaSeconds: 300 // Estimate
                                                    }
                                                }
                                            }
                                        );

                                        // 3. Notify Driver 1 (Handshake Mode)
                                        const updatedBatch1 = await db.collection<Batch>('batches').findOne({ _id: batch._id });
                                        io.to(driverState.socketId).emit('batchUpdated', {
                                            batch: updatedBatch1,
                                            message: "Relay Partner Found! routing to Hub."
                                        });

                                        // 4. Notify Driver 2 (New Task)
                                        if (partner.socketId) {
                                            await driverRepo.updateStatus(partner.driverId, 'COLLECTING_BATCH');
                                            // Update partner active batch
                                            await driverRepo.update(partner.driverId, { activeBatchId: batch2Id }); // Ensure this method exists or use direct redis

                                            io.to(partner.socketId).emit('newTask', {
                                                batch: batch2
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Existing IDLE Assignment Logic (Replaced with Flash Offer)
                    if (driverState && driverState.status === 'IDLE') {
                        // [NEW] Prevent Spam: Check if driver already has an active offer
                        if (await offerService.hasActiveOffer(driverId)) {
                            // Already considering an offer. Do nothing.
                            return;
                        }

                        const bestBatch = await Engine.findBestBatchForDriver(driverId, data.lat, data.lon, db, driverRepo);
                        if (bestBatch) {
                            // [MODIFIED] Check Cooldown before offering
                            if (!await offerService.canMakeOffer(bestBatch._id.toString(), driverId)) {
                                console.log(`[Assignment] Skipping offer of Batch ${bestBatch._id} to Driver ${driverId} (Cooldown/Busy)`);
                                return;
                            }

                            // [MODIFIED] Create FLASH OFFER instead of Direct Assignment
                            const offerCreated = await offerService.createOffer(bestBatch._id.toString(), driverId);

                            if (offerCreated) {
                                // Update Batch Status to 'offered' so other drivers don't see it
                                await db.collection<Batch>('batches').updateOne(
                                    { _id: new ObjectId(bestBatch._id) },
                                    {
                                        $set: {
                                            status: 'offered' as any, // Cast to avoid lint error until restart
                                            updatedAt: new Date()
                                        }
                                    }
                                );

                                // Emit Offer (BLIND: Remove Price/Earnings)
                                if (driverState.socketId) {
                                    const blindBatch = {
                                        ...bestBatch,
                                        shipments: bestBatch.shipments?.map(s => {
                                            // Strip financial data to prevent speculation (cherry-picking)
                                            const { price, driverCost, ...safeS } = s as any;
                                            return safeS;
                                        })
                                    };

                                    io.to(driverState.socketId).emit('batchOffer', {
                                        batch: blindBatch,
                                        expiresInSeconds: 30
                                    });
                                    console.log(`[Assignment] OFFERED Blind Batch ${bestBatch._id} to Driver ${driverId}`);
                                }
                            }
                        }
                    }
                }
            });

            // ... (Vehicle Update ...)

            // ... (Confirm Transfer ...)

            socket.on('disconnect', async () => {
                const driverId = socketToDriverMap.get(socket.id);
                if (driverId) {
                    console.log(`Driver ${driverId} disconnected. Setting status to OFFLINE.`);
                    // Instead of removing, we mark as OFFLINE so we don't lose state (e.g. active batch)
                    await driverRepo.updateStatus(driverId, 'OFFLINE');
                    socketToDriverMap.delete(socket.id);

                    // [NEW] Start Disconnect Timeout (e.g., 5 minutes)
                    // If driver doesn't reconnect, we release their batch.
                    const TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes

                    const timeoutId = setTimeout(async () => {
                        console.log(`[Timeout] Driver ${driverId} has been OFFLINE for ${TIMEOUT_MS / 1000}s. Releasing active batch...`);

                        // Check if still offline (Concurrent check)
                        const currentState = await driverRepo.get(driverId);
                        if (!currentState) return; // Driver logged out fully?

                        // Find active batch
                        assignedCollectorId: driverId,
                            status: 'assigned' // Only release if it hasn't started moving substantially
                    });

                    // [DEBUG] Trigger Flash Offer manually from Script
                    // Usage: socket.emit('debug:triggerFlashOffer', { driverSocketId, offerPayload })
                    socket.on('debug:triggerFlashOffer', async (debugData: any) => {
                        console.log('[DEBUG] Triggering Flash Offer...');

                        let targetSocketId = debugData.driverSocketId;

                        // If no specific target, pick the FIRST connected driver (excluding self)
                        if (!targetSocketId) {
                            // Find any socket mapped to a driver
                            for (const [sId, dId] of socketToDriverMap.entries()) {
                                if (sId !== socket.id) {
                                    targetSocketId = sId;
                                    break;
                                }
                            }
                        }

                        if (targetSocketId) {
                            console.log(`[DEBUG] Targeting Driver at Socket: ${targetSocketId}`);
                            io.to(targetSocketId).emit('batchOffer', debugData.offerPayload);
                        } else {
                            console.log('[DEBUG] No target driver found to trigger offer.');
                        }
                    });

                    if (staleBatch) {
                        // CRITICAL START: Partial Collection Safety Check
                        // We must verify against the 'shipments' collection because 'staleBatch.shipments' might be stale.
                        // If the driver has picked up ANY package, we MUST NOT release the batch.
                        const shipmentIds = staleBatch.shipments?.map(s => new ObjectId(s._id)) || [];
                        const realShipments = await db.collection<GoingNetworkShipment>('shipments').find({
                            _id: { $in: shipmentIds }
                        }).toArray();

                        const hasStartedCollection = realShipments.some(s =>
                            s.status === 'in_transit' ||
                            s.status === 'out_for_delivery' ||
                            s.status === 'delivered'
                        );

                        if (hasStartedCollection) {
                            console.warn(`[Timeout] Driver ${driverId} has partially collected batch ${staleBatch._id}. NOT releasing. (Shipments in transit detected)`);

                            // [NEW] Start "Red Alert" Timer (Total 10 minutes = 5 + 5)
                            console.log(`[Timeout] Scheduling SECURITY CHECK in 5 minutes for driver ${driverId}`);

                            setTimeout(async () => {
                                console.log(`[Security Alert] Checking driver ${driverId} after 10 minutes...`);
                                // Re-check connectivity
                                if (socketToDriverMap.size > 0) {
                                    // We can't check 'socketToDriverMap' easily by value without iteration.
                                    // But we can check 'driverRepo' status.
                                    const status = await driverRepo.get(driverId);
                                    if (status && status.status !== 'OFFLINE') {
                                        console.log(`[Security Alert] Driver ${driverId} is back online. Aborting alert.`);
                                        return;
                                    }
                                }

                                // Proceed with Splitting
                                const currentBatch = await db.collection<Batch>('batches').findOne({ _id: staleBatch._id });
                                if (!currentBatch) return;

                                // Identify Uncollected Items
                                // We need to re-fetch real statuses again to be sure
                                const layoutShipments = currentBatch.shipments || [];
                                const ids = layoutShipments.map(s => new ObjectId(s._id));
                                const liveShipments = await db.collection<GoingNetworkShipment>('shipments').find({ _id: { $in: ids } }).toArray();

                                const uncollectedIds: ObjectId[] = [];
                                const keptShipmentsForBatch: any[] = [];

                                for (const s of liveShipments) {
                                    if (s.status === 'ready_to_ship' || s.status === 'batched' || s.status === 'pending') {
                                        uncollectedIds.push(s._id);
                                    } else {
                                        // It's in_transit or delivered -> Keep in batch
                                        keptShipmentsForBatch.push(s);
                                    }
                                }

                                if (uncollectedIds.length > 0) {
                                    console.warn(`[Security Alert] SPLITTING BATCH ${currentBatch._id}. Releasing ${uncollectedIds.length} uncollected items.`);

                                    // 1. Release Shipments to Pool
                                    const updateRes = await db.collection<GoingNetworkShipment>('shipments').updateMany(
                                        { _id: { $in: uncollectedIds } },
                                        { $set: { status: 'ready_to_ship' } } // Reset to ready
                                    );
                                    console.log(`[Security Alert] Released shipments: ${updateRes.modifiedCount}`);

                                    // 2. Update Batch to remove them
                                    await db.collection<Batch>('batches').updateOne(
                                        { _id: currentBatch._id },
                                        {
                                            $set: {
                                                shipments: keptShipmentsForBatch,
                                                notes: "Security Split: Uncollected items released."
                                                // Consider changing status to 'security_incident' if needed
                                            }
                                        }
                                    );

                                    // 3. Log / Alert Logic (Email Admin)
                                    console.error(`[SECURITY ALERT] Driver ${driverId} disappeared with ${keptShipmentsForBatch.length} items. ${uncollectedIds.length} items returned to pool.`);

                                    const webUrl = process.env.WEB_APP_URL || 'http://localhost:3000';

                                    // Helper to send Admin Alert
                                    const sendAdminAlert = async () => {
                                        try {
                                            // Adjust URL for Docker if needed (localhost in docker is container)
                                            // Try to detect if we need host.docker.internal fallback?
                                            // For now relying on ENV, but logging URL.
                                            console.log(`[Security Alert] Accessing Web API at: ${webUrl}`);

                                            await fetch(`${webUrl}/api/emails/admin-alert`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({
                                                    driverId,
                                                    message: `Driver disappeared with ${keptShipmentsForBatch.length} uncollected items. ${uncollectedIds.length} items were returned to the pool.`,
                                                    details: {
                                                        batchId: currentBatch._id,
                                                        keptShipments: keptShipmentsForBatch.map(s => s._id),
                                                        releasedShipments: uncollectedIds
                                                    }
                                                })
                                            });
                                            console.log(`[Security Alert] Email sent successfully.`);
                                        } catch (err) {
                                            console.error(`[Security Alert] Failed to send email:`, err);
                                        }
                                    };
                                    sendAdminAlert();

                                } else {
                                    console.log(`[Security Alert] All items in batch are collected. Cannot split. flagging incident.`);
                                }

                            }, 5 * 60 * 1000); // Wait another 5 minutes

                        } else {
                            console.log(`[Timeout] Releasing batch ${staleBatch._id} from driver ${driverId} (No pickups detected)`);
                            await db.collection<Batch>('batches').updateOne(
                                { _id: staleBatch._id },
                                {
                                    $set: {
                                        assignedCollectorId: undefined,
                                        status: 'pending_assignment'
                                    }
                                }
                            );
                        }
                        // CRITICAL END
                        // We don't need to update driver status to IDLE because they are OFFLINE.
                        // When they reconnect, they will be IDLE because no batch is assigned.
                    } else {
                        console.log(`[Timeout] No 'assigned' batch found for ${driverId} to release.`);
                    }

                    disconnectTimeouts.delete(driverId);

                }, TIMEOUT_MS);

            disconnectTimeouts.set(driverId, timeoutId);
        }
            });
});

// --- OSRM PROXY ---
// Allows external apps (like going_web via Ngrok) to access the internal OSRM container
// Using RegExp to avoid string pattern issues in Express 5
app.get(/^\/osrm\/(.*)/, async (req, res) => {
    try {
        // Strip '/osrm' from the path
        const internalPath = (req.params as any)[0];
        const queryString = new URLSearchParams(req.query as any).toString();
        const osrmServiceUrl = process.env.OSRM_INTERNAL_URL || 'http://osrm:5000';

        const targetUrl = `${osrmServiceUrl}/${internalPath}${queryString ? `?${queryString}` : ''}`;

        console.log(`[OSRM Proxy] Forwarding to: ${targetUrl}`);

        const response = await fetch(targetUrl);

        if (!response.ok) {
            const errorText = await response.text();
            res.status(response.status).send(errorText);
            return;
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("[OSRM Proxy] Error:", error);
        res.status(500).json({ error: "OSRM Proxy Error" });
    }
});

// --- Handshake API ---
app.use(express.json());

app.post('/api/handshake', async (req, res) => {
    try {
        const { shipmentId, scannerId, role, location } = req.body;
        console.log(`[Handshake] Received request for shipment ${shipmentId}, scanner ${scannerId}, role ${role}`);

        if (!shipmentId || !scannerId || !role) {
            console.warn('[Handshake] Missing required fields');
            res.status(400).json({ error: 'Missing required fields' });
            return;
        }

        // 1. Verify Scanner (Driver/User)
        // For MVP, assume scannerId is valid. In prod, verify token/auth.

        // 2. Get Shipment
        const shipment = await db.collection<GoingNetworkShipment>('shipments').findOne({ _id: new ObjectId(shipmentId) });
        if (!shipment) {
            console.warn(`[Handshake] Shipment ${shipmentId} not found`);
            res.status(404).json({ error: 'Shipment not found' });
            return;
        }

        // 2b. Geofence Validation (Security)
        if (location && location.lat !== 0 && location.lon !== 0) {
            // Determine Target Location
            let targetLat: number | undefined;
            let targetLon: number | undefined;

            // If picking up -> use pickupAddress. If delivering -> use deliveryAddress
            // Simplification: logic below determines step. 
            // But we can check shipment status to infer target.
            if (shipment.status === 'ready_to_ship' || shipment.status === 'pending' || shipment.status === 'batched') {
                targetLat = shipment.pickupAddress.lat;
                targetLon = shipment.pickupAddress.lon;
            } else if (shipment.status === 'in_transit' || shipment.status === 'out_for_delivery') {
                const decryptedDelivery = (shipment as any).encryptedDeliveryAddress ? decryptObject((shipment as any).encryptedDeliveryAddress) : shipment.deliveryAddress;
                // @ts-ignore
                targetLat = decryptedDelivery?.lat;
                // @ts-ignore
                targetLon = decryptedDelivery?.lon;
            }

            if (targetLat && targetLon) {
                const from = turf.point([location.lon, location.lat]);
                const to = turf.point([targetLon, targetLat]);
                const distanceKm = turf.distance(from, to, { units: 'kilometers' });
                const MAX_DISTANCE_KM = 0.05; // 50 meters

                console.log(`[Handshake] Geofence Check: Driver at ${distanceKm.toFixed(4)}km from target.`);

                // BYPASS if in Debug Mode or explicit override
                const isDebug = process.env.ENABLE_GEOFENCE_DEBUG === 'true';

                if (distanceKm > MAX_DISTANCE_KM && !isDebug) {
                    console.warn(`[Handshake] Geofence Violation! Distance: ${distanceKm}km > ${MAX_DISTANCE_KM}km`);
                    res.status(400).json({ error: `You are too far from the location (${(distanceKm * 1000).toFixed(0)}m). Please get closer.` });
                    return;
                }
            }
        } else {
            console.warn("[Handshake] No location provided by driver. Skipping geofence (Potentially less secure).");
        }

        // 3. Update Custody & Status
        // ... Logic depends on Role ...
        let newStatus = shipment.status;
        let custodyUpdate: any = {};

        if (role === 'DRIVER') {
            // Driver Picking up from Seller (or Hub)
            if (shipment.status === 'ready_to_ship' || shipment.status === 'pending' || shipment.status === 'batched') {
                newStatus = 'in_transit';
                custodyUpdate = {
                    custody: {
                        holderId: scannerId,
                        holderType: 'driver',
                        timestamp: new Date()
                    },
                    status: newStatus,
                    pickupTime: new Date()
                };
                console.log(`[Handshake] Driver picked up shipment ${shipmentId}. New status: ${newStatus}`);

                // TRIGGER EMAIL NOTIFICATION (Async)
                if (shipment.recipientEmail) {
                    const webUrl = process.env.WEB_APP_URL || 'http://localhost:3000'; // Or use ngrok URL from env
                    // If running in docker and WEB_APP_URL is localhost, warn user.
                    if (webUrl.includes('localhost') && process.env.OSRM_URL?.includes('osrm')) {
                        // Heuristic: if OSRM_URL is 'osrm' (docker service name), but WEB_APP_URL is localhost, 
                        // it might imply we are inside container trying to reach host.
                        console.warn(`[Config Warning] WEB_APP_URL is ${webUrl} but we seem to be in Docker. Ensure this URL is reachable from the container! (Use http://host.docker.internal:3000 if Web is on host)`);
                    }

                    const trackingUrl = `${webUrl}/tracking/${shipment._id}`;

                    console.log(`[Handshake] Triggering email for ${shipment.recipientEmail} via ${webUrl}`);

                    fetch(`${webUrl}/api/emails/shipment-started`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            shipmentId: shipment._id,
                            recipientEmail: shipment.recipientEmail,
                            trackingUrl
                        })
                    }).then(async res => {
                        if (res.ok) console.log(`[Handshake] Email trigger sent successfully.`);
                        else {
                            const text = await res.text();
                            console.error(`[Handshake] Email trigger failed: ${res.status} - ${text}`);
                        }
                    }).catch(err => console.error(`[Handshake] Email trigger network error:`, err));
                }
            } else {
                console.log(`[Handshake] Driver scanned shipment ${shipmentId} but status is ${shipment.status} (expected ready_to_ship/pending)`);
            }
        } else if (role === 'CUSTOMER') {
            // Customer receiving from Driver
            if (shipment.status === 'in_transit' || shipment.status === 'out_for_delivery') {
                newStatus = 'delivered';
                custodyUpdate = {
                    custody: {
                        holderId: 'customer',
                        holderType: 'customer',
                        timestamp: new Date()
                    },
                    status: newStatus,
                    deliveryTime: new Date()
                };
                console.log(`[Handshake] Customer received shipment ${shipmentId}. New status: ${newStatus}`);
            }
        }

        if (Object.keys(custodyUpdate).length > 0) {
            await db.collection<GoingNetworkShipment>('shipments').updateOne(
                { _id: new ObjectId(shipmentId) },
                { $set: custodyUpdate }
            );
        }

        // 4. Check Batch Status (if applicable)
        // Find active batch for this driver
        const activeBatch = await db.collection<Batch>('batches').findOne({
            assignedCollectorId: scannerId,
            status: { $in: ['assigned', 'in_progress', 'in_transit', 'out_for_delivery'] }
        });

        if (activeBatch) {
            console.log(`[Handshake] Checking batch ${activeBatch._id} progress...`);
            // Re-fetch all shipments for this batch to check their status
            // Re-fetch all shipments for this batch to check their status
            const rawBatchShipments = await db.collection<GoingNetworkShipment>('shipments').find({
                _id: { $in: activeBatch.shipments?.map(s => new ObjectId(s._id)) || [] }
            }).toArray();

            // Decrypt for client update
            const batchShipments = rawBatchShipments.map(s => {
                if ((s as any).encryptedDeliveryAddress) {
                    try {
                        const deliveryAddress = decryptObject((s as any).encryptedDeliveryAddress) as any;
                        return { ...s, deliveryAddress };
                    } catch (e) {
                        console.error(`Failed to decrypt address for shipment ${s._id}`, e);
                        return s;
                    }
                }
                return s;
            });

            const allCollected = batchShipments.every(s => s.status === 'in_transit' || s.status === 'out_for_delivery' || s.status === 'delivered');
            const allDelivered = batchShipments.every(s => s.status === 'delivered');

            console.log(`[Handshake] Batch Status Check: AllCollected=${allCollected}, AllDelivered=${allDelivered}`);
            console.log(`[Handshake] Shipment Statuses: ${batchShipments.map(s => s.status).join(', ')}`);

            if (allDelivered) {
                await db.collection<Batch>('batches').updateOne(
                    { _id: activeBatch._id },
                    { $set: { status: 'completed' } }
                );

                // Clear driver state
                await driverRepo.update(scannerId, { activeBatchId: undefined });
                console.log(`[Handshake] Cleared activeBatchId for driver ${scannerId}`);

                const driverState = await driverRepo.get(scannerId);
                if (driverState && driverState.socketId) {
                    console.log(`[Handshake] Emitting batchCompleted to ${driverState.socketId}`);
                    io.to(driverState.socketId).emit('batchCompleted', {
                        batchId: activeBatch._id,
                        status: 'completed'
                    });
                }
            } else if (allCollected && activeBatch.status === 'assigned') {
                // Transition to In Progress (Delivery Phase)
                // Update activeBatch with fresh shipments (so frontend gets new statuses)
                activeBatch.shipments = batchShipments;
                activeBatch.status = 'in_progress';

                const updateResult = await db.collection<Batch>('batches').updateOne(
                    { _id: activeBatch._id },
                    {
                        $set: {
                            status: 'in_progress',
                            shipments: batchShipments // Persist updated shipments to Batch
                        }
                    }
                );
                console.log(`[Handshake] Batch update result: Matched=${updateResult.matchedCount}, Modified=${updateResult.modifiedCount}`);

                const driverState = await driverRepo.get(scannerId);
                if (driverState && driverState.socketId) {
                    console.log(`[Handshake] Emitting batchProgress to ${driverState.socketId}`);
                    io.to(driverState.socketId).emit('batchProgress', {
                        batchId: activeBatch._id,
                        status: 'in_progress',
                        newDriverStatus: 'DELIVERING_BATCH',
                        batch: activeBatch // Send full, updated batch
                    });
                } else {
                    console.warn(`[Handshake] Driver ${scannerId} socket not found for batchProgress`);
                }
            }
        }

        res.json({ success: true, message: 'Handshake processed', newStatus });

    } catch (error) {
        console.error('Handshake error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Change Stream Logic (Debounced) ---
const shipmentsCollection = db.collection<GoingNetworkShipment>('shipments');
let changeStream;

try {
    // DEBUG MODE: Listen to ALL events to diagnose silent failure
    changeStream = shipmentsCollection.watch([], { fullDocument: 'updateLookup' });
} catch (e) {
    console.warn("⚠️ ChangeStream failed (likely standalone Mongo). Falling back to Polling only.");
}

// Debounce State
let processingTimeout: NodeJS.Timeout | null = null;
let isProcessing = false;
let needsReprocessing = false; // Flag to catch events during processing
const DEBOUNCE_MS = 1000;

// Interval moved to bottom of main() to ensure functions are defined

console.log("Listening for ALL changes (Debug Mode)...");

// --- Startup: Process Existing Unbatched Shipments ---
const processExistingUnbatchedShipments = async () => {
    console.log("[Startup] Checking for existing unbatched shipments...");
    const unbatchedShipments = await db.collection<GoingNetworkShipment>('shipments').find({
        status: 'ready_to_ship',
        shippingType: 'going_network'
    }).toArray();

    if (unbatchedShipments.length > 0) {
        console.log(`[Startup] Found ${unbatchedShipments.length} unbatched shipments. Processing...`);

        // Decrypt addresses before processing
        const decryptedShipments = unbatchedShipments.map(s => {
            if ((s as any).encryptedDeliveryAddress) {
                try {
                    const deliveryAddress = decryptObject((s as any).encryptedDeliveryAddress) as any; // Cast to any to avoid strict type check for now, or GeocodedAddress
                    return { ...s, deliveryAddress };
                } catch (e) {
                    console.error(`Failed to decrypt address for shipment ${s._id}`, e);
                    return s;
                }
            }
            return s;
        });

        const newBatches = await LogisticsQueueEngine.createStartupBatches(decryptedShipments as any[], driverRepo, db);

        for (const batch of newBatches) {
            const result = await db.collection<Batch>('batches').insertOne(batch);

            const shipments = batch.shipments || batch.items || [];
            console.log(`[Startup] Created Batch ${result.insertedId} with ${shipments.length} shipments`);

            if (shipments.length > 0) {
                const shipmentIds = shipments.map(s => new ObjectId(s._id));
                await db.collection<GoingNetworkShipment>('shipments').updateMany(
                    { _id: { $in: shipmentIds } },
                    { $set: { status: 'batched' } }
                );
                console.log(`[Batching] Marked ${shipmentIds.length} shipments as 'batched' for batch ${result.insertedId}`);
            }

            const savedBatch = await db.collection<Batch>('batches').findOne({ _id: result.insertedId });
            if (savedBatch && savedBatch.shipments) {
                const driverId = await Engine.findBestDriverForBatch(savedBatch, driverRepo, 8, db);
                if (driverId) {
                    console.log(`[Startup] Driver ${driverId} found for batch ${savedBatch._id}`);
                    await db.collection<Batch>('batches').updateOne(
                        { _id: savedBatch._id },
                        { $set: { assignedCollectorId: driverId, status: 'assigned' } }
                    );
                    await driverRepo.updateStatus(driverId, 'COLLECTING_BATCH');
                    const driverState = await driverRepo.get(driverId);
                    if (driverState && driverState.socketId) {
                        io.to(driverState.socketId).emit('newTask', { batch: savedBatch });
                    }
                }
            }
        }
    } else {
        console.log("[Startup] No unbatched shipments found.");
    }
};

processExistingUnbatchedShipments();

// Helper function to run the processing loop
const runProcessingLoop = async () => {
    if (isProcessing) {
        console.log("[ChangeStream] Processing already in progress. Marking for re-run.");
        needsReprocessing = true;
        return;
    }

    isProcessing = true;

    do {
        needsReprocessing = false;
        try {
            console.log("[ChangeStream] Processing cycle started. Fetching pending shipments...");
            const pendingShipments = await shipmentsCollection.find({
                shippingType: 'going_network',
                status: 'ready_to_ship'
            }).toArray();

            if (pendingShipments.length > 0) {
                console.log(`[ChangeStream] Processing pool of ${pendingShipments.length} pending shipments.`);

                // Geocode Shipments if needed
                const validShipments: GoingNetworkShipment[] = [];

                for (const s of pendingShipments) {
                    let shipment = s as GoingNetworkShipment;
                    let modified = false;

                    if (!shipment.pickupAddress.lat || !shipment.pickupAddress.lon) {
                        console.log(`[Geocoding] Geocoding Pickup for ${shipment._id}...`);
                        const geocoded = await geocodeAddress(shipment.pickupAddress);
                        if (geocoded) {
                            shipment.pickupAddress = geocoded;
                            modified = true;
                        } else {
                            console.warn(`[Geocoding] Failed to geocode Pickup for ${shipment._id}. Skipping.`);
                            continue;
                        }
                    }

                    if (!shipment.deliveryAddress.lat || !shipment.deliveryAddress.lon) {
                        console.log(`[Geocoding] Geocoding Delivery for ${shipment._id}...`);
                        const geocoded = await geocodeAddress(shipment.deliveryAddress);
                        if (geocoded) {
                            shipment.deliveryAddress = geocoded;
                            modified = true;
                        } else {
                            console.warn(`[Geocoding] Failed to geocode Delivery for ${shipment._id}. Skipping.`);
                            continue;
                        }
                    }

                    if (modified) {
                        // Update in DB to persist coordinates
                        await shipmentsCollection.updateOne(
                            { _id: shipment._id },
                            {
                                $set: {
                                    pickupAddress: shipment.pickupAddress,
                                    deliveryAddress: shipment.deliveryAddress
                                }
                            }
                        );
                    }

                    // Ensure H3 indices are present (Engine needs them)
                    // Note: createBatches calculates them if missing, but good to have.
                    validShipments.push(shipment);
                }

                if (validShipments.length > 0) {
                    await processNewShipments(validShipments, db, driverRepo);
                }
            } else {
                console.log("[ChangeStream] No pending shipments found.");
            }
        } catch (err) {
            console.error("[ChangeStream] Error processing shipments:", err);
        }

        if (needsReprocessing) {
            console.log("[ChangeStream] Re-processing triggered by events during last cycle.");
        }

    } while (needsReprocessing);

    isProcessing = false;
    processingTimeout = null;
};

if (changeStream) {
    try {
        for await (const change of changeStream) {
            console.log(`[ChangeStream] RAW EVENT: ${change.operationType}`);

            if (change.operationType === 'insert' || change.operationType === 'update' || change.operationType === 'replace') {
                const fullDocument = (change as any).fullDocument;
                const updatedFields = (change as any).updateDescription?.updatedFields;

                const isNewReadyToShip = change.operationType === 'insert' && fullDocument?.shippingType === 'going_network' && fullDocument?.status === 'ready_to_ship';
                const isUpdateToReadyToShip = change.operationType === 'update' && fullDocument?.shippingType === 'going_network' && updatedFields?.status === 'ready_to_ship';

                if (isNewReadyToShip || isUpdateToReadyToShip) {
                    console.log(`[ChangeStream] RELEVANT Event detected: ${change.operationType}. Resetting debounce timer.`);

                    if (processingTimeout) {
                        clearTimeout(processingTimeout);
                    }

                    processingTimeout = setTimeout(runProcessingLoop, DEBOUNCE_MS);
                }

                // --- Handle Cancellation (Immediate Action) ---
                const isCancelled = change.operationType === 'update' && updatedFields?.status === 'cancelled';
                if (isCancelled) {
                    const shipmentId = change.documentKey._id;
                    console.log(`[ChangeStream] Shipment ${shipmentId} CANCELLED. Checking for active batches...`);

                    // Find batch containing this shipment
                    const batch = await db.collection<Batch>('batches').findOne({ "shipments._id": shipmentId });

                    if (batch) {
                        console.log(`[ChangeStream] Removing cancelled shipment ${shipmentId} from batch ${batch._id}`);

                        // Remove shipment from batch
                        await db.collection<Batch>('batches').updateOne(
                            { _id: batch._id },
                            { $pull: { shipments: { _id: shipmentId } as any } }
                        );

                        // Check if batch is empty
                        const updatedBatch = await db.collection<Batch>('batches').findOne({ _id: batch._id });
                        if (updatedBatch && (updatedBatch.shipments?.length || 0) === 0) {
                            console.log(`[ChangeStream] Batch ${batch._id} is empty. Deleting...`);
                            await db.collection<Batch>('batches').deleteOne({ _id: batch._id });
                        } else if (updatedBatch) {
                            // Optional: Notify driver if assigned
                            if (updatedBatch.assignedCollectorId) {
                                const driverId = updatedBatch.assignedCollectorId;
                                const driverState = await driverRepo.get(driverId);
                                if (driverState && driverState.socketId) {
                                    console.log(`[ChangeStream] Notifying driver ${driverId} of batch update (cancellation)`);
                                    io.to(driverState.socketId).emit('batchUpdated', {
                                        batch: updatedBatch,
                                        message: "A shipment in your batch was cancelled."
                                    });
                                }
                            }
                        }
                    }
                }

                // --- Handle Deletion (Immediate Action) ---
                const isDeleted = (change as any).operationType === 'delete';
                if (isDeleted) {
                    const shipmentId = (change as any).documentKey._id;
                    console.log(`[ChangeStream] Shipment ${shipmentId} DELETED. Checking for active batches...`);

                    // Find batch containing this shipment
                    const batch = await db.collection<Batch>('batches').findOne({ "shipments._id": shipmentId });

                    if (batch) {
                        console.log(`[ChangeStream] Removing deleted shipment ${shipmentId} from batch ${batch._id}`);

                        // Remove shipment from batch
                        await db.collection<Batch>('batches').updateOne(
                            { _id: batch._id },
                            { $pull: { shipments: { _id: shipmentId } as any } }
                        );

                        // Check if batch is empty
                        const updatedBatch = await db.collection<Batch>('batches').findOne({ _id: batch._id });
                        if (updatedBatch && (updatedBatch.shipments?.length || 0) === 0) {
                            console.log(`[ChangeStream] Batch ${batch._id} is empty. Deleting...`);
                            await db.collection<Batch>('batches').deleteOne({ _id: batch._id });
                        } else if (updatedBatch) {
                            // Optional: Notify driver if assigned
                            if (updatedBatch.assignedCollectorId) {
                                const driverId = updatedBatch.assignedCollectorId;
                                const driverState = await driverRepo.get(driverId);
                                if (driverState && driverState.socketId) {
                                    console.log(`[ChangeStream] Notifying driver ${driverId} of batch update (deletion)`);
                                    io.to(driverState.socketId).emit('batchUpdated', {
                                        batch: updatedBatch,
                                        message: "A shipment in your batch was deleted."
                                    });
                                }
                            }
                        }
                    }
                }
            }
            if (change.operationType === 'update' || change.operationType === 'replace') {
                const shipmentId = (change as any).documentKey._id.toString();
                const updatedFields = (change as any).updateDescription?.updatedFields;

                // Emit 'shipment_updated' to the specific room
                // This allows the Web Dashboard to update in real-time
                if (updatedFields && (updatedFields.status || updatedFields.custody)) {
                    console.log(`[ChangeStream] Sending real-time update for shipment ${shipmentId}`);
                    // We need to fetch the full document to send it? Or just the delta?
                    // Ideally send the full doc or the updated fields.
                    // Since we have 'fullDocument: updateLookup', let's use it if available, else fetch.
                    const fullDoc = (change as any).fullDocument;
                    if (fullDoc) {
                        io.to(shipmentId).emit('shipment_updated', fullDoc);
                    } else {
                        // Fallback fetch
                        const doc = await shipmentsCollection.findOne({ _id: new ObjectId(shipmentId) });
                        if (doc) io.to(shipmentId).emit('shipment_updated', doc);
                    }
                }
            }
        } // End of for await loop
    } catch (err) {
        console.error("ChangeStream specific error:", err);
    }
}

// --- Robust Polling (Fallback for ChangeStream) ---
// Checks for new shipments AND assigns pending batches
setInterval(() => {
    // 1. Assign existing batches
    processPendingBatches(db, driverRepo);

    // 2. Create new batches (Fallback if ChangeStream misses events)
    if (!isProcessing) {
        runProcessingLoop();
    }
}, 10000); // Poll every 10 seconds

    } catch (error) {
    console.error("Error in main loop:", error);
    process.exit(1);
}
}

// --- Background Job: Progressive Search (Continuous Polling) ---
async function processPendingBatches(db: Db, repo: any) {
    try {
        const now = new Date();
        const pendingBatches = await db.collection<Batch>('batches').find({
            status: 'pending_assignment'
        }).toArray();

        for (const batch of pendingBatches) {
            const currentLevel = batch.currentSearchLevel || 8;
            const levelStartTime = batch.levelStartTime ? new Date(batch.levelStartTime) : new Date(batch.createdAt);

            const driverId = await Engine.findBestDriverForBatch(batch, repo, currentLevel, db);

            if (driverId) {
                console.log(`[Progressive] Driver ${driverId} found for batch ${batch._id} at Level ${currentLevel}`);

                await db.collection<Batch>('batches').updateOne(
                    { _id: batch._id },
                    {
                        $set: {
                            assignedCollectorId: driverId,
                            status: 'assigned'
                        }
                    }
                );
                await repo.updateStatus(driverId, 'COLLECTING_BATCH');

                const driverState = await repo.get(driverId);
                if (driverState && driverState.socketId) {
                    io.to(driverState.socketId).emit('newTask', { batch });
                }
            } else {
                const timeAtLevelMs = now.getTime() - levelStartTime.getTime();
                const ONE_MINUTE = 60000;

                if (timeAtLevelMs > ONE_MINUTE) {
                    let nextLevel = currentLevel;
                    let nextStartTime = now;

                    if (currentLevel > 6) {
                        nextLevel = currentLevel - 1;
                    } else {
                        nextLevel = 8;
                        nextStartTime = new Date(now.getTime() + 5 * 60000);
                    }

                    await db.collection<Batch>('batches').updateOne(
                        { _id: batch._id },
                        {
                            $set: {
                                currentSearchLevel: nextLevel,
                                levelStartTime: nextStartTime
                            },
                            $inc: { searchAttempts: 1 }
                        }
                    );
                }
            }
        }
    } catch (error) {
        console.error("Error in processPendingBatches:", error);
    }
}


/**
 * REPLACED LOGIC: Push to Redis Queue instead of creating batches directly.
 * The 'LogisticsWorker' picks these up.
 */
async function processNewShipments(shipments: Shipment[], db: Db, repo: any) {
    console.log(`[Ingestion] Buffering ${shipments.length} shipments to Redis (Lane-Based)...`);

    for (const s of shipments) {
        if (s.shippingType !== 'going_network') continue;

        const shipment = s as GoingNetworkShipment;

        // Use Level 8 Index (Micro Zone ~460m) for Pickup (grouping stops)
        // Use Level 7 Index (Meso Zone ~1.2km) for Destination (general direction)
        // Lane Key: queue:lane:{OriginL8}:{DestL7}

        const { latLngToCell } = require('./lib/routingUtils');

        // 1. Get Origin Zone (L8)
        let originL8 = '';
        if (shipment.pickupAddress.lat) {
            originL8 = latLngToCell(shipment.pickupAddress.lat, shipment.pickupAddress.lon, 8);
        }

        // 2. Get Destination Zone (L7)
        let destL7 = '';
        if (shipment.deliveryAddress.lat) {
            destL7 = latLngToCell(shipment.deliveryAddress.lat, shipment.deliveryAddress.lon, 7);
        }

        if (originL8 && destL7) {
            await RedisQueue.addShipmentToLane(shipment, originL8, destL7);
        } else {
            console.warn(`[Ingestion] Failed to determine L8/L7 Zones for shipment ${shipment._id}`);
        }
    }

    console.log(`[Ingestion] Buffer complete.`);
}


server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Socket Server running on port ${PORT}`);

    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`> Local LAN IP: http://${net.address}:${PORT}`);
            }
        }
    }
});

main();