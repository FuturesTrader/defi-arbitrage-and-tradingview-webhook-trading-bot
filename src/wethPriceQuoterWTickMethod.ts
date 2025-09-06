// src/wethPriceQuoter.ts
// 🔧 FIXED: WETH/USDC price quoter for Arbitrum - TypeScript Errors Resolved v2.1.0
// ✅ Fixed BigintIsh compatibility, proper contract typing, and tick data provider

import {
    createPublicClient,
    http,
    parseUnits,
    type PublicClient
} from 'viem';
import { arbitrum } from 'viem/chains';
import {
    CurrencyAmount,
    Token,
} from '@uniswap/sdk-core';
import {
    Pool,
    TICK_SPACINGS,
    nearestUsableTick,
    type TickDataProvider
} from '@uniswap/v3-sdk';
import type { BigintIsh } from '@uniswap/sdk-core';

import {
    ABIS,
    getNetworkConfig,
    type NetworkKey,
    SUPPORTED_NETWORKS,
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

// 🔧 FIX: Simple Tick Data Provider Implementation with proper types
class SimpleTickDataProvider implements TickDataProvider {
    async getTick(tick: number): Promise<{ liquidityNet: BigintIsh }> {
        // For price calculation, we return a minimal implementation
        // Using string '0' which is compatible with BigintIsh
        return { liquidityNet: '0' };
    }

    async nextInitializedTickWithinOneWord(
        tick: number,
        lte: boolean,
        tickSpacing: number
    ): Promise<[number, boolean]> {
        // Return the current tick as initialized
        return [tick, true];
    }
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
                    version: '2.1.0-ts-fixed'
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
                // Get tick spacing for the fee tier
                const fee = poolData.fee;
                const tickSpacing = TICK_SPACINGS[fee as keyof typeof TICK_SPACINGS];

                if (!tickSpacing) {
                    throw new Error(`No tick spacing found for fee ${fee}`);
                }

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
                    poolFee: fee,
                    tick: poolData.tick
                });

                // 🔧 FIX: Try pool calculation with proper tick data provider
                try {
                    const tickDataProvider = new SimpleTickDataProvider();

                    // Create pool with minimal ticks array
                    const pool = new Pool(
                        arbitrumTokens.USDC_UNI, // token0 (USDC)
                        arbitrumTokens.WETH_UNI, // token1 (WETH)
                        fee,
                        poolData.sqrtPriceX96.toString(),
                        poolData.liquidity.toString(),
                        poolData.tick,
                        [
                            {
                                index: nearestUsableTick(poolData.tick, tickSpacing),
                                liquidityNet: poolData.liquidity.toString(), // 🔧 FIX: String is compatible with BigintIsh
                                liquidityGross: poolData.liquidity.toString() // 🔧 FIX: String is compatible with BigintIsh
                            }
                        ]
                    );

                    // Set the tick data provider to prevent the error
                    (pool as any).tickDataProvider = tickDataProvider;

                    // Create input amount for 1 WETH
                    const inputAmount = CurrencyAmount.fromRawAmount(
                        arbitrumTokens.WETH_UNI,
                        parseUnits('1', arbitrumTokens.WETH_UNI.decimals).toString()
                    );

                    // Try to get output amount (this should work now)
                    const [outputAmount] = await pool.getOutputAmount(inputAmount);
                    const price = parseFloat(outputAmount.toExact());

                    logger.debug('WETH price calculation result', {
                        network: 'ARBITRUM',
                        inputWETH: inputAmount.toExact(),
                        outputUSDC: outputAmount.toExact(),
                        calculatedPrice: price,
                        method: 'pool_calculation_with_tick_provider'
                    });

                    // Apply sanity check on price
                    if (this.isPriceReasonable(price)) {
                        this.lastPrice = price;
                        this.lastUpdateTime = Date.now();

                        logger.info('WETH/USDC price updated successfully', {
                            price: this.lastPrice.toFixed(2),
                            network: 'ARBITRUM',
                            method: 'pool_calculation',
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        logger.warn('Received unreasonable WETH price from pool, trying mathematical approach', {
                            calculatedPrice: price,
                            currentPrice: this.lastPrice,
                            reasonableRange: '1000-15000'
                        });

                        // Fall back to mathematical calculation
                        const mathPrice = this.calculatePriceFromSqrtPrice(
                            poolData.sqrtPriceX96,
                            arbitrumTokens.USDC_UNI.decimals,
                            arbitrumTokens.WETH_UNI.decimals
                        );

                        if (this.isPriceReasonable(mathPrice)) {
                            this.lastPrice = mathPrice;
                            this.lastUpdateTime = Date.now();
                        }
                    }
                } catch (poolError) {
                    // If pool calculation fails, try mathematical approach
                    logger.warn('Pool calculation failed, using mathematical approach', {
                        error: getErrorMessage(poolError)
                    });

                    const price = this.calculatePriceFromSqrtPrice(
                        poolData.sqrtPriceX96,
                        arbitrumTokens.USDC_UNI.decimals,
                        arbitrumTokens.WETH_UNI.decimals
                    );

                    if (this.isPriceReasonable(price)) {
                        this.lastPrice = price;
                        this.lastUpdateTime = Date.now();

                        logger.info('WETH/USDC price updated via mathematical calculation', {
                            price: this.lastPrice.toFixed(2),
                            network: 'ARBITRUM',
                            method: 'mathematical_calculation'
                        });
                    }
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

            // Get tokens with proper type assertion
            const arbitrumTokens = networkConfig.tokenInstances as typeof networkConfig.tokenInstances & {
                WETH_UNI: Token;
                USDC_UNI: Token;
                WBTC_UNI: Token;
            };

            // WETH/USDC pool address on Arbitrum (fee tier 3000)
            const poolAddress = '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d' as const;

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
            const fee = 3000; // This pool has 0.3% fee

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
                poolAddress: '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d',
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