import { createClient } from 'redis';
import { ObjectId, Db } from 'mongodb';
import { Batch, DriverStatus } from '../interfaces';
import { DriverRepository } from '../repositories/driverRepository';

export class OfferService {
    private redis: any;
    private db: Db;
    private driverRepo: DriverRepository;
    private readonly OFFER_TTL_SECONDS = 30;

    constructor(redisUrl: string, db: Db, driverRepo: DriverRepository) {
        this.redis = createClient({ url: redisUrl, password: process.env.REDIS_PASSWORD || undefined });
        this.redis.connect().catch(console.error);
        this.db = db;
        this.driverRepo = driverRepo;
    }

    /**
     * Creates a new Flash Offer for a specific driver.
     * Stores in Redis: 
     * 1. offer:{batchId}:{driverId} -> timestamp (The Offer itself)
     * 2. driver_active_offer:{driverId} -> batchId (Lock to prevent spam)
     */
    async createOffer(batchId: string, driverId: string): Promise<boolean> {
        try {
            const offerKey = `offer:${batchId}:${driverId}`;
            const driverLockKey = `driver_active_offer:${driverId}`;

            const multi = this.redis.multi();
            multi.set(offerKey, Date.now().toString(), { EX: this.OFFER_TTL_SECONDS });
            multi.set(driverLockKey, batchId, { EX: this.OFFER_TTL_SECONDS });
            await multi.exec();

            console.log(`[OfferService] Created offer for Batch ${batchId} -> Driver ${driverId} (TTL 30s)`);
            return true;
        } catch (e) {
            console.error('[OfferService] Failed to create offer', e);
            return false;
        }
    }

    /**
     * Checks if a driver already has a pending offer.
     */
    async hasActiveOffer(driverId: string): Promise<boolean> {
        const driverLockKey = `driver_active_offer:${driverId}`;
        const exists = await this.redis.exists(driverLockKey);
        return exists === 1;
    }

    /**
     * Attempts to Accept an offer.
     * Returns the Batch if successful, or null if expired/taken.
     */
    async acceptOffer(batchId: string, driverId: string): Promise<{ success: boolean; batch?: Batch; error?: string }> {
        const key = `offer:${batchId}:${driverId}`;
        const isValid = await this.redis.get(key);

        if (!isValid) {
            return { success: false, error: 'Offer expired or invalid.' };
        }

        // 1. Double Check: Is batch still pending? (Race condition check)
        const batch = await this.db.collection<Batch>('batches').findOne({
            _id: new ObjectId(batchId),
            status: { $in: ['offered', 'pending_assignment'] } // Acceptable statuses
        });

        if (!batch) {
            return { success: false, error: 'Batch no longer available.' };
        }

        if (batch.assignedCollectorId && batch.assignedCollectorId !== driverId) {
            return { success: false, error: 'Batch was taken by another driver.' };
        }

        // 2. Assign Driver
        await this.db.collection<Batch>('batches').updateOne(
            { _id: new ObjectId(batchId) },
            {
                $set: {
                    status: 'assigned',
                    assignedCollectorId: driverId,
                    updatedAt: new Date()
                }
            }
        );

        // 3. Cleanup Offer & Lock
        const driverLockKey = `driver_active_offer:${driverId}`;
        await this.redis.del([key, driverLockKey]);

        // 4. Update Driver Status
        await this.driverRepo.updateStatus(driverId, 'COLLECTING_BATCH');
        await this.driverRepo.update(driverId, { activeBatchId: batchId });

        return { success: true, batch };
    }

    /**
     * Checks if we are allowed to make an offer.
     * Prevents:
     * 1. Spamming a driver who already has an offer.
     * 2. Nagging a driver who recently rejected this specific batch.
     */
    async canMakeOffer(batchId: string, driverId: string): Promise<boolean> {
        const driverLockKey = `driver_active_offer:${driverId}`;
        const rejectionKey = `rejected:${batchId}:${driverId}`;

        const [hasActive, wasRejected] = await Promise.all([
            this.redis.exists(driverLockKey),
            this.redis.exists(rejectionKey)
        ]);

        if (hasActive) return false;
        if (wasRejected) return false;

        return true;
    }

    /**
     * Driver specifically rejected the offer.
     * We remove the key so the Engine can immediately look for someone else.
     * Starts a cooldown so we don't nag them with the same batch.
     */
    async rejectOffer(batchId: string, driverId: string): Promise<boolean> {
        const key = `offer:${batchId}:${driverId}`;
        const driverLockKey = `driver_active_offer:${driverId}`;
        const rejectionKey = `rejected:${batchId}:${driverId}`;

        await this.redis.del([key, driverLockKey]);

        // Add to Rejection Cooldown (5 Minutes)
        await this.redis.set(rejectionKey, '1', { EX: 300 });

        // Also update Batch status back to pending_assignment so it's visible again?
        // Or does the Engine handle specific re-pool logic?
        // Engine loop only sees 'pending_assignment'.
        // If we left it as 'offered', it needs to be reset.

        await this.db.collection<Batch>('batches').updateOne(
            { _id: new ObjectId(batchId) },
            { $set: { status: 'pending_assignment', updatedAt: new Date() } }
        );

        return true;
    }
}
