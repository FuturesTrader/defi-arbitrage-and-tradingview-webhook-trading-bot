// src/tradeMetrics.ts
import dotenv from 'dotenv';
dotenv.config();
import logger from '@/logger';
import { calculateDuration } from './utils';

interface GasMetrics {
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    estimatedGas: bigint;
    blockNumber: number;
    timestamp: number;
    tradeId: string;
}

interface TradeMetrics {
    inputAmount: string;
    outputAmount: string;
    executionPrice: number;
    slippage: number;
    priceImpact: number;
    timestamp: number;
}

export interface SwapMetrics {
    dex: string;
    swapStartTime: number;
    swapEndTime: number;
    swapCycleTime: number;
    chainId: number;
    chainName: string;
    inputTokenSymbol: string;
    inputTokenAddress: string;
    outputTokenSymbol: string;
    outputTokenAddress: string;
    poolAddress: string;
    routerAddress: string;
    fee: number;
    inputAmount: string;
    outputAmount: string;
    transactionHash: string;
    hashVerificationCycles: number;
    methodName: string;
    tradeId: string;
    recipient: string;
    gasEstimate: string;
    gasActual: string;
    priceImpact?: number;
    executionPrice?: string;
    swapDifference?: string;
}

export interface SecondSwapMetrics extends SwapMetrics {
    estimatedInputAmount: string;
    actualInputAmount: string;
    actualOutputAmount: string;
    // Note: inputAmount is already inherited from SwapMetrics.
}

export interface TotalMetrics {
    totalCycleTime: number;
    totalGasCost: string;
    profitLoss: string;
    profitLossPercentage: string;
    startTime: number;
    endTime: number;
}

export interface DetailedTradeMetrics {
    firstSwap: SwapMetrics;
    secondSwap: SecondSwapMetrics;
    totals: TotalMetrics;
}

export class metricsManager {
    private static instance: metricsManager;
    private readonly gasHistory: GasMetrics[] = [];
    private readonly tradeHistory: TradeMetrics[] = [];
    private readonly MAX_HISTORY = 100;
    private constructor() {}
    static getInstance(): metricsManager {
        if (!metricsManager.instance) {
            metricsManager.instance = new metricsManager();
        }
        return metricsManager.instance;
    }

    public addGasMetrics(metrics: GasMetrics): void {
        this.gasHistory.push(metrics);
        if (this.gasHistory.length > this.MAX_HISTORY) {
            this.gasHistory.shift();
        }
        logger.info('Gas metrics recorded', { metrics });
    }

    public addTradeMetrics(metrics: TradeMetrics): void {
        this.tradeHistory.push(metrics);
        if (this.tradeHistory.length > this.MAX_HISTORY) {
            this.tradeHistory.shift();
        }
        logger.info('Trade metrics recorded', { metrics });
    }

    public calculateOptimalGasLimit(): bigint {
        if (this.gasHistory.length === 0) {
            return BigInt(300000); // Default gas limit
        }

        const totalGasUsed = this.gasHistory.reduce(
            (sum, metrics) => sum + metrics.gasUsed,
            BigInt(0)
        );

        const avgGasUsed = totalGasUsed / BigInt(this.gasHistory.length);

        // Add 20% buffer to average gas used
        return (avgGasUsed * BigInt(120)) / BigInt(100);
    }

    public calculateDynamicSlippage(): number {
        if (this.tradeHistory.length < 2) {
            return 0.005; // Default 0.5% slippage
        }

        // Calculate price volatility from recent trades
        const recentTrades = this.tradeHistory.slice(-10);
        const prices = recentTrades.map(t => t.executionPrice);
        const volatility = this.calculateVolatility(prices);

        // Adjust slippage based on volatility
        if (volatility < 0.001) return 0.003; // 0.3% for low volatility
        if (volatility < 0.005) return 0.005; // 0.5% for medium volatility
        if (volatility < 0.01) return 0.01;   // 1% for high volatility
        return 0.02; // 2% for extreme volatility
    }

    public calculateVolatility(prices: number[]): number {
        if (prices.length < 2) return 0;
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i-1]) / prices[i-1]);
        }
        const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / returns.length;
        return Math.sqrt(variance);
    }

    // Helper method to get gas metrics for testing
    public getGasHistory(): GasMetrics[] {
        return [...this.gasHistory];
    }
    // Get last gas metric
    public getLastGasMetric(): GasMetrics | null {
        return this.gasHistory.length > 0 ? this.gasHistory[this.gasHistory.length - 1] : null;
    }
    // Get average gas usage
    public getAverageGasUsage(): bigint {
        if (this.gasHistory.length === 0) {
            return BigInt(0);
        }
        const totalGas = this.gasHistory.reduce((sum, metric) => sum + metric.gasUsed, BigInt(0));
        return totalGas / BigInt(this.gasHistory.length);
    }
    // Get gas metrics array
    public getGasMetrics(): GasMetrics[] {
        return [...this.gasHistory];
    }
    // Add new method to get gas metrics for specific trade
    public getTradeGasMetrics(tradeId: string): GasMetrics[] {
        return this.gasHistory.filter(metric => metric.tradeId === tradeId);
    }
    // Add method to analyze gas usage patterns
    public getGasUsageStats(): {
        min: bigint;
        max: bigint;
        avg: bigint;
        median: bigint;
    } {
        if (this.gasHistory.length === 0) {
            return {
                min: BigInt(0),
                max: BigInt(0),
                avg: BigInt(0),
                median: BigInt(0)
            };
        }

        const gasUsages = this.gasHistory.map(metric => metric.gasUsed);
        gasUsages.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        const min = gasUsages[0];
        const max = gasUsages[gasUsages.length - 1];
        const avg = gasUsages.reduce((sum, gas) => sum + gas, BigInt(0)) / BigInt(gasUsages.length);
        const median = gasUsages[Math.floor(gasUsages.length / 2)];

        return { min, max, avg, median };
    }

    // Helper method to get trade metrics for testing
    public getTradeHistory(): TradeMetrics[] {
        return [...this.tradeHistory];
    }

    // Helper method to clear history (useful for testing)
    clearHistory(): void {
        this.gasHistory.length = 0;
        this.tradeHistory.length = 0;
    }
}

export class TradeMetricsManager {
    private static instance: TradeMetricsManager;
    private currentMetrics: DetailedTradeMetrics | null = null;

    private constructor() {}

    public static getInstance(): TradeMetricsManager {
        if (!TradeMetricsManager.instance) {
            TradeMetricsManager.instance = new TradeMetricsManager();
        }
        return TradeMetricsManager.instance;
    }

    /**
     * Start a new trade metrics tracking session
     */
    public startNewTradeMetrics(): void {
        // Get current performance time for consistent tracking
        const now = performance.now();

        this.currentMetrics = {
            firstSwap: this.initializeSwapMetrics(now),
            secondSwap: this.initializeSecondSwapMetrics(now),
            totals: this.initializeTotalMetrics(now)
        };

        logger.debug('New trade metrics initialized', {
            startTime: now,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Initialize a new SwapMetrics object with the given timestamp
     * @param timestamp The starting timestamp (performance.now())
     */
    public initializeSwapMetrics(timestamp?: number): SwapMetrics {
        const now = timestamp || performance.now();
        return {
            dex: '',
            swapStartTime: now,
            swapEndTime: now,
            swapCycleTime: 0,
            chainId: 0,
            chainName: '',
            inputTokenSymbol: '',
            inputTokenAddress: '',
            outputTokenSymbol: '',
            outputTokenAddress: '',
            poolAddress: '',
            routerAddress: '',
            fee: 0,
            inputAmount: '',
            outputAmount: '',
            transactionHash: '',
            hashVerificationCycles: 0,
            methodName: '',
            tradeId: '',
            recipient: '',
            gasEstimate: '',
            gasActual: '',
            priceImpact: 0,
            executionPrice: '0',
            swapDifference: '0'
        };
    }

    /**
     * Initialize a new SecondSwapMetrics object with the given timestamp
     * @param timestamp The starting timestamp (performance.now())
     */
    public initializeSecondSwapMetrics(timestamp?: number): SecondSwapMetrics {
        return {
            ...this.initializeSwapMetrics(timestamp),
            estimatedInputAmount: '',
            actualInputAmount: '',
            actualOutputAmount: ''
        };
    }

    /**
     * Initialize a new TotalMetrics object with the given timestamp
     * @param timestamp The starting timestamp (performance.now())
     */
    public initializeTotalMetrics(timestamp?: number): TotalMetrics {
        const now = timestamp || performance.now();
        return {
            totalCycleTime: 0,
            totalGasCost: '',
            profitLoss: '',
            profitLossPercentage: '',
            startTime: now,
            endTime: now
        };
    }

    /**
     * Get the current metrics being tracked
     */
    public getCurrentMetrics(): DetailedTradeMetrics | null {
        return this.currentMetrics;
    }

    /**
     * Update first swap metrics with partial data
     * @param metrics Partial metrics to update
     */
    public updateFirstSwapMetrics(metrics: Partial<SwapMetrics>): void {
        if (!this.currentMetrics) {
            // Initialize if not already done
            this.startNewTradeMetrics();
        }

        if (this.currentMetrics) {
            // Record swap start time if provided
            if (metrics.swapStartTime) {
                this.currentMetrics.firstSwap.swapStartTime = metrics.swapStartTime;
                // Update total start time if this is earlier
                if (metrics.swapStartTime < this.currentMetrics.totals.startTime) {
                    this.currentMetrics.totals.startTime = metrics.swapStartTime;
                }
            }

            // Record swap end time if provided
            if (metrics.swapEndTime) {
                this.currentMetrics.firstSwap.swapEndTime = metrics.swapEndTime;

                // If second swap hasn't started yet, set its start time to first swap end time
                if (!this.currentMetrics.secondSwap.swapStartTime ||
                    this.currentMetrics.secondSwap.swapStartTime === this.currentMetrics.secondSwap.swapEndTime) {
                    this.currentMetrics.secondSwap.swapStartTime = metrics.swapEndTime;
                }
            }

            // Check if swapDifference is present and log it for debugging
            if (metrics.swapDifference) {
                logger.debug('First swap difference recorded', {
                    tradeId: metrics.tradeId,
                    dex: metrics.dex,
                    swapDifference: metrics.swapDifference
                });
            }

            // Merge the provided metrics into the firstSwap metrics
            this.currentMetrics.firstSwap = {
                ...this.currentMetrics.firstSwap,
                ...metrics
            };

            // Update cycle time if both start and end times are set
            if (this.currentMetrics.firstSwap.swapStartTime && this.currentMetrics.firstSwap.swapEndTime) {
                const duration = calculateDuration(
                    this.currentMetrics.firstSwap.swapStartTime,
                    this.currentMetrics.firstSwap.swapEndTime
                );
                this.currentMetrics.firstSwap.swapCycleTime = duration;
            }
        }
    }

    /**
     * Update second swap metrics with partial data
     * @param metrics Partial metrics to update
     */
    public updateSecondSwapMetrics(metrics: Partial<SecondSwapMetrics>): void {
        if (!this.currentMetrics) {
            // Initialize if not already done
            this.startNewTradeMetrics();
        }

        if (this.currentMetrics) {
            // Record swap start time if provided
            if (metrics.swapStartTime &&
                (!this.currentMetrics.secondSwap.swapStartTime ||
                    this.currentMetrics.secondSwap.swapStartTime === this.currentMetrics.secondSwap.swapEndTime)) {
                this.currentMetrics.secondSwap.swapStartTime = metrics.swapStartTime;
            }

            // Record swap end time and update totals if provided
            if (metrics.swapEndTime) {
                this.currentMetrics.secondSwap.swapEndTime = metrics.swapEndTime;

                // Update totals end time if this is later
                if (metrics.swapEndTime > this.currentMetrics.totals.endTime) {
                    this.currentMetrics.totals.endTime = metrics.swapEndTime;
                }
            }

            // Check if actualInputAmount is available
            if (metrics.outputAmount && this.currentMetrics.firstSwap.outputAmount) {
                // First swap output should be second swap input
                this.currentMetrics.secondSwap.actualInputAmount = this.currentMetrics.firstSwap.outputAmount;
            }

            // Check if swapDifference is present and log it for debugging
            if (metrics.swapDifference) {
                logger.debug('Second swap difference recorded', {
                    tradeId: metrics.tradeId,
                    dex: metrics.dex,
                    swapDifference: metrics.swapDifference
                });
            }

            // Merge the provided metrics into the secondSwap metrics
            this.currentMetrics.secondSwap = {
                ...this.currentMetrics.secondSwap,
                ...metrics
            };

            // Update cycle time if both start and end times are set
            if (this.currentMetrics.secondSwap.swapStartTime && this.currentMetrics.secondSwap.swapEndTime) {
                const duration = calculateDuration(
                    this.currentMetrics.secondSwap.swapStartTime,
                    this.currentMetrics.secondSwap.swapEndTime
                );
                this.currentMetrics.secondSwap.swapCycleTime = duration;
            }

            // Update totals whenever second swap metrics are updated
            this.calculateAndUpdateTotals();
        }
    }

    /**
     * Update total metrics with partial data
     * @param metrics Partial metrics to update
     */
    public updateTotalMetrics(metrics: Partial<TotalMetrics>): void {
        if (!this.currentMetrics) {
            this.startNewTradeMetrics();
        }

        if (this.currentMetrics) {
            // Ensure totals has valid timing data
            if (metrics.startTime && (!this.currentMetrics.totals.startTime ||
                metrics.startTime < this.currentMetrics.totals.startTime)) {
                this.currentMetrics.totals.startTime = metrics.startTime;
            }

            if (metrics.endTime && metrics.endTime > this.currentMetrics.totals.endTime) {
                this.currentMetrics.totals.endTime = metrics.endTime;
            }

            // Merge the provided metrics
            this.currentMetrics.totals = {
                ...this.currentMetrics.totals,
                ...metrics
            };

            // Recalculate cycle time
            this.currentMetrics.totals.totalCycleTime = calculateDuration(
                this.currentMetrics.totals.startTime,
                this.currentMetrics.totals.endTime
            );
        }
    }

    /**
     * Calculate and update totals based on the current swap metrics
     */
    public calculateAndUpdateTotals(): void {
        if (!this.currentMetrics) {
            return;
        }

        const { firstSwap, secondSwap, totals } = this.currentMetrics;
        const now = performance.now();

        // Ensure all time fields have values
        if (!firstSwap.swapStartTime) firstSwap.swapStartTime = now;
        if (!firstSwap.swapEndTime) firstSwap.swapEndTime = now;
        if (!secondSwap.swapStartTime) secondSwap.swapStartTime = firstSwap.swapEndTime;
        if (!secondSwap.swapEndTime) secondSwap.swapEndTime = now;

        // Calculate the individual swap cycle times - with safety checks
        firstSwap.swapCycleTime = calculateDuration(
            firstSwap.swapStartTime,
            firstSwap.swapEndTime
        );

        secondSwap.swapCycleTime = calculateDuration(
            secondSwap.swapStartTime,
            secondSwap.swapEndTime
        );

        // Set overall trade start and end times (min start, max end)
        totals.startTime = Math.min(
            firstSwap.swapStartTime || now,
            secondSwap.swapStartTime || now,
            totals.startTime || now
        );

        totals.endTime = Math.max(
            firstSwap.swapEndTime || now,
            secondSwap.swapEndTime || now,
            totals.endTime || now
        );

        // Calculate total cycle time
        totals.totalCycleTime = calculateDuration(
            totals.startTime,
            totals.endTime
        );

        // Calculate profit/loss if we have input and final output amounts
        if (firstSwap.inputAmount && secondSwap.outputAmount) {
            this.calculateProfitLoss();
        }

        // Calculate total gas cost if we have gas usage data
        if (firstSwap.gasActual || secondSwap.gasActual) {
            this.calculateTotalGasCost();
        }

        // Log metrics update with timing details
        logger.debug('Updated trade metrics totals', {
            firstSwapStartTime: firstSwap.swapStartTime,
            firstSwapEndTime: firstSwap.swapEndTime,
            firstSwapCycleTime: firstSwap.swapCycleTime,
            secondSwapStartTime: secondSwap.swapStartTime,
            secondSwapEndTime: secondSwap.swapEndTime,
            secondSwapCycleTime: secondSwap.swapCycleTime,
            totalStartTime: totals.startTime,
            totalEndTime: totals.endTime,
            totalCycleTime: totals.totalCycleTime
        });
    }

    /**
     * Calculate profit/loss metrics based on current swap data
     */
    private calculateProfitLoss(): void {
        if (!this.currentMetrics) return;

        const { firstSwap, secondSwap, totals } = this.currentMetrics;

        try {
            // Get input and output amounts
            const inputAmount = parseFloat(firstSwap.inputAmount || '0');
            const outputAmount = parseFloat(secondSwap.outputAmount || '0');

            if (inputAmount <= 0) {
                logger.warn('Invalid input amount for profit calculation', {
                    inputAmount: firstSwap.inputAmount
                });
                return;
            }

            // Calculate profit and percentage
            const profit = outputAmount - inputAmount;
            const profitPercentage = (profit / inputAmount) * 100;

            // Update totals
            totals.profitLoss = profit.toFixed(6);
            totals.profitLossPercentage = profitPercentage.toFixed(4) + '%';

            logger.debug('Profit/loss calculated', {
                inputAmount: firstSwap.inputAmount,
                outputAmount: secondSwap.outputAmount,
                profit: totals.profitLoss,
                profitPercentage: totals.profitLossPercentage
            });
        } catch (error) {
            logger.error('Error calculating profit/loss', {
                error: error instanceof Error ? error.message : String(error),
                inputAmount: firstSwap.inputAmount,
                outputAmount: secondSwap.outputAmount
            });
        }
    }

    /**
     * Calculate total gas cost based on current gas data
     */
    private calculateTotalGasCost(): void {
        if (!this.currentMetrics) return;

        const { firstSwap, secondSwap, totals } = this.currentMetrics;

        try {
            // Parse gas values with fallbacks
            const firstGas = firstSwap.gasActual ? parseFloat(firstSwap.gasActual) : 0;
            const secondGas = secondSwap.gasActual ? parseFloat(secondSwap.gasActual) : 0;

            // Sum total gas
            const totalGas = firstGas + secondGas;
            totals.totalGasCost = totalGas.toString();

            logger.debug('Total gas cost calculated', {
                firstGas: firstSwap.gasActual,
                secondGas: secondSwap.gasActual,
                totalGas: totals.totalGasCost
            });
        } catch (error) {
            logger.error('Error calculating total gas cost', {
                error: error instanceof Error ? error.message : String(error),
                firstGas: firstSwap.gasActual,
                secondGas: secondSwap.gasActual
            });
        }
    }
}

export const tradeMetricsManager = TradeMetricsManager.getInstance();
export type { GasMetrics, TradeMetrics };