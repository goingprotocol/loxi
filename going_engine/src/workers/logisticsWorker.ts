
import { RedisQueue } from '../lib/redisQueue';
import { LogisticsEngine } from '../logisticsEngine';
import { createRedisDriverRepository } from '../repositories/redisDriverRepository';
import { MongoClient, ObjectId } from 'mongodb';
import { Batch } from '../interfaces';
import { EmailService } from '../lib/emailService';

// Worker Configuration
const POLLING_INTERVAL_MS = 10 * 1000; // 10 seconds (Active Check)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_GOING || 'going_db_v2';
const REDIS_URL = process.env.REDIS_PUBLIC_ENDPOINT || 'redis://localhost:6379';
const REDIS_PASS = process.env.REDIS_PASSWORD;

let dbClient: MongoClient;

/**
 * The Logistics Worker
 * Responsibilities:
 * 1. Scan Redis for "Active Cells" (Cells with pending shipments).
 * 2. Check if a Cell is "Ready" (Volume > 50 OR Time > 10m).
 * 3. Reserve (Pop) shipments using RELIABLE PATTERN.
 * 4. Pass to LogisticsQueueEngine.
 * 5. Save resultant Batches to MongoDB.
 * 6. ACK (Confirm) to Redis only if Save succeeds.
 */
async function startWorker() {
    console.log('[Worker] Starting Logistics Worker...');

    // Connect to Mongo
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        console.log('[Worker] Connected to MongoDB');
    } catch (e) {
        console.error('[Worker] Fatal: Failed to connect to Mongo', e);
        process.exit(1);
    }

    const db = dbClient.db(DB_NAME);
    const batchesCollection = db.collection<Batch>('batches');

    // Create Driver Repository (For Check Availability)
    const driverRepo = createRedisDriverRepository(REDIS_URL, db, REDIS_PASS);

    // Main Loop
    setInterval(async () => {
        try {
            // 1. Scan Active Lanes
            const activeLanes = await RedisQueue.scanActiveCells();
            if (activeLanes.length === 0) return; // Silent sleep

            // 2. Iterate Lanes
            for (const laneKey of activeLanes) {
                const { ready, reason } = await RedisQueue.shouldProcess(laneKey);

                if (ready) {
                    console.log(`[Worker] Lane ${laneKey} is READY (Trigger: ${reason})`);

                    // 3. RESERVE Batch (Reliable Pop)
                    // Data is moved to 'processing' list but NOT deleted.
                    const { processingId, shipments } = await RedisQueue.reserveBatch(laneKey);

                    if (shipments.length === 0) continue;

                    console.log(`[Worker] Processing batch ${processingId} with ${shipments.length} shipments (Lane: ${laneKey})...`);

                    // 4. Process (Create Routes/Batches)
                    const newBatches = await LogisticsEngine.processRedisBatch(shipments, laneKey, driverRepo, db);

                    if (newBatches.length > 0) {
                        try {
                            // 5. Save to MongoDB
                            const result = await batchesCollection.insertMany(newBatches as any);
                            console.log(`[Worker] Saved ${result.insertedCount} batches to DB.`);

                            // 6. ACK (Commit) - Delete from Redis
                            await RedisQueue.ackBatch(laneKey, processingId);
                            console.log(`[Worker] Batch ${processingId} ACK'd successfully.`);

                        } catch (dbError) {
                            console.error('[Worker] DB Save Failed. Shipments remain in Processing List (Safe).', dbError);
                            // Critical: We do NOT Ack. Data stays in 'processing:lane:...'
                            // Future: A 'Stale Processing Monitor' will pick these up.
                            // For MVP: We could attempt immediate retry or just log.
                        }
                    } else {
                        console.warn(`[Worker] Batches returned empty for ${shipments.length} shipments. Logic filtered them out? Checking POISON LOGIC.`);

                        // Handle Logical Rejections (Empty Batches returned by Engine)
                        // If Engine returns [], it usually means "Wait" or "Invalid Data".
                        // But since we already 'Reserved' them, we must decide what to do.
                        // Ideally: Re-queue with incremented retry count.

                        // Since we have a 'processingId', we can just drop it if we want to discard?
                        // NO, we must re-queue or they are lost in limbo.

                        // Strategy: NACK (Manual Re-queue)
                        // We put them back into the MAIN QUEUE.

                        const [origin, dest] = laneKey.split(':');
                        if (origin && dest) {
                            // Clean up the 'processing' state (Manual NACK)
                            // Since we don't have a 'nack' method, we have to do it manually or fail.
                            // Actually, let's treat this as a "Soft Fail" -> Re-queue.

                            console.log(`[Worker] Re-queuing shipments from empty batch...`);

                            for (const s of shipments) {
                                // Simplified Retry Logic for MVP
                                // We re-add them to the main queue. 
                                // In a robust system, we would increment retry count inside the object before saving.
                                const currentRetries = (s as any)._retryCount || 0;

                                if (currentRetries >= 3) {
                                    // Poison Logic
                                    // ... (Same Poison Logic as before) ...
                                    // For now, let's just log and move to failed_shipments
                                    await db.collection('failed_shipments').insertOne({ ...s, reason: 'ENGINE_RETURNED_EMPTY', failedAt: new Date() });
                                    if (s._id) {
                                        await db.collection('shipments').updateOne({ _id: new ObjectId(s._id as any) }, { $set: { status: 'failed', failureReason: 'Engine Processing Failed' } });
                                    }
                                } else {
                                    await RedisQueue.addShipmentToLane(s, origin, dest, currentRetries + 1);
                                }
                            }

                            // After re-queuing (or DLQing), we can safely DELETE the processing key (ACK)
                            await RedisQueue.ackBatch(laneKey, processingId);
                        } else {
                            console.error(`[Worker] Failed to parse laneKey. Cannot re-queue. Dropping.`);
                            // If we can't parse lane, we can't re-queue properly. 
                            // Just Ack to clean up the mess? Or leave for manual debug?
                            // Ack to avoid leak.
                            await RedisQueue.ackBatch(laneKey, processingId);
                        }
                    }
                }
            }

        } catch (error) {
            console.error('[Worker] Error in loop:', error);
        }
    }, POLLING_INTERVAL_MS);
}

// Start
startWorker();
