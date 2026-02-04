import { Shipment, Coordinate, Vehicle, DriverState } from '../interfaces';

// --- VROOM Interfaces ---

interface VroomJob {
    id: number;
    description?: string;
    location: [number, number]; // [lon, lat]
    service?: number; // Service duration in seconds
    pickup?: number[]; // [weight, volume]
    delivery?: number[]; // [weight, volume]
    skills?: number[];
    priority?: number; // 0-100 (100 = highest)
    time_windows?: [number, number][];
}

interface VroomVehicle {
    id: number;
    profile: string; // 'car', 'bike', etc. (must match OSRM profile)
    start?: [number, number];
    end?: [number, number];
    capacity?: number[]; // [weight, volume]
    skills?: number[];
    time_window?: [number, number];
}

interface VroomInput {
    jobs?: any[];
    shipments?: any[];
    vehicles: VroomVehicle[];
    options?: {
        g?: boolean; // Generate geometry
    };
    matrices?: { [profile: string]: number[][] };
}

interface VroomOutput {
    code: number;
    error?: string;
    summary: {
        cost: number;
        routes: number;
        unassigned: number;
        delivery: number[];
        pickup: number[];
        setup: number;
        service: number;
        duration: number;
        waiting_time: number;
        priority: number;
        violations: any[];
    };
    unassigned: {
        id: number;
        location: [number, number];
    }[];
    routes: VroomRoute[];
}

interface VroomRoute {
    vehicle: number;
    cost: number;
    delivery: number[];
    pickup: number[];
    setup: number;
    service: number;
    duration: number;
    waiting_time: number;
    priority: number;
    steps: VroomStep[];
    geometry?: string; // Encoded polyline
}

interface VroomStep {
    type: 'start' | 'end' | 'job' | 'pickup' | 'delivery' | 'break';
    location: [number, number];
    id?: number;
    service: number;
    waiting_time: number;
    arrival: number;
    duration: number;
    description?: string;
    load: number[];
}

// --- Client Implementation ---

const VROOM_URL = process.env.VROOM_URL;
if (!VROOM_URL) {
    throw new Error("Configuration Error: VROOM_URL environment variable is missing. Public API usage is disabled.");
}

export const solveVrp = async (
    shipments: (Shipment & { priority?: number })[],
    availableDrivers: DriverState[] = [],
    matrix?: number[][], // Optional: Custom Matrix for Coupled Cost (LIFO)
    options?: { forceRoundTrip?: boolean; vehicleStartIndex?: number }
): Promise<VroomOutput> => {

    // 1. Map Shipments/Jobs
    // Strategy:
    // - If NO Matrix (Standard VROOM): Use 'shipments' (P&D pairs). VROOM routes both legs.
    // - If Matrix (LIFO Coupled): Use 'jobs' (Single Tasks, representing Pickups). VROOM routes Pickups only. Matrix encodes Delivery cost.

    let vroomShipments: any[] = [];
    let vroomJobs: any[] = [];

    if (matrix) {
        // LIFO Mode: 60 Jobs, Matrix 60x60
        vroomJobs = shipments.map((s, index) => ({
            id: index + 1, // Job ID
            description: `Pickup ${s._id}`,
            location: [s.pickupAddress.lon, s.pickupAddress.lat], // Always provide coords
            location_index: index, // Matrix Index
            service: 300,
            amount: [calculateWeight(s), calculateVolume(s)]
        }));
    } else {
        // Standard Mode: 60 Shipments (120 stops)
        vroomShipments = shipments.map((s, index) => ({
            id: index + 1,
            pickup: {
                id: (index + 1) * 10 + 1,
                description: `Pickup ${s._id}`,
                location: [s.pickupAddress.lon, s.pickupAddress.lat] as [number, number],
                service: 300
            },
            delivery: {
                id: (index + 1) * 10 + 2,
                description: `Delivery ${s._id}`,
                location: [s.deliveryAddress.lon, s.deliveryAddress.lat] as [number, number],
                service: 300
            },
            amount: [calculateWeight(s), calculateVolume(s)]
        }));
    }

    // 2. Map Vehicles
    let vroomVehicles: VroomVehicle[] = [];

    // Helper for Vehicle Start Location
    // Always provide start coords, add start_index if matrix.
    const getStartLoc = (refShipment: Shipment): any => {
        const startCoords = [refShipment.pickupAddress.lon, refShipment.pickupAddress.lat];
        // If vehicleStartIndex provided, use it. Default to 0.
        const vIndex = (options?.vehicleStartIndex !== undefined) ? options.vehicleStartIndex : 0;
        return matrix
            ? { start: startCoords, start_index: vIndex }
            : { start: startCoords };
    };

    // [MODIFICATION] Support for Round Trip (Anchor Mode)
    // If enabled, we force the vehicle to end at the start location.
    const forceRoundTrip = (options as any)?.forceRoundTrip || false;

    if (availableDrivers.length > 0) {
        // Real Drivers
        vroomVehicles = availableDrivers.map((d, index) => {
            const base = {
                id: index + 1,
                profile: 'car',
                // If matrix provided, we'd need to add Driver Pos to Matrix. 
                // For LIFO-IntraZonal, we assume Driver is AT Hub/First Pickup or ignored.
                // For this test, we force Start Index 0.
                ...getStartLoc(shipments[0]),
                capacity: [
                    (d.vehicle?.max_payload_kg || 1000) * 1000,
                    (d.vehicle?.max_volume_m3 || 10) * 1000000
                ]
            };

            // If Round Trip Enforced (e.g. Dedicated Seller Loop)
            if (forceRoundTrip) {
                (base as any).end = (base as any).start;
            }

            return base;
        });
    } else {
        // Virtual Mixed Fleet
        const startLoc = getStartLoc(shipments[0]);
        // ... (Virtual Fleet Logic same as below, just apply end=start if needed)
        // For brevity preserving existing Loop Logic structure but injecting the check

        const createVirtual = (id: number, capW: number, capV: number, skill: number[]) => {
            const v: any = {
                id,
                profile: 'car',
                ...startLoc,
                capacity: [capW * 1000, capV * 1000],
                skills: skill,
                time_window: [0, 3600]
            };
            if (forceRoundTrip) v.end = v.start;
            return v;
        };

        // 1. Motos
        for (let i = 1; i <= 10; i++) vroomVehicles.push(createVirtual(i, 25, 80, [1]));
        // 2. Cars
        for (let i = 11; i <= 15; i++) vroomVehicles.push(createVirtual(i, 100, 400, [1, 2]));
        // 3. Vans
        for (let i = 16; i <= 20; i++) vroomVehicles.push(createVirtual(i, 1000, 3000, [1, 2, 3]));
        // 4. Trucks
        for (let i = 21; i <= 22; i++) vroomVehicles.push(createVirtual(i, 3000, 15000, [1, 2, 3, 4]));
    }

    const input: VroomInput = {
        jobs: vroomJobs.length > 0 ? vroomJobs : undefined,
        shipments: vroomShipments.length > 0 ? vroomShipments : undefined,
        vehicles: vroomVehicles,
        options: { g: !matrix } // Disable geometry if using matrix (no coords)
    };

    if (matrix) {
        // VROOM requires 'matrices' object with keys matching vehicle profiles
        // Using explicit 'durations' wrapper to avoid ambiguity
        (input as any).matrices = { car: { durations: matrix } };
    }

    return await sendVroomRequest(input);
};

// --- Swarm Optimization (Feeder Logic) ---
export const solveSwarmVrp = async (
    shipments: Shipment[],
    meetingPoint: Coordinate,
    vehicleCount: number = 5,
    transferTimeSeconds: number = 300 // Default 5 mins coordination buffer
): Promise<VroomOutput> => {
    // 1. Map Shipments to P&D (Pickup -> Hub)
    // We treat the "Feeder Leg" as a complete shipment from Source to Hub.
    // The "Delivery" service time represents the Handover/Transfer time.
    const vroomShipments = shipments.map((s, index) => ({
        id: index + 1,
        amount: [calculateWeight(s), calculateVolume(s)],
        pickup: {
            id: (index + 1) * 10 + 1,
            description: `Pickup ${s._id}`,
            location: [s.pickupAddress.lon, s.pickupAddress.lat] as [number, number],
            service: 300 // 5 min pickup
        },
        delivery: {
            id: (index + 1) * 10 + 2,
            description: `Handover @ Hub`,
            location: [meetingPoint.lon, meetingPoint.lat] as [number, number],
            service: transferTimeSeconds // Buffer for coordination/transfer
        }
    }));

    // 2. Configure Feeder Fleet (Motos)
    const vroomVehicles: VroomVehicle[] = [];
    const endLoc = [meetingPoint.lon, meetingPoint.lat];

    for (let i = 1; i <= vehicleCount; i++) {
        // Start roughly at the first pickup to help local optimization
        const startLoc = [shipments[0].pickupAddress.lon, shipments[0].pickupAddress.lat];

        vroomVehicles.push({
            id: i,
            profile: 'car',
            start: startLoc as [number, number],
            end: endLoc as [number, number], // End at Hub
            capacity: [25 * 1000, 80 * 1000],
            skills: [1],
            time_window: [0, 3600]
        });
    }

    const input: VroomInput = {
        shipments: vroomShipments, // Use P&D
        vehicles: vroomVehicles,
        options: { g: true }
    };

    return await sendVroomRequest(input);
};

const sendVroomRequest = async (input: VroomInput): Promise<VroomOutput> => {
    try {
        console.log(`[VROOM] Sending request to: ${VROOM_URL}`);
        // console.log(`[VROOM] Payload Size: ${JSON.stringify(input).length} bytes`);
        const response = await fetch(VROOM_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(input),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[VROOM] Error Body: ${errText}`);
            throw new Error(`VROOM API Error: ${response.status} ${response.statusText} - ${errText}`);
        }

        const data = await response.json();
        return data as VroomOutput;
    } catch (error) {
        console.error('VROOM API Error:', error);
        throw error;
    }
};

// Helpers
const calculateWeight = (s: Shipment): number => {
    // Return in grams (integer)
    const weightKg = s.items.reduce((sum, item) => sum + (item.weight_kg || 0.1) * item.quantity, 0);
    return Math.round(weightKg * 1000);
};

const calculateVolume = (s: Shipment): number => {
    // Return in cm3 (integer)
    // 1 m3 = 1,000,000 cm3
    const volumeM3 = s.items.reduce((sum, item) => {
        // Use explicit volume if available, else calculate from dimensions
        if (item.volume_m3) return sum + (item.volume_m3 * item.quantity);
        return sum + ((item.width_cm || 10) * (item.height_cm || 10) * (item.depth_cm || 10)) / 1000000 * item.quantity;
    }, 0);
    return Math.round(volumeM3 * 1000000);
};
