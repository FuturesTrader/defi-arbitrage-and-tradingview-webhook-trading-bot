// src/services/flashLoanService.ts - Updated for Balancer V2 flash loans with WBTC support

import {
    type Address,
    parseUnits,
} from 'viem';
import { avalanche } from 'viem/chains';
import { getErrorMessage, TimingUtility } from '../utils';
import { SmartContractService } from './smartContractService';
import { TOKEN_CONFIGS, ARBITRAGE_SETTINGS, ADDRESSES } from '../constants';
import { tradeMetricsManager, SwapMetrics, SecondSwapMetrics } from '../tradeMetrics';
import logger from '../logger';
import type {
    ArbitrageConfig,
    TradeResult,
    TraderJoeTradeType,
    UniswapTradeType
} from '../tradeTypes';

const FLASH_POOL = ADDRESSES.BALANCER_V2.POOL;
const FLASH_LOAN_BPS = ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS;

/**
 * Safely parses a string to a bigint, handling negative values properly
 */
function safeParseUnits(valueStr: string, decimals: number): bigint {
    if (!valueStr) return 0n;

    // Parse the value to a float first to handle scientific notation
    const floatValue = parseFloat(valueStr);

    // Check if the value is negative
    if (floatValue < 0) {
        // Convert the absolute value to bigint with decimals and then negate it
        const absValue = Math.abs(floatValue);
        return -parseUnits(absValue.toString(), decimals);
    } else {
        // Normal positive or zero case
        return parseUnits(valueStr, decimals);
    }
}

/**
 * Local interface for token pair configuration
 */
interface TokenPairConfig {
    sourceToken: typeof TOKEN_CONFIGS.USDC;
    targetToken: typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC;
    intermediateCurrency: typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC;
}

/**
 * Service for executing flash loan-based arbitrage using Balancer V2
 * Updated to support multiple token pairs including USDC-WAVAX and USDC-WBTC
 */
export class FlashLoanService {
    private readonly smartContractService: SmartContractService;
    private readonly balancerVaultAddress: Address;
    private isExecuting = false;
    private isShuttingDown = false;
    private isInitialized = false;
    // Balancer flash loans have 0% fee
    private readonly flashLoanFeeBps = FLASH_LOAN_BPS;

    constructor(
        smartContractService: SmartContractService,
        balancerVaultAddress: Address = FLASH_POOL as Address
    ) {
        try {
            // Simple validation to avoid hanging
            if (!smartContractService) {
                throw new Error('SmartContractService is required');
            }

            if (!balancerVaultAddress || balancerVaultAddress === '0x0000000000000000000000000000000000000000' as Address) {
                throw new Error('Invalid Balancer Vault address');
            }

            this.smartContractService = smartContractService;
            this.balancerVaultAddress = balancerVaultAddress;
            this.isInitialized = true;

            // Log initialization but don't block
            setTimeout(() => {
                logger.info('FlashLoanService initialized for Balancer V2', {
                    contractAddress: this.smartContractService.getContractAddress(),
                    flashLoanProvider: this.balancerVaultAddress,
                    flashLoanFeeBps: this.flashLoanFeeBps,
                    supportedTokens: {
                        base: 'USDC',
                        intermediateTokens: ['WAVAX', 'WBTC']
                    }
                });
            }, 0);
        } catch (error) {
            // Log initialization errors
            console.error('Error initializing FlashLoanService:', getErrorMessage(error));
            logger.error('FlashLoanService initialization failed', {
                error: getErrorMessage(error)
            });

            // Re-throw to make failure visible
            throw error;
        }
    }

    /**
     * Determines the token pair configuration from the arbitrage config
     * @param config The arbitrage configuration
     * @returns TokenPairConfig with source, target, and intermediate token details
     */
    private determineTokenPair(config: ArbitrageConfig): TokenPairConfig {
        // Default to USDC as source token
        const sourceToken = TOKEN_CONFIGS.USDC;

        // Determine target token by checking addresses in quotes
        let targetToken = TOKEN_CONFIGS.WAVAX; // Default to WAVAX
        let isWbtcPair = false;

        // Check first leg output token to determine pair
        if (config.simulatedTradeData?.firstLeg?.trade) {
            const trade = config.simulatedTradeData.firstLeg.trade;

            try {
                // Try to identify if this is a Uniswap or TraderJoe trade
                if ('executionPrice' in trade && 'outputAmount' in trade) {
                    if ('currency' in trade.outputAmount) {
                        // This is likely a Uniswap trade
                        const uniTrade = trade as UniswapTradeType;
                        const outputCurrency = uniTrade.outputAmount.currency;

                        if (outputCurrency && 'address' in outputCurrency) {
                            const outputAddress = (outputCurrency.address as string).toLowerCase();
                            isWbtcPair = outputAddress === TOKEN_CONFIGS.WBTC.address.toLowerCase();

                            logger.debug('Detected token from Uniswap trade', {
                                tokenSymbol: outputCurrency.symbol,
                                tokenAddress: outputAddress,
                                isWbtcPair
                            });
                        }
                    } else if (trade.outputAmount && 'token' in trade.outputAmount) {
                        // This is likely a TraderJoe trade
                        const joeTrade = trade as TraderJoeTradeType;
                        const outputToken = joeTrade.outputAmount.token;

                        if (outputToken && 'address' in outputToken) {
                            const outputAddress = (outputToken.address as string).toLowerCase();
                            isWbtcPair = outputAddress === TOKEN_CONFIGS.WBTC.address.toLowerCase();

                            logger.debug('Detected token from TraderJoe trade', {
                                tokenSymbol: outputToken.symbol,
                                tokenAddress: outputAddress,
                                isWbtcPair
                            });
                        }
                    }
                }
            } catch (error) {
                logger.warn('Error determining token pair from trade', {
                    error: getErrorMessage(error)
                });
                // If we can't determine from the trade, check target tokens directly in quotes
            }

            // If we haven't determined the token type yet, try a more direct approach
            if (!isWbtcPair) {
                try {
                    // Log some debug info to help diagnose issues
                    const tradeStr = JSON.stringify(trade, (key, value) => {
                        if (typeof value === 'bigint') return value.toString();
                        return value;
                    });

                    logger.debug('Checking trade object directly for token information', {
                        tradeLength: tradeStr.length > 100 ? tradeStr.length : 'N/A',
                        tradeKeys: Object.keys(trade),
                        hasOutputAmount: 'outputAmount' in trade,
                        outputAmountKeys: 'outputAmount' in trade ? Object.keys(trade.outputAmount) : []
                    });

                    // Check the expected output address in the trade data
                    if (config.simulatedTradeData.firstLeg.expectedOutput) {
                        // The amount is probably in WAVAX or WBTC
                        // Look for clues in the pool address
                        const poolAddress = config.simulatedTradeData.firstLeg.poolAddress?.toLowerCase();
                        if (poolAddress) {
                            if (poolAddress === ADDRESSES.UNISWAP_V3.POOLS.USDC_WBTC.toLowerCase() ||
                                poolAddress === ADDRESSES.TRADER_JOE.POOLS.USDC_WBTC.toLowerCase()) {
                                isWbtcPair = true;
                            }
                        }
                    }
                } catch (error) {
                    logger.warn('Error in backup token determination', {
                        error: getErrorMessage(error)
                    });
                }
            }
        }

        // Use WBTC if detected in the trade, otherwise stay with WAVAX
        if (isWbtcPair) {
            targetToken = TOKEN_CONFIGS.WBTC;
        }

        logger.info('Determined token pair for flash loan arbitrage', {
            sourceToken: sourceToken.symbol,
            targetToken: targetToken.symbol,
            isWbtcPair
        });

        return {
            sourceToken,
            targetToken,
            intermediateCurrency: targetToken
        };
    }

    /**
     * Executes a flash loan-based arbitrage using Balancer V2
     * Updated to support USDC-WAVAX and USDC-WBTC trading pairs
     * @param config ArbitrageConfig containing trade information
     * @returns TradeResult with execution details
     */
    public async executeFlashLoanArbitrage(config: ArbitrageConfig): Promise<TradeResult> {
        // Add validation to avoid hanging
        if (!this.isInitialized) {
            return {
                success: false,
                error: 'FlashLoanService not properly initialized',
                errorType: 'INITIALIZATION_ERROR'
            };
        }

        if (!config.simulatedTradeData?.firstLeg || !config.simulatedTradeData?.secondLeg) {
            return {
                success: false,
                error: 'Missing simulated trade data',
                errorType: 'CONFIGURATION_ERROR'
            };
        }

        if (this.isShuttingDown) {
            return {
                success: false,
                error: 'Service is shutting down',
                errorType: 'SERVICE_UNAVAILABLE'
            };
        }

        if (this.isExecuting) {
            return {
                success: false,
                error: 'Another flash loan arbitrage is in progress',
                errorType: 'CONCURRENCY_ERROR'
            };
        }

        // Get lock to prevent concurrent executions
        this.isExecuting = true;

        // Determine which token pair we're trading (USDC-WAVAX or USDC-WBTC)
        const tokenPair = this.determineTokenPair(config);
        const isWbtcPair = tokenPair.targetToken.symbol === 'WBTC';

        const tradeId = Date.now().toString();
        const tradeTimingUtility = new TimingUtility(tradeId);
        tradeTimingUtility.recordEvent('startTime');

        try {
            // Initialize metrics tracking
            tradeMetricsManager.startNewTradeMetrics();

            // Log arbitrage attempt with token pair information
            logger.info('Initiating Balancer flash loan arbitrage', {
                tradeId,
                startDex: config.startDex,
                endDex: config.endDex,
                tokenPair: `${tokenPair.sourceToken.symbol}-${tokenPair.targetToken.symbol}`,
                inputAmount: config.inputAmount,
                testMode: config.testMode || ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE
            });

            // Check if expected profit is positive
            // The expected output from quotes already accounts for DEX fees
            if (config.simulatedTradeData.secondLeg.expectedOutput) {
                const inputAmount = parseFloat(config.inputAmount);
                const expectedOutput = parseFloat(config.simulatedTradeData.secondLeg.expectedOutput);

                // Calculate expected profit (excluding flash loan fee)
                const expectedProfit = expectedOutput - inputAmount;

                // Balancer has 0% flash loan fee
                const flashLoanFee = 0;

                // Net profit equals expected profit since there's no flash loan fee
                const netProfit = expectedProfit;

                logger.info('Balancer flash loan profit analysis', {
                    inputAmount: inputAmount.toFixed(6),
                    expectedOutput: expectedOutput.toFixed(6),
                    expectedProfit: expectedProfit.toFixed(6),
                    flashLoanFee: flashLoanFee.toFixed(6),
                    netProfit: netProfit.toFixed(6),
                    testMode: config.testMode
                });

                // Only proceed if expected to be profitable or in test mode
                const testMode = config.testMode || ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE;
                if (netProfit <= 0 && !testMode) {
                    logger.warn('Skipping Balancer flash loan arbitrage - not expected to be profitable', {
                        expectedProfit: expectedProfit.toFixed(6),
                        netProfit: netProfit.toFixed(6)
                    });

                    this.isExecuting = false; // Release lock

                    return {
                        success: false,
                        error: 'Not expected to be profitable',
                        errorType: 'INSUFFICIENT_PROFIT',
                        profit: expectedProfit.toString(),
                        flashLoanFee: flashLoanFee.toString(),
                        netProfit: netProfit.toString()
                    };
                }
            }

            // Execute the flash loan arbitrage via smart contract with dynamic token addresses
            const result = await this.smartContractService.executeFlashLoanArbitrage({
                sourceToken: tokenPair.sourceToken.address,
                targetToken: tokenPair.targetToken.address,
                amount: safeParseUnits(config.inputAmount, tokenPair.sourceToken.decimals),
                firstSwapData: config.simulatedTradeData.firstLeg.swapCalldata as `0x${string}`,
                secondSwapData: config.simulatedTradeData.secondLeg.swapCalldata as `0x${string}`,
                firstRouter: config.simulatedTradeData.firstLeg.routerAddress,
                secondRouter: config.simulatedTradeData.secondLeg.routerAddress,
                testMode: config.testMode || ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE,
                expectedFirstOutput: safeParseUnits(
                    config.simulatedTradeData.firstLeg.expectedOutput || "0",
                    tokenPair.targetToken.decimals
                ),
                expectedSecondOutput: safeParseUnits(
                    config.simulatedTradeData.secondLeg.expectedOutput || "0",
                    tokenPair.sourceToken.decimals
                )
            });

            // Record timing and update metrics
            tradeTimingUtility.recordEvent('endTime');
            const executionTime = tradeTimingUtility.getTotalTimeOrZero();

            // Update metrics if successful
            if (result.success && result.receipt) {
                this.updateTradeMetrics(config, result, tradeId, executionTime, tokenPair);
            }

            // Return detailed result
            if (result.success) {
                // Balancer has 0% flash loan fee
                const flashLoanFee = "0";

                // If profit is missing, default to 0 for successful transactions
                if (!result.profit || result.profit === "undefined") {
                    logger.info('Flash loan succeeded but profit data missing, using default value');
                    result.profit = "0";
                }

                // Set flash loan fee to 0 for Balancer
                result.flashLoanFee = flashLoanFee;

                // Net profit equals gross profit since there's no flash loan fee
                // Handle potential negative profit properly
                const grossProfit = parseFloat(result.profit || "0");
                const netProfit = grossProfit;
                result.netProfit = netProfit.toFixed(6);

                logger.info('Balancer flash loan arbitrage completed successfully', {
                    tradeId,
                    tokenPair: `${tokenPair.sourceToken.symbol}-${tokenPair.targetToken.symbol}`,
                    profit: result.profit,
                    flashLoanFee: result.flashLoanFee,
                    netProfit: result.netProfit,
                    gasUsed: result.gasUsed,
                    executionTime
                });
            }

            return result;
        } catch (error) {
            logger.error('Error executing Balancer flash loan arbitrage', {
                tradeId,
                error: getErrorMessage(error),
                tokenPair: `${tokenPair.sourceToken.symbol}-${tokenPair.targetToken.symbol}`,
                config: {
                    startDex: config.startDex,
                    endDex: config.endDex,
                    inputAmount: config.inputAmount
                }
            });

            return {
                success: false,
                error: getErrorMessage(error),
                errorType: 'EXECUTION_ERROR'
            };
        } finally {
            this.isExecuting = false;
        }
    }

    /**
     * Calculate the Balancer flash loan fee (always 0)
     * @param amount The amount to borrow
     * @returns The fee amount (Balancer fee is 0%)
     */
    public calculateFlashLoanFee(amount: string | number): number {
        return 0; // Balancer V2 has no flash loan fee
    }

    /**
     * Get the flash loan provider address (Balancer Vault)
     * @returns The Balancer Vault address
     */
    public getFlashLoanProviderAddress(): Address {
        return this.balancerVaultAddress;
    }

    /**
     * Initiates service shutdown
     */
    public async shutdown(): Promise<void> {
        logger.info('Initiating flash loan service shutdown');
        this.isShuttingDown = true;

        // Wait for any executing trades to complete
        while (this.isExecuting) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        logger.info('Flash loan service shutdown complete');
    }

    /**
     * Updates trade metrics after successful execution
     * Enhanced to support both USDC-WAVAX and USDC-WBTC pairs
     */
    private updateTradeMetrics(
        config: ArbitrageConfig,
        result: TradeResult,
        tradeId: string,
        executionTime: number,
        tokenPair: TokenPairConfig
    ): void {
        if (!result.receipt) return;

        // Extract output from result values
        const outputAmount = result.profit || '0';
        const netProfit = result.netProfit || result.profit || '0';

        // Create base metrics for the first swap with dynamic token info
        const firstSwapMetrics: Partial<SwapMetrics> = {
            dex: config.startDex,
            tradeId,
            swapStartTime: performance.now() - executionTime,
            swapEndTime: performance.now(),
            chainId: avalanche.id,
            chainName: 'Avalanche',
            inputTokenSymbol: tokenPair.sourceToken.symbol,
            inputTokenAddress: tokenPair.sourceToken.address,
            outputTokenSymbol: tokenPair.targetToken.symbol,
            outputTokenAddress: tokenPair.targetToken.address,
            poolAddress: config.simulatedTradeData?.firstLeg?.poolAddress || '',
            routerAddress: result.firstRouter || '',
            fee: config.simulatedTradeData?.firstLeg?.fee || 0,
            inputAmount: config.inputAmount,
            outputAmount: result.firstLegOutput || config.simulatedTradeData?.firstLeg?.expectedOutput || '0',
            transactionHash: result.receipt.transactionHash,
            gasEstimate: result.gasEstimate || '0',
            gasActual: result.gasUsed || '0',
            swapCycleTime: executionTime / 2 // Approximate since we can't track precisely in flash loan
        };

        // Second swap metrics
        const secondSwapMetrics: Partial<SecondSwapMetrics> = {
            dex: config.endDex,
            tradeId,
            swapStartTime: performance.now() - executionTime / 2,
            swapEndTime: performance.now(),
            chainId: avalanche.id,
            chainName: 'Avalanche',
            inputTokenSymbol: tokenPair.targetToken.symbol,
            inputTokenAddress: tokenPair.targetToken.address,
            outputTokenSymbol: tokenPair.sourceToken.symbol,
            outputTokenAddress: tokenPair.sourceToken.address,
            poolAddress: config.simulatedTradeData?.secondLeg?.poolAddress || '',
            routerAddress: result.secondRouter || '',
            fee: config.simulatedTradeData?.secondLeg?.fee || 0,
            inputAmount: result.firstLegOutput || config.simulatedTradeData?.firstLeg?.expectedOutput || '0',
            outputAmount: result.secondLegOutput || config.inputAmount,
            actualOutputAmount: netProfit,
            transactionHash: result.receipt.transactionHash,
            gasEstimate: '0', // Can't estimate individually in flash loan
            gasActual: '0',
            swapCycleTime: executionTime / 2 // Approximate
        };

        // Update metrics
        tradeMetricsManager.updateFirstSwapMetrics(firstSwapMetrics);
        tradeMetricsManager.updateSecondSwapMetrics(secondSwapMetrics);

        // Calculate and update totals
        tradeMetricsManager.calculateAndUpdateTotals();
    }
}