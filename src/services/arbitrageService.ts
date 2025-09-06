// src/services/arbitrageService.ts

import {
    type PublicClient,
    createPublicClient,
    http,
    type Hash,
    type Address
} from 'viem';
import { avalanche } from 'viem/chains';
import { getErrorMessage, TimingUtility, TransactionTracker, GasTransactionUtility, getBlockchainTime, estimateGasCostInUSDC} from '../utils.ts';
import { SmartContractService } from './smartContractService.ts';
import { FlashLoanService } from './flashLoanService.ts';
import { ARBITRAGE_SETTINGS, ADDRESSES, TOKEN_CONFIGS } from '../constants.ts';
import { tradeMetricsManager } from '../tradeMetrics.ts';
import logger from '../logger.js';
import {
    ArbitrageConfig,
    TradeResult,
    GasTrackingResult,
    DexType,
    TypeGuards
} from '../tradeTypes.ts';

export class ArbitrageService {
    private readonly publicClient: PublicClient;
    private readonly smartContractService: SmartContractService;
    private readonly transactionTracker: TransactionTracker;
    private readonly gasUtility: GasTransactionUtility;
    private readonly gasMetrics: GasTrackingResult[] = [];
    private isExecuting = false;
    private isShuttingDown = false;
    private acceptingNewTrades = true;
    private readonly pendingTransactions: Map<string, Hash> = new Map();
    private readonly activeTrades: Set<string> = new Set();
    private readonly activeTimings: Map<string, TimingUtility> = new Map();
    private readonly flashLoanService: FlashLoanService;

    constructor(privateKey: string) {
        if (!process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables');
        }
        const transport = http(process.env.AVALANCHE_RPC_URL);
        this.publicClient = createPublicClient({
            chain: avalanche,
            transport
        });
        // Ensure private key is properly formatted
        const formattedPrivateKey = privateKey.startsWith('0x')
            ? privateKey as `0x${string}`
            : `0x${privateKey}` as `0x${string}`;

        this.gasUtility = GasTransactionUtility.getInstance(this.publicClient);
        this.smartContractService = new SmartContractService(
            formattedPrivateKey,
            process.env.ARBITRAGE_CONTRACT_ADDRESS as Address
        );

        this.transactionTracker = new TransactionTracker();

        // Initialize FlashLoanService - required for operation
        try {
            this.flashLoanService = new FlashLoanService(
                this.smartContractService,
                ADDRESSES.BALANCER_V2.POOL as Address
            );
            logger.info('FlashLoanService initialized in ArbitrageService', {
                flashLoanProvider: ADDRESSES.BALANCER_V2.POOL,
                flashLoanFeeBps: ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS
            });
        } catch (error) {
            logger.error('Failed to initialize FlashLoanService in ArbitrageService', {
                error: getErrorMessage(error)
            });
            throw new Error('Failed to initialize FlashLoanService, which is required for operation');
        }

        logger.info('ArbitrageService initialized', {
            contractAddress: this.smartContractService.getContractAddress(),
            flashLoanProvider: ADDRESSES.BALANCER_V2.POOL,
            supportedTokens: {
                base: 'USDC',
                intermediateTokens: ['WAVAX', 'WBTC']
            }
        });
    }

    /**
     * Executes a flash loan arbitrage opportunity via FlashLoanService
     * @param config The arbitrage configuration to execute
     * @returns TradeResult containing the results of the execution
     */
    public async executeAtomicArbitrage(config: ArbitrageConfig): Promise<TradeResult> {
        if (!this.acceptingNewTrades) {
            return { success: false, error: 'Service not accepting trades', errorType: 'SERVICE_UNAVAILABLE' };
        }

        // Enhanced validation of arbitrage configuration
        if (!this.validateArbitrageConfig(config)) {
            return {
                success: false,
                error: 'Invalid arbitrage configuration',
                errorType: 'INVALID_CONFIG'
            };
        }

        const blockchainTime = await getBlockchainTime(this.publicClient);
        if (config.quoteTimestamp) {
            const quoteAge = blockchainTime - Number(config.quoteTimestamp);
            logger.info('Quote age assessment', {
                quoteTimestamp: config.quoteTimestamp,
                blockchainTime,
                quoteAge: `${quoteAge} seconds`
            });

            // Update timestamp if stale
            if (quoteAge > 5) {
                logger.warn('Updating stale timestamp in arbitrage config', {
                    originalTimestamp: config.quoteTimestamp,
                    blockchainTimestamp: blockchainTime,
                    quoteAge: blockchainTime - Number(config.quoteTimestamp)
                });
                config.quoteTimestamp = blockchainTime;
            }
        } else {
            logger.warn('Missing timestamp in arbitrage config, setting to blockchain time', {
                blockchainTimestamp: blockchainTime
            });
            config.quoteTimestamp = blockchainTime;
        }

        // Determine token pair type - USDC-WAVAX or USDC-WBTC
        const tokenPair = this.determineTokenPair(config);
        const sourceToken = tokenPair.sourceToken;
        const targetToken = tokenPair.targetToken;
        const isWbtcPair = targetToken.symbol === 'WBTC';

        logger.info('Token pair determined for arbitrage execution', {
            sourceToken: sourceToken.symbol,
            targetToken: targetToken.symbol,
            isWbtcPair
        });

        // Enhanced profit calculation with gas costs and flash loan fee
        if (config.simulatedTradeData?.secondLeg?.expectedOutput) {
            const inputAmount = parseFloat(config.inputAmount);
            const expectedOutput = parseFloat(config.simulatedTradeData.secondLeg.expectedOutput);
            const expectedProfit = expectedOutput - inputAmount;

            // Calculate flash loan fee - Balancer has 0% fee
            const flashLoanFee = 0;

            // Get gas cost estimate in USDC terms
            const gasEstimate = await estimateGasCostInUSDC(this.publicClient);

            // Calculate net profit after all fees
            const netProfit = expectedProfit - flashLoanFee - gasEstimate;

            logger.info('Profit calculation with fees', {
                tokenPair: `${sourceToken.symbol}-${targetToken.symbol}`,
                inputAmount,
                expectedOutput,
                expectedProfit,
                flashLoanFee,
                gasEstimateUSDC: gasEstimate,
                netProfit,
                isProfitable: netProfit > 0
            });

            // Combine global & local flags for test mode
            const isTestMode = ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE || config.testMode;

            if (netProfit <= 0) {
                if (!isTestMode) {
                    logger.warn("Skipping flash loan arbitrage because net profit <= 0 and testMode is false.");
                    return {
                        success: false,
                        error: "Unprofitable in non-test mode",
                        errorType: "INSUFFICIENT_PROFIT"
                    };
                } else {
                    // testMode is true - so we allow the trade anyway
                    logger.info("testMode is TRUE, proceeding with unknown-profit trade for testing.");
                }
            }
        } else {
            logger.warn('Missing expected output in second leg, cannot calculate profit');
        }

        // Initialize tracking and metrics
        const tradeId = performance.now().toString();
        const tradeTimingUtility = new TimingUtility(tradeId);
        this.activeTimings.set(tradeId, tradeTimingUtility);
        this.activeTrades.add(tradeId);
        tradeTimingUtility.recordEvent('startTime');

        try {
            if (!(await this.acquireLock())) {
                return {
                    success: false,
                    error: 'Service busy/shutting down',
                    errorType: 'SERVICE_BUSY'
                };
            }

            try {
                // Initialize metrics tracking
                tradeMetricsManager.startNewTradeMetrics();

                logger.info('Initiating flash loan arbitrage execution', {
                    tradeId,
                    startDex: config.startDex,
                    endDex: config.endDex,
                    tokenPair: `${sourceToken.symbol}-${targetToken.symbol}`,
                    inputAmount: config.inputAmount,
                    expectedProfit: config.simulatedTradeData?.secondLeg?.expectedOutput,
                    testMode: config.testMode || ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE,
                    flashLoanFee: '0' // Balancer has 0% fee
                });

                // Execute flash loan arbitrage via FlashLoanService
                const result = await this.flashLoanService.executeFlashLoanArbitrage(config);

                // Record timing for analytics
                tradeTimingUtility.recordEvent('endTime');
                let executionTime = 0;
                try {
                    executionTime = tradeTimingUtility.getTotalTime();
                } catch (error) {
                    logger.warn('Unable to get total time, using fallback method', {
                        tradeId,
                        error: getErrorMessage(error)
                    });
                    tradeTimingUtility.recordEvent('endTime');
                    executionTime = tradeTimingUtility.getTotalTimeOrZero();
                }

                if (result.success) {
                    // Update the transaction hash for tracking
                    if (result.firstLegHash) {
                        this.pendingTransactions.set(tradeId, result.firstLegHash as Hash);
                    }

                    // Log success details
                    logger.info('Flash loan arbitrage execution completed successfully', {
                        tradeId,
                        tokenPair: `${sourceToken.symbol}-${targetToken.symbol}`,
                        transactionHash: result.firstLegHash,
                        profit: result.profit,
                        flashLoanFee: result.flashLoanFee || '0',
                        netProfit: result.netProfit,
                        gasUsed: result.gasUsed,
                        executionTime
                    });

                    // Process validation checkpoints if available
                    if (result.validationCheckpoints && result.validationCheckpoints.length > 0) {
                        this.processValidationCheckpoints(config, result);
                    }

                    // Add checkpoint data to result if available
                    if (result.swapCheckpoints && result.swapCheckpoints.length > 0) {
                        logger.debug('Swap checkpoints from contract', {
                            tradeId,
                            checkpointCount: result.swapCheckpoints.length,
                            checkpoints: result.swapCheckpoints.map(cp => ({
                                stage: cp.stage,
                                actualBalance: cp.actualBalance,
                                expectedBalance: cp.expectedBalance,
                                difference: cp.difference
                            }))
                        });
                    }
                } else {
                    logger.error('Flash loan arbitrage execution failed', {
                        tradeId,
                        tokenPair: `${sourceToken.symbol}-${targetToken.symbol}`,
                        error: result.error,
                        errorType: result.errorType || 'UNKNOWN_ERROR'
                    });
                }

                return result;
            } finally {
                this.releaseLock();
            }
        } catch (error) {
            logger.error('Error executing flash loan arbitrage', {
                tradeId,
                error: getErrorMessage(error),
                config: {
                    startDex: config.startDex,
                    endDex: config.endDex,
                    inputAmount: config.inputAmount,
                    quoteTimestamp: config.quoteTimestamp,
                    tokenPair: `${sourceToken.symbol}-${targetToken.symbol}`
                }
            });
            return {
                success: false,
                error: getErrorMessage(error),
                errorType: 'EXECUTION_ERROR'
            };
        } finally {
            // Clean up tracking resources
            this.activeTrades.delete(tradeId);
            this.activeTimings.delete(tradeId);
            this.pendingTransactions.delete(tradeId);
        }
    }

    /**
     * Determines the token pair configuration from the arbitrage config
     * @param config The arbitrage configuration
     * @returns Object with source and target token details
     */
    private determineTokenPair(config: ArbitrageConfig): {
        sourceToken: typeof TOKEN_CONFIGS.USDC;
        targetToken: typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC;
    } {
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
                if (TypeGuards.isUniswapTrade(trade)) {
                    const outputCurrency = trade.outputAmount.currency;

                    if (outputCurrency && 'address' in outputCurrency) {
                        const outputAddress = (outputCurrency.address as string).toLowerCase();
                        isWbtcPair = outputAddress === TOKEN_CONFIGS.WBTC.address.toLowerCase();

                        logger.debug('Detected token from Uniswap trade', {
                            tokenSymbol: outputCurrency.symbol,
                            tokenAddress: outputAddress,
                            isWbtcPair
                        });
                    }
                } else if (TypeGuards.isTraderJoeTrade(trade)) {
                    const outputToken = trade.outputAmount.token;

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
            } catch (error) {
                logger.warn('Error determining token pair from trade object', {
                    error: getErrorMessage(error)
                });
            }

            // If we haven't determined the token type yet, try checking pool addresses
            if (!isWbtcPair) {
                try {
                    // Check the pool address for clues
                    const poolAddress = config.simulatedTradeData.firstLeg.poolAddress?.toLowerCase();
                    if (poolAddress) {
                        if (poolAddress === ADDRESSES.UNISWAP_V3.POOLS.USDC_WBTC.toLowerCase() ||
                            poolAddress === ADDRESSES.TRADER_JOE.POOLS.USDC_WBTC.toLowerCase()) {
                            isWbtcPair = true;

                            logger.debug('Detected WBTC pair from pool address', {
                                poolAddress,
                                isWbtcPair: true
                            });
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

        logger.info('Determined token pair for arbitrage', {
            sourceToken: sourceToken.symbol,
            targetToken: targetToken.symbol,
            isWbtcPair
        });

        return {
            sourceToken,
            targetToken
        };
    }

    /**
     * Helper method to process validation checkpoints from the contract
     */
    private processValidationCheckpoints(config: ArbitrageConfig, result: TradeResult): void {
        if (!result.validationCheckpoints) return;

        // Find last successful checkpoint
        const lastSuccessful = result.validationCheckpoints
            .filter(cp => cp.detail === "Pass" || cp.detail.includes("Completed"))
            .pop();

        // Find first failure
        const firstFailure = result.validationCheckpoints
            .find(cp => cp.detail !== "Pass" && !cp.detail.includes("Completed") && !cp.detail.includes("Starting"));

        if (firstFailure) {
            logger.warn('Flash loan validation failure', {
                lastSuccessfulStage: lastSuccessful?.stage || 'None',
                failedStage: firstFailure.stage,
                failureDetail: firstFailure.detail,
                startDex: config.startDex,
                endDex: config.endDex
            });

            // Record DEX-specific failures
            if (firstFailure.stage === "FirstSwap" && config.startDex) {
                this.recordDexFailure(config.startDex, firstFailure.stage);
            } else if (firstFailure.stage === "SecondSwap" && config.endDex) {
                this.recordDexFailure(config.endDex, firstFailure.stage);
            }
        }
    }

    // Track DEX-specific failures for analytics
    private dexFailureCounts: Record<DexType, Record<string, number>> = {
        uniswap: {},
        traderjoe: {}
    };

    private recordDexFailure(dex: DexType, errorType: string): void {
        if (!this.dexFailureCounts[dex][errorType]) {
            this.dexFailureCounts[dex][errorType] = 0;
        }

        this.dexFailureCounts[dex][errorType]++;

        // Log if we're seeing a pattern of failures with a particular DEX
        const failureCount = this.dexFailureCounts[dex][errorType];
        if (failureCount >= 3) {
            logger.warn(`Repeated failures with ${dex}`, {
                dex,
                errorType,
                failureCount,
                allFailures: this.dexFailureCounts[dex]
            });
        }
    }

    /**
     * Gets the current gas price with adjustments based on configuration
     * @returns The adjusted gas price in wei
     */
    public async getCurrentGasPrice(): Promise<bigint> {
        return this.gasUtility.getGasPrice();
    }

    /**
     * Initiates a service shutdown
     */
    public async shutdown(): Promise<void> {
        logger.info('Initiating arbitrage service shutdown');
        this.isShuttingDown = true;
        this.acceptingNewTrades = false;

        // Shutdown flash loan service
        try {
            await this.flashLoanService.shutdown();
            logger.info('Flash loan service shutdown complete');
        } catch (error) {
            logger.error('Error shutting down flash loan service', {
                error: getErrorMessage(error)
            });
        }

        // Wait for any pending operations to complete
        if (this.pendingTransactions.size > 0 || this.activeTrades.size > 0) {
            await Promise.all([
                this.waitForPendingTransactions(),
                this.waitForActiveTrades()
            ]);
        }

        this.transactionTracker.clear();
        await logger.flush();
    }

    /**
     * Gets the address of the wallet
     * @returns The wallet address
     */
    public getWalletAddress(): Address {
        return this.smartContractService.getWalletAddress();
    }

    /**
     * Checks if there are any active trades or pending transactions
     * @returns True if there are active trades, false otherwise
     */
    public hasActiveTrades(): boolean {
        return this.pendingTransactions.size > 0 || this.activeTrades.size > 0;
    }

    private async acquireLock(): Promise<boolean> {
        if (this.isExecuting || this.isShuttingDown) return false;
        this.isExecuting = true;
        return true;
    }

    private releaseLock(): void {
        this.isExecuting = false;
    }

    private async waitForPendingTransactions(timeout: number = 60000): Promise<void> {
        const startTime = performance.now();
        while (this.pendingTransactions.size > 0) {
            if (performance.now() - startTime > timeout) {
                logger.warn(`Shutdown timeout reached with ${this.pendingTransactions.size} transactions pending`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    private async waitForActiveTrades(timeout: number = 30000): Promise<void> {
        const startTime = performance.now();
        while (this.activeTrades.size > 0) {
            if (performance.now() - startTime > timeout) {
                logger.warn(`Shutdown timeout reached with ${this.activeTrades.size} trades active`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    /**
     * Validates the arbitrage configuration
     * @param config The arbitrage configuration to validate
     * @returns True if the configuration is valid, false otherwise
     */
    private validateArbitrageConfig(config: ArbitrageConfig): boolean {
        let isValid = true;
        const validationErrors: string[] = [];

        // Check required top-level fields
        if (!config.startDex) {
            validationErrors.push('Missing startDex');
            isValid = false;
        }

        if (!config.endDex) {
            validationErrors.push('Missing endDex');
            isValid = false;
        }

        if (!config.inputAmount) {
            validationErrors.push('Missing inputAmount');
            isValid = false;
        } else if (parseFloat(config.inputAmount) <= 0) {
            validationErrors.push('inputAmount must be greater than 0');
            isValid = false;
        }

        // Check for simulated trade data
        if (!config.simulatedTradeData) {
            validationErrors.push('Missing simulatedTradeData');
            isValid = false;
        } else {
            // Validate first leg
            if (!config.simulatedTradeData.firstLeg) {
                validationErrors.push('Missing firstLeg in simulatedTradeData');
                isValid = false;
            } else {
                // Check first leg fields
                if (!config.simulatedTradeData.firstLeg.swapCalldata) {
                    validationErrors.push('Missing swapCalldata in firstLeg');
                    isValid = false;
                }

                if (!config.simulatedTradeData.firstLeg.routerAddress) {
                    validationErrors.push('Missing routerAddress in firstLeg');
                    isValid = false;
                }

                if (!config.simulatedTradeData.firstLeg.expectedOutput) {
                    validationErrors.push('Missing expectedOutput in firstLeg');
                    isValid = false;
                }

                if (!config.simulatedTradeData.firstLeg.trade) {
                    validationErrors.push('Missing trade object in firstLeg');
                    isValid = false;
                }
            }

            // Validate second leg
            if (!config.simulatedTradeData.secondLeg) {
                validationErrors.push('Missing secondLeg in simulatedTradeData');
                isValid = false;
            } else {
                // Check second leg fields
                if (!config.simulatedTradeData.secondLeg.swapCalldata) {
                    validationErrors.push('Missing swapCalldata in secondLeg');
                    isValid = false;
                }

                if (!config.simulatedTradeData.secondLeg.routerAddress) {
                    validationErrors.push('Missing routerAddress in secondLeg');
                    isValid = false;
                }

                if (!config.simulatedTradeData.secondLeg.expectedOutput) {
                    validationErrors.push('Missing expectedOutput in secondLeg');
                    isValid = false;
                }

                if (!config.simulatedTradeData.secondLeg.trade) {
                    validationErrors.push('Missing trade object in secondLeg');
                    isValid = false;
                }
            }
        }

        // Log validation results
        if (!isValid) {
            logger.warn('Invalid arbitrage configuration', {
                validationErrors,
                config: {
                    startDex: config.startDex,
                    endDex: config.endDex,
                    inputAmount: config.inputAmount,
                    quoteTimestamp: config.quoteTimestamp
                }
            });
        }

        return isValid;
    }

    // Used in mainArbitrage.ts
    /**
     * Gets the list of active trade IDs for monitoring
     * @returns Array of active trade IDs
     */
    public getActiveTrades(): string[] {
        return Array.from(this.activeTrades);
    }

    // Used in mainArbitrage.ts
    /**
     * Gets the list of pending transaction hashes for monitoring
     * @returns Array of pending transaction hashes
     */
    public getPendingTransactions(): Hash[] {
        return Array.from(this.pendingTransactions.values());
    }

    /**
     * Gets the current blockchain time from the latest block
     * @returns The blockchain timestamp in seconds
     */
    public async getBlockchainTime(): Promise<number> {
        return getBlockchainTime(this.publicClient);
    }

    /**
     * Gets the flash loan provider address
     * @returns The address of the flash loan provider
     */
    public getFlashLoanProviderAddress(): Address {
        return ADDRESSES.BALANCER_V2.POOL as Address;
    }

    /**
     * Calculates the expected flash loan fee for a given amount
     * @param amount The loan amount as a string
     * @returns The expected flash loan fee as a string
     */
    public calculateFlashLoanFee(amount: string): string {
        // For Balancer V2, flash loan fee is 0
        return "0";
    }
}