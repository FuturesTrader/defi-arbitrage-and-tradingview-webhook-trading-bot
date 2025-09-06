// src/mainArbitrage.ts
import { ArbitrageService } from './services/arbitrageService';
import { SmartContractService } from './services/smartContractService';
import { PriceMonitorService } from './services/priceMonitorService';
import { FlashLoanService } from './services/flashLoanService';
import { getErrorMessage, sleep } from './utils';
import { formatUnits, createPublicClient, http, type Address } from 'viem';
import { avalanche } from 'viem/chains';
import { ARBITRAGE_SETTINGS, GAS_OPTIMIZATION, TOKEN_CONFIGS, ADDRESSES } from './constants';
import dotenv from 'dotenv';
dotenv.config();
import logger from '@/logger';
import { tradeLogger } from '@/logger';
import { tradeMetricsManager, DetailedTradeMetrics } from '@/tradeMetrics';
import {
    type TimingMetrics,
    type ArbitrageOpportunity,
    type TradeResult,
    type ArbitrageExecutedEvent,
    type ArbitrageConfig,
    TypeGuards
} from '@/tradeTypes';
// Standardize flash loan fee basis points
const FLASH_LOAN_FEE_BPS = ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS;
const FLASH_LOAN_POOL = ADDRESSES.BALANCER_V2.POOL;
// Global service references
let arbitrageService: ArbitrageService | null = null;
let smartContractService: SmartContractService | null = null;
let priceMonitor: PriceMonitorService | null = null;
let flashLoanService: FlashLoanService | null = null;
let isShuttingDown = false;
let forceShutdown = false;

interface FlashLoanErrorDetails {
    tradeId: string;
    error: string | undefined;
    errorType: string;
    transactionHash: `0x${string}` | undefined;
    expectedFlashLoanFee: string;
    expectedNetProfit: string;
    possibleCause?: string;
    recoveryAction?: string;
    tokenPair?: string;
}
interface IFlashLoanService {
    executeFlashLoanArbitrage(config: ArbitrageConfig): Promise<TradeResult>;
    shutdown(): Promise<void>;
}
// Enhanced metrics interface to include contract-specific metrics
interface ExtendedTimingMetrics extends TimingMetrics {
    contractMetrics: {
        totalGasUsed: string;
        averageGasUsed: string;
        successfulAtomicSwaps: number;
        failedAtomicSwaps: number;
        totalAtomicProfit: string;
        averageExecutionTime: string;
        totalTransactions: number;
        failedTransactions: number;
    };
    flashLoanMetrics: {
        attempts: number;
        successful: number;
        failed: number;
        totalProfit: number;
        totalFeesPaid: number;
        averageNetProfit: number;
    };
    // Add token-specific metrics to track WAVAX vs WBTC performance
    tokenMetrics: {
        WAVAX: {
            attempts: number;
            successful: number;
            totalProfit: number;
        };
        WBTC: {
            attempts: number;
            successful: number;
            totalProfit: number;
        };
    };
}

// Initialize metrics
const metrics: ExtendedTimingMetrics = {
    startTime: 0,
    lastCheckpoint: 0,
    checkpoints: {},
    cycleCount: 0,
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    profitableTrades: 0,
    unprofitableTrades: 0,
    totalProfit: 0,
    gasMetrics: [],
    contractMetrics: {
        totalGasUsed: '0',
        averageGasUsed: '0',
        successfulAtomicSwaps: 0,
        failedAtomicSwaps: 0,
        totalAtomicProfit: '0',
        averageExecutionTime: '0',
        totalTransactions: 0,
        failedTransactions: 0
    },
    flashLoanMetrics: {
        attempts: 0,
        successful: 0,
        failed: 0,
        totalProfit: 0,
        totalFeesPaid: 0,
        averageNetProfit: 0
    },
    // Initialize token-specific metrics
    tokenMetrics: {
        WAVAX: {
            attempts: 0,
            successful: 0,
            totalProfit: 0
        },
        WBTC: {
            attempts: 0,
            successful: 0,
            totalProfit: 0
        }
    }
};

function logPerformanceMetrics(): void {
    const executedTrades = metrics.successfulTrades + metrics.failedTrades;
    const successRate = executedTrades > 0
        ? (metrics.successfulTrades / executedTrades) * 100
        : 0;
    const profitRate = metrics.successfulTrades > 0
        ? (metrics.profitableTrades / metrics.successfulTrades) * 100
        : 0;

    logger.info('Performance metrics', {
        cycleCount: metrics.cycleCount,
        totalTrades: metrics.totalTrades,
        successfulTrades: metrics.successfulTrades,
        failedTrades: metrics.failedTrades,
        profitableTrades: metrics.profitableTrades,
        unprofitableTrades: metrics.unprofitableTrades,
        totalProfit: metrics.totalProfit.toFixed(6),
        successRate: `${successRate.toFixed(2)}%`,
        profitRateAmongSuccesses: `${profitRate.toFixed(2)}%`,
        contractMetrics: {
            successfulAtomicSwaps: metrics.contractMetrics.successfulAtomicSwaps,
            failedAtomicSwaps: metrics.contractMetrics.failedAtomicSwaps,
            averageGasUsed: metrics.contractMetrics.averageGasUsed,
            totalAtomicProfit: metrics.contractMetrics.totalAtomicProfit
        },
        flashLoanMetrics: {
            attempts: metrics.flashLoanMetrics.attempts,
            successful: metrics.flashLoanMetrics.successful,
            failed: metrics.flashLoanMetrics.failed,
            totalProfit: metrics.flashLoanMetrics.totalProfit.toFixed(6),
            totalFeesPaid: metrics.flashLoanMetrics.totalFeesPaid.toFixed(6),
            successRate: metrics.flashLoanMetrics.attempts > 0
                ? ((metrics.flashLoanMetrics.successful / metrics.flashLoanMetrics.attempts) * 100).toFixed(2) + '%'
                : 'N/A'
        },
        // Include token-specific metrics
        tokenMetrics: {
            WAVAX: {
                attempts: metrics.tokenMetrics.WAVAX.attempts,
                successful: metrics.tokenMetrics.WAVAX.successful,
                totalProfit: metrics.tokenMetrics.WAVAX.totalProfit.toFixed(6),
                successRate: metrics.tokenMetrics.WAVAX.attempts > 0
                    ? ((metrics.tokenMetrics.WAVAX.successful / metrics.tokenMetrics.WAVAX.attempts) * 100).toFixed(2) + '%'
                    : 'N/A'
            },
            WBTC: {
                attempts: metrics.tokenMetrics.WBTC.attempts,
                successful: metrics.tokenMetrics.WBTC.successful,
                totalProfit: metrics.tokenMetrics.WBTC.totalProfit.toFixed(6),
                successRate: metrics.tokenMetrics.WBTC.attempts > 0
                    ? ((metrics.tokenMetrics.WBTC.successful / metrics.tokenMetrics.WBTC.attempts) * 100).toFixed(2) + '%'
                    : 'N/A'
            }
        }
    });
}

async function emergencyShutdown(): Promise<void> {
    logger.error('Initiating emergency shutdown...');
    forceShutdown = true;
    try {
        recordMetric('emergency_shutdown');
        const runtime = calculateRuntime();
        const successRate = metrics.totalTrades > 0
            ? (metrics.successfulTrades / metrics.totalTrades) * 100
            : 0;
        const profitRate = metrics.successfulTrades > 0
            ? (metrics.profitableTrades / metrics.successfulTrades) * 100
            : 0;
        const avgProfitPerTrade = metrics.profitableTrades > 0
            ? metrics.totalProfit / metrics.profitableTrades
            : 0;
        const shutdownPromises: Promise<void>[] = [];

        if (priceMonitor) {
            shutdownPromises.push(
                Promise.race([
                    priceMonitor.shutdown(),
                    sleep(5000)
                ]).catch(error => {
                    logger.error('Price monitor emergency shutdown failed', { error: getErrorMessage(error) });
                })
            );
        }

        if (arbitrageService) {
            shutdownPromises.push(
                Promise.race([
                    arbitrageService.shutdown(),
                    sleep(5000)
                ]).catch(error => {
                    logger.error('Arbitrage service emergency shutdown failed', { error: getErrorMessage(error) });
                })
            );
        }

        if (flashLoanService) {
            shutdownPromises.push(
                Promise.race([
                    flashLoanService.shutdown(),
                    sleep(5000)
                ]).catch(error => {
                    logger.error('Flash loan service emergency shutdown failed', { error: getErrorMessage(error) });
                })
            );
        }

        await Promise.all(shutdownPromises);

        const timingAnalysis = Object.entries(metrics.checkpoints)
            .map(([name, time]) => ({
                checkpoint: name,
                timeFromStart: `${((time - metrics.startTime) / 1000).toFixed(2)}s`,
                timeFromPrevious: name === 'start' ? '0.00s' : `${((time - metrics.checkpoints[Object.keys(metrics.checkpoints)[Object.keys(metrics.checkpoints).indexOf(name) - 1]]) / 1000).toFixed(2)}s`
            }));

        let totalGasCost = '0';
        let avgGasCostPerTrade = '0';
        if (metrics.gasMetrics && metrics.gasMetrics.length > 0) {
            const totalGasUsed = metrics.gasMetrics.reduce((sum, m) => sum + BigInt(m.gasUsed), 0n);
            const avgGasPrice = metrics.gasMetrics.reduce((sum, m) => sum + BigInt(m.effectiveGasPrice), 0n) / BigInt(metrics.gasMetrics.length);
            totalGasCost = formatUnits(totalGasUsed * avgGasPrice, 18);
            avgGasCostPerTrade = formatUnits((totalGasUsed * avgGasPrice) / BigInt(metrics.totalTrades), 18);
        }

        logger.error('Emergency Shutdown Summary', {
            runtime: `${runtime.hours}h ${runtime.minutes}m ${runtime.seconds}s`,
            trades: {
                total: metrics.totalTrades,
                successful: metrics.successfulTrades,
                failed: metrics.failedTrades,
                profitable: metrics.profitableTrades,
                unprofitable: metrics.unprofitableTrades,
                successRate: `${successRate.toFixed(2)}%`,
                profitRate: `${profitRate.toFixed(2)}%`
            },
            profits: {
                total: `${metrics.totalProfit.toFixed(6)} USDC`,
                averagePerProfitableTrade: `${avgProfitPerTrade.toFixed(6)} USDC`,
                netProfitAfterGas: `${(metrics.totalProfit - parseFloat(totalGasCost)).toFixed(6)} USDC`
            },
            gas: {
                totalCost: `${totalGasCost} AVAX`,
                averagePerTrade: `${avgGasCostPerTrade} AVAX`
            },
            flashLoanMetrics: {
                attempts: metrics.flashLoanMetrics.attempts,
                successful: metrics.flashLoanMetrics.successful,
                failed: metrics.flashLoanMetrics.failed,
                totalProfit: metrics.flashLoanMetrics.totalProfit.toFixed(6),
                totalFeesPaid: metrics.flashLoanMetrics.totalFeesPaid.toFixed(6),
                averageNetProfit: metrics.flashLoanMetrics.averageNetProfit.toFixed(6)
            },
            tokenMetrics: {
                WAVAX: {
                    attempts: metrics.tokenMetrics.WAVAX.attempts,
                    successful: metrics.tokenMetrics.WAVAX.successful,
                    totalProfit: metrics.tokenMetrics.WAVAX.totalProfit.toFixed(6)
                },
                WBTC: {
                    attempts: metrics.tokenMetrics.WBTC.attempts,
                    successful: metrics.tokenMetrics.WBTC.successful,
                    totalProfit: metrics.tokenMetrics.WBTC.totalProfit.toFixed(6)
                }
            },
            performance: {
                cycles: metrics.cycleCount,
                averageCycleTime: metrics.cycleCount > 0
                    ? `${((performance.now() - metrics.startTime) / metrics.cycleCount / 1000).toFixed(2)}s`
                    : '0s',
                activeTransactions: arbitrageService?.hasActiveTrades() || false
            },
            timingAnalysis,
            checkpoints: metrics.checkpoints
        });

        if (arbitrageService?.hasActiveTrades()) {
            logger.warn('Emergency shutdown executed with active trades', {
                pendingTransactions: arbitrageService.getPendingTransactions?.() || [],
                activeTrades: arbitrageService.getActiveTrades?.() || []
            });
        }

        await logger.flush();
    } catch (error) {
        console.error('Emergency shutdown logging failed:', error);
    } finally {
        process.exit(1);
    }
}

// Utility function to calculate runtime.
function calculateRuntime(): { hours: number; minutes: number; seconds: number } {
    const totalSeconds = Math.floor((performance.now() - metrics.startTime) / 1000);
    return {
        hours: Math.floor(totalSeconds / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
    };
}

async function checkBalance(arbitrageService: ArbitrageService): Promise<boolean> {
    try {
        const gasPrice = await arbitrageService.getCurrentGasPrice();
        const baseGasPrice = gasPrice / 10n;
        const adjustedGasPrice =
            (baseGasPrice *
                BigInt(Math.floor(GAS_OPTIMIZATION.BASE_FEE_MULTIPLIER * 100))) /
            100n;
        const estimatedGasCost = adjustedGasPrice * GAS_OPTIMIZATION.ESTIMATOR.SWAP_BASE;
        const maxGasCost = BigInt(
            Math.ceil(Number(estimatedGasCost) * GAS_OPTIMIZATION.ESTIMATOR.BUFFER_MULTIPLIER)
        );
        const minRequired = maxGasCost * 3n;

        const publicClient = createPublicClient({
            chain: avalanche,
            transport: http(process.env.AVALANCHE_RPC_URL as string),
        });

        const balance = await publicClient.getBalance({
            address: arbitrageService.getWalletAddress(),
        });

        logger.info('AVAX balance check', {
            currentBalance: formatUnits(balance, 18),
            requiredBalance: formatUnits(minRequired, 18),
            estimatedGasCost: formatUnits(maxGasCost, 18),
            adjustedGasPrice: formatUnits(adjustedGasPrice, 9),
            baseGasPrice: formatUnits(gasPrice, 9),
        });

        return balance >= minRequired;
    } catch (error) {
        logger.error('Error checking balance', {
            error: getErrorMessage(error),
        });
        return false;
    }
}

async function validateBalance(arbitrageService: ArbitrageService): Promise<void> {
    const hasBalance = await checkBalance(arbitrageService);
    if (!hasBalance) {
        logger.error('Insufficient AVAX balance for gas costs');
        await emergencyShutdown();
    }
}

/**
 * Determines whether to use flash loans for a given opportunity
 * @param opportunity The arbitrage opportunity to evaluate
 * @returns boolean indicating whether to use flash loans
 */
async function shouldUseFlashLoan(opportunity: ArbitrageOpportunity): Promise<boolean> {
    // Skip flash loans if disabled in settings
    if (!ARBITRAGE_SETTINGS.FLASH_LOANS_ENABLED) {
        return false;
    }

    // Parse input amount
    const inputAmount = parseFloat(opportunity.amountIn);

    // Get contract USDC balance
    const contractUSDCBalance = await getContractUSDCBalance();

    // Force flash loans if contract doesn't have enough balance
    if (contractUSDCBalance < inputAmount) {
        logger.info('Using flash loan due to insufficient contract balance', {
            contractBalance: contractUSDCBalance.toFixed(6),
            requiredAmount: inputAmount.toFixed(6)
        });
        return true;
    }

    // If in test mode, follow the test mode setting
    if (ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE) {
        return ARBITRAGE_SETTINGS.TEST_FLASH_LOANS;
    }

    // Only use flash loans for trades above the threshold
    if (inputAmount < ARBITRAGE_SETTINGS.FLASH_LOAN_THRESHOLD) {
        return false;
    }

    // Calculate the Balancer flash loan fee (typically 0%)
    const flashLoanFee = (inputAmount * FLASH_LOAN_FEE_BPS) / 10000;

    // Calculate expected profit
    // The expectedOutput already includes the DEX fee impact
    const expectedOutput = parseFloat(opportunity.secondLeg.expectedOutput);
    const expectedProfit = expectedOutput - inputAmount;

    // Calculate net profit after flash loan fee
    const netProfit = expectedProfit - flashLoanFee;

    // Only use flash loans if profitable after fee
    if (netProfit <= 0) {
        logger.debug('Flash loan not profitable after fees', {
            inputAmount,
            expectedProfit,
            netProfit,
            tokenPair: opportunity.targetTokenSymbol || 'WAVAX' // Include token type in logging
        });

        // Instead of returning an object, just return false
        return false;
    }

    // Calculate profit margin percentage (profit relative to input)
    const profitMargin = netProfit / inputAmount * 100;

    // Log decision details
    logger.debug('Flash loan decision factors', {
        tokenPair: opportunity.targetTokenSymbol || 'WAVAX', // Include token type in logging
        inputAmount: inputAmount.toFixed(6),
        expectedOutput: expectedOutput.toFixed(6),
        expectedProfit: expectedProfit.toFixed(6),
        flashLoanFee: flashLoanFee.toFixed(6),
        netProfit: netProfit.toFixed(6),
        profitMargin: `${profitMargin.toFixed(4)}%`,
        minThreshold: ARBITRAGE_SETTINGS.MIN_FLASH_LOAN_PROFIT_PERCENT,
        useFlashLoan: profitMargin >= ARBITRAGE_SETTINGS.MIN_FLASH_LOAN_PROFIT_PERCENT
    });

    // Use flash loans if profit margin exceeds minimum threshold
    return profitMargin >= ARBITRAGE_SETTINGS.MIN_FLASH_LOAN_PROFIT_PERCENT;
}
/**
 * Gets the current USDC balance of the arbitrage contract
 * @returns Promise resolving to the contract's USDC balance as a number
 */
async function getContractUSDCBalance(): Promise<number> {
    try {
        if (!smartContractService) {
            logger.warn('Smart contract service not initialized');
            return 0;
        }

        // Get the contract address
        const contractAddress = smartContractService.getContractAddress();

        // Create an ERC20 contract instance for USDC
        const usdcContract = {
            address: TOKEN_CONFIGS.USDC.address as Address,
            abi: [
                {
                    name: 'balanceOf',
                    type: 'function',
                    stateMutability: 'view',
                    inputs: [{ name: 'account', type: 'address' }],
                    outputs: [{ name: '', type: 'uint256' }]
                }
            ]
        };

        // Get the balance using PublicClient
        const publicClient = createPublicClient({
            chain: avalanche,
            transport: http(process.env.AVALANCHE_RPC_URL as string)
        });

        const balanceBigInt = await publicClient.readContract({
            ...usdcContract,
            functionName: 'balanceOf',
            args: [contractAddress]
        }) as bigint;

        // Convert to human-readable format with proper decimals
        const balance = Number(formatUnits(balanceBigInt, TOKEN_CONFIGS.USDC.decimals));

        logger.debug('Contract USDC balance check', {
            contractAddress,
            usdcBalance: balance.toFixed(6)
        });

        return balance;
    } catch (error) {
        logger.error('Error checking contract USDC balance', {
            error: getErrorMessage(error)
        });
        return 0; // Default to 0 on error
    }
}
// Updated monitoring and execution function to include flash loan logic and WBTC support
async function monitorAndExecute(
    arbitrageService: ArbitrageService,
    smartContractService: SmartContractService,
    priceMonitor: PriceMonitorService,
    flashLoanService: IFlashLoanService
): Promise<void> {
    if (isShuttingDown) {
        logger.info('Skipping execution cycle - shutdown in progress');
        return;
    }

    metrics.cycleCount++;
    recordMetric('cycle_start');

    try {
        const opportunity = await priceMonitor.findArbitrageOpportunity();
        recordMetric('price_check_complete');
        if (opportunity) {
            await smartContractService.checkTimeSync();
        }
        if (!opportunity) return;

        metrics.totalTrades++;
        const blockchainTime = await arbitrageService.getBlockchainTime();
        const tradeId = `${blockchainTime}-${performance.now()}`;

        // Determine the token pair being traded (WAVAX or WBTC)
        const isWbtcPair = opportunity.targetTokenSymbol === 'WBTC';
        const tokenPairLabel = isWbtcPair ? 'USDC-WBTC' : 'USDC-WAVAX';

        // Update token-specific metrics counters
        if (isWbtcPair) {
            metrics.tokenMetrics.WBTC.attempts++;
        } else {
            metrics.tokenMetrics.WAVAX.attempts++;
        }

        // Log the opportunity with token pair info
        logger.info('Processing arbitrage opportunity', {
            tradeId,
            tokenPair: tokenPairLabel,
            startDex: opportunity.startDex,
            endDex: opportunity.endDex,
            profitPercent: `${opportunity.profitPercent.toFixed(3)}%`,
            expectedProfit: opportunity.expectedProfit,
            amountIn: opportunity.amountIn
        });

        // Determine whether to use flash loans
        const useFlashLoan = await shouldUseFlashLoan(opportunity);

        if (useFlashLoan) {
            logger.info('Executing flash loan arbitrage opportunity', {
                tradeId,
                tokenPair: tokenPairLabel,
                startDex: opportunity.startDex,
                endDex: opportunity.endDex,
                profitPercent: `${opportunity.profitPercent.toFixed(3)}%`,
                expectedProfit: opportunity.expectedProfit,
                amountIn: opportunity.amountIn,
                flashLoanFee: (parseFloat(opportunity.amountIn) * FLASH_LOAN_FEE_BPS / 10000).toFixed(6),
                netProfit: (parseFloat(opportunity.expectedProfit)).toFixed(6)
            });

            // Track flash loan metrics
            metrics.flashLoanMetrics.attempts++;

            recordMetric('flash_loan_execution_start');
            tradeMetricsManager.startNewTradeMetrics();

            // Execute the flash loan arbitrage
            const result = await flashLoanService.executeFlashLoanArbitrage({
                startDex: opportunity.startDex,
                endDex: opportunity.endDex,
                inputAmount: opportunity.amountIn,
                simulatedTradeData: {
                    firstLeg: opportunity.firstLeg,
                    secondLeg: opportunity.secondLeg
                },
                testMode: ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE
            });
            // Calculate flash loan fee regardless of success for logging
            const flashLoanFee = parseFloat(result.flashLoanFee ||
                (parseFloat(opportunity.amountIn) * FLASH_LOAN_FEE_BPS / 10000).toFixed(6));

            // Calculate net profit (either from result or manually)
            const actualProfit = parseFloat(result.profit || '0');
            const netProfit = parseFloat(result.netProfit ||
                (actualProfit - flashLoanFee).toFixed(6));
            // Update metrics based on flash loan execution result
            if (result.success) {
                metrics.successfulTrades++;
                metrics.flashLoanMetrics.successful++;

                // Update token-specific success metrics
                if (isWbtcPair) {
                    metrics.tokenMetrics.WBTC.successful++;
                    metrics.tokenMetrics.WBTC.totalProfit += netProfit;
                } else {
                    metrics.tokenMetrics.WAVAX.successful++;
                    metrics.tokenMetrics.WAVAX.totalProfit += netProfit;
                }

                metrics.totalProfit += netProfit;
                metrics.flashLoanMetrics.totalProfit += netProfit;
                metrics.flashLoanMetrics.totalFeesPaid += flashLoanFee;

                if (metrics.flashLoanMetrics.successful > 0) {
                    metrics.flashLoanMetrics.averageNetProfit =
                        metrics.flashLoanMetrics.totalProfit / metrics.flashLoanMetrics.successful;
                }

                if (netProfit > 0) {
                    metrics.profitableTrades++;
                    logger.info('Flash loan arbitrage executed successfully', {
                        tradeId,
                        tokenPair: tokenPairLabel,
                        transactionHash: result.firstLegHash,
                        profit: actualProfit.toFixed(6),
                        flashLoanFee: flashLoanFee.toFixed(6),
                        netProfit: netProfit.toFixed(6),
                        totalProfitSoFar: metrics.totalProfit.toFixed(6)
                    });
                } else {
                    metrics.unprofitableTrades++;
                    logger.warn('Flash loan arbitrage executed but with no net profit', {
                        tradeId,
                        tokenPair: tokenPairLabel,
                        transactionHash: result.firstLegHash,
                        profit: actualProfit.toFixed(6),
                        flashLoanFee: flashLoanFee.toFixed(6),
                        netProfit: netProfit.toFixed(6)
                    });
                }
            } else {
                metrics.failedTrades++;
                metrics.flashLoanMetrics.failed++;
                // Enhanced error reporting for flash loan failures
                const errorDetails: FlashLoanErrorDetails = {
                    tradeId,
                    error: result.error,
                    errorType: result.errorType || 'UNKNOWN_ERROR',
                    transactionHash: result.firstLegHash,
                    expectedFlashLoanFee: flashLoanFee.toFixed(6),
                    expectedNetProfit: (parseFloat(opportunity.expectedProfit) - flashLoanFee).toFixed(6),
                    tokenPair: tokenPairLabel
                };

                // Add specific details for common flash loan errors
                if (result.errorType === 'FLASH_LOAN_CALLBACK_FAILED') {
                    errorDetails['possibleCause'] = 'Contract was unable to execute the callback function';
                    errorDetails['recoveryAction'] = 'Check contract approvals and balance';
                } else if (result.errorType === 'FLASH_LOANS_FROZEN') {
                    errorDetails['possibleCause'] = 'Flash loans are disabled on the contract';
                    errorDetails['recoveryAction'] = 'Run configureFlashLoan.ts to enable them';
                } else if (result.errorType === 'INSUFFICIENT_BALANCE') {
                    errorDetails['possibleCause'] = 'The contract does not have enough balance to repay the loan';
                    errorDetails['recoveryAction'] = 'Fund the contract or use test mode with owner funds';
                }

                logger.error('Flash loan arbitrage execution failed', errorDetails);
            }

            // Log detailed metrics
            const metricsData = tradeMetricsManager.getCurrentMetrics();
            await logTradeExecution(
                tradeId,
                opportunity,
                result,
                null,
                metricsData,
                true,  // Explicitly mark as flash loan
                flashLoanFee,  // Pass the fee
                netProfit  // Pass the net profit
            );

            recordMetric('flash_loan_execution_complete');
        } else {
            // Regular arbitrage execution (non-flash loan)
            logger.info('Executing atomic arbitrage opportunity', {
                tradeId,
                tokenPair: tokenPairLabel,
                startDex: opportunity.startDex,
                endDex: opportunity.endDex,
                profitPercent: `${opportunity.profitPercent.toFixed(3)}%`,
                expectedProfit: opportunity.expectedProfit,
                amountIn: opportunity.amountIn
            });

            recordMetric('execution_start');
            tradeMetricsManager.startNewTradeMetrics();
            logger.warn('CRITICAL PRE-EXECUTION CHECK', {
                opportunityQuoteTimestamp: opportunity.quoteTimestamp,
                opportunityQuoteTimestampISO: opportunity.quoteTimestamp
                    ? new Date(opportunity.quoteTimestamp * 1000).toISOString()
                    : 'undefined',
                currentTime: Math.floor(Date.now() / 1000),
                currentTimeISO: new Date().toISOString(),
                tokenPair: tokenPairLabel
            });

            // Execute the atomic arbitrage via arbitrageService
            const result = await arbitrageService.executeAtomicArbitrage({
                startDex: opportunity.startDex,
                endDex: opportunity.endDex,
                inputAmount: opportunity.amountIn,
                simulatedTradeData: {
                    firstLeg: opportunity.firstLeg,
                    secondLeg: opportunity.secondLeg
                },
                testMode: ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE
            });

            // Get event data if successful
            let event: ArbitrageExecutedEvent | null = null;
            if (result.success && result.receipt) {
                event = smartContractService.parseArbitrageEvent(result.receipt);
            }

            // Update metrics based on atomic execution result
            if (result.success) {
                metrics.successfulTrades++;
                metrics.contractMetrics.successfulAtomicSwaps++;

                // Update token-specific success metrics
                if (isWbtcPair) {
                    metrics.tokenMetrics.WBTC.successful++;
                }
                else {
                    metrics.tokenMetrics.WAVAX.successful++;
                }

                const profit = event ? Number(formatUnits(event.profit, 6)) : 0;
                metrics.totalProfit += profit;
                metrics.contractMetrics.totalAtomicProfit =
                    (BigInt(metrics.contractMetrics.totalAtomicProfit) + (event?.profit || 0n)).toString();

                // Update token-specific profit metrics
                if (isWbtcPair) {
                    metrics.tokenMetrics.WBTC.totalProfit += profit;
                } else {
                    metrics.tokenMetrics.WAVAX.totalProfit += profit;
                }

                if (profit > 0) {
                    metrics.profitableTrades++;
                    logger.info('Atomic swap executed successfully', {
                        tradeId,
                        tokenPair: tokenPairLabel,
                        transactionHash: result.firstLegHash,
                        profit: profit.toFixed(6),
                        totalProfitSoFar: metrics.totalProfit.toFixed(6)
                    });
                } else {
                    metrics.unprofitableTrades++;
                    logger.warn('Atomic swap executed but with no profit', {
                        tradeId,
                        tokenPair: tokenPairLabel,
                        transactionHash: result.firstLegHash,
                        profit: profit.toFixed(6)
                    });
                }
            } else {
                metrics.failedTrades++;
                metrics.contractMetrics.failedAtomicSwaps++;
                logger.error('Atomic swap execution failed', {
                    tradeId,
                    tokenPair: tokenPairLabel,
                    error: result.error,
                    transactionHash: result.firstLegHash
                });
            }

            if (!result.success) {
                metrics.failedTrades++;
                metrics.contractMetrics.failedAtomicSwaps++;

                // Check time sync after stale quote errors
                if (result.errorType === 'STALE_QUOTE') {
                    logger.warn('Stale quote error detected, checking time synchronization');
                    await smartContractService.checkTimeSync();
                }

                logger.error('Atomic swap execution failed', {
                    tradeId,
                    tokenPair: tokenPairLabel,
                    error: result.error,
                    transactionHash: result.firstLegHash
                });
            }

            // Update contract-specific metrics
            if (event) {
                metrics.contractMetrics.averageGasUsed =
                    (BigInt(metrics.contractMetrics.totalGasUsed) / BigInt(metrics.totalTrades)).toString();
            }

            // Log detailed metrics
            const metricsData = tradeMetricsManager.getCurrentMetrics();
            await logTradeExecution(tradeId, opportunity, result, event, metricsData);

            recordMetric('execution_complete');
        }

        logPerformanceMetrics();

        if (!isShuttingDown) {
            await sleep(ARBITRAGE_SETTINGS.MONITORING_INTERVAL);
        }

    } catch (error) {
        metrics.failedTrades++;
        logger.error('Error in monitorAndExecute cycle', {
            error: getErrorMessage(error),
            cycleCount: metrics.cycleCount
        });
    } finally {
        // Always sleep between cycles, regardless of result
        if (!isShuttingDown) {
            recordMetric('cycle_end');
            logger.debug(`Sleeping for ${ARBITRAGE_SETTINGS.MONITORING_INTERVAL}ms before next cycle`);
            await sleep(ARBITRAGE_SETTINGS.MONITORING_INTERVAL);
        }
    }

    recordMetric('cycle_complete');
}

// Utility function to record a timing metric.
function recordMetric(name: string) {
    const now = performance.now();
    const timeSinceStart = (now - metrics.startTime) / 1000;
    const timeSinceLastCheckpoint = (now - metrics.lastCheckpoint) / 1000;

    metrics.checkpoints[name] = timeSinceStart;
    metrics.lastCheckpoint = now;

    logger.info(`Timing checkpoint: ${name}`, {
        timeSinceStart: `${timeSinceStart.toFixed(3)}s`,
        timeSinceLastCheckpoint: `${timeSinceLastCheckpoint.toFixed(3)}s`,
        cycleCount: metrics.cycleCount,
        successfulTrades: metrics.successfulTrades,
        failedTrades: metrics.failedTrades,
    });
}

/**
 * Enhanced logTradeExecution function with consistent flash loan fee calculation
 * Updated to include token pair info (WAVAX or WBTC)
 * @param tradeId Unique identifier for the trade
 * @param opportunity The arbitrage opportunity being executed
 * @param result Results of the trade execution
 * @param event On-chain event data if available
 * @param metricsData Collected metrics about the trade
 * @param isFlashLoan Whether this was a flash loan trade
 * @param flashLoanFeeOverride Optional override for flash loan fee
 * @param netProfitOverride Optional override for net profit
 */
export async function logTradeExecution(
    tradeId: string,
    opportunity: ArbitrageOpportunity,
    result: TradeResult,
    event: ArbitrageExecutedEvent | null,
    metricsData: DetailedTradeMetrics | null,
    isFlashLoan?: boolean,
    flashLoanFeeOverride?: number,
    netProfitOverride?: number
): Promise<void> {
    // Determine the token pair being traded
    const isWbtcPair = opportunity.targetTokenSymbol === 'WBTC';
    const targetTokenSymbol = isWbtcPair ? 'WBTC' : 'WAVAX';
    const tokenPairLabel = `USDC-${targetTokenSymbol}`;

    // ---------------------------------------------------
    // 0) Gather the "currentMetrics" for timings, if any
    // ---------------------------------------------------
    const currentMetrics = metricsData || {
        firstSwap: tradeMetricsManager.initializeSwapMetrics(),
        secondSwap: tradeMetricsManager.initializeSecondSwapMetrics(),
        totals: tradeMetricsManager.initializeTotalMetrics()
    };

    // Ensure we have a valid "startTime" & "endTime" for total time
    const startTimeMs = currentMetrics.totals.startTime ?? performance.now();
    let endTimeMs = currentMetrics.totals.endTime ?? performance.now();
    if (endTimeMs < startTimeMs) {
        tradeLogger.warn('Negative total time detected. Setting endTime = startTime', {
            startTimeMs,
            endTimeMs
        });
        endTimeMs = startTimeMs;
    }
    const totalTimeMs = endTimeMs - startTimeMs;
    const totalTimeSec = (totalTimeMs / 1000).toFixed(3);

    // ---------------------------------------------------
    // 1) Force-populate secondLeg router/pool if missing
    // ---------------------------------------------------
    const secondLegRouter = currentMetrics.secondSwap.routerAddress
        || opportunity.secondLeg.routerAddress
        || '';
    const secondLegPool = currentMetrics.secondSwap.poolAddress
        || opportunity.secondLeg.poolAddress
        || '';

    // Similarly for the firstLeg if you want
    const firstLegRouter = currentMetrics.firstSwap.routerAddress
        || opportunity.firstLeg.routerAddress
        || '';
    const firstLegPool = currentMetrics.firstSwap.poolAddress
        || opportunity.firstLeg.poolAddress
        || '';

    // ---------------------------------------------------
    // 2) Decide on "transactionHash" from multiple places
    // ---------------------------------------------------
    const transactionHash = result.firstLegHash
        || result.secondLegHash
        || result.receipt?.transactionHash
        || null;

    // ---------------------------------------------------
    // 3) Handle local negative-profit override
    // ---------------------------------------------------
    const isTestMode = ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE;
    const contractProfitString = result.profit || '0';
    let localProfitString = contractProfitString;

    // If testMode & contractProfit=0 & we have negative expectedProfit
    const localExpectedProfitNum = parseFloat(opportunity.expectedProfit ?? '0');
    if (isTestMode) {
        const contractProfitNum = parseFloat(contractProfitString);
        if (contractProfitNum === 0 && localExpectedProfitNum < 0) {
            // Overwrite for logging only:
            localProfitString = opportunity.expectedProfit!;
        }
    }

    // ---------------------------------------------------
    // 4) Determine if this was a flash loan trade and calculate fees
    // ---------------------------------------------------
    // Determine if this was a flash loan trade
    const useFlashLoan = isFlashLoan !== undefined
        ? isFlashLoan
        : (result.flashLoanFee !== undefined);

    // Get flash loan details with consistent fee calculation
    let flashLoanFee = 0;
    let netProfitNum = 0;
    let netProfitString = '0';

    if (useFlashLoan) {
        const inputAmount = parseFloat(opportunity.amountIn);

        // Use override if provided, otherwise use result.flashLoanFee or calculate using FLASH_LOAN_FEE_BPS
        flashLoanFee = flashLoanFeeOverride !== undefined
            ? flashLoanFeeOverride
            : result.flashLoanFee
                ? parseFloat(result.flashLoanFee)
                : (inputAmount * FLASH_LOAN_FEE_BPS) / 10000; // Consistent calculation using constant

        const actualProfitNum = parseFloat(localProfitString || '0');

        // Use override if provided, otherwise use result.netProfit or calculate
        netProfitNum = netProfitOverride !== undefined
            ? netProfitOverride
            : result.netProfit
                ? parseFloat(result.netProfit)
                : actualProfitNum - flashLoanFee;  // Consistent net profit calculation

        netProfitString = netProfitNum.toFixed(6);
    }

    // Calculate profit differences
    const inputAmountNum = parseFloat(opportunity.amountIn);
    const actualProfitNum = useFlashLoan ? netProfitNum : parseFloat(localProfitString || '0');
    const expectedProfitNum = parseFloat(opportunity.expectedProfit || '0');
    const difference = actualProfitNum - expectedProfitNum;
    const profitPercentage = (inputAmountNum > 0)
        ? (actualProfitNum / inputAmountNum) * 100
        : 0;

    // Get final balance
    const finalBalanceString = event
        ? formatUnits(event.finalBalance, TOKEN_CONFIGS.USDC.decimals)
        : (result.finalBalance || '0');

    // -----------------------------------------
    // 5) Build the final object for logging
    // -----------------------------------------
    tradeLogger.info('Atomic Trade Execution Complete', {
        tradeId,
        timestamp: new Date().toISOString(),
        tokenPair: tokenPairLabel,  // Add token pair info

        // Add flash loan info if applicable
        flashLoan: useFlashLoan ? {
            used: true,
            fee: flashLoanFee.toFixed(6),
            feeBps: FLASH_LOAN_FEE_BPS, // Add the BPS for reference
            grossProfit: localProfitString,
            netProfit: netProfitString
        } : null,

        // 5a) Execution info
        execution: {
            transactionHash,
            timing: {
                totalTime: `${totalTimeSec} seconds`,
                executionStart: startTimeMs,
                executionEnd: endTimeMs
            },
            amounts: {
                input: opportunity.amountIn,
                expectedOutput: opportunity.secondLeg.expectedOutput,
                finalBalance: finalBalanceString,
                intermediateExpected: opportunity.expectedWAVAX,
                intermediateActual: currentMetrics.secondSwap.actualInputAmount || '',
                expectedProfit: opportunity.expectedProfit,
                actualProfit: useFlashLoan ? netProfitString : localProfitString
            },
        },

        // 5b) Dex info - forcibly fill secondLeg if missing
        dexInfo: {
            firstLeg: {
                dex: opportunity.startDex,
                router: firstLegRouter,
                pool: firstLegPool,
                fee: currentMetrics.firstSwap.fee ?? (opportunity.firstLeg.fee || 0),
                priceImpact: currentMetrics.firstSwap.priceImpact || (opportunity.firstLeg.priceImpact || 0)
            },
            secondLeg: {
                dex: opportunity.endDex,
                router: secondLegRouter,
                pool: secondLegPool,
                fee: currentMetrics.secondSwap.fee ?? (opportunity.secondLeg.fee || 0),
                priceImpact: currentMetrics.secondSwap.priceImpact || (opportunity.secondLeg.priceImpact || 0)
            }
        },

        // 5c) Token mapping - updated to include correct token info for WBTC/WAVAX
        tokens: {
            firstLeg: {
                input: {
                    symbol: TypeGuards.isUniswapTrade(opportunity.firstLeg.trade)
                        ? opportunity.firstLeg.trade.inputAmount.currency.symbol ?? ''
                        : opportunity.firstLeg.trade.inputAmount.token.symbol,
                    address: TypeGuards.isUniswapTrade(opportunity.firstLeg.trade)
                        ? (opportunity.firstLeg.trade.inputAmount.currency as any).address ?? ''
                        : opportunity.firstLeg.trade.inputAmount.token.address
                },
                output: {
                    symbol: TypeGuards.isUniswapTrade(opportunity.firstLeg.trade)
                        ? opportunity.firstLeg.trade.outputAmount.currency.symbol ?? ''
                        : opportunity.firstLeg.trade.outputAmount.token.symbol,
                    address: TypeGuards.isUniswapTrade(opportunity.firstLeg.trade)
                        ? (opportunity.firstLeg.trade.outputAmount.currency as any).address ?? ''
                        : opportunity.firstLeg.trade.outputAmount.token.address
                }
            },
            secondLeg: {
                input: {
                    symbol: TypeGuards.isUniswapTrade(opportunity.secondLeg.trade)
                        ? opportunity.secondLeg.trade.inputAmount.currency.symbol ?? ''
                        : opportunity.secondLeg.trade.inputAmount.token.symbol,
                    address: TypeGuards.isUniswapTrade(opportunity.secondLeg.trade)
                        ? (opportunity.secondLeg.trade.inputAmount.currency as any).address ?? ''
                        : opportunity.secondLeg.trade.inputAmount.token.address
                },
                output: {
                    symbol: TypeGuards.isUniswapTrade(opportunity.secondLeg.trade)
                        ? opportunity.secondLeg.trade.outputAmount.currency.symbol ?? ''
                        : opportunity.secondLeg.trade.outputAmount.token.symbol,
                    address: TypeGuards.isUniswapTrade(opportunity.secondLeg.trade)
                        ? (opportunity.secondLeg.trade.outputAmount.currency as any).address ?? ''
                        : opportunity.secondLeg.trade.outputAmount.token.address
                }
            }
        },

        // 5d) Contract execution summary
        contractExecution: {
            sourceToken: TOKEN_CONFIGS.USDC.address,
            targetToken: isWbtcPair ? TOKEN_CONFIGS.WBTC.address : TOKEN_CONFIGS.WAVAX.address, // Use correct target token
            firstRouter: opportunity.startDex === 'uniswap' ? 'Uniswap V3' : 'Trader Joe',
            secondRouter: opportunity.endDex === 'uniswap' ? 'Uniswap V3' : 'Trader Joe',
            priceImpact: {
                first: opportunity.firstLeg.priceImpact || 0,
                second: opportunity.secondLeg.priceImpact || 0,
                total: (opportunity.firstLeg.priceImpact || 0) + (opportunity.secondLeg.priceImpact || 0)
            }
        },

        // 5e) Final metrics
        metrics: {
            profit: {
                expected: opportunity.expectedProfit,
                actual: useFlashLoan ? netProfitString : localProfitString,
                percentage: `${profitPercentage.toFixed(2)}%`,
                difference: difference.toFixed(6),
                flashLoanFee: useFlashLoan ? flashLoanFee.toFixed(6) : undefined
            },
            performance: {
                totalCycleTime: totalTimeMs,
                avgGasPrice: result.effectiveGasPrice || '0',
                gasEfficiency: result.gasUsed
                    ? (parseFloat(opportunity.gasCosts?.estimatedGasUsed || '0') / parseFloat(result.gasUsed)).toFixed(4)
                    : '0'
            }
        },

        status: result.success ? 'success' : 'failed',
        error: result.error || null
    });
}

async function main(): Promise<void> {
    try {
        console.log('Starting main execution...');
        logger.info('Starting arbitrage bot', {
            version: '1.2.0', // Updated version to reflect WBTC support
            mode: ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE ? 'TEST MODE' : 'PRODUCTION MODE',
            flashLoansEnabled: ARBITRAGE_SETTINGS.FLASH_LOANS_ENABLED,
            supportedTokenPairs: ['USDC-WAVAX', 'USDC-WBTC']  // Added WBTC support info
        });

        metrics.startTime = performance.now();
        recordMetric('start');

        // Initialize services
        if (!process.env.PRIVATE_KEY || !process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables');
        }

        // Parse private key with or without 0x prefix
        const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
            ? process.env.PRIVATE_KEY as `0x${string}`
            : `0x${process.env.PRIVATE_KEY}` as `0x${string}`;

        // Initialize services - with more logging to debug initialization
        console.log('Initializing services...');
        logger.info('Initializing services');

        // Initialize SmartContractService first since others depend on it
        console.log('Initializing SmartContractService...');
        smartContractService = new SmartContractService(
            privateKey,
            process.env.ARBITRAGE_CONTRACT_ADDRESS as `0x${string}`
        );
        console.log('SmartContractService initialized.');

        // Initialize PriceMonitorService with minimum profit threshold
        console.log('Initializing PriceMonitorService...');
        priceMonitor = new PriceMonitorService(
            ARBITRAGE_SETTINGS.MIN_PROFIT_THRESHOLD
        );
        console.log('PriceMonitorService initialized.');

        // Initialize ArbitrageService with private key
        console.log('Initializing ArbitrageService...');
        arbitrageService = new ArbitrageService(privateKey);
        console.log('ArbitrageService initialized.');

        // Initialize FlashLoanService if flash loans are enabled
        if (ARBITRAGE_SETTINGS.FLASH_LOANS_ENABLED) {
            try {
                console.log('Initializing FlashLoanService...');
                flashLoanService = new FlashLoanService(
                    smartContractService,
                    ADDRESSES.BALANCER_V2.POOL as `0x${string}`
                );
                console.log('FlashLoanService initialized.');

                logger.info('Flash loan service initialized', {
                    flashLoanProvider: ADDRESSES.BALANCER_V2.POOL,
                    flashLoanFeeBps: ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS,
                    supportedTokens: {
                        base: 'USDC',
                        intermediate: ['WAVAX', 'WBTC']  // Updated to include WBTC
                    }
                });
            } catch (error) {
                console.error('Failed to initialize FlashLoanService:', getErrorMessage(error));
                logger.error('Failed to initialize FlashLoanService', {
                    error: getErrorMessage(error)
                });
            }
        } else {
            logger.info('Flash loans disabled in configuration');
        }

        recordMetric('services_initialized');

        // Check time sync on startup
        await smartContractService.checkTimeSync();

        // Set up interval for time sync checks
        console.log('Setting up time sync interval...');
        const timeSyncInterval = setInterval(async () => {
            try {
                if (!smartContractService) {
                    throw new Error('SmartContractService failed to initialize');
                }
                await smartContractService.checkTimeSync();
            } catch (error) {
                logger.error('Error in time sync check interval', {
                    error: getErrorMessage(error)
                });
            }
        }, ARBITRAGE_SETTINGS.TIME_SYNC_CHECK_INTERVAL);

        // Validate wallet balances
        console.log('Validating balances...');
        await validateBalance(arbitrageService);

        // Set up interval for balance checks
        console.log('Setting up balance check interval...');
        const balanceCheckInterval = setInterval(async () => {
            try {
                if (!arbitrageService) {
                    throw new Error('ArbitrageService failed to initialize');
                }
                await validateBalance(arbitrageService);
            } catch (error) {
                logger.error('Error in balance check interval', {
                    error: getErrorMessage(error)
                });
            }
        }, ARBITRAGE_SETTINGS.BALANCE_CHECK_INTERVAL);

        // Handle shutdown signals
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, initiating graceful shutdown');
            clearInterval(timeSyncInterval);
            clearInterval(balanceCheckInterval);
            isShuttingDown = true;
            await gracefulShutdown();
        });

        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, initiating graceful shutdown');
            clearInterval(timeSyncInterval);
            clearInterval(balanceCheckInterval);
            isShuttingDown = true;
            await gracefulShutdown();
        });

        // Log configuration
        logger.info('Configuration loaded', {
            minProfitThreshold: ARBITRAGE_SETTINGS.MIN_PROFIT_THRESHOLD,
            testMode: ARBITRAGE_SETTINGS.ON_CHAIN_TEST_MODE,
            monitoringInterval: ARBITRAGE_SETTINGS.MONITORING_INTERVAL,
            flashLoansEnabled: ARBITRAGE_SETTINGS.FLASH_LOANS_ENABLED,
            flashLoanThreshold: ARBITRAGE_SETTINGS.FLASH_LOAN_THRESHOLD,
            minFlashLoanProfitPercent: ARBITRAGE_SETTINGS.MIN_FLASH_LOAN_PROFIT_PERCENT,
            supportedTokenPairs: ['USDC-WAVAX', 'USDC-WBTC']  // Added WBTC support info
        });

        recordMetric('setup_complete');

        // Start the main monitoring loop - USING THE WORKING PATTERN
        console.log('Starting monitoring loop...');
        logger.info('Starting monitoring loop');
        isShuttingDown = false;

        // Main loop from the working version
        while (!isShuttingDown) {
            if (!flashLoanService && ARBITRAGE_SETTINGS.FLASH_LOANS_ENABLED) {
                // If flash loans are enabled but service isn't initialized, try initializing again
                try {
                    flashLoanService = new FlashLoanService(
                        smartContractService,
                        FLASH_LOAN_POOL as `0x${string}`
                    );
                    logger.info('Flash loan service initialized');
                } catch (error) {
                    logger.error('Failed to initialize flash loan service', {
                        error: getErrorMessage(error)
                    });
                }
            }
            if (!arbitrageService || !smartContractService || !priceMonitor) {
                throw new Error('Required services failed to initialize');
            }

            // For the flashLoanService, we need to handle it differently since it might legitimately be null
            // if flash loans are disabled
            const flashLoanServiceToUse = flashLoanService || {
                // Create a minimal stub implementation that does nothing
                executeFlashLoanArbitrage: async () => ({
                    success: false,
                    error: 'Flash loan service not available',
                    errorType: 'SERVICE_UNAVAILABLE'
                }),
                shutdown: async () => {}
            }
            await monitorAndExecute(
                arbitrageService,
                smartContractService,
                priceMonitor,
                flashLoanServiceToUse
            );

            // Short sleep to prevent tight loop if monitorAndExecute returns immediately
            await sleep(100);
        }
    } catch (error) {
        logger.error('Fatal error in main function', {
            error: getErrorMessage(error)
        });

        // Try to flush logs before exiting
        await logger.flush();
        process.exit(1);
    }
}
// Add graceful shutdown function
async function gracefulShutdown(): Promise<void> {
    logger.info('Initiating graceful shutdown');

    try {
        const shutdownPromises: Promise<void>[] = [];

        if (priceMonitor) {
            shutdownPromises.push(priceMonitor.shutdown());
        }

        if (arbitrageService) {
            shutdownPromises.push(arbitrageService.shutdown());
        }

        if (flashLoanService) {
            shutdownPromises.push(flashLoanService.shutdown());
        }

        // Wait for all services to shut down gracefully
        await Promise.allSettled(shutdownPromises);

        // Log final metrics
        logPerformanceMetrics();

        // Flush logs
        await logger.flush();

        // Exit with success code
        process.exit(0);
    } catch (error) {
        logger.error('Error during graceful shutdown', {
            error: getErrorMessage(error)
        });

        // Try to flush logs
        await logger.flush();

        // Exit with error code
        process.exit(1);
    }
}

// Run the main function
main().catch(async (error) => {
    console.error('Uncaught error in main:', error);
    try {
        // Try to log the error
        logger.error('Uncaught error in main', {
            error: getErrorMessage(error)
        });
        await logger.flush();
    } catch {
        // If logging fails, just exit
    }
    process.exit(1);
});