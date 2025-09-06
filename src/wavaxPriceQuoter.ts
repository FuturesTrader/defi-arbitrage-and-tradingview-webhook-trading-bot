// src/wavaxPriceQuoter.ts
// Lightweight WAVAX/USDC price quoter that runs independently of main services

import {
    createPublicClient,
    http,
    parseUnits,
    type PublicClient
} from 'viem';
import { avalanche } from 'viem/chains';
import {
    CurrencyAmount,
} from '@uniswap/sdk-core';
import {
    Pool,
    TICK_SPACINGS
} from '@uniswap/v3-sdk';

import { TOKENS, ABIS, ADDRESSES, GAS_OPTIMIZATION } from './constants';
import { getErrorMessage } from './utils';
import logger from './logger';
import dotenv from 'dotenv';
dotenv.config();

// Define the interface for our price quoter
interface IPriceQuoter {
    getPrice(): Promise<number>;
    updatePrice(): Promise<number>;
}

class WavaxPriceQuoter implements IPriceQuoter {
    private static instance: WavaxPriceQuoter;
    private publicClient: PublicClient;
    private lastPrice: number = GAS_OPTIMIZATION.NATIVE_PRICE_IN_USDC;
    private lastUpdateTime: number = 0;
    private updateIntervalMs: number = 5 * 60 * 1000; // 5 minutes
    private isUpdating: boolean = false;

    private constructor() {
        this.publicClient = createPublicClient({
            chain: avalanche,
            transport: http(process.env.AVALANCHE_RPC_URL as string)
        });

        try {
            if (logger && typeof logger.info === 'function') {
                logger.info('WavaxPriceQuoter initialized', {
                    initialPrice: this.lastPrice
                });
            } else {
                console.log('WavaxPriceQuoter initialized with initial price:', this.lastPrice);
            }
        } catch (error) {
            console.log('Could not log initialization of WavaxPriceQuoter:', error);
        }

        // Schedule regular updates
        this.scheduleUpdate();
    }

    public static getInstance(): WavaxPriceQuoter {
        if (!WavaxPriceQuoter.instance) {
            WavaxPriceQuoter.instance = new WavaxPriceQuoter();
        }
        return WavaxPriceQuoter.instance;
    }

    /**
     * Get the current WAVAX price in USDC
     * Returns cached price if recent, or triggers update if stale
     */
    public async getPrice(): Promise<number> {
        const now = Date.now();

        // If price is stale and not currently updating, trigger update
        if (now - this.lastUpdateTime > this.updateIntervalMs && !this.isUpdating) {
            try {
                await this.updatePrice();
            } catch (error) {
                logger.warn('Failed to update WAVAX price', {
                    error: getErrorMessage(error)
                });
                // Continue with cached price
            }
        }

        return this.lastPrice;
    }

    /**
     * Creates minimal bounding ticks for a single tick range.
     */
    private createWideBoundingTicks(
        currentTick: number,
        liquidity: bigint,
        tickSpacing: number,
        rangeInTickSteps: number
    ) {
        // Lower bound
        const tickLowerIndex = Math.floor(currentTick / tickSpacing) - rangeInTickSteps;
        // Make sure we stay above MIN_TICK in Uniswap V3 if needed
        const tickLower = tickLowerIndex * tickSpacing;

        // Upper bound
        const tickUpperIndex = Math.floor(currentTick / tickSpacing) + rangeInTickSteps;
        // Make sure we stay below MAX_TICK
        const tickUpper = tickUpperIndex * tickSpacing;

        return [
            {
                index: tickLower,
                liquidityNet: liquidity.toString(),
                liquidityGross: liquidity.toString(),
            },
            {
                index: tickUpper,
                liquidityNet: (-liquidity).toString(),
                liquidityGross: liquidity.toString(),
            }
        ];
    }

    /**
     * Manually trigger a price update
     */
    public async updatePrice(): Promise<number> {
        if (this.isUpdating) {
            logger.debug('Price update already in progress');
            return this.lastPrice;
        }

        this.isUpdating = true;
        try {
            // Get pool data first
            const poolData = await this.getPoolData();

            // If pool data is valid, calculate price
            if (poolData) {
                // Lookup tick spacing based on fee
                const fee = poolData.fee;
                const tickSpacing = TICK_SPACINGS[fee as keyof typeof TICK_SPACINGS];
                const rangeInTickSteps = 1000; // Wide range for pricing

                // Create bounding ticks - this is what was missing
                const boundingTicks = this.createWideBoundingTicks(
                    poolData.tick,
                    poolData.liquidity,
                    tickSpacing,
                    rangeInTickSteps
                );

                // Create a Pool instance with bounding ticks
                const pool = new Pool(
                    TOKENS.USDC_UNI,
                    TOKENS.WAVAX_UNI,
                    poolData.fee,
                    poolData.sqrtPriceX96.toString(),
                    poolData.liquidity.toString(),
                    poolData.tick,
                    boundingTicks // Added bounding ticks here
                );

                // Create input amount for 1 WAVAX
                const inputAmount = CurrencyAmount.fromRawAmount(
                    TOKENS.WAVAX_UNI,
                    parseUnits('1', TOKENS.WAVAX_UNI.decimals).toString()
                );

                // Calculate output amount for 1 WAVAX
                try {
                    const [outputAmount] = await pool.getOutputAmount(inputAmount);
                    const price = parseFloat(outputAmount.toExact());

                    // Apply sanity check on price
                    if (this.isPriceReasonable(price)) {
                        this.lastPrice = price;
                        this.lastUpdateTime = Date.now();

                        logger.info('WAVAX/USDC price updated', {
                            price: this.lastPrice
                        });
                    } else {
                        logger.warn('Received unreasonable WAVAX price, ignoring', {
                            price,
                            currentPrice: this.lastPrice
                        });
                    }
                } catch (error) {
                    logger.error('Error calculating WAVAX price', {
                        error: getErrorMessage(error)
                    });
                }
            }
        } catch (error) {
            logger.error('Failed to update WAVAX price', {
                error: getErrorMessage(error)
            });
        } finally {
            this.isUpdating = false;
        }

        return this.lastPrice;
    }

    /**
     * Check if price is within reasonable bounds
     */
    private isPriceReasonable(price: number): boolean {
        // Price must be positive
        if (price <= 0) return false;

        // If we have a previous price, check if the new price is within ±50%
        if (this.lastPrice > 0) {
            const maxPrice = this.lastPrice * 1.5;
            const minPrice = this.lastPrice * 0.5;
            return price >= minPrice && price <= maxPrice;
        }

        // For first price, accept anything between $5 and $50
        return price >= 5 && price <= 50;
    }

    /**
     * Get pool data from the USDC/WAVAX pool
     */
    private async getPoolData(): Promise<{
        token0: `0x${string}`;
        token1: `0x${string}`;
        fee: number;
        sqrtPriceX96: bigint;
        liquidity: bigint;
        tick: number;
    } | null> {
        try {
            const poolAddress = ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX;

            // Get slot0 data
            const slot0Data = await this.publicClient.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'slot0'
            }) as [bigint, number, number, number, number, number, boolean];

            // Get liquidity
            const liquidity = await this.publicClient.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'liquidity'
            }) as bigint;

            // Get fee
            const fee = await this.publicClient.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'fee'
            }) as number;

            return {
                token0: TOKENS.USDC_UNI.address as `0x${string}`,
                token1: TOKENS.WAVAX_UNI.address as `0x${string}`,
                fee,
                sqrtPriceX96: slot0Data[0],
                liquidity,
                tick: slot0Data[1]
            };
        } catch (error) {
            logger.error('Failed to get pool data', {
                error: getErrorMessage(error)
            });
            return null;
        }
    }

    /**
     * Schedule the next price update
     */
    private scheduleUpdate(): void {
        setTimeout(async () => {
            try {
                await this.updatePrice();
            } catch (error) {
                logger.error('Error in scheduled price update', {
                    error: getErrorMessage(error)
                });
            } finally {
                // Schedule next update regardless of success/failure
                this.scheduleUpdate();
            }
        }, this.updateIntervalMs);
    }
}

// Create and export the singleton instance - with error handling
let wavaxPriceQuoterInstance: WavaxPriceQuoter | null = null;
try {
    wavaxPriceQuoterInstance = WavaxPriceQuoter.getInstance();
} catch (error) {
    console.error('Error initializing WavaxPriceQuoter:', error);
}

// Export the instance or a fallback implementation
export const wavaxPriceQuoter: IPriceQuoter = wavaxPriceQuoterInstance || {
    getPrice: async (): Promise<number> => GAS_OPTIMIZATION.NATIVE_PRICE_IN_USDC,
    updatePrice: async (): Promise<number> => GAS_OPTIMIZATION.NATIVE_PRICE_IN_USDC
};

// If this file is run directly, update and log the price
if (import.meta.url === `file://${process.argv[1]}`) {
    wavaxPriceQuoter.updatePrice()
        .then((price: number) => {
            console.log(`Current WAVAX price in USDC: ${price}`);
            process.exit(0);
        })
        .catch((error: Error) => {
            console.error('Error getting WAVAX price:', error);
            process.exit(1);
        });
}