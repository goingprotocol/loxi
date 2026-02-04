import Redis from 'ioredis';
import { ObjectId } from 'mongodb';
import { GoingNetworkShipment } from '../interfaces';

// Redis Configuration
const REDIS_URL = process.env.REDIS_PUBLIC_ENDPOINT || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
    password: process.env.REDIS_PASSWORD,
    family: 4, // Force IPv4 for Docker/Cloud compatibility
});

// Keys
const QUEUE_PREFIX = 'queue:lane:'; // Changed to Lane
const METADATA_PREFIX = 'meta:lane:';
const SHIPMENT_DATA_PREFIX = 'shipment:data:';

interface CellMetadata {
    count: number;
    firstTimestamp: number;
    totalRevenue: number;
    totalVolume: number;
}

export class RedisQueue {
    /**
     * Add a shipment to a specific LANE Waiting Room (Queue)
     * Key: queue:lane:{OriginL7}:{DestL7}
     */
    static async addShipmentToLane(shipment: GoingNetworkShipment, originL7: string, destL7: string, retryCount: number = 0): Promise<void> {
        // Construct Lane Key
        const laneKeySuffix = `${originL7}:${destL7}`;

        const queueKey = `${QUEUE_PREFIX}${laneKeySuffix}`;
        const metaKey = `${METADATA_PREFIX}${laneKeySuffix}`;
        const shipmentKey = `${SHIPMENT_DATA_PREFIX}${shipment._id}`;

        const shipmentWithRetry = { ...shipment, _retryCount: retryCount };

        // 1. Store full shipment data
        await redis.set(shipmentKey, JSON.stringify(shipmentWithRetry), 'EX', 3600);

        // 2. Add ID to the Lane Queue (Sorted Set for FIFO)
        const score = new Date(shipment.createdAt).getTime();
        await redis.zadd(queueKey, score, shipment._id ? shipment._id.toString() : '');

        // 3. Update Aggregate Metadata (Count, Volume, Revenue)
        // We need to fetch existing to accumulate correctly? 
        // Or can we trust ZCARD for count, but we need persistent sum for others.
        // Race condition warning: READ-MODIFY-WRITE.
        // Ideally should use Lua script or strict locking, but for MVP we read->write.

        const existingMeta = await redis.get(metaKey);
        let meta: CellMetadata = existingMeta
            ? JSON.parse(existingMeta)
            : { count: 0, firstTimestamp: Date.now(), totalRevenue: 0, totalVolume: 0 };

        // Update Count from Source of Truth (ZCARD) to be safe
        meta.count = await redis.zcard(queueKey);

        // Update Aggregates based on THIS shipment (Increment)
        // Note: This naive increment might drift if we re-add existing shipments or if pods restart.
        // A better way for "Total in Queue" is to recalc, but that's expensive.
        // Let's increment.
        const sPrice = shipment.price || 0;
        const sVol = shipment.items.reduce((acc, i) => acc + (i.volume_m3 || 0), 0);

        meta.totalRevenue = (meta.totalRevenue || 0) + sPrice;
        meta.totalVolume = (meta.totalVolume || 0) + sVol;

        if (meta.count === 1) { // Reset timestamp if it was empty/new
            // Check if it really was empty before? 
            // ZCARD is current count. 
            // If this is the first item, set TS.
            // If we just popped everything, count would be 0 before this.
            // But we are inside addShipment.
            // Safe logic: If timestamp is old (> 1day), reset it? 
            // Or simpler: If count is 1, set TS.
            meta.firstTimestamp = Date.now();
        } else {
            // Keep existing timestamp (Oldest item defines the wait)
            // But ensure we have one
            if (!meta.firstTimestamp) meta.firstTimestamp = Date.now();
        }

        await redis.set(metaKey, JSON.stringify(meta));

        console.log(`[Redis] Added ${shipment._id} to LANE ${laneKeySuffix}. Rev: $${meta.totalRevenue}, Vol: ${meta.totalVolume.toFixed(4)}`);
    }

    // ... (Legacy addShipment omitted) ...

    /**
     * Check if a cell is ready for Processing (Trigger Logic)
     */
    static async shouldProcess(h3Index: string): Promise<{ ready: boolean; reason?: 'VOLUME' | 'TIME' | 'REVENUE' }> {
        const metaKey = `${METADATA_PREFIX}${h3Index}`;
        const data = await redis.get(metaKey);

        if (!data) return { ready: false };

        const meta: CellMetadata = JSON.parse(data);
        const now = Date.now();
        const ageMinutes = (now - meta.firstTimestamp) / 1000 / 60;

        // --- PROFITABILITY TRIGGERS (Smart Batching) ---

        // 1. REVENUE TRIGGER: $6.000 ARS
        // Covers typical Driver Payout (Base $2800 + 5km * $600 = $5800)
        // Result: Profitable immediately.
        if ((meta.totalRevenue || 0) >= 6000) {
            return { ready: true, reason: 'REVENUE' };
        }

        // 2. VOLUME TRIGGER: 0.04 m3 (Half Moto Box)
        // Result: Efficient Fill.
        if ((meta.totalVolume || 0) >= 0.04) {
            return { ready: true, reason: 'VOLUME' };
        }

        // 3. TIME TRIGGER: 60 Minutes
        // Safety Valve.
        if (meta.count > 0 && ageMinutes >= 60) {
            return { ready: true, reason: 'TIME' };
        }

        return { ready: false };
    }

    /**
     * [RELIABLE POP STEP 1] Reserve Batch
     * Moves items from Main Queue to Processing List.
     * DOES NOT DELETE DATA.
     */
    static async reserveBatch(laneKey: string): Promise<{ processingId: string; shipments: GoingNetworkShipment[] }> {
        const queueKey = `${QUEUE_PREFIX}${laneKey}`;
        const BATCH_SIZE_LIMIT = 60;

        // 1. Get IDs (Sorted by Score = FIFO)
        const shipmentIds = await redis.zrange(queueKey, 0, BATCH_SIZE_LIMIT - 1);
        if (shipmentIds.length === 0) return { processingId: '', shipments: [] };

        // 2. Move to Connecting 'Processing' Key
        // key: processing:lane:{laneKey}:{processingId}
        const processingId = new ObjectId().toString();
        const processingKey = `processing:lane:${laneKey}:${processingId}`;

        // Store active IDs in processing list
        await redis.rpush(processingKey, ...shipmentIds);

        // Remove from Main Queue (so other workers don't pick them up)
        await redis.zrem(queueKey, ...shipmentIds);

        // Fetch Data
        const shipments: GoingNetworkShipment[] = [];
        const pipeline = redis.pipeline();
        for (const id of shipmentIds) {
            pipeline.get(`${SHIPMENT_DATA_PREFIX}${id}`);
        }

        const results = await pipeline.exec();
        if (results) {
            results.forEach(([err, result]) => {
                if (result && typeof result === 'string') {
                    shipments.push(JSON.parse(result));
                }
            });
        }

        console.log(`[Redis] Reserved ${shipments.length} shipments from ${laneKey} (ProcID: ${processingId})`);
        return { processingId, shipments };
    }

    /**
     * [RELIABLE POP STEP 2] Acknowledge Batch
     * Permanently deletes data from Redis after successful DB save.
     */
    static async ackBatch(laneKey: string, processingId: string): Promise<void> {
        const processingKey = `processing:lane:${laneKey}:${processingId}`;
        const metaKey = `${METADATA_PREFIX}${laneKey}`;

        // 1. Get IDs to clean up data keys
        const shipmentIds = await redis.lrange(processingKey, 0, -1);

        if (shipmentIds.length > 0) {
            const dataKeys = shipmentIds.map(id => `${SHIPMENT_DATA_PREFIX}${id}`);
            await redis.del(...dataKeys);
        }

        // 2. Remove Processing Key
        await redis.del(processingKey);

        // 3. Update Metadata if queue is empty (Optional cleanliness)
        const remainingCount = await redis.zcard(`${QUEUE_PREFIX}${laneKey}`);
        if (remainingCount === 0) {
            await redis.del(metaKey);
        }

        console.log(`[Redis] Ack'd Batch ${processingId} (Lane: ${laneKey}). Data cleaned.`);
    }

    /**
     * Scan for all Active H3 Cells (that have metadata)
     * This allows the worker to know WHICH cells to check without polling the entire world.
     */
    static async scanActiveCells(): Promise<string[]> {
        const stream = redis.scanStream({
            match: `${METADATA_PREFIX}*`,
            count: 100
        });

        const keys: string[] = [];
        for await (const chunk of stream) {
            keys.push(...chunk);
        }

        // Extract H3 Index from Key
        return keys.map(k => k.replace(METADATA_PREFIX, ''));
    }
}
