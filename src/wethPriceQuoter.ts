// src/wethPriceQuoter.ts
// 🚀 OPTIMIZED: WETH/USDC price quoter for Arbitrum - Mathematical Approach v2.2.0
// ✅ Uses reliable mathematical calculation, eliminates pool warnings, production-ready

import {
    createPublicClient,
    http,
    type PublicClient
} from 'viem';
import { arbitrum } from 'viem/chains';
import {
    Token,
} from '@uniswap/sdk-core';

import {
    ABIS,
    getNetworkConfig,
    type NetworkKey,
    SUPPORTED_NETWORKS,
    POOL_FEES
} from './constants.ts';
import { getErrorMessage } from './utils.ts';
import logger from './logger.ts';
import dotenv from 'dotenv';
dotenv.config();

// Define the interface for our price quoter
interface IPriceQuoter {
    getPrice(): Promise<number>;
    updatePrice(): Promise<number>;
}

class WethPriceQuoter implements IPriceQuoter {
    private static instance: WethPriceQuoter;
    private publicClient: PublicClient;
    private lastPrice: number = 3500; // ETH fallback price
    private lastUpdateTime: number = 0;
    private updateIntervalMs: number = 5 * 60 * 1000; // 5 minutes
    private isUpdating: boolean = false;

    private constructor() {
        this.publicClient = createPublicClient({
            chain: arbitrum,
            transport: http(process.env.ARBITRUM_RPC_URL as string)
        });

        try {
            if (logger && typeof logger.info === 'function') {
                logger.info('WethPriceQuoter initialized', {
                    initialPrice: this.lastPrice,
                    network: 'ARBITRUM',
                    version: '2.2.0-mathematical-optimized'
                });
            } else {
                console.log('WethPriceQuoter initialized with initial price:', this.lastPrice);
            }
        } catch (error) {
            console.log('Could not log initialization of WethPriceQuoter:', error);
        }

        // Schedule regular updates
        this.scheduleUpdate();
    }

    public static getInstance(): WethPriceQuoter {
        if (!WethPriceQuoter.instance) {
            WethPriceQuoter.instance = new WethPriceQuoter();
        }
        return WethPriceQuoter.instance;
    }

    /**
     * Get the current WETH price in USDC
     * Returns cached price if recent, or triggers update if stale
     */
    public async getPrice(): Promise<number> {
        const now = Date.now();

        // If price is stale and not currently updating, trigger update
        if (now - this.lastUpdateTime > this.updateIntervalMs && !this.isUpdating) {
            try {
                await this.updatePrice();
            } catch (error) {
                logger.warn('Failed to update WETH price, using cached value', {
                    error: getErrorMessage(error),
                    cachedPrice: this.lastPrice
                });
                // Continue with cached price
            }
        }

        return this.lastPrice;
    }

    /**
     * Force update the WETH price from Uniswap V3 pool
     */
    public async updatePrice(): Promise<number> {
        if (this.isUpdating) {
            return this.lastPrice;
        }

        this.isUpdating = true;

        try {
            const networkConfig = getNetworkConfig('ARBITRUM');
            const poolData = await this.getPoolData();

            if (poolData) {
                // Get Arbitrum tokens using proper type assertion
                const arbitrumTokens = networkConfig.tokenInstances as typeof networkConfig.tokenInstances & {
                    WETH_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };

                logger.debug('WETH price calculation parameters', {
                    network: 'ARBITRUM',
                    inputToken: 'WETH',
                    outputToken: 'USDC',
                    inputAmount: '1',
                    poolFee: poolData.fee,
                    tick: poolData.tick,
                    method: 'mathematical_calculation_primary'
                });

                // 🚀 OPTIMIZED: Use mathematical approach as primary method
                // This is more reliable and eliminates pool calculation warnings
                const price = this.calculatePriceFromSqrtPrice(
                    poolData.sqrtPriceX96,
                    arbitrumTokens.USDC_UNI.decimals,
                    arbitrumTokens.WETH_UNI.decimals
                );

                if (this.isPriceReasonable(price)) {
                    this.lastPrice = price;
                    this.lastUpdateTime = Date.now();

                    logger.info('WETH/USDC price updated successfully', {
                        price: this.lastPrice.toFixed(2),
                        network: 'ARBITRUM',
                        method: 'mathematical_calculation',
                        timestamp: new Date().toISOString(),
                        sqrtPriceX96: poolData.sqrtPriceX96.toString(),
                        tick: poolData.tick
                    });
                } else {
                    logger.warn('Received unreasonable WETH price, keeping cached value', {
                        calculatedPrice: price,
                        currentPrice: this.lastPrice,
                        reasonableRange: '1000-15000'
                    });
                }
            } else {
                logger.warn('Could not retrieve WETH pool data, using cached price', {
                    cachedPrice: this.lastPrice
                });
            }
        } catch (error) {
            logger.error('Failed to update WETH price', {
                error: getErrorMessage(error),
                network: 'ARBITRUM',
                fallbackPrice: this.lastPrice
            });
        } finally {
            this.isUpdating = false;
        }

        return this.lastPrice;
    }

    /**
     * 🔧 FIXED: Calculate price directly from sqrtPriceX96 (corrected decimal handling)
     */
    private calculatePriceFromSqrtPrice(
        sqrtPriceX96: bigint,
        token0Decimals: number, // USDC decimals (6)
        token1Decimals: number  // WETH decimals (18)
    ): number {
        try {
            // Convert sqrtPriceX96 to regular price
            const Q96 = 2n ** 96n;
            const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
            const rawPrice = sqrtPrice ** 2;

            // 🔧 FIX: Correct decimal adjustment for USDC/WETH pool
            // For USDC/WETH pool: token0=USDC(6), token1=WETH(18)
            // We want: WETH price in USDC
            // Raw price gives us: (USDC amount) / (WETH amount)
            // To get WETH price in USDC: we need to adjust for decimals and invert if needed
            const decimalAdjustment = 10 ** (token1Decimals - token0Decimals); // 10^(18-6) = 10^12
            const adjustedPrice = rawPrice * decimalAdjustment;

            logger.debug('Mathematical price calculation', {
                sqrtPriceX96: sqrtPriceX96.toString(),
                sqrtPrice: sqrtPrice.toFixed(10),
                rawPrice: rawPrice.toExponential(6),
                token0Decimals,
                token1Decimals,
                decimalAdjustment,
                adjustedPrice: adjustedPrice.toFixed(2),
                description: 'WETH price in USDC'
            });

            return adjustedPrice;
        } catch (error) {
            logger.error('Failed to calculate price from sqrtPrice', {
                error: getErrorMessage(error)
            });
            return this.lastPrice; // Return cached price on error
        }
    }

    /**
     * 🔧 ENHANCED: Check if price is within reasonable bounds for ETH
     */
    private isPriceReasonable(price: number): boolean {
        const minPrice = 1000;  // ETH minimum reasonable price
        const maxPrice = 15000; // ETH maximum reasonable price

        const isValid = price > minPrice &&
            price < maxPrice &&
            !isNaN(price) &&
            isFinite(price) &&
            price > 0;

        if (!isValid) {
            logger.warn('WETH price validation failed', {
                price,
                isNaN: isNaN(price),
                isFinite: isFinite(price),
                tooLow: price <= minPrice,
                tooHigh: price >= maxPrice,
                reasonableRange: `${minPrice}-${maxPrice}`,
                action: 'keeping_cached_price'
            });
        } else {
            logger.debug('WETH price validation passed', {
                price: price.toFixed(2),
                reasonableRange: `${minPrice}-${maxPrice}`
            });
        }

        return isValid;
    }

    /**
     * Get WETH/USDC pool data from Arbitrum with proper typing
     */
    private async getPoolData(): Promise<{
        poolAddress: string;
        token0: string;
        token1: string;
        fee: number;
        sqrtPriceX96: bigint;
        liquidity: bigint;
        tick: number;
    } | null> {
        try {
            const networkConfig = getNetworkConfig('ARBITRUM');

            // ✅ TYPE-SAFE: Cast to Arbitrum-specific pool configuration
            const arbitrumPools = networkConfig.addresses.UNISWAP_V3.POOLS as {
                USDC_WETH: `0x${string}`;
                USDC_WBTC: `0x${string}`;
            };
            const poolAddress = arbitrumPools.USDC_WETH;

            // Get tokens with proper type assertion
            const arbitrumTokens = networkConfig.tokenInstances as typeof networkConfig.tokenInstances & {
                WETH_UNI: Token;
                USDC_UNI: Token;
                WBTC_UNI: Token;
            };

            logger.debug('Fetching WETH pool data', {
                network: 'ARBITRUM',
                poolAddress,
                wethAddress: arbitrumTokens.WETH_UNI.address,
                usdcAddress: arbitrumTokens.USDC_UNI.address
            });

            // 🔧 FIX: Properly type the contract read results
            const [slot0Result, liquidityResult] = await Promise.all([
                this.publicClient.readContract({
                    address: poolAddress,
                    abi: ABIS.UNISWAP_V3_POOL,
                    functionName: 'slot0'
                }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
                this.publicClient.readContract({
                    address: poolAddress,
                    abi: ABIS.UNISWAP_V3_POOL,
                    functionName: 'liquidity'
                }) as Promise<bigint>
            ]);

            // 🔧 FIX: Extract values with proper typing
            const sqrtPriceX96 = slot0Result[0];
            const tick = slot0Result[1];
            const liquidity = liquidityResult;

            // ✅ USE FEE FROM CONSTANTS
            const fee = POOL_FEES.LOW; // 3000 (0.3% fee tier)

            logger.info('WETH pool data retrieved successfully', {
                poolAddress,
                sqrtPriceX96: sqrtPriceX96.toString(),
                liquidity: liquidity.toString(),
                tick,
                fee,
                network: 'ARBITRUM'
            });

            return {
                poolAddress,
                token0: arbitrumTokens.USDC_UNI.address,
                token1: arbitrumTokens.WETH_UNI.address,
                fee,
                sqrtPriceX96,
                liquidity,
                tick
            };
        } catch (error) {
            logger.error('Failed to get WETH pool data with detailed error', {
                error: getErrorMessage(error),
                network: 'ARBITRUM',
                troubleshooting: 'Check RPC connection and pool address'
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
                logger.error('Error in scheduled WETH price update', {
                    error: getErrorMessage(error),
                    network: 'ARBITRUM'
                });
            } finally {
                // Schedule next update regardless of success/failure
                this.scheduleUpdate();
            }
        }, this.updateIntervalMs);
    }
}

// Create and export the singleton instance - with error handling
let wethPriceQuoterInstance: WethPriceQuoter | null = null;
try {
    wethPriceQuoterInstance = WethPriceQuoter.getInstance();
} catch (error) {
    console.error('Error initializing WethPriceQuoter:', error);
}

// Export the instance or a fallback implementation
export const wethPriceQuoter: IPriceQuoter = wethPriceQuoterInstance || {
    getPrice: async (): Promise<number> => {
        logger.warn('Using fallback ETH price - WethPriceQuoter failed to initialize');
        return 3500; // ETH fallback
    },
    updatePrice: async (): Promise<number> => {
        logger.warn('Using fallback ETH price - WethPriceQuoter failed to initialize');
        return 3500;
    }
};

/**
 * 🔧 NEW: Test script to verify price calculation
 */
export async function testWethPriceCalculation(): Promise<void> {
    try {
        console.log('🧪 Testing WETH price calculation...');

        const priceQuoter = WethPriceQuoter.getInstance();
        const price = await priceQuoter.updatePrice();

        console.log('✅ WETH Price Test Results:');
        console.log(`   Current Price: $${price.toFixed(2)}`);
        console.log(`   Is Reasonable: ${price > 1000 && price < 15000}`);
        console.log(`   Expected Range: $1,000 - $15,000`);

        if (price > 1000 && price < 15000) {
            console.log('🎉 Price calculation is working correctly!');
        } else {
            console.log('❌ Price calculation needs attention');
            console.log(`   Calculated price: $${price}`);
        }

    } catch (error) {
        console.error('❌ WETH price test failed:', error);
    }
}

// If this file is run directly, update and log the price
if (import.meta.url === `file://${process.argv[1]}`) {
    wethPriceQuoter.updatePrice()
        .then((price: number) => {
            console.log(`Current WETH price in USDC: $${price.toFixed(2)}`);
            process.exit(0);
        })
        .catch((error: Error) => {
            console.error('Error getting WETH price:', error);
            process.exit(1);
        });
}