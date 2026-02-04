// Bridge Type: Compatible with string (Frontend) and ObjectId (Backend)
export type ObjectId = any;

// --- Tipos Fundamentales ---

export type DriverStatus = 'IDLE' | 'COLLECTING_BATCH' | 'ROUTING_TO_HUB' | 'DELIVERING_BATCH' | 'PERFORMING_DIRECT_ROUTE' | 'OFFLINE';
export type ShippingType = 'going_network' | 'self_delivery';

// --- Entidades Principales ---

export interface Address {
    fullName: string; // Canonical field for the person/business name at this address
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
    lat?: number;
    lon?: number; // Opcional en la entrada, obligatorio en el sistema.
    h3Index?: string; // Level 9 (Legacy/Default)
    h3IndexL6?: string; // Level 6 (Macro Zone - Grouping)
    h3IndexL8?: string; // Level 8 (Micro Zone - Filtering)
    h3IndexL11?: string; // Level 11 (Nano Zone - Spatial Sweep)
    instructions?: string; // Delivery instructions
    phone?: string; // Contact phone number
}

export interface GeocodedAddress extends Address {
    lat: number;
    lon: number;
    h3Index: string;
    h3IndexL6: string;
    h3IndexL8: string;
    h3IndexL11: string;
}

export type NodeType = 'VIRTUAL' | 'RELAY_POINT' | 'WAREHOUSE' | 'AIRPORT' | 'SEAPORT';

export interface NetworkNode {
    _id?: string;
    name: string;
    type: NodeType;
    location: GeocodedAddress;
    capabilities: {
        maxVehicleSize: 'motorcycle' | 'car' | 'van' | 'truck' | 'plane' | 'ship';
        hasStorage: boolean;
        operatingHours?: string; // e.g., "08:00-20:00"
    };
}

export interface User {
    _id?: ObjectId | string;
    fullName: string;
    addresses: Address[];
    email: string;
    avatar: string;
    joined: string;
    location: string;
    bio: string;
    website: string;
    twitter: string;
    x: string;
    instagram: string;
    telegram: string;
    facebook: string;
    isSeller: boolean;
    isLogisticsClient: boolean;
    isDriver?: boolean;
    driverDetails?: {
        status?: DriverStatus;
        idleSince?: Date;
        vehicle?: Vehicle;
        socketId?: string;
        currentLocation?: {
            lat: number;
            lon: number;
            h3Index: string;
        };
    };
    wishlist: string[];
    settings: {
        theme: "light" | "dark" | "system";
        currency: string;
        language: string;
    }
}

export interface Product {
    _id?: ObjectId | string;
    seller: string;
    name: string;
    addressWallet: string;
    description: string;
    category: string;
    price: number;
    currency: string;
    shippingType: ShippingType;
    pickupAddress: Address; // En el producto, la dirección puede no estar geocodificada aún.
    publishStatus: "published" | "unpublished";
    images: Array<string | File>;
    mainImage: string;
    stock: number;
    location?: string;
    condition?: string;
    tags?: string[];
    isService?: boolean;
    isFeatured?: boolean;
    isOffer?: boolean;
    offerPercentage: number;
    reviews?: string[];
    rating: number;
    subcategory?: string;
    createdAt?: Date;
    updatedAt?: Date;
    weight_kg?: number;
    width_cm?: number;
    height_cm?: number;
    depth_cm?: number;
    isFragile?: boolean;
    estimatedDeliveryDays?: number;
}

export interface CartItem {
    _id: ObjectId | string; // El _id del producto
    name: string;
    price: number;
    mainImage: string;
    seller: string;
    addressWallet: string;
    currency: string;
    shippingType: ShippingType;
    pickupAddress: Address; // La dirección del producto se copia aquí.
    weight_kg?: number;
    width_cm?: number;
    height_cm?: number;
    depth_cm?: number;
    estimatedDeliveryDays?: number;
    quantity: number;
    isOffer?: boolean;
    offerPercentage?: number;
    volume_m3?: number;
}

export interface Order {
    _id?: ObjectId | string;
    date: Date;
    status: 'payment_pending' | 'processing' | 'completed' | 'cancelled';
    buyer: {
        walletAddress: string;
        _id?: string;
        address: Address; // La dirección del comprador puede no estar geocodificada aún.
        email: string;
        phone: string;
    };
    sellers: string[];
    shipments: string[];
    signature: string;
    items: CartItem[];
}



export interface CustodyEvent {
    timestamp: Date;
    action: 'PICKUP' | 'DROPOFF' | 'HANDSHAKE' | 'CHECK_IN';
    actorId: string; // Driver ID or Hub Operator ID
    location: Coordinate;
    nodeId?: string; // If happened at a specific node
    proof?: {
        method: 'QR_SCAN' | 'PIN' | 'PHOTO';
        signature?: string;
    };
}

export interface ShipmentLeg {
    _id: string;
    shipmentId: string;
    sequenceNumber: number; // 1, 2, 3...
    status: 'pending' | 'assigned' | 'in_progress' | 'completed';
    origin: GeocodedAddress | NetworkNode;
    destination: GeocodedAddress | NetworkNode;
    requiredVehicleType: 'motorcycle' | 'car' | 'van' | 'truck' | 'plane';
    estimatedDistanceKm: number;
    estimatedDurationMin: number;

    assignedBatchId?: string; // The batch this leg belongs to
    requiresConsolidation?: boolean; // If true, this leg waits for a full truck/van
    externalProvider?: {
        providerName: string; // e.g., "Maersk", "DHL", "Aerolineas Argentinas"
        trackingId?: string;
        estimatedCost?: number;
    };
    assignmentStrategy?: 'AUTO' | 'MARKETPLACE';
}

// --- Modelos de Envío (Shipment) ---

export interface BaseShipment {
    _id?: ObjectId | string;
    orderId: string;
    sellerId: string;
    buyerId: string;
    shippingType: ShippingType;
    deliveryAddress: GeocodedAddress; // Obligatorio que esté geocodificada
    pickupAddress: GeocodedAddress;   // Obligatorio que esté geocodificada
    items: CartItem[];
    createdAt: Date;
    updatedAt: Date;
    // [Added] Support for Email Notifications & Error Handling
    recipientEmail?: string;
    failureReason?: string;
    failedAt?: Date;
    // [Added] Operational Readiness (Labels & Security)
    shortCode?: string; // e.g., "AF-49"
    packageCount?: number; // e.g., 3 boxes
    deliveryToken?: string; // e.g., "4590" (PIN)
    price?: number; // Total Shipping Fee (Standardized)
    driverCost?: number; // Base Driver Payout (Cost)
}

export type ShipmentStatus = 'pending' | 'ready_to_ship' | 'batched' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'cancelled' | 'shipped' | 'failed';

export interface GoingNetworkShipment extends BaseShipment {
    shippingType: 'going_network';
    status: ShipmentStatus;
    deliveryDetails?: {
        driverId: string;
        trackingNumber?: string;
        confirmedDeliveryDays?: number;
    };
    scheduledDispatchTime?: Date;
    serviceLevel: 'standard' | 'express';
    custodyLog: CustodyEvent[];
    currentCustodyId?: string;
    legs: ShipmentLeg[];
}

export interface SelfDeliveryShipment extends BaseShipment {
    shippingType: 'self_delivery';
    status: 'shipped_by_seller' | 'completed' | 'cancelled' | 'dispute' | 'failed';
    deliveryDetails?: {
        confirmedDeliveryDays: number;
        trackingNumber?: string;
    };
}

export type Shipment = (GoingNetworkShipment | SelfDeliveryShipment) & {
    _id?: ObjectId | string;
};

// --- Logística y Tareas de Conductor ---

export interface Batch {
    _id?: ObjectId | string;
    batchId?: string; // Temporary ID for in-memory operations
    type: 'HYPER_LOCAL' | 'DIRECT' | 'HUB_AND_SPOKE' | 'RELAY' | 'feeder_batch' | 'trunk_batch' | 'SWARM';
    status: 'pending_assignment' | 'pending_inbound' | 'planning' | 'assigning' | 'assigned' | 'in_progress' | 'in_transit' | 'out_for_delivery' | 'completed' | 'cancelled';
    shipments?: (Shipment & { _id: ObjectId | string })[]; // Standardized collection
    assignedCollectorId?: string;
    assignedDelivererId?: string;
    hubLocation?: Coordinate;
    createdAt: Date;
    updatedAt?: Date;
    totalWeightKg?: number;
    totalVolumeM3?: number;
    requiredVehicleType?: 'bicycle' | 'motorcycle' | 'car' | 'van' | 'truck' | 'plane';
    assignmentStrategy: 'AUTO' | 'MANUAL' | 'MARKETPLACE' | 'VROOM_OPTIMIZED' | 'RELAY_MATCH';
    currentSearchLevel?: number; // H3 Resolution Level (e.g., 8, 7, 6)
    levelStartTime?: Date; // When did we start searching at this level?
    searchAttempts?: number;
    metadata?: {
        strategy?: string;
        hiveLocation?: Coordinate;
        processId?: string;
        feederBatches?: string[];
        [key: string]: any;
    };
}

export interface DriverTask {
    status: DriverStatus;
    batch?: Batch;
    hubLocation?: Coordinate;
    route?: Coordinate[];
    rendezvousInfo?: {
        partnerDriver: {
            name: string;
            id: string;
        };
        etaSeconds: number;
        location: Coordinate;
    };
}

// --- Tipos Auxiliares y de Servidor ---

export type NewOrderPayload = Omit<Order, '_id' | 'shipments' | 'signature'>;

export type Coordinate = { lat: number; lon: number };

export interface Vehicle {
    type: 'bicycle' | 'motorcycle' | 'car' | 'van' | 'truck' | 'plane';
    max_payload_kg: number;
    max_volume_m3: number;
    plate?: string;
    model?: string;
    definition?: VehicleDefinition; // The specific "Digital Twin" configuration
}

export interface ExclusionZone {
    id: string;
    position: { x: number; y: number; z: number }; // Relative to cargo bottom-left-front
    dimensions: { width: number; height: number; depth: number };
    type: 'wheel_arch' | 'bulkhead' | 'other';
}

export interface VehicleDimensions {
    length: number; // Internal Cargo Length (mm)
    width: number;  // Internal Cargo Width (mm)
    height: number; // Internal Cargo Height (mm)
    widthBetweenWheelArches?: number; // Critical for vans (mm)
}

export interface VehicleDefinition {
    id: string; // e.g., 'renault_trafic_l1h1'
    name: string; // e.g., 'Renault Trafic L1H1'
    manufacturer: string;
    model: string;
    yearRange?: string;
    dimensions: VehicleDimensions;
    exclusionZones: ExclusionZone[];
    maxPayloadKg: number;
    source: 'manufacturer' | 'user_scan' | 'estimated';
    isVerified: boolean; // True if from reliable DB or verified Scan
    hasGNC?: boolean; // Critical for capacity calculation
}

export interface VehicleScannerResult {
    vehicleId?: string; // If matching an existing definition
    scannedDimensions: VehicleDimensions;
    detectedExclusionZones: ExclusionZone[];
    confidenceScore: number; // 0.0 - 1.0
    scanTimestamp: Date;
    scanProofImage?: string; // URL to the debug image
}

export interface EncryptedData {
    iv: string;
    content: string;
    tag: string;
}

export interface DriverState {
    socketId: string;
    driverId: string;
    lat: number;
    lon: number;
    status: DriverStatus;
    idleSince: number;
    quadrantId: string;
    vehicle?: Vehicle;
    activeBatchId?: string;
    lastDistanceToHub?: number;
    deviationCount?: number;
}

export type AvailableDriver = DriverState;