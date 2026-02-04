import { DriverState, DriverStatus, User } from '../interfaces';
import { Db, ObjectId } from 'mongodb';
import { latLngToCell, gridDisk } from 'h3-js';

export interface DriverRepository {
    add(driverId: string, initialData: DriverState): Promise<void>;
    remove(driverId: string): Promise<void>;
    updateLocation(driverId: string, lat: number, lon: number): Promise<void>;
    updateStatus(driverId: string, status: DriverStatus): Promise<void>;
    get(driverId: string): Promise<DriverState | undefined>;
    findIdleInRadius(h3Index: string, k: number): Promise<DriverState[]>;
    findPredictiveRelayCandidates(targetH3Index: string, windowMinutes: number): Promise<DriverState[]>;
    getLastBatch(driverId: string): Promise<import('../interfaces').Batch | null>;
    update(driverId: string, updates: Partial<DriverState>): Promise<void>;
}

export class MongoDriverRepository implements DriverRepository {
    private cache: Map<string, DriverState> = new Map();
    private db: Db;
    private readonly H3_RESOLUTION = 9;

    constructor(db: Db) {
        this.db = db;
    }

    async add(driverId: string, initialData: DriverState): Promise<void> {
        this.cache.set(driverId, initialData);
        try {
            await this.db.collection<User>('users').updateOne(
                { _id: new ObjectId(driverId) },
                {
                    $set: {
                        'driverDetails.socketId': initialData.socketId,
                        'driverDetails.status': initialData.status,
                        'driverDetails.idleSince': new Date(initialData.idleSince),
                        'driverDetails.currentLocation': {
                            lat: initialData.lat,
                            lon: initialData.lon,
                            h3Index: initialData.quadrantId
                        }
                    }
                }
            );
            console.log(`Driver ${driverId} added/updated in repo.`);
        } catch (error) {
            console.error(`Failed to sync driver ${driverId} to DB:`, error);
        }
    }

    async remove(driverId: string): Promise<void> {
        this.cache.delete(driverId);
        try {
            await this.db.collection<User>('users').updateOne(
                { _id: new ObjectId(driverId) },
                { $unset: { 'driverDetails.socketId': "" } }
            );
            console.log(`Driver ${driverId} removed from repo.`);
        } catch (error) {
            console.error(`Failed to sync driver removal ${driverId}:`, error);
        }
    }

    async updateLocation(driverId: string, lat: number, lon: number): Promise<void> {
        const driver = this.cache.get(driverId);
        if (driver) {
            const quadrantId = latLngToCell(lat, lon, this.H3_RESOLUTION);
            const updatedDriver = { ...driver, lat, lon, quadrantId };
            this.cache.set(driverId, updatedDriver);

            try {
                await this.db.collection<User>('users').updateOne(
                    { _id: new ObjectId(driverId) },
                    {
                        $set: {
                            'driverDetails.currentLocation': { lat, lon, h3Index: quadrantId }
                        }
                    }
                );
            } catch (error) {
                console.error(`Failed to sync location for ${driverId}:`, error);
            }
        }
    }

    async updateStatus(driverId: string, status: DriverStatus): Promise<void> {
        const driver = this.cache.get(driverId);
        if (driver) {
            const updatedDriver = {
                ...driver,
                status,
                idleSince: status === 'IDLE' ? Date.now() : driver.idleSince
            };
            this.cache.set(driverId, updatedDriver);

            try {
                const updateDoc: any = { 'driverDetails.status': status };
                if (status === 'IDLE') {
                    updateDoc['driverDetails.idleSince'] = new Date();
                }
                await this.db.collection<User>('users').updateOne(
                    { _id: new ObjectId(driverId) },
                    { $set: updateDoc }
                );
            } catch (error) {
                console.error(`Failed to sync status for ${driverId}:`, error);
            }
        }
    }

    async get(driverId: string): Promise<DriverState | undefined> {
        return this.cache.get(driverId);
    }

    async findIdleInRadius(h3Index: string, k: number): Promise<DriverState[]> {
        // This implementation mimics what Redis GEOSEARCH would do.
        // When we switch to Redis, this method will just call redis.geosearch(...)
        // The Engine logic won't need to change.

        const ring = gridDisk(h3Index, k);
        const drivers = Array.from(this.cache.values());

        return drivers.filter(d =>
            d.status === 'IDLE' && ring.includes(d.quadrantId)
        );
    }

    async findPredictiveRelayCandidates(targetH3Index: string, windowMinutes: number): Promise<DriverState[]> {
        // Stub implementation for In-Memory Repo (Test/Dev mode without Redis)
        // Just returns IDLE drivers in the exact cell for now.
        const drivers = Array.from(this.cache.values());
        return drivers.filter(d => d.status === 'IDLE' && d.quadrantId === targetH3Index);
    }

    async getLastBatch(driverId: string): Promise<import('../interfaces').Batch | null> {
        try {
            const batch = await this.db.collection<import('../interfaces').Batch>('batches').findOne(
                { assignedCollectorId: driverId, status: 'completed' },
                { sort: { createdAt: -1 } }
            );
            return batch;
        } catch (error) {
            console.error(`Failed to get last batch for driver ${driverId}:`, error);
            return null;
        }
    }

    async update(driverId: string, updates: Partial<DriverState>): Promise<void> {
        const driver = this.cache.get(driverId);
        if (driver) {
            const updatedDriver = { ...driver, ...updates };
            this.cache.set(driverId, updatedDriver);

            // Sync relevant fields to DB if needed
            if (updates.status) {
                await this.updateStatus(driverId, updates.status);
            }
        }
    }
}
