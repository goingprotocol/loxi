import { DriverRepository } from './driverRepository';
import { DriverState, DriverStatus, Batch } from '../interfaces';
import Redis from 'ioredis';
import { latLngToCell } from 'h3-js';

const H3_RESOLUTION = 8;
const GEO_KEY = 'drivers:geo:idle';
const DRIVER_PREFIX = 'driver:';

import { Db, ObjectId } from 'mongodb';

export const createRedisDriverRepository = (redisUrl: string, db: Db, redisPassword?: string): DriverRepository => {
    const redis = new Redis(redisUrl, {
        password: redisPassword
    });

    redis.on('error', (err) => {
        console.error('Redis connection error:', err);
    });

    redis.on('connect', () => {
        console.log('Connected to Redis');
    });

    const add = async (driverId: string, initialData: DriverState): Promise<void> => {
        const key = `${DRIVER_PREFIX}${driverId}`;

        await redis.hset(key, {
            driverId: initialData.driverId,
            socketId: initialData.socketId,
            status: initialData.status,
            lat: initialData.lat,
            lon: initialData.lon,
            idleSince: initialData.idleSince,
            quadrantId: initialData.quadrantId,
            vehicle: initialData.vehicle ? JSON.stringify(initialData.vehicle) : ''
        });

        if (initialData.status === 'IDLE') {
            const lat = Number(initialData.lat);
            const lon = Number(initialData.lon);

            if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
                await redis.geoadd(GEO_KEY, lon, lat, driverId);
                console.log(`[Redis] Driver ${driverId} added to GEO index at ${lat}, ${lon}`);
            } else {
                console.warn(`[Redis] Driver ${driverId} has invalid coordinates (${lat}, ${lon}). Skipping GEO index.`);
            }
        } else {
            console.log(`[Redis] Driver ${driverId} NOT added to GEO index. Status: ${initialData.status}`);
        }

        console.log(`Driver ${driverId} added to Redis.`);
    };

    const remove = async (driverId: string): Promise<void> => {
        const key = `${DRIVER_PREFIX}${driverId}`;

        await Promise.all([
            redis.zrem(GEO_KEY, driverId),
            redis.del(key)
        ]);

        console.log(`Driver ${driverId} removed from Redis.`);
    };

    const updateLocation = async (driverId: string, lat: number, lon: number): Promise<void> => {
        const key = `${DRIVER_PREFIX}${driverId}`;
        const quadrantId = latLngToCell(lat, lon, H3_RESOLUTION);

        const status = await redis.hget(key, 'status') as DriverStatus;

        await redis.hset(key, {
            lat,
            lon,
            quadrantId
        });

        if (status === 'IDLE') {
            if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
                await redis.geoadd(GEO_KEY, lon, lat, driverId);
            }
        }
    };

    const updateStatus = async (driverId: string, status: DriverStatus): Promise<void> => {
        const key = `${DRIVER_PREFIX}${driverId}`;

        await redis.hset(key, { status });

        // [MODIFIED] We now keep ALL drivers in the GEO index to enable Predictive Logic (finding active drivers nearby)
        // Previously we removed non-IDLE drivers.
        const [latStr, lonStr] = await redis.hmget(key, 'lat', 'lon');
        const lat = Number(latStr);
        const lon = Number(lonStr);

        if (lat && lon && !isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
            await redis.geoadd(GEO_KEY, lon, lat, driverId);
        }

        if (status === 'IDLE') {
            await redis.hset(key, { idleSince: Date.now() });
        }

        console.log(`Driver ${driverId} status updated to ${status} in Redis.`);
    };

    const get = async (driverId: string): Promise<DriverState | undefined> => {
        const key = `${DRIVER_PREFIX}${driverId}`;
        const data = await redis.hgetall(key);

        if (!data || Object.keys(data).length === 0) return undefined;

        let vehicle = undefined;
        if (data.vehicle) {
            try {
                vehicle = JSON.parse(data.vehicle);
            } catch (e) {
                console.error(`Failed to parse vehicle data for driver ${driverId}`, e);
            }
        }

        return {
            driverId: data.driverId,
            socketId: data.socketId,
            status: data.status as DriverStatus,
            lat: Number(data.lat),
            lon: Number(data.lon),
            idleSince: Number(data.idleSince),
            quadrantId: data.quadrantId,
            vehicle,
            activeBatchId: data.activeBatchId,
            lastDistanceToHub: data.lastDistanceToHub ? Number(data.lastDistanceToHub) : undefined,
            deviationCount: data.deviationCount ? Number(data.deviationCount) : undefined
        };
    };

    const findIdleInRadius = async (h3Index: string, k: number): Promise<DriverState[]> => {
        // We need h3-js to get lat/lon from index to use as center for GEOSEARCH
        const { cellToLatLng, getResolution } = require('h3-js');
        const [lat, lon] = cellToLatLng(h3Index);
        const resolution = getResolution(h3Index);

        let radiusKm = 2;
        if (resolution === 7) radiusKm = 5;
        if (resolution === 6) radiusKm = 10;
        if (resolution < 6) radiusKm = 20;

        const results = await redis.geosearch(
            GEO_KEY,
            'FROMLONLAT',
            lon,
            lat,
            'BYRADIUS',
            radiusKm,
            'km'
        ) as string[];

        if (results.length === 0) return [];

        const drivers: DriverState[] = [];
        for (const driverId of results) {
            const driver = await get(driverId);
            // Strict checking for IDLE
            if (driver && driver.status === 'IDLE') {
                drivers.push(driver);
            }
        }

        return drivers;
    };

    const findPredictiveRelayCandidates = async (targetH3Index: string, windowMinutes: number): Promise<DriverState[]> => {
        const { cellToLatLng, gridDistance } = require('h3-js');
        const [lat, lon] = cellToLatLng(targetH3Index);

        // 1. Search Radius: 5km (Relevant for Relay Handover)
        const radiusKm = 5;

        const results = await redis.geosearch(
            GEO_KEY,
            'FROMLONLAT',
            lon,
            lat,
            'BYRADIUS',
            radiusKm,
            'km'
        ) as string[];

        if (results.length === 0) return [];

        const candidates: { driver: DriverState, score: number }[] = [];

        for (const driverId of results) {
            const driver = await get(driverId);
            if (!driver) continue;

            // Scenario A: Driver is IDLE in Zone (High Priority)
            if (driver.status === 'IDLE') {
                candidates.push({ driver, score: 100 });
                continue;
            }

            // Scenario B: Driver is FINISHING Delivery in Zone (Medium Priority)
            if ((driver.status === 'DELIVERING_BATCH' || driver.status === 'ROUTING_TO_HUB') && driver.activeBatchId) {
                // Fetch Batch Destination from Mongo
                const batch = await db.collection<Batch>('batches').findOne({ _id: new ObjectId(driver.activeBatchId) }); // Use generic ObjectId handling if needed, but db driver handles it

                if (batch && batch.hubLocation) { // Hub Location is the destination for a defined batch
                    const destCell = latLngToCell(batch.hubLocation.lat, batch.hubLocation.lon, H3_RESOLUTION);

                    // Check if Destination is CLOSE to Target Relay Point
                    const dist = gridDistance(targetH3Index, destCell);

                    if (dist <= 2) { // Within ~1km of Relay Point
                        candidates.push({ driver, score: 80 });
                    }
                }
            }
        }

        // Sort by Score (Desc)
        return candidates.sort((a, b) => b.score - a.score).map(c => c.driver);
    };

    const getLastBatch = async (driverId: string): Promise<Batch | null> => {
        try {
            const batch = await db.collection<Batch>('batches').findOne(
                { assignedCollectorId: driverId, status: 'completed' },
                { sort: { createdAt: -1 } }
            );
            return batch;
        } catch (error) {
            console.error(`Failed to get last batch for driver ${driverId}:`, error);
            return null;
        }
    };

    const update = async (driverId: string, updates: Partial<DriverState>): Promise<void> => {
        const key = `${DRIVER_PREFIX}${driverId}`;
        const redisUpdates: Record<string, any> = {};

        if (updates.activeBatchId !== undefined) {
            if (updates.activeBatchId === null) {
                await redis.hdel(key, 'activeBatchId');
            } else {
                redisUpdates.activeBatchId = updates.activeBatchId;
            }
        }

        if (updates.status) {
            redisUpdates.status = updates.status;
            // Trigger geo index update if status changes (Refresh position assurance)
            await updateStatus(driverId, updates.status);
        }

        if (updates.lastDistanceToHub !== undefined) redisUpdates.lastDistanceToHub = updates.lastDistanceToHub;
        if (updates.deviationCount !== undefined) redisUpdates.deviationCount = updates.deviationCount;

        if (Object.keys(redisUpdates).length > 0) {
            await redis.hset(key, redisUpdates);
        }
    };

    return {
        add,
        remove,
        updateLocation,
        updateStatus,
        get,
        findIdleInRadius,
        findPredictiveRelayCandidates,
        getLastBatch,
        update
    };
};
