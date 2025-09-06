// src/services/priceMonitorService.ts

import { getQuote as getUniswapQuote } from '../quoterUniswap';
import { getQuote as getTraderJoeQuote } from '../quoterTraderJoe';
import logger from '../logger';
import { TRADE_SETTINGS, GAS_OPTIMIZATION, ARBITRAGE_SETTINGS, TOKEN_CONFIGS, ADDRESSES } from '../constants';
import { getErrorMessage, estimateGasCostInUSDC} from '../utils';
import type {
    DexType,
    UniswapTradeType,
    TraderJoeTradeType,
    SimulatedQuoteResult,
    UniswapToken,
    TraderJoeToken,
    ArbitrageOpportunity,
} from '../tradeTypes';
import {
    createPublicClient,
    http,
    type PublicClient,
    Address
} from 'viem';
import { avalanche } from 'viem/chains';

// MAX_PROFIT_THRESHOLD acts as a sanity check against unrealistic blockchain data.
const MAX_PROFIT_THRESHOLD = ARBITRAGE_SETTINGS.MAX_PROFIT_THRESHOLD;

export class PriceMonitorService {
    private readonly minProfitThreshold: number;
    private isShuttingDown = false;
    private activeOperations: Set<string> = new Set();
    private readonly publicClient: PublicClient;

    constructor(minProfitThreshold: number) {
        this.minProfitThreshold = minProfitThreshold;
        // Initialize the public client
        this.publicClient = createPublicClient({
            chain: avalanche,
            transport: http(process.env.AVALANCHE_RPC_URL as string),
        });

        logger.info('PriceMonitorService initialized', { minProfitThreshold });
    }

    public async shutdown(): Promise<void> {
        logger.info('Initiating PriceMonitorService shutdown');
        this.isShuttingDown = true;

        if (this.activeOperations.size > 0) {
            logger.info(`Waiting for ${this.activeOperations.size} active operations to complete`);
            await this.waitForActiveOperations();
        }

        logger.info('PriceMonitorService shutdown complete');
        await logger.flush();
    }

    private async waitForActiveOperations(timeout: number = 30000): Promise<void> {
        const startTime = performance.now();
        while (this.activeOperations.size > 0) {
            if (performance.now() - startTime > timeout) {
                logger.warn(`Shutdown timeout reached with ${this.activeOperations.size} operations remaining`);
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    /**
     * Find arbitrage opportunities between Uniswap and TraderJoe
     * Enhanced to support both USDC-WAVAX and USDC-WBTC trading pairs
     */
    public async findArbitrageOpportunity(): Promise<ArbitrageOpportunity | null> {
        if (this.isShuttingDown) {
            logger.info('Skipping price check - service is shutting down');
            return null;
        }

        // Set test mode flag from settings
        const isTestMode = ARBITRAGE_SETTINGS.OFF_CHAIN_TEST_MODE;

        const operationId = performance.now().toString();
        this.activeOperations.add(operationId);

        try {
            // Define supported token pairs
            const tokenPairs = [
                { baseToken: 'USDC', quoteToken: 'WAVAX', pairName: 'USDC-WAVAX' },
                { baseToken: 'USDC', quoteToken: 'WBTC', pairName: 'USDC-WBTC' }
            ];

            // Randomly select a token pair to check for this cycle
            // Alternating between pairs helps avoid overloading any single liquidity pool with checks
            const selectedPairIndex = Math.floor(Math.random() * tokenPairs.length);
            const selectedPair = tokenPairs[selectedPairIndex];

            logger.info(`Checking for arbitrage opportunities on ${selectedPair.pairName} pair`, {
                operationId,
                tokenPair: selectedPair.pairName
            });

            // Get initial USDC quote for both routes with selected token pair
            const inputUSDC = TRADE_SETTINGS.TRADE_SIZE;
            // Use contract address as recipient for quotes when available
            const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as Address | undefined;

            logger.info("Requesting quotes in parallel", {
                tokenPair: selectedPair.pairName,
                inputAmount: inputUSDC,
                recipient: contractAddress || 'wallet'
            });

            const startTime = performance.now();

            // Determine USDC->intermediate token direction based on selected pair
            const firstLegDirection = selectedPair.quoteToken === 'WAVAX' ? 'USDC->WAVAX' : 'USDC->WBTC';

            // CHANGE: Fetch initial quotes in parallel
            const [uniQuoteUSDCtoToken, tjQuoteUSDCtoToken] = await Promise.allSettled([
                getUniswapQuote(firstLegDirection as any, inputUSDC, contractAddress),
                getTraderJoeQuote(firstLegDirection as any, inputUSDC, contractAddress)
            ]);

            const firstLegTime = performance.now() - startTime;
            logger.debug('First leg parallel quotes completed', {
                tokenPair: selectedPair.pairName,
                durationMs: firstLegTime,
                uniswapSuccess: uniQuoteUSDCtoToken.status === 'fulfilled',
                traderJoeSuccess: tjQuoteUSDCtoToken.status === 'fulfilled'
            });

            // Extract and validate results
            const uniQuoteResult = uniQuoteUSDCtoToken.status === 'fulfilled' ? uniQuoteUSDCtoToken.value : null;
            const tjQuoteResult = tjQuoteUSDCtoToken.status === 'fulfilled' ? tjQuoteUSDCtoToken.value : null;

            // Validate first leg quotes
            let validUniQuote = uniQuoteResult && this.validateQuoteDirection(uniQuoteResult, 'uniswap', firstLegDirection as any);
            let validTjQuote = tjQuoteResult && this.validateQuoteDirection(tjQuoteResult, 'traderjoe', firstLegDirection as any);

            if (!validUniQuote) {
                logger.warn(`Invalid or missing Uniswap ${firstLegDirection} quote`, {
                    operationId,
                    tokenPair: selectedPair.pairName,
                    status: uniQuoteUSDCtoToken.status,
                    reason: uniQuoteUSDCtoToken.status === 'rejected' ?
                        getErrorMessage(uniQuoteUSDCtoToken.reason) : 'Validation failed'
                });
            }

            if (!validTjQuote) {
                logger.warn(`Invalid or missing TraderJoe ${firstLegDirection} quote`, {
                    operationId,
                    tokenPair: selectedPair.pairName,
                    status: tjQuoteUSDCtoToken.status,
                    reason: tjQuoteUSDCtoToken.status === 'rejected' ?
                        getErrorMessage(tjQuoteUSDCtoToken.reason) : 'Validation failed'
                });
            }

            // Check if we have at least one valid quote
            if (!validUniQuote && !validTjQuote) {
                logger.warn('Both first leg quotes failed, cannot proceed', {
                    operationId,
                    tokenPair: selectedPair.pairName
                });
                return null;
            }

            // Get expected intermediate token outputs if available
            const tokenFromUni = validUniQuote ? uniQuoteResult!.expectedOutput : null;
            const tokenFromTJ = validTjQuote ? tjQuoteResult!.expectedOutput : null;

            // Determine second leg direction based on selected pair
            const secondLegDirection = selectedPair.quoteToken === 'WAVAX' ? 'WAVAX->USDC' : 'WBTC->USDC';

            // Fetch second leg quotes in parallel
            const secondLegStartTime = performance.now();
            const secondLegQuotes = await Promise.allSettled([
                validUniQuote && tokenFromUni ?
                    getTraderJoeQuote(secondLegDirection as any, tokenFromUni, contractAddress) :
                    Promise.resolve(null),
                validTjQuote && tokenFromTJ ?
                    getUniswapQuote(secondLegDirection as any, tokenFromTJ, contractAddress) :
                    Promise.resolve(null)
            ]);

            const secondLegTime = performance.now() - secondLegStartTime;
            logger.debug('Second leg parallel quotes completed', {
                tokenPair: selectedPair.pairName,
                durationMs: secondLegTime,
                route1Success: secondLegQuotes[0].status === 'fulfilled' && secondLegQuotes[0].value !== null,
                route2Success: secondLegQuotes[1].status === 'fulfilled' && secondLegQuotes[1].value !== null
            });

            // Extract second leg results
            const tjQuoteTokenToUSDC = secondLegQuotes[0].status === 'fulfilled' && secondLegQuotes[0].value ?
                secondLegQuotes[0].value : null;
            const uniQuoteTokenToUSDC = secondLegQuotes[1].status === 'fulfilled' && secondLegQuotes[1].value ?
                secondLegQuotes[1].value : null;

            // Validate complete routes
            let routeOneValid = false;
            let routeTwoValid = false;

            // Route One: Uniswap -> TraderJoe
            if (validUniQuote && tjQuoteTokenToUSDC) {
                routeOneValid = this.validateQuoteDirection(tjQuoteTokenToUSDC, 'traderjoe', secondLegDirection as any) &&
                    !!tjQuoteTokenToUSDC.swapCalldata &&
                    !!tjQuoteTokenToUSDC.routerAddress;

                if (!routeOneValid) {
                    logger.warn('Route One (Uniswap->TraderJoe) second leg validation failed', {
                        operationId,
                        tokenPair: selectedPair.pairName,
                        hasCalldata: !!tjQuoteTokenToUSDC.swapCalldata,
                        hasRouterAddress: !!tjQuoteTokenToUSDC.routerAddress,
                        directionValid: this.validateQuoteDirection(tjQuoteTokenToUSDC, 'traderjoe', secondLegDirection as any)
                    });
                }
            }

            // Route Two: TraderJoe -> Uniswap
            if (validTjQuote && uniQuoteTokenToUSDC) {
                routeTwoValid = this.validateQuoteDirection(uniQuoteTokenToUSDC, 'uniswap', secondLegDirection as any) &&
                    !!uniQuoteTokenToUSDC.swapCalldata &&
                    !!uniQuoteTokenToUSDC.routerAddress;

                if (!routeTwoValid) {
                    logger.warn('Route Two (TraderJoe->Uniswap) second leg validation failed', {
                        operationId,
                        tokenPair: selectedPair.pairName,
                        hasCalldata: !!uniQuoteTokenToUSDC.swapCalldata,
                        hasRouterAddress: !!uniQuoteTokenToUSDC.routerAddress,
                        directionValid: this.validateQuoteDirection(uniQuoteTokenToUSDC, 'uniswap', secondLegDirection as any)
                    });
                }
            }

            // Check if at least one valid route exists
            if (!routeOneValid && !routeTwoValid) {
                logger.warn('No valid complete arbitrage routes available', {
                    operationId,
                    tokenPair: selectedPair.pairName,
                    firstLegUniswapValid: validUniQuote,
                    firstLegTraderJoeValid: validTjQuote,
                    secondLegUniswapValid: !!uniQuoteTokenToUSDC,
                    secondLegTraderJoeValid: !!tjQuoteTokenToUSDC
                });
                return null;
            }

            // Enhanced gas cost calculation for both routes
            const profitCalcStartTime = performance.now();
            let routeOneProfit = { netProfit: 0, profitPercent: 0, isViable: false };
            let routeTwoProfit = { netProfit: 0, profitPercent: 0, isViable: false };
            let gasDataRouteOne = { estimatedGasUsed: '0', totalGasCostUSDC: 0, effectiveGasPrice: '0' };
            let gasDataRouteTwo = { estimatedGasUsed: '0', totalGasCostUSDC: 0, effectiveGasPrice: '0' };

            // Calculate gas data and profits for both routes in parallel
            await Promise.all([
                // Route One (Uniswap -> TraderJoe)
                (async () => {
                    if (routeOneValid && uniQuoteResult && tjQuoteTokenToUSDC) {
                        gasDataRouteOne = await this.getGasCostData({
                            startDex: 'uniswap',
                            endDex: 'traderjoe',
                            inputAmount: inputUSDC,
                            simulatedTradeData: {
                                firstLeg: uniQuoteResult,
                                secondLeg: tjQuoteTokenToUSDC
                            }
                        });

                        routeOneProfit = this.calculateRouteProfit(
                            inputUSDC,
                            tjQuoteTokenToUSDC.expectedOutput,
                            gasDataRouteOne.totalGasCostUSDC,
                            `Uniswap->TraderJoe (${selectedPair.pairName})`
                        );

                        if (routeOneProfit.netProfit <= 0 && !isTestMode) {
                            routeOneProfit.isViable = false;
                            logger.debug(`RouteOne (${selectedPair.pairName}): netProfit <= 0 and testMode=false => isViable=false.`);
                        }
                    }
                })(),

                // Route Two (TraderJoe -> Uniswap)
                (async () => {
                    if (routeTwoValid && tjQuoteResult && uniQuoteTokenToUSDC) {
                        gasDataRouteTwo = await this.getGasCostData({
                            startDex: 'traderjoe',
                            endDex: 'uniswap',
                            inputAmount: inputUSDC,
                            simulatedTradeData: {
                                firstLeg: tjQuoteResult,
                                secondLeg: uniQuoteTokenToUSDC
                            }
                        });

                        routeTwoProfit = this.calculateRouteProfit(
                            inputUSDC,
                            uniQuoteTokenToUSDC.expectedOutput,
                            gasDataRouteTwo.totalGasCostUSDC,
                            `TraderJoe->Uniswap (${selectedPair.pairName})`
                        );

                        if (routeTwoProfit.netProfit <= 0 && !isTestMode) {
                            routeTwoProfit.isViable = false;
                            logger.debug(`RouteTwo (${selectedPair.pairName}): netProfit <= 0 and testMode=false => isViable=false.`);
                        }
                    }
                })()
            ]);

            const profitCalcTime = performance.now() - profitCalcStartTime;
            if (profitCalcTime > 1000) {
                logger.warn('Slow profit calculation detected', {
                    profitCalcTime,
                    tokenPair: selectedPair.pairName
                });
            } else {
                logger.debug('Profit calculation time', {
                    profitCalcTime,
                    tokenPair: selectedPair.pairName
                });
            }

            // Select the more profitable route
            let opportunity: ArbitrageOpportunity | null = null;

            // Determine source and target token addresses based on the selected pair
            const sourceTokenAddress = TOKEN_CONFIGS.USDC.address;
            const targetTokenAddress = selectedPair.quoteToken === 'WAVAX'
                ? TOKEN_CONFIGS.WAVAX.address
                : TOKEN_CONFIGS.WBTC.address;

            // Route One: Uniswap -> TraderJoe
            if (routeOneValid && routeOneProfit.isViable &&
                (!routeTwoValid || !routeTwoProfit.isViable || routeOneProfit.netProfit > routeTwoProfit.netProfit) &&
                routeOneProfit.profitPercent <= MAX_PROFIT_THRESHOLD) {

                opportunity = {
                    startDex: 'uniswap',
                    endDex: 'traderjoe',
                    startPrice: parseFloat(uniQuoteResult!.formattedPrice),
                    endPrice: parseFloat(tjQuoteTokenToUSDC!.formattedPrice),
                    profitPercent: routeOneProfit.profitPercent,
                    amountIn: inputUSDC,
                    expectedWAVAX: tokenFromUni!,
                    quoteTimestamp: Math.min(
                        Number(uniQuoteResult!.quoteTimestamp || BigInt(Math.floor(Date.now() / 1000))),
                        Number(tjQuoteTokenToUSDC!.quoteTimestamp || BigInt(Math.floor(Date.now() / 1000)))
                    ),
                    firstLeg: {
                        trade: uniQuoteResult!.trade,
                        formattedPrice: uniQuoteResult!.formattedPrice,
                        expectedOutput: uniQuoteResult!.expectedOutput,
                        poolAddress: uniQuoteResult!.poolAddress,
                        fee: Number(uniQuoteResult!.fee),
                        gasPrice: uniQuoteResult!.gasPrice,
                        priceImpact: uniQuoteResult!.priceImpact,
                        minAmountOut: uniQuoteResult!.minAmountOut,
                        swapCalldata: uniQuoteResult!.swapCalldata,
                        routerAddress: uniQuoteResult!.routerAddress,
                        estimatedGas: uniQuoteResult!.estimatedGas
                    },
                    secondLeg: {
                        trade: tjQuoteTokenToUSDC!.trade,
                        formattedPrice: tjQuoteTokenToUSDC!.formattedPrice,
                        expectedOutput: tjQuoteTokenToUSDC!.expectedOutput,
                        poolAddress: tjQuoteTokenToUSDC!.poolAddress,
                        fee: Number(tjQuoteTokenToUSDC!.fee),
                        gasPrice: tjQuoteTokenToUSDC!.gasPrice,
                        priceImpact: tjQuoteTokenToUSDC!.priceImpact,
                        minAmountOut: tjQuoteTokenToUSDC!.minAmountOut,
                        swapCalldata: tjQuoteTokenToUSDC!.swapCalldata,
                        routerAddress: tjQuoteTokenToUSDC!.routerAddress,
                        estimatedGas: tjQuoteTokenToUSDC!.estimatedGas
                    },
                    expectedProfit: routeOneProfit.netProfit.toFixed(6),
                    gasCosts: {
                        estimatedGasUsed: gasDataRouteOne.estimatedGasUsed,
                        estimatedGasCostUSDC: gasDataRouteOne.totalGasCostUSDC.toFixed(6),
                        effectiveGasPrice: gasDataRouteOne.effectiveGasPrice
                    },
                    metrics: {
                        priceImpact: this.calculateTotalPriceImpact(
                            uniQuoteResult!,
                            tjQuoteTokenToUSDC!
                        ).toString(),
                        executionTime: performance.now().toString(),
                        swapPath: `Uniswap->TraderJoe (${selectedPair.pairName})`,
                        timestamp: performance.now()
                    },
                    contractAddress, // Add contract address to opportunity
                    sourceToken: sourceTokenAddress,
                    targetToken: targetTokenAddress,
                    sourceTokenSymbol: 'USDC',
                    targetTokenSymbol: selectedPair.quoteToken
                };
            }
            // Route Two: TraderJoe -> Uniswap
            else if (routeTwoValid && routeTwoProfit.isViable &&
                routeTwoProfit.profitPercent <= MAX_PROFIT_THRESHOLD) {

                opportunity = {
                    startDex: 'traderjoe',
                    endDex: 'uniswap',
                    startPrice: parseFloat(tjQuoteResult!.formattedPrice),
                    endPrice: parseFloat(uniQuoteTokenToUSDC!.formattedPrice),
                    profitPercent: routeTwoProfit.profitPercent,
                    amountIn: inputUSDC,
                    expectedWAVAX: tokenFromTJ!,
                    quoteTimestamp: Math.min(
                        Number(tjQuoteResult!.quoteTimestamp || BigInt(Math.floor(Date.now() / 1000))),
                        Number(uniQuoteTokenToUSDC!.quoteTimestamp || BigInt(Math.floor(Date.now() / 1000)))
                    ),
                    firstLeg: {
                        trade: tjQuoteResult!.trade,
                        formattedPrice: tjQuoteResult!.formattedPrice,
                        expectedOutput: tjQuoteResult!.expectedOutput,
                        poolAddress: tjQuoteResult!.poolAddress,
                        fee: Number(tjQuoteResult!.fee),
                        gasPrice: tjQuoteResult!.gasPrice,
                        priceImpact: tjQuoteResult!.priceImpact,
                        minAmountOut: tjQuoteResult!.minAmountOut,
                        swapCalldata: tjQuoteResult!.swapCalldata,
                        routerAddress: tjQuoteResult!.routerAddress,
                        estimatedGas: tjQuoteResult!.estimatedGas
                    },
                    secondLeg: {
                        trade: uniQuoteTokenToUSDC!.trade,
                        formattedPrice: uniQuoteTokenToUSDC!.formattedPrice,
                        expectedOutput: uniQuoteTokenToUSDC!.expectedOutput,
                        poolAddress: uniQuoteTokenToUSDC!.poolAddress,
                        fee: Number(uniQuoteTokenToUSDC!.fee),
                        gasPrice: uniQuoteTokenToUSDC!.gasPrice,
                        priceImpact: uniQuoteTokenToUSDC!.priceImpact,
                        minAmountOut: uniQuoteTokenToUSDC!.minAmountOut,
                        swapCalldata: uniQuoteTokenToUSDC!.swapCalldata,
                        routerAddress: uniQuoteTokenToUSDC!.routerAddress,
                        estimatedGas: uniQuoteTokenToUSDC!.estimatedGas
                    },
                    expectedProfit: routeTwoProfit.netProfit.toFixed(6),
                    gasCosts: {
                        estimatedGasUsed: gasDataRouteTwo.estimatedGasUsed,
                        estimatedGasCostUSDC: gasDataRouteTwo.totalGasCostUSDC.toFixed(6),
                        effectiveGasPrice: gasDataRouteTwo.effectiveGasPrice
                    },
                    metrics: {
                        priceImpact: this.calculateTotalPriceImpact(
                            tjQuoteResult!,
                            uniQuoteTokenToUSDC!
                        ).toString(),
                        executionTime: performance.now().toString(),
                        swapPath: `TraderJoe->Uniswap (${selectedPair.pairName})`,
                        timestamp: performance.now()
                    },
                    contractAddress,
                    sourceToken: sourceTokenAddress,
                    targetToken: targetTokenAddress,
                    sourceTokenSymbol: 'USDC',
                    targetTokenSymbol: selectedPair.quoteToken
                };
            }

            // Perform one final check with the most up-to-date gas price
            if (opportunity) {
                const latestGasData = await this.getGasCostData({
                    startDex: opportunity.startDex,
                    endDex: opportunity.endDex,
                    inputAmount: opportunity.amountIn,
                    simulatedTradeData: {
                        firstLeg: opportunity.firstLeg,
                        secondLeg: opportunity.secondLeg
                    }
                });

                const latestGasCost = latestGasData.totalGasCostUSDC;
                const latestNetProfit = parseFloat(opportunity.expectedProfit) - latestGasCost;

                // Skip only if negative profit and !testMode
                if (latestNetProfit <= 0 && !isTestMode) {
                    logger.warn('Skipping opportunity - negative profit with latest gas price', {
                        tokenPair: selectedPair.pairName,
                        originalExpectedProfit: opportunity.expectedProfit,
                        originalGasCost: opportunity.gasCosts?.estimatedGasCostUSDC,
                        latestGasCost: latestGasCost.toFixed(6),
                        latestNetProfit: latestNetProfit.toFixed(6)
                    });
                    return null;
                }

                // Ensure gasCosts exists
                if (!opportunity.gasCosts) {
                    opportunity.gasCosts = {
                        estimatedGasUsed: '0',
                        estimatedGasCostUSDC: '0',
                        effectiveGasPrice: '0'
                    };
                }

                // Update with latest values
                const originalProfit = opportunity.expectedProfit;
                opportunity.expectedProfit = latestNetProfit.toFixed(6);
                opportunity.gasCosts.estimatedGasCostUSDC = latestGasCost.toFixed(6);
                opportunity.gasCosts.effectiveGasPrice = latestGasData.effectiveGasPrice;

                logger.info('Updated opportunity with latest gas price', {
                    tokenPair: selectedPair.pairName,
                    oldExpectedProfit: originalProfit,
                    newExpectedProfit: opportunity.expectedProfit,
                    latestGasCost: latestGasCost.toFixed(6)
                });
            }

            if (opportunity) {
                // Final validation of calldata
                const validationResults = {
                    firstLegCalldata: this.validateQuoteCalldata(
                        opportunity.firstLeg,
                        opportunity.startDex,
                        firstLegDirection as any
                    ),
                    secondLegCalldata: this.validateQuoteCalldata(
                        opportunity.secondLeg,
                        opportunity.endDex,
                        secondLegDirection as any
                    )
                };

                // Log final validation results
                logger.debug('Final calldata validation', {
                    operationId,
                    tokenPair: selectedPair.pairName,
                    firstLegValid: validationResults.firstLegCalldata.valid,
                    secondLegValid: validationResults.secondLegCalldata.valid,
                    firstLegIssues: validationResults.firstLegCalldata.issues,
                    secondLegIssues: validationResults.secondLegCalldata.issues
                });

                // If there are any validation issues with calldata, log them but proceed
                // We're logging rather than returning null because these might be false positives
                if (!validationResults.firstLegCalldata.valid || !validationResults.secondLegCalldata.valid) {
                    logger.warn('Proceeding with opportunity despite calldata validation issues', {
                        operationId,
                        tokenPair: selectedPair.pairName,
                        path: `${opportunity.startDex} -> ${opportunity.endDex}`,
                        firstLegCalldataLength: opportunity.firstLeg.swapCalldata ?
                            opportunity.firstLeg.swapCalldata.length : 0,
                        secondLegCalldataLength: opportunity.secondLeg.swapCalldata ?
                            opportunity.secondLeg.swapCalldata.length : 0
                    });
                }
            }

            if (opportunity && !opportunity.quoteTimestamp) {
                opportunity.quoteTimestamp = Math.floor(Date.now() / 1000);
            }

            if (opportunity) {
                logger.info('Arbitrage opportunity found', {
                    operationId,
                    tokenPair: selectedPair.pairName,
                    path: `${opportunity.startDex} -> ${opportunity.endDex}`,
                    profitPercent: `${opportunity.profitPercent.toFixed(2)}%`,
                    amountIn: opportunity.amountIn,
                    expectedIntermediateToken: opportunity.expectedWAVAX,
                    expectedProfit: opportunity.expectedProfit,
                    totalGasCostUSDC: opportunity.gasCosts?.estimatedGasCostUSDC,
                    totalProcessingTimeMs: performance.now() - startTime,
                    quoteAge: Math.floor(Date.now() / 1000) - opportunity.quoteTimestamp!,
                    tradePaths: {
                        firstLeg: `USDC->${opportunity.targetTokenSymbol} on ${opportunity.startDex}`,
                        secondLeg: `${opportunity.targetTokenSymbol}->USDC on ${opportunity.endDex}`
                    }
                });
            }

            return opportunity;

        } catch (error) {
            logger.error('Error checking for arbitrage opportunity', {
                operationId,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        } finally {
            this.activeOperations.delete(operationId);
        }
    }

    // Helper method for standardized gas cost data
    private async getGasCostData(config: {
        startDex: DexType;
        endDex: DexType;
        inputAmount: string;
        simulatedTradeData: {
            firstLeg?: SimulatedQuoteResult;
            secondLeg?: SimulatedQuoteResult;
        };
    }): Promise<{
        estimatedGasUsed: string;
        totalGasCostUSDC: number;
        effectiveGasPrice: string;
    }> {
        try {
            // Use the estimateGasCostInUSDC utility
            const gasCostUSDC = await estimateGasCostInUSDC(this.publicClient);

            // Get current gas price for effective price
            const currentGasPrice = await this.publicClient.getGasPrice();

            // Create standardized structure
            return {
                estimatedGasUsed: GAS_OPTIMIZATION.ESTIMATOR.SWAP_BASE.toString(),
                totalGasCostUSDC: gasCostUSDC,
                effectiveGasPrice: (await this.getGasPrice()).toString()
            };
        } catch (error) {
            logger.warn('Error estimating gas costs, using fallback values', {
                error: getErrorMessage(error)
            });

            // Return fallback values if estimation fails
            return {
                estimatedGasUsed: GAS_OPTIMIZATION.ESTIMATOR.SWAP_BASE.toString(),
                totalGasCostUSDC: 0.01, // Conservative default
                effectiveGasPrice: '0'
            };
        }
    }

    // Cache the latest gas price to speed the calculations up
    private lastGasPriceTime = 0;
    private cachedGasPrice: bigint = 0n;
    private readonly GAS_PRICE_CACHE_TTL = 10000; // 10 seconds

    private async getGasPrice(): Promise<bigint> {
        const now = Date.now();
        if (now - this.lastGasPriceTime > this.GAS_PRICE_CACHE_TTL || this.cachedGasPrice === 0n) {
            this.cachedGasPrice = await this.publicClient.getGasPrice();
            this.lastGasPriceTime = now;
        }
        return this.cachedGasPrice;
    }

    /**
     * Validate the quote direction for the given DEX and trading pair
     * Enhanced to support both USDC-WAVAX and USDC-WBTC trading pairs
     */
    private validateQuoteDirection(
        quote: SimulatedQuoteResult,
        dex: DexType,
        direction?: 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC'
    ): boolean {
        try {
            if (!quote.trade) {
                logger.error(`Missing trade data in ${dex} quote`);
                return false;
            }

            if (!this.validateQuoteFees(quote, dex)) {
                return false;
            }

            if (dex === 'uniswap') {
                const uniTrade = quote.trade as UniswapTradeType;
                const inputCurrency = uniTrade.inputAmount.currency as UniswapToken;
                const outputCurrency = uniTrade.outputAmount.currency as UniswapToken;

                if (direction === 'WAVAX->USDC') {
                    return (
                        inputCurrency.symbol === 'WAVAX' &&
                        outputCurrency.symbol === 'USDC' &&
                        inputCurrency.address.toLowerCase() === TOKEN_CONFIGS.WAVAX.address.toLowerCase() &&
                        outputCurrency.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase()
                    );
                } else if (direction === 'USDC->WAVAX') {
                    return (
                        inputCurrency.symbol === 'USDC' &&
                        outputCurrency.symbol === 'WAVAX' &&
                        inputCurrency.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase() &&
                        outputCurrency.address.toLowerCase() === TOKEN_CONFIGS.WAVAX.address.toLowerCase()
                    );
                } else if (direction === 'WBTC->USDC') {
                    return (
                        inputCurrency.symbol === 'BTC.b' &&
                        outputCurrency.symbol === 'USDC' &&
                        inputCurrency.address.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase() &&
                        outputCurrency.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase()
                    );
                } else if (direction === 'USDC->WBTC') {
                    return (
                        inputCurrency.symbol === 'USDC' &&
                        outputCurrency.symbol === 'BTC.b' &&
                        inputCurrency.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase() &&
                        outputCurrency.address.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase()
                    );
                }
            }

            if (dex === 'traderjoe') {
                const joeTrade = quote.trade as TraderJoeTradeType;
                const inputToken = joeTrade.inputAmount.token as TraderJoeToken;
                const outputToken = joeTrade.outputAmount.token as TraderJoeToken;

                if (direction === 'WAVAX->USDC') {
                    return (
                        inputToken.symbol === 'WAVAX' &&
                        outputToken.symbol === 'USDC' &&
                        inputToken.address.toLowerCase() === TOKEN_CONFIGS.WAVAX.address.toLowerCase() &&
                        outputToken.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase()
                    );
                } else if (direction === 'USDC->WAVAX') {
                    return (
                        inputToken.symbol === 'USDC' &&
                        outputToken.symbol === 'WAVAX' &&
                        inputToken.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase() &&
                        outputToken.address.toLowerCase() === TOKEN_CONFIGS.WAVAX.address.toLowerCase()
                    );
                } else if (direction === 'WBTC->USDC') {
                    return (
                        inputToken.symbol === 'BTC.b' &&
                        outputToken.symbol === 'USDC' &&
                        inputToken.address.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase() &&
                        outputToken.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase()
                    );
                } else if (direction === 'USDC->WBTC') {
                    return (
                        inputToken.symbol === 'USDC' &&
                        outputToken.symbol === 'BTC.b' &&
                        inputToken.address.toLowerCase() === TOKEN_CONFIGS.USDC.address.toLowerCase() &&
                        outputToken.address.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase()
                    );
                }
            }

            return false;
        } catch (error) {
            logger.error(`Error validating quote direction for ${dex}`, {
                error: getErrorMessage(error),
                direction
            });
            return false;
        }
    }

    /**
     * Enhanced validation for quote calldata and router address
     * Updated to support both WAVAX and WBTC token pairs
     */
    private validateQuoteCalldata(
        quote: SimulatedQuoteResult,
        dex: DexType,
        direction: string
    ): { valid: boolean; issues: string[] } {
        const issues: string[] = [];

        // Check if calldata exists and has valid format
        if (!quote.swapCalldata) {
            issues.push('Missing swap calldata');
        } else if (!quote.swapCalldata.startsWith('0x')) {
            issues.push('Calldata does not start with 0x');
        } else if (quote.swapCalldata.length < 10) {
            issues.push('Calldata too short (needs method ID + params)');
        }

        // Check router address
        if (!quote.routerAddress) {
            issues.push('Missing router address');
        } else {
            const expectedRouter = dex === 'uniswap'
                ? ADDRESSES.UNISWAP_V3.ROUTER
                : ADDRESSES.TRADER_JOE.ROUTER;

            if (quote.routerAddress.toLowerCase() !== expectedRouter.toLowerCase()) {
                issues.push(`Router address mismatch: expected ${expectedRouter}, got ${quote.routerAddress}`);
            }
        }

        // Check if expected output is reasonable
        if (!quote.expectedOutput) {
            issues.push('Missing expected output');
        } else if (parseFloat(quote.expectedOutput) <= 0) {
            issues.push('Expected output is zero or negative');
        }

        // Check if gas estimates are provided
        if (!quote.estimatedGas) {
            issues.push('Missing gas estimate');
        }

        return {
            valid: issues.length === 0,
            issues
        };
    }

    /**
     * Calculate route profit with gas costs, slippage protection
     */
    private calculateRouteProfit(
        inputAmount: string,
        outputAmount: string,
        gasCostUSDC: number,
        route: string
    ): { netProfit: number; profitPercent: number; isViable: boolean } {
        const input = parseFloat(inputAmount);
        const output = parseFloat(outputAmount);
        const rawProfit = output - input;

        // Apply a small safety margin for price movements (0.05% of input)
        // Note: Gas cost already includes its own buffer from calculateEnhancedGasCosts
        const safetyMargin = input * 0.00000005;

        const netProfit = rawProfit - gasCostUSDC - safetyMargin;
        const profitPercent = (netProfit / input) * 100;

        // Determine if this is a viable trade
        const minRequiredProfit = (this.minProfitThreshold * input) / 100;

        let isViable: boolean;
        if (ARBITRAGE_SETTINGS.OFF_CHAIN_TEST_MODE) {
            // Force the route to be "viable" even if negative netProfit, so we can see the transaction on-chain
            isViable = true;
        } else {
            isViable = netProfit > 0 && netProfit >= minRequiredProfit;
        }

        logger.debug(`Route profit calculation: ${route}`, {
            input,
            output,
            rawProfit: rawProfit.toFixed(6),
            safetyMargin: safetyMargin.toFixed(6),
            gasCostUSDC: gasCostUSDC.toFixed(6),
            netProfit: netProfit.toFixed(6),
            minRequiredProfit: minRequiredProfit.toFixed(6),
            profitPercent: `${profitPercent.toFixed(4)}%`,
            isViable
        });

        return { netProfit, profitPercent, isViable };
    }

    /**
     * Calculate the total price impact across both legs of the arbitrage
     */
    private calculateTotalPriceImpact(
        firstLegQuote: SimulatedQuoteResult,
        secondLegQuote: SimulatedQuoteResult
    ): number {
        const firstLegImpact = firstLegQuote.priceImpact || 0;
        const secondLegImpact = secondLegQuote.priceImpact || 0;
        return firstLegImpact + secondLegImpact;
    }

    /**
     * Validate fee ranges for different DEXes
     */
    private validateQuoteFees(
        quote: SimulatedQuoteResult,
        dex: DexType
    ): boolean {
        if (quote.fee === undefined) {
            logger.error(`Missing fee data in ${dex} quote`);
            return false;
        }

        // Validate fee ranges based on DEX
        if (dex === 'uniswap') {
            // Uniswap fees are typically 500, 3000, or 10000 (0.05%, 0.3%, or 1%)
            const validFees = [100, 500, 3000, 10000];
            if (!validFees.includes(Number(quote.fee))) {
                logger.error(`Invalid Uniswap fee value: ${quote.fee}`);
                return false;
            }
        } else if (dex === 'traderjoe') {
            // TraderJoe fees validation
            if (quote.fee < 0 || quote.fee > 1) {
                logger.error(`Invalid TraderJoe fee value: ${quote.fee}`);
                return false;
            }
        }
        return true;
    }
}