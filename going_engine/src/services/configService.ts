import { Db, ChangeStream } from 'mongodb';

export interface PricingRule {
    _id?: string;
    country: string; // 'AR', 'US'
    currency: 'USD' | 'ARS';
    vehicles: {
        motorcycle: {
            baseFee: number;
            baseDistanceKm: number;
            costPerKm: number;
            baseWeightKg: number;
            costPerKg: number;
        };
        van: {
            baseFeeSmall: number;
            baseFeeMedium: number;
            baseFeeLarge: number;
            baseDistanceKm: number;
            costPerKm: number;
            baseWeightKg: number;
            costPerKg: number;
        };
    };
    effectiveDate: Date;
}

const FALLBACK_RULES: Record<string, PricingRule> = {
    'AR': {
        country: 'AR',
        currency: 'ARS',
        vehicles: {
            motorcycle: {
                baseFee: 2100,
                baseDistanceKm: 3,
                costPerKm: 500,
                baseWeightKg: 5,
                costPerKg: 100
            },
            van: {
                baseFeeSmall: 8000,
                baseFeeMedium: 10000,
                baseFeeLarge: 15000,
                baseDistanceKm: 10,
                costPerKm: 1200,
                baseWeightKg: 50,
                costPerKg: 150
            }
        },
        effectiveDate: new Date()
    },
    'US': {
        country: 'US',
        currency: 'USD',
        vehicles: {
            motorcycle: {
                baseFee: 7.00,
                baseDistanceKm: 3,
                costPerKm: 1.50,
                baseWeightKg: 5,
                costPerKg: 1.00
            },
            van: {
                baseFeeSmall: 12.00,
                baseFeeMedium: 15.00,
                baseFeeLarge: 25.00,
                baseDistanceKm: 10,
                costPerKm: 2.50,
                baseWeightKg: 50,
                costPerKg: 2.00
            }
        },
        effectiveDate: new Date()
    }
};

export class ConfigService {
    private static instance: ConfigService;
    private pricingRules: Map<string, PricingRule> = new Map();
    private loaded: boolean = false;
    private changeStream: ChangeStream | null = null;

    private constructor() { }

    static getInstance(): ConfigService {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }

    async loadPricingRules(db: Db): Promise<void> {
        try {
            console.log('[ConfigService] Loading pricing rules form DB...');
            // Fetch all rules, sorted by date desc
            const rules = await db.collection<PricingRule>('pricing_rules')
                .find({})
                .sort({ effectiveDate: -1 })
                .toArray();

            // Store latest per country
            // Since we sorted by date desc, the first one we see for a country is the latest.
            rules.forEach(r => {
                if (!this.pricingRules.has(r.country)) {
                    this.pricingRules.set(r.country, r);
                    console.log(`[ConfigService] Loaded Rule for ${r.country}: Base Moto ${r.vehicles.motorcycle.baseFee} ${r.currency}`);
                }
            });

            this.loaded = true;
        } catch (error) {
            console.error('[ConfigService] Failed to load pricing rules from DB. Using Fallbacks.', error);
        }
    }

    /**
     * Start watching for changes in pricing_rules
     * HOT RELOAD: Updates internal cache on DB insert/update.
     */
    async startWatching(db: Db): Promise<void> {
        if (this.changeStream) {
            console.warn('[ConfigService] Watcher already active.');
            return;
        }

        try {
            const collection = db.collection('pricing_rules');
            this.changeStream = collection.watch([], { fullDocument: 'updateLookup' });

            console.log('[ConfigService] Hot Reload Active: Listening for Pricing changes...');

            this.changeStream.on('change', async (change) => {
                if (change.operationType === 'insert' || change.operationType === 'update' || change.operationType === 'replace') {
                    console.log(`[ConfigService] HOT RELOAD DETECTED (${change.operationType}). Refreshing rules...`);
                    // Reload everything to be safe and simple
                    // Optimization: We could just update the specific rule changed, but full reload is safer for precedence logic.
                    this.pricingRules.clear(); // Clear cache to allow new rule to take precedence
                    await this.loadPricingRules(db);
                }
            });

            this.changeStream.on('error', (err) => {
                console.error('[ConfigService] ChangeStream Error:', err);
                // Simple reconnection logic could go here, or just log fatal.
            });

        } catch (error) {
            console.warn('[ConfigService] Failed to start ChangeStream (Replica Set required). Hot Reload disabled.');
        }
    }

    getPricing(countryCode: string = 'AR'): PricingRule {
        if (this.pricingRules.has(countryCode)) {
            return this.pricingRules.get(countryCode)!;
        }
        // Fallback or verify if loaded
        if (!this.loaded) {
            console.warn('[ConfigService] Pricing not loaded yet (or DB fail). Using Hardcoded Fallback.');
        } else {
            console.warn(`[ConfigService] No rule for ${countryCode}. Using Fallback.`);
        }

        return FALLBACK_RULES[countryCode] || FALLBACK_RULES['AR']; // Default to AR for this project
    }
}
