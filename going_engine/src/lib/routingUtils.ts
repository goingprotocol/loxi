import { CartItem, Vehicle, Coordinate } from '../interfaces';
import * as h3 from 'h3-js';

// Export wrappers
export const latLngToCell = h3.latLngToCell;
export const cellToLatLng = h3.cellToLatLng;
export const greatCircleDistance = h3.greatCircleDistance;
export const gridDistance = h3.gridDistance;
export const gridDisk = h3.gridDisk;

export const H3_RESOLUTION_MICRO = 8;
export const H3_RESOLUTION_MACRO = 6;

export const calculateTotalWeight = (items: CartItem[]): number => {
    return items.reduce((sum, item) => sum + (item.weight_kg || 0) * item.quantity, 0);
};

export const calculateTotalVolume = (items: CartItem[]): number => {
    return items.reduce((sum, item) => {
        if (item.volume_m3 && item.volume_m3 > 0) {
            return sum + (item.volume_m3 * item.quantity);
        }
        // Volume in m3. Dimensions are in cm.
        // If dimensions are missing, assume a small default (e.g., 10x10x10 cm = 0.001 m3)
        const w = item.width_cm || 10;
        const h = item.height_cm || 10;
        const d = item.depth_cm || 10;
        const volumeM3 = (w * h * d) / 1_000_000;
        return sum + (volumeM3 * item.quantity);
    }, 0);
};

// --- 1. Definición de Perfiles de Vehículos (Hardcoded para MVP) ---
const VEHICLE_SPECS: Record<string, any> = {
    'motorcycle': {
        max_weight_kg: 25,
        max_len_cm: 45, max_width_cm: 45, max_height_cm: 45,
        volume_m3: 0.08,
        width_between_wells_cm: 0
    },
    'van_small': { // Kangoo, Partner, Fiorino
        max_weight_kg: 600,
        max_len_cm: 160, max_width_cm: 140, max_height_cm: 115,
        volume_m3: 2.3,
        width_between_wells_cm: 110
    },
    'pickup': { // Hilux, Amarok (Sin cúpula)
        max_weight_kg: 900,
        max_len_cm: 150, max_width_cm: 150, max_height_cm: 50,
        volume_m3: 1.1,
        width_between_wells_cm: 105
    },
    'van_mid': { // Trafic, Vito
        max_weight_kg: 1000,
        max_len_cm: 230, max_width_cm: 160, max_height_cm: 135,
        volume_m3: 4.8,
        width_between_wells_cm: 120
    }
};

export const calculateVolumetricWeight = (items: CartItem[]): number => {
    return items.reduce((sum, item) => {
        const w = item.width_cm || 10;
        const h = item.height_cm || 10;
        const d = item.depth_cm || 10;
        const volWeight = (w * h * d) / 5000;
        return sum + (volWeight * item.quantity);
    }, 0);
};

export const determineRequiredVehicleType = (
    weightKg: number,
    volumeM3: number,
    distanceHops: number = 0
): 'bicycle' | 'motorcycle' | 'van' => {
    // Simplified logic for quick routing
    if (weightKg <= 25 && volumeM3 <= 0.08) return 'motorcycle';
    return 'van';
};

export const canVehicleCarryBatch = (
    vehicle: Vehicle,
    batchWeight?: number, // Legacy param kept for compat, but we prefer items check
    batchVolume?: number, // Legacy param
    items: CartItem[] = []
): boolean => {
    // 1. Fallback to Simple Check if no Items provided (Legacy Compatibility)
    if (items.length === 0) {
        const maxWeight = (vehicle as any).maxWeightKg || (vehicle as any).max_payload_kg || 0;
        const maxVolume = (vehicle as any).maxVolumeM3 || (vehicle as any).max_volume_m3 || 0;
        return (batchWeight || 0) <= maxWeight && (batchVolume || 0) <= maxVolume;
    }

    // 2. INDUSTRIAL CHECK (With Dimensions & GNC)
    let type = (vehicle as any).type || 'van';
    if (type === 'car') type = 'van_small'; // Map generic car to small van

    let specs = VEHICLE_SPECS[type];
    if (!specs) specs = VEHICLE_SPECS['van_small'];

    // A. AJUSTE POR GNC (Assuming vehicle object has this flag, else false)
    const hasGNC = (vehicle as any).hasGNC || false;
    let currentMaxLen = specs.max_len_cm;
    let currentVol = specs.volume_m3;

    if (hasGNC && type !== 'motorcycle') {
        currentMaxLen -= 45;
        currentVol *= 0.75;
    }

    // B. FILTRO DIMENSIONAL
    for (const item of items) {
        const iLen = item.depth_cm || 0;
        const iWidth = item.width_cm || 0;
        const iHeight = item.height_cm || 0;

        if (iLen > currentMaxLen) return false; // Too Long
        if (iHeight > specs.max_height_cm) return false; // Too Tall

        // Width logic (Wheel wells)
        if (specs.width_between_wells_cm > 0 && iWidth > specs.width_between_wells_cm) {
            if (iWidth > specs.max_width_cm) return false; // Too Wide for box
            // If between wells and max, assume it rests on top (accepted for now)
        }
    }

    // C. FILTRO POR PESO & VOLUMEN (Mayor exigencia)
    const totalWeight = calculateTotalWeight(items);
    if (totalWeight > specs.max_weight_kg) return false;

    const volWeight = calculateVolumetricWeight(items);
    const totalVol = calculateTotalVolume(items);

    if (totalVol > currentVol) return false;

    // Optional: Check volumetric weight against payload? 
    // Usually carriers charge by volWeight but physical constraint is volume.
    // We stick to volume physical constraint here.

    return true;
};

export const areCellsNeighbors = (h3IndexA: string, h3IndexB: string): boolean => {
    if (h3IndexA === h3IndexB) return true;
    const disk = gridDisk(h3IndexA, 1);
    return disk.includes(h3IndexB);
};

export const calculateTripDistanceHops = (pickup: Coordinate, delivery: Coordinate): number => {
    const startCell = latLngToCell(pickup.lat, pickup.lon, H3_RESOLUTION_MICRO);
    const endCell = latLngToCell(delivery.lat, delivery.lon, H3_RESOLUTION_MICRO);
    return gridDistance(startCell, endCell);
};

export const calculateTripDistanceKm = (pickup: Coordinate, delivery: Coordinate): number => {
    return greatCircleDistance(
        [pickup.lat, pickup.lon],
        [delivery.lat, delivery.lon],
        'km'
    );
};

export const calculateRouteDistanceHops = (start: Coordinate, end: Coordinate): number => {
    const startCell = latLngToCell(start.lat, start.lon, H3_RESOLUTION_MICRO);
    const endCell = latLngToCell(end.lat, end.lon, H3_RESOLUTION_MICRO);
    return gridDistance(startCell, endCell);
};

export const getNextCellTowardsDestination = (currentH3: string, destLat: number, destLon: number): string => {
    const { cellToLatLng } = require('h3-js'); // Ensure h3-js is available
    const neighbors = gridDisk(currentH3, 1);

    let bestCell = currentH3;
    let minDistance = Infinity;

    for (const cell of neighbors) {
        if (cell === currentH3) continue; // Skip current cell

        const [lat, lon] = cellToLatLng(cell);
        const dist = greatCircleDistance([lat, lon], [destLat, destLon], 'km');

        if (dist < minDistance) {
            minDistance = dist;
            bestCell = cell;
        }
    }

    return bestCell;
};

import axios from 'axios';

export const optimizeRouteOSRM = async (
    start: Coordinate,
    points: Coordinate[],
    options: { source?: 'first' | 'any', destination?: 'last' | 'any', roundtrip?: boolean, timeout?: number } = { source: 'first', roundtrip: false, timeout: 3000 }
): Promise<{ sortedIndices: number[], totalDistance: number, totalDuration: number }> => {
    if (points.length === 0) return { sortedIndices: [], totalDistance: 0, totalDuration: 0 };

    // Construct coordinates string
    // If destination=last, we expect the LAST point in 'allCoords' to be the fixed destination.
    // The caller must arrange 'allCoords' accordingly.

    // Standardize input:
    // If source=first, 'start' is the fixed start.
    // If destination=last, 'start' (which is usually the Hub in our current logic) should be moved to the END.

    let allCoords: Coordinate[];
    let queryParams = '';
    const roundtrip = options.roundtrip ? 'true' : 'false';

    if (options.destination === 'last') {
        // For Collection: points (Pickups) -> start (Hub)
        // We want OSRM to optimize the Pickups to end at Hub.
        allCoords = [...points, start];
        queryParams = `destination=last&source=${options.source || 'any'}&roundtrip=${roundtrip}`;
    } else {
        // Default (Distribution): start (Hub) -> points (Deliveries)
        allCoords = [start, ...points];
        queryParams = `source=${options.source || 'first'}&roundtrip=${roundtrip}`;
    }

    const coordsString = allCoords.map(c => `${c.lon},${c.lat}`).join(';');
    const baseUrl = process.env.OSRM_URL || 'http://router.project-osrm.org';
    const url = `${baseUrl}/trip/v1/driving/${coordsString}?${queryParams}`;

    try {
        // console.log(`[OSRM] Requesting optimization for ${allCoords.length} points...`);
        const response = await axios.get(url, { timeout: options.timeout || 3000 }); // Configurable Timeout

        if (response.data.code !== 'Ok') {
            console.error('[OSRM] Error:', response.data.code);
            throw new Error(`OSRM API Error: ${response.data.code}`);
        }

        const waypoints = response.data.waypoints;
        const trips = response.data.trips;

        // trips[0] contains the summary of the route
        const totalDistance = trips[0]?.distance || 0; // Meters
        const totalDuration = trips[0]?.duration || 0; // Seconds

        const sortedIndices: number[] = [];

        for (const wp of waypoints) {
            const originalIndex = wp.waypoint_index;
            if (originalIndex === 0) continue; // Skip start point
            sortedIndices.push(originalIndex - 1); // Adjust to 0-based index for 'points' array
        }

        return { sortedIndices, totalDistance, totalDuration };

    } catch (error) {
        console.warn('[OSRM] Request failed or timed out. Using Haversine Fallback.');

        // Fallback: Calculate Straight Line Distance for the sequence
        // We don't optimize the order in fallback (too complex for now), just assume input order.
        // Or better: Assume input order is [P0, P1, ...].
        // Total Distance = Start -> P0 -> P1 ... -> End (if dest=last)

        // For simplicity in fallback:
        // 1. Calculate distance from Start to P0
        // 2. P0 to P1...
        // 3. Last P to Start (if roundtrip) or Last P (if not)

        // Actually, the caller expects 'sortedIndices'. We'll return 0..N.

        let estimatedDistance = 0;
        let current = start;

        // Estimate path through points in provided order
        for (const p of points) {
            estimatedDistance += calculateTripDistanceKm(current, p) * 1000; // Convert to meters
            current = p;
        }

        if (options.roundtrip) {
            estimatedDistance += calculateTripDistanceKm(current, start) * 1000;
        }

        // Apply Tortuosity Factor (1.3x for urban)
        estimatedDistance = estimatedDistance * 1.3;

        // Estimate duration: 20km/h avg speed in city = 5.5 m/s
        const estimatedDuration = estimatedDistance / 5.5;

        return {
            sortedIndices: points.map((_, i) => i),
            totalDistance: estimatedDistance,
            totalDuration: estimatedDuration
        };
    }
};

/**
 * Fetch OSRM Table (Matrix) to get driving durations from a source to multiple destinations.
 * Used for the "Funnel Filter" to select the best neighbor based on real driving time.
 */
export const getOSRMTable = async (
    source: Coordinate,
    destinations: Coordinate[],
    timeout: number = 3000
): Promise<number[]> => {
    if (destinations.length === 0) return [];

    // OSRM Table API format: /table/v1/driving/{lon},{lat};{lon},{lat};...?sources=0&destinations=1;2;3...
    // Index 0 is the source. Indices 1..N are destinations.

    const allCoords = [source, ...destinations];
    const coordsString = allCoords.map(c => `${c.lon},${c.lat}`).join(';');

    // sources=0 (only the first point is a source)
    // destinations=1;2;3... (all other points are destinations)
    const destIndices = destinations.map((_, i) => i + 1).join(';');
    const baseUrl = process.env.OSRM_URL || 'http://router.project-osrm.org';
    const url = `${baseUrl}/table/v1/driving/${coordsString}?sources=0&destinations=${destIndices}`;

    try {
        // console.log(`[OSRM Table] Requesting matrix for 1 source -> ${destinations.length} destinations`);
        const response = await axios.get(url, { timeout });

        if (response.data.code !== 'Ok') {
            console.error('[OSRM Table] Error:', response.data.code);
            throw new Error(`OSRM API Error: ${response.data.code}`);
        }

        // response.data.durations is a 2D array [source_index][dest_index]
        // Since we have 1 source, it's durations[0] which is an array of durations to each destination.
        const durations: number[] = response.data.durations[0];

        return durations; // Array of durations in seconds

    } catch (error) {
        console.warn('[OSRM Table] Request failed or timed out. Returning empty array (fallback will be used).');
        return [];
    }
};

/**
 * Fetches an N x N duration matrix for a set of points.
 */
export const getOSRMSquareMatrix = async (
    points: Coordinate[],
    timeout: number = 5000
): Promise<number[][]> => {
    if (points.length === 0) return [];
    if (points.length === 1) return [[0]];

    const coordsString = points.map(c => `${c.lon},${c.lat}`).join(';');
    const baseUrl = process.env.OSRM_URL || 'http://router.project-osrm.org';
    // No source/dest filters = Square Matrix
    const url = `${baseUrl}/table/v1/driving/${coordsString}`;

    try {
        const response = await axios.get(url, { timeout });
        if (response.data.code !== 'Ok') throw new Error(response.data.code);
        return response.data.durations; // N x N array
    } catch (e) {
        console.error('[OSRM Square] Failed', e);
        // Fallback: Euclidean Matrix (in seconds approximation)
        const size = points.length;
        const matrix: number[][] = Array(size).fill(0).map(() => Array(size).fill(0));
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                if (i === j) continue;
                // Approx 5.5 m/s speed
                const km = calculateTripDistanceKm(points[i], points[j]);
                matrix[i][j] = (km * 1000) / 5.5;
            }
        }
        return matrix;
    }
};

/**
 * Calculates the "Coupled LIFO Matrix" for VROOM.
 * Cost(i, j) = Travel(Pick_i -> Pick_j) + Travel(Drop_j -> Drop_i)
 * This forces VROOM to minimize the loop assuming Last-In-First-Out processing.
 */
export const calculateLifoMatrix = async (
    shipments: import('../interfaces').Shipment[]
): Promise<number[][]> => {
    const size = shipments.length;
    if (size === 0) return [];

    console.log(`[LIFO] Calculating Coupled Matrix for ${size} shipments...`);

    const pickups = shipments.map(s => s.pickupAddress);
    const deliveries = shipments.map(s => s.deliveryAddress);

    // Parallel fetch
    const [pickMatrix, dropMatrix] = await Promise.all([
        getOSRMSquareMatrix(pickups),
        getOSRMSquareMatrix(deliveries)
    ]);

    const coupledMatrix: number[][] = Array(size).fill(0).map(() => Array(size).fill(0));

    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (i === j) {
                coupledMatrix[i][j] = 0;
                continue;
            }
            // Cost = Time(Pick i->j) + Time(Drop j->i)
            // Note indices on Drop Matrix: [j][i] because we go backwards in the drop sequence
            coupledMatrix[i][j] = pickMatrix[i][j] + dropMatrix[j][i];
        }
    }

    return coupledMatrix;
};

/**
 * Augments a Cost Matrix with a "Virtual Start Node" (Ghost Node).
 * - Appends a Row (N) and Column (N).
 * - Cost(Ghost -> Any) = 0 (Free start anywhere).
 * - Cost(Any -> Ghost) = 0 (Free return, though typically unused in open paths).
 */
export const addVirtualStartToMatrix = (matrix: number[][]): number[][] => {
    const size = matrix.length;
    if (size === 0) return [];

    // Create new matrix of Size+1
    const newMatrix: number[][] = Array(size + 1).fill(0).map(() => Array(size + 1).fill(0));

    // Copy original data
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            newMatrix[i][j] = matrix[i][j];
        }
    }

    // Fill Ghost Row (Index size) -> 0
    // Fill Ghost Col (Index size) -> 0
    // Already 0 by init, but explicit for clarity
    for (let i = 0; i < size; i++) {
        newMatrix[size][i] = 0; // Ghost -> Client i
        newMatrix[i][size] = 0; // Client i -> Ghost
    }

    return newMatrix;
};
