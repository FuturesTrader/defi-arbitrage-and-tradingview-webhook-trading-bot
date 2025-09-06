// src/utils.ts
import {
    Address,
    PublicClient,
    WalletClient,
    Account,
    formatUnits,
    Hash
} from 'viem';
import {
    ARBITRAGE_SETTINGS,
    GAS_OPTIMIZATION,
    getNetworkConfig,
    type NetworkKey
} from './constants';
import { getNetworkNonceManager,NonceManager} from "./nonceManager.ts";
import { wavaxPriceQuoter } from './wavaxPriceQuoter';
import { wethPriceQuoter } from './wethPriceQuoter.ts';
import dotenv from 'dotenv';
dotenv.config();
import logger from './logger';
import type { TransactionConfig, TradeTimings, GasParameters, ArbitrageConfig, DexType } from './tradeTypes';

const POLLING_INTERVAL = ARBITRAGE_SETTINGS.POLLING_INTERVAL;
const CONFIRMATION_TIMEOUT = ARBITRAGE_SETTINGS.CONFIRMATION_TIMEOUT;
const DEFAULT_GAS_MULTIPLIER = 1.1;  // 10% buffer
const MAX_GAS_IN_GWEI = GAS_OPTIMIZATION.MAX_GAS_IN_GWEI;      // Cap at 50% increase
const NATIVE_PRICE_IN_USDC = GAS_OPTIMIZATION.NATIVE_PRICE_IN_USDC; // Use constant from settings
const BASE_GAS_ESTIMATE = GAS_OPTIMIZATION.SWAP_BASE;   // Base gas units for swap
const GAS_BUFFER = 1.2;  // 20% safety buffer
// Re-export necessary types
export type { PublicClient, WalletClient, Account, Address };

/**
 * getErrorMessage
 * Decodes error data using the provided Error object.
 */
/**
 * Enhanced error message extraction with detailed context
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    // Handle viem contract errors specifically
    if (typeof error === 'object' && error !== null) {
        const errorObj = error as any;

        // Viem contract call errors
        if (errorObj.name === 'ContractFunctionExecutionError' || errorObj.name === 'TransactionExecutionError') {
            return errorObj.shortMessage || errorObj.message || errorObj.details || 'Contract execution failed';
        }

        // Viem transaction errors
        if (errorObj.name === 'TransactionReceiptNotFoundError') {
            return 'Transaction receipt not found - transaction may have failed or not been mined';
        }

        // Network/RPC errors
        if (errorObj.name === 'RpcRequestError' || errorObj.name === 'HttpRequestError') {
            return errorObj.shortMessage || errorObj.message || 'Network request failed';
        }

        // Gas estimation errors
        if (errorObj.name === 'EstimateGasExecutionError') {
            return `Gas estimation failed: ${errorObj.shortMessage || errorObj.message || 'Unknown gas error'}`;
        }

        // Nonce errors
        if (errorObj.message && errorObj.message.includes('nonce')) {
            return `Nonce error: ${errorObj.message}`;
        }

        // Extract message from various error formats
        if (errorObj.message) return errorObj.message;
        if (errorObj.reason) return errorObj.reason;
        if (errorObj.error && errorObj.error.message) return errorObj.error.message;
        if (errorObj.shortMessage) return errorObj.shortMessage;
        if (errorObj.details) return errorObj.details;
    }

    return String(error);
}
/**
 * Safely calculates duration between two time points, handling edge cases
 * @param startTime The starting timestamp
 * @param endTime The ending timestamp
 * @returns Duration in milliseconds (0 if inputs are invalid)
 */
export function calculateDuration(startTime: number, endTime: number): number {
    if (startTime === undefined || startTime === null || isNaN(startTime)) return 0;
    if (endTime === undefined || endTime === null || isNaN(endTime)) return 0;
    if (endTime < startTime) return 0;
    return endTime - startTime;
}

/**
 * Gets current wall clock timestamp in seconds
 */
export function getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * sleep
 * Returns a Promise that resolves after the specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * safeSerialize
 * Enhanced safe serialization of objects with special type handling (BigInt, Errors,
 * functions, symbols, and circular references).
 */
export function safeSerialize(obj: any, indent: number = 2): string {
    const seen = new WeakSet();

    return JSON.stringify(
        obj,
        (key: string, value: any) => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            if (value instanceof Error) {
                const error: Record<string, any> = {
                    name: value.name,
                    message: value.message,
                    stack: value.stack
                };
                Object.getOwnPropertyNames(value).forEach((prop) => {
                    if (!error[prop]) {
                        error[prop] = (value as any)[prop];
                    }
                });
                return error;
            }
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            switch (typeof value) {
                case 'undefined':
                    return 'undefined';
                case 'function':
                    return `[Function: ${value.name || 'anonymous'}]`;
                case 'symbol':
                    return value.toString();
                default:
                    return value;
            }
        },
        indent
    );
}

export class GasTransactionUtility {
    private static instance: GasTransactionUtility | null = null;
    private readonly publicClient: PublicClient;
    private gasMultiplier: number = DEFAULT_GAS_MULTIPLIER;
    private lastBaseFee: bigint = 0n;
    private consecutiveFailures: number = 0;
    private lastUpdateTime: number = 0;
    private readonly updateIntervalMs: number = 30000; // 30 seconds cache

    /**
     * Get singleton instance
     */
    public static getInstance(publicClient: PublicClient): GasTransactionUtility {
        if (!GasTransactionUtility.instance) {
            GasTransactionUtility.instance = new GasTransactionUtility(publicClient);
        }
        return GasTransactionUtility.instance;
    }

    /**
     * Constructor - private to enforce singleton pattern
     */
    private constructor(publicClient: PublicClient) {
        this.publicClient = publicClient;
        this.updateChainState(); // Initial update

        logger.info('GasTransactionUtility initialized', {
            defaultGasMultiplier: this.gasMultiplier,
            baseGasEstimate: BASE_GAS_ESTIMATE.toString(),
            wavaxPriceInUSDC: NATIVE_PRICE_IN_USDC
        });
    }

    /**
     * Update blockchain state - gets current base fee
     */
    private async updateChainState(): Promise<void> {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateIntervalMs) {
            return; // Skip if we updated recently
        }

        try {
            this.lastUpdateTime = now;
            const block = await this.publicClient.getBlock({ blockTag: 'latest' });

            // Get base fee from block, or from gas price if not available
            if (block.baseFeePerGas) {
                this.lastBaseFee = block.baseFeePerGas;
            } else {
                this.lastBaseFee = await this.publicClient.getGasPrice();
            }

            logger.debug('Updated chain state', {
                blockNumber: block.number.toString(),
                baseFee: formatUnits(this.lastBaseFee, 9) + ' Gwei'
            });
        } catch (error) {
            logger.warn('Failed to update chain state, using previous values', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Gets the raw gas price with minimal adjustments
     */
    public async getGasPrice(): Promise<bigint> {
        await this.updateChainState();

        // Get base gas price
        let baseGasPrice: bigint;
        try {
            baseGasPrice = await this.publicClient.getGasPrice();
        } catch (error) {
            // Fallback to lastBaseFee if getGasPrice fails
            baseGasPrice = this.lastBaseFee;
            logger.warn('Failed to get gas price, using cached value', {
                cachedBaseFee: formatUnits(baseGasPrice, 9)
            });
        }

        // Calculate adjusted price with multiplier (capped)
        const multiplierBps = BigInt(Math.floor(this.gasMultiplier * 100));
        const adjustedGasPrice = (baseGasPrice * multiplierBps) / 100n;

        // Add priority fee (fixed 2 Gwei)
        const priorityFee = 2_000_000_000n; // 2 Gwei
        const finalGasPrice = adjustedGasPrice + priorityFee;

        logger.debug('Gas price calculation', {
            baseGasPrice: formatUnits(baseGasPrice, 9),
            multiplier: this.gasMultiplier.toFixed(2),
            priorityFee: formatUnits(priorityFee, 9),
            finalGasPrice: formatUnits(finalGasPrice, 9)
        });

        return finalGasPrice;
    }

    /**
     * Simplified gas parameters for transaction submission
     */
    public async getGasParameters(): Promise<{
        gasPrice: bigint;
        gasLimit: bigint;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
    }> {
        await this.updateChainState();

        // Always use a fixed base gas estimate for consistency
        const gasLimit = BASE_GAS_ESTIMATE;

        try {
            // Check if we can use EIP-1559 parameters
            const block = await this.publicClient.getBlock({ blockTag: 'latest' });

            if (block.baseFeePerGas) {
                // EIP-1559 compatible chain
                const baseFee = block.baseFeePerGas;
                const priorityFee = 2_000_000_000n; // Fixed 2 Gwei priority fee

                // Apply multiplier to base fee (with cap)
                const multiplierBps = BigInt(Math.floor(this.gasMultiplier * 100));
                const baseFeeWithMultiplier = (baseFee * multiplierBps) / 100n;

                // Max fee = base fee (with multiplier) + priority fee
                const maxFeePerGas = baseFeeWithMultiplier + priorityFee;

                logger.debug('Using EIP-1559 gas parameters', {
                    baseFee: formatUnits(baseFee, 9),
                    maxFeePerGas: formatUnits(maxFeePerGas, 9),
                    maxPriorityFeePerGas: formatUnits(priorityFee, 9),
                    gasLimit: gasLimit.toString()
                });

                return {
                    gasPrice: 0n, // Not used with EIP-1559
                    gasLimit,
                    maxFeePerGas,
                    maxPriorityFeePerGas: priorityFee
                };
            }

            // Fallback to legacy gas price
            const gasPrice = await this.getGasPrice();

            logger.debug('Using legacy gas parameters', {
                gasPrice: formatUnits(gasPrice, 9),
                gasLimit: gasLimit.toString()
            });

            return { gasPrice, gasLimit };

        } catch (error) {
            // Fallback values if there's an error
            const gasPrice = 2_000_000_000n; // 5 Gwei default

            logger.warn('Error getting gas parameters, using fallback values', {
                error: error instanceof Error ? error.message : String(error),
                fallbackGasPrice: formatUnits(gasPrice, 9),
                fallbackGasLimit: gasLimit.toString()
            });

            return { gasPrice, gasLimit };
        }
    }

    /**
     * Simple function to estimate gas cost for a transaction
     * Uses fixed values from constants
     */
    public async getFixedGasCostEstimate(): Promise<number> {
        try {
            // Try to get price from the quoter
            const wavaxPrice = await wavaxPriceQuoter.getPrice();

            // Use fixed values for gas parameters
            const gasUnits = Number(BASE_GAS_ESTIMATE);
            const gasPriceGwei = GAS_OPTIMIZATION.MAX_GAS_IN_GWEI;
            const gasCostInAVAX = (gasUnits * gasPriceGwei) / 1e9;
            const gasCostInUSDC = gasCostInAVAX * wavaxPrice;

            // Add buffer for safety
            return gasCostInUSDC * GAS_BUFFER;
        } catch (error) {
            // Use the constant as fallback
            const gasUnits = Number(BASE_GAS_ESTIMATE);
            const gasPriceGwei = GAS_OPTIMIZATION.MAX_GAS_IN_GWEI;
            const gasCostInAVAX = (gasUnits * gasPriceGwei) / 1e9;
            const gasCostInUSDC = gasCostInAVAX * GAS_OPTIMIZATION.NATIVE_PRICE_IN_USDC;

            return gasCostInUSDC * GAS_BUFFER;
        }
    }
}

export interface GasFailureRecord {
    timestamp: number;
    errorType: string;
    gasPrice: bigint;
    baseFee?: bigint;
    blockNumber?: bigint;
    transactionHash?: string;
}

export interface GasSuccessRecord {
    timestamp: number;
    gasPrice: bigint;
    effectiveGasPrice: bigint;
    gasUsed: bigint;
    transactionHash: string;
}

/**
 * DynamicGasAdjuster
 * -------------------
 * Manages gas price adjustments based on recent transaction history and
 * network conditions to optimize transaction success rates.
 */
export class DynamicGasAdjuster {
    private readonly publicClient: PublicClient;
    private readonly maxRecords: number = 20;
    private feeMultiplierAdjustment: number = 1.0;
    private baseFeeBuffer: bigint = BigInt(1e9); // 1 Gwei default buffer
    private priorityFeeMultiplier: number = 1.0;
    private recentFailures: GasFailureRecord[] = [];
    private recentSuccesses: GasSuccessRecord[] = [];
    private lastBaseFee: bigint = BigInt(0);
    private consecutiveFailures: number = 0;
    private networkCongestionLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
    private lastUpdateTime: number | null = null;
    private static instance: DynamicGasAdjuster | null = null;
    // Add a cache duration property
    private updateIntervalMs: number = 30000; // 30 seconds cache

    // Add the static getInstance method
    public static getInstance(publicClient: PublicClient, initialMultiplier?: number): DynamicGasAdjuster {
        if (!DynamicGasAdjuster.instance) {
            DynamicGasAdjuster.instance = new DynamicGasAdjuster(publicClient, initialMultiplier);
        }
        return DynamicGasAdjuster.instance;
    }

    /**
     * Creates a new DynamicGasAdjuster instance
     * @param publicClient - Viem PublicClient for chain interaction
     * @param initialMultiplier - Starting fee multiplier (defaults to 1.0)
     */
    constructor(publicClient: PublicClient, initialMultiplier: number = 1.0) {
        this.publicClient = publicClient;
        this.feeMultiplierAdjustment = initialMultiplier;

        // Initialize once at startup
        this.updateNetworkState().catch(error => {
            logger.warn('Initial network state fetch failed, using defaults', {
                error: error instanceof Error ? error.message : String(error)
            });
        });

        // Schedule regular network state updates
        setInterval(() => {
            this.updateNetworkState().catch(error => {
                logger.error('Failed to update network state', {
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }, 120000); // Update every 120 seconds
    }

    /**
     * Get the current network congestion level
     */
    public getNetworkCongestionLevel(): 'LOW' | 'MEDIUM' | 'HIGH' {
        return this.networkCongestionLevel;
    }

    /**
     * Updates network state by fetching latest block and gas info
     */
    public async updateNetworkState(): Promise<void> {
        // Skip if update is too recent
        const now = Date.now();
        if (this.lastUpdateTime && now - this.lastUpdateTime < this.updateIntervalMs) {
            return;
        }

        try {
            // Update timestamp first to prevent concurrent calls
            this.lastUpdateTime = now;

            // Fetch block data
            const block = await this.publicClient.getBlock({ blockTag: 'latest' });

            // Use block.baseFeePerGas if available, otherwise fallback to getGasPrice
            if (block.baseFeePerGas) {
                this.lastBaseFee = block.baseFeePerGas;
            } else {
                const gasPrice = await this.publicClient.getGasPrice();
                this.lastBaseFee = gasPrice;
            }

            // Simple congestion level detection based on block utilization
            if (block.gasUsed && block.gasLimit) {
                const utilization = Number(block.gasUsed * 100n / block.gasLimit);

                // Set congestion level based on utilization
                if (utilization > 80) {
                    this.networkCongestionLevel = 'HIGH';
                } else if (utilization > 50) {
                    this.networkCongestionLevel = 'MEDIUM';
                } else {
                    this.networkCongestionLevel = 'LOW';
                }

                logger.debug('Network state updated', {
                    blockNumber: block.number.toString(),
                    baseFee: formatUnits(this.lastBaseFee, 9) + ' Gwei',
                    utilization: `${utilization.toFixed(2)}%`,
                    congestionLevel: this.networkCongestionLevel
                });
            } else {
                // If block doesn't have gas data, just log the basic info
                logger.debug('Network state updated (limited data)', {
                    blockNumber: block.number.toString(),
                    baseFee: formatUnits(this.lastBaseFee, 9) + ' Gwei'
                });
            }
        } catch (error) {
            logger.error('Error fetching network state', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Records a transaction failure and adjusts parameters
     * @param errorType - Type of failure (e.g., 'INSUFFICIENT_GAS_PRICE')
     * @param gasPrice - Gas price used in the failed transaction
     * @param transactionHash - Optional hash of the failed transaction
     */
    public recordFailure(errorType: string, gasPrice: bigint, transactionHash?: string): void {
        const failureRecord: GasFailureRecord = {
            timestamp: Date.now(),
            errorType,
            gasPrice,
            baseFee: this.lastBaseFee,
            transactionHash
        };

        // Add to history, maintain max size
        this.recentFailures.push(failureRecord);
        if (this.recentFailures.length > this.maxRecords) {
            this.recentFailures.shift();
        }

        // Increment consecutive failures counter
        this.consecutiveFailures++;

        // Adjust parameters based on failure type
        switch (errorType) {
            case 'INSUFFICIENT_GAS_PRICE':
            case 'TRANSACTION_UNDERPRICED':
            case 'MAX_FEE_TOO_LOW':
                // Aggressive increase for gas price related failures
                this.feeMultiplierAdjustment += 0.3;
                this.baseFeeBuffer += BigInt(1e9); // Add 1 Gwei to buffer
                this.priorityFeeMultiplier += 0.2;
                break;

            case 'STALE_QUOTE':
                // Modest increase as this might be due to slow transactions
                this.feeMultiplierAdjustment += 0.1;
                break;

            case 'SLIPPAGE_TOO_HIGH':
                // Minor adjustment as this isn't directly gas related
                this.feeMultiplierAdjustment += 0.05;
                break;

            default:
                // Small default increase for unknown errors
                this.feeMultiplierAdjustment += 0.05;
        }

        // Apply exponential increase for consecutive failures
        if (this.consecutiveFailures > 2) {
            this.feeMultiplierAdjustment *= 1.1;
        }

        // Cap the multiplier to prevent excessive fees
        if (this.feeMultiplierAdjustment > 3.0) {
            this.feeMultiplierAdjustment = 3.0;
        }

        // Cap the priority fee multiplier
        if (this.priorityFeeMultiplier > 5.0) {
            this.priorityFeeMultiplier = 5.0;
        }

        logger.info('Gas parameters adjusted after failure', {
            errorType,
            consecutiveFailures: this.consecutiveFailures,
            newFeeMultiplier: this.feeMultiplierAdjustment.toFixed(2),
            newPriorityFeeMultiplier: this.priorityFeeMultiplier.toFixed(2),
            baseFeeBuffer: formatUnits(this.baseFeeBuffer, 9),
            congestionLevel: this.networkCongestionLevel
        });
    }

    /**
     * Records a successful transaction and adjusts parameters
     * @param gasUsed - Gas used by the transaction
     * @param effectiveGasPrice - The effective gas price paid
     * @param transactionHash - Hash of the successful transaction
     */
    public recordSuccess(gasUsed: bigint, effectiveGasPrice: bigint, transactionHash: string): void {
        const successRecord: GasSuccessRecord = {
            timestamp: Date.now(),
            gasPrice: effectiveGasPrice,
            effectiveGasPrice,
            gasUsed,
            transactionHash
        };

        // Add to history, maintain max size
        this.recentSuccesses.push(successRecord);
        if (this.recentSuccesses.length > this.maxRecords) {
            this.recentSuccesses.shift();
        }

        // Reset consecutive failures counter
        this.consecutiveFailures = 0;

        // Gradually decrease multipliers after success
        this.feeMultiplierAdjustment *= 0.95; // Reduce by 5%
        this.priorityFeeMultiplier *= 0.95; // Reduce by 5%

        // Ensure multipliers don't go below base values
        if (this.feeMultiplierAdjustment < 1.0) {
            this.feeMultiplierAdjustment = 1.0;
        }

        if (this.priorityFeeMultiplier < 1.0) {
            this.priorityFeeMultiplier = 1.0;
        }

        logger.debug('Gas parameters adjusted after success', {
            transactionHash,
            effectiveGasPrice: formatUnits(effectiveGasPrice, 9),
            gasUsed: gasUsed.toString(),
            newFeeMultiplier: this.feeMultiplierAdjustment.toFixed(2),
            newPriorityFeeMultiplier: this.priorityFeeMultiplier.toFixed(2)
        });
    }

    /**
     * Computes optimal gas parameters for a new transaction
     * @returns Object containing adjusted gas parameters
     */
    public async computeGasParameters(): Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
        gasLimit: bigint;
        baseFee: bigint;
    }> {
        await this.updateNetworkState();

        // Get current gas price from chain
        const gasPrice = await this.publicClient.getGasPrice();

        // Use either base fee from block or gas price as fallback
        const baseFee = this.lastBaseFee > 0n ? this.lastBaseFee : gasPrice;

        // Calculate priority fee based on congestion level
        let priorityFee: bigint;
        switch (this.networkCongestionLevel) {
            case 'HIGH':
                priorityFee = BigInt(Math.floor(GAS_OPTIMIZATION.PRIORITY_FEE.HIGH * this.priorityFeeMultiplier));
                break;
            case 'MEDIUM':
                priorityFee = BigInt(Math.floor(GAS_OPTIMIZATION.PRIORITY_FEE.MEDIUM * this.priorityFeeMultiplier));
                break;
            case 'LOW':
            default:
                priorityFee = BigInt(Math.floor(GAS_OPTIMIZATION.PRIORITY_FEE.LOW * this.priorityFeeMultiplier));
        }

        // Calculate max fee per gas:
        // baseFee + priorityFee + buffer + dynamic adjustment
        const multiplierBps = BigInt(Math.floor(this.feeMultiplierAdjustment * 100));
        const dynamicBuffer = (baseFee * multiplierBps) / 100n - baseFee;
        const maxFeePerGas = baseFee + priorityFee + this.baseFeeBuffer + dynamicBuffer;

        // For gas limit, use configured default with safety margin based on congestion
        const gasLimitMultiplier = this.networkCongestionLevel === 'HIGH' ? 1.2 :
            (this.networkCongestionLevel === 'MEDIUM' ? 1.1 : 1.05);
        const gasLimit = BigInt(Math.floor(Number(GAS_OPTIMIZATION.ESTIMATED_GAS_LIMIT) * gasLimitMultiplier));

        logger.info('Computed gas parameters', {
            baseFee: formatUnits(baseFee, 9),
            priorityFee: formatUnits(priorityFee, 9),
            buffer: formatUnits(this.baseFeeBuffer, 9),
            dynamicAdjustment: formatUnits(dynamicBuffer, 9),
            maxFeePerGas: formatUnits(maxFeePerGas, 9),
            maxPriorityFeePerGas: formatUnits(priorityFee, 9),
            gasLimit: gasLimit.toString(),
            feeMultiplier: this.feeMultiplierAdjustment.toFixed(2),
            congestion: this.networkCongestionLevel
        });

        return {
            maxFeePerGas,
            maxPriorityFeePerGas: priorityFee,
            gasLimit,
            baseFee
        };
    }

    /**
     * Gets stats about recent transaction performance
     */
    public getStats(): {
        feeMultiplier: number;
        priorityFeeMultiplier: number;
        baseFeeBuffer: string;
        consecutiveFailures: number;
        congestionLevel: string;
        recentFailureCount: number;
        recentSuccessCount: number;
        lastBaseFee: string;
    } {
        return {
            feeMultiplier: this.feeMultiplierAdjustment,
            priorityFeeMultiplier: this.priorityFeeMultiplier,
            baseFeeBuffer: formatUnits(this.baseFeeBuffer, 9),
            consecutiveFailures: this.consecutiveFailures,
            congestionLevel: this.networkCongestionLevel,
            recentFailureCount: this.recentFailures.length,
            recentSuccessCount: this.recentSuccesses.length,
            lastBaseFee: formatUnits(this.lastBaseFee, 9)
        };
    }

    /**
     * Gets the current fee multiplier adjustment
     */
    public getFeeMultiplier(): number {
        return this.feeMultiplierAdjustment;
    }

    /**
     * Identifies if there's a critical gas issue requiring intervention
     */
    public hasCriticalGasIssue(): boolean {
        return this.consecutiveFailures >= 5 || this.feeMultiplierAdjustment >= 2.5;
    }

    /**
     * Gets recommended action based on recent performance
     */
    public getRecommendedAction(): 'PROCEED' | 'CAUTION' | 'PAUSE' {
        if (this.consecutiveFailures >= 5 || this.feeMultiplierAdjustment >= 2.5) {
            return 'PAUSE';
        }

        if (this.consecutiveFailures >= 3 || this.feeMultiplierAdjustment >= 1.8) {
            return 'CAUTION';
        }

        return 'PROCEED';
    }
}

/**
 * waitForFirstLegConfirmation
 *
 * Polls the blockchain using publicClient.getTransactionReceipt to determine whether a transaction
 * (identified by its hash) has been confirmed. This function is intended for waiting on the first leg
 * of an arbitrage trade. It will return true if the transaction is confirmed (receipt.status === 'success')
 * before the timeout; otherwise, it returns false.
 *
 * @param hash - the transaction hash to check.
 * @param publicClient - an instance of a viem PublicClient.
 * @param timeoutMs - maximum time to wait (default: CONFIRMATION_TIMEOUT)
 * @param pollingInterval - time between polls (default: POLLING_INTERVAL)
 * @returns a Promise that resolves to true if confirmed, or false if timed out.
 */
export async function waitForTransactionConfirmation(
//export async function waitForFirstLegConfirmation(
    hash: Hash,
    publicClient: PublicClient,
    timeoutMs: number = CONFIRMATION_TIMEOUT,
    pollingInterval: number = POLLING_INTERVAL
): Promise<boolean> {
    const startTime = performance.now();
    while (performance.now() - startTime < timeoutMs) {
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash });
            if (receipt && receipt.status === 'success') {
                logger.info(`First leg transaction ${hash} confirmed on block ${receipt.blockNumber}.`);
                return true;
            }
        } catch (error) {
            logger.debug(`Error checking first leg confirmation for ${hash}: ${getErrorMessage(error)}`);
        }
        await sleep(pollingInterval);
    }
    logger.error(`Timeout waiting for first leg transaction ${hash} confirmation after ${timeoutMs}ms.`);
    return false;
}

/**
 * TimingUtility
 * Utility class to record and log timing checkpoints for a trade.
 */
export class TimingUtility {
    private readonly timings: TradeTimings;
    private readonly checkpoints: Map<string, number>;
    private readonly tradeId: string;

    constructor(tradeId: string) {
        this.tradeId = tradeId;
        const now = timingUtils.getPerformanceTime();
        this.timings = {
            startTime: now,
            // Initialize all timing points to avoid nulls
            firstTradeSubmitted: 0,
            firstTradeConfirmed: 0,
            secondTradeSubmitted: 0,
            secondTradeConfirmed: 0,
            endTime: 0
        };
        this.checkpoints = new Map();
        this.checkpoints.set('start', now);
    }

    // Record a timing event
    public recordEvent(event: keyof TradeTimings): void {
        const now = timingUtils.getPerformanceTime();
        this.timings[event] = now;
        this.checkpoints.set(event, now);
        this.logTimings(event);

        // Auto-set endTime for certain events
        if (event === 'secondTradeConfirmed') {
            this.timings.endTime = now;
            this.checkpoints.set('endTime', now);
        }
    }

    // Define the logTimings method that was missing
    private logTimings(event: string): void {
        const currentTime = timingUtils.getPerformanceTime();
        const elapsedTotal = (currentTime - this.timings.startTime) / 1000;
        const details: Record<string, string | number> = {
            tradeId: this.tradeId,
            totalElapsedSeconds: parseFloat(elapsedTotal.toFixed(3))
        };

        // Add event-specific timings
        if (this.timings.firstTradeSubmitted) {
            details.firstTradeSubmissionTime =
                ((this.timings.firstTradeSubmitted - this.timings.startTime) / 1000).toFixed(3);
        }

        if (this.timings.firstTradeConfirmed && this.timings.firstTradeSubmitted) {
            details.firstTradeConfirmationTime =
                ((this.timings.firstTradeConfirmed - this.timings.firstTradeSubmitted) / 1000).toFixed(3);
        }

        if (this.timings.secondTradeSubmitted && this.timings.firstTradeConfirmed) {
            details.secondTradeSubmissionTime =
                ((this.timings.secondTradeSubmitted - this.timings.firstTradeConfirmed) / 1000).toFixed(3);
        }

        if (this.timings.secondTradeConfirmed && this.timings.secondTradeSubmitted) {
            details.secondTradeConfirmationTime =
                ((this.timings.secondTradeConfirmed - this.timings.secondTradeSubmitted) / 1000).toFixed(3);
        }

        if (this.timings.endTime) {
            details.totalExecutionTime =
                ((this.timings.endTime - this.timings.startTime) / 1000).toFixed(3);
        }

        logger.info(`Trade timing update - ${event}`, { metadata: details });
    }

    // Get total execution time - version that throws error if timing data invalid
    public getTotalTime(): number {
        if (!this.timings.endTime) {
            const now = timingUtils.getPerformanceTime();
            logger.debug(`Auto-setting missing endTime in getTotalTime for tradeId ${this.tradeId}`);
            this.timings.endTime = now;
            this.checkpoints.set('endTime', now);
        }

        const startTime = this.timings.startTime;
        const endTime = this.timings.endTime;

        // Validate timing data before returning duration
        if (!startTime) {
            throw new Error(`Invalid timing data: missing startTime for tradeId ${this.tradeId}`);
        }

        if (!endTime) {
            throw new Error(`Invalid timing data: missing endTime for tradeId ${this.tradeId}`);
        }

        if (endTime < startTime) {
            logger.warn(`Negative duration detected in getTotalTime for tradeId ${this.tradeId}`, {
                startTime,
                endTime,
                difference: endTime - startTime
            });
            // Return zero instead of negative value
            return 0;
        }

        return endTime - startTime;
    }

    // Safe method to get total execution time
    public getTotalTimeOrZero(): number {
        if (!this.timings.endTime) {
            const now = timingUtils.getPerformanceTime();
            logger.debug(`Auto-setting missing endTime in getTotalTimeOrZero for tradeId ${this.tradeId}`);
            this.timings.endTime = now;
            this.checkpoints.set('endTime', now);
        }

        // Inline duration calculation
        const startTime = this.timings.startTime;
        const endTime = this.timings.endTime;

        if (!startTime) return 0;
        if (!endTime || endTime < startTime) return 0;
        return endTime - startTime;
    }

    // Get all timing data for reporting
    public getTimingData(): Record<string, number | string> {
        const now = timingUtils.getPerformanceTime();
        const elapsedTotal = (now - this.timings.startTime) / 1000;

        const data: Record<string, number | string> = {
            tradeId: this.tradeId,
            startTime: this.timings.startTime,
            currentTime: now,
            totalElapsedSeconds: parseFloat(elapsedTotal.toFixed(3))
        };

        // Add leg-specific timings if available
        if (this.timings.firstTradeSubmitted) {
            data.firstTradeSubmissionTime =
                (this.timings.firstTradeSubmitted - this.timings.startTime) / 1000;
        }

        if (this.timings.firstTradeConfirmed && this.timings.firstTradeSubmitted) {
            data.firstTradeConfirmationTime =
                (this.timings.firstTradeConfirmed - this.timings.firstTradeSubmitted) / 1000;
        }

        if (this.timings.secondTradeSubmitted && this.timings.firstTradeConfirmed) {
            data.secondTradeSubmissionTime =
                (this.timings.secondTradeSubmitted - this.timings.firstTradeConfirmed) / 1000;
        }

        if (this.timings.secondTradeConfirmed && this.timings.secondTradeSubmitted) {
            data.secondTradeConfirmationTime =
                (this.timings.secondTradeConfirmed - this.timings.secondTradeSubmitted) / 1000;
        }

        if (this.timings.endTime) {
            data.totalExecutionTime =
                (this.timings.endTime - this.timings.startTime) / 1000;
        }

        return data;
    }
}
/**
 * Gets the current blockchain timestamp from the latest block
 * @param publicClient - Viem public client for chain interaction
 * @returns Promise resolving to the current blockchain timestamp (in seconds)
 */
export async function getBlockchainTime(publicClient: PublicClient): Promise<number> {
    try {
        const latestBlock = await publicClient.getBlock({ blockTag: 'latest' });
        return Number(latestBlock.timestamp);
    } catch (error) {
        logger.error('Failed to fetch blockchain time', {
            error: getErrorMessage(error)
        });
        // Fall back to system time if blockchain time fetching fails
        // Consider adding a small offset to account for typical lag
        return Math.floor(Date.now() / 1000) - 3;
    }
}

/**
 * TransactionTracker
 * Utility class to track a limited number of transaction hashes.
 */
export class TransactionTracker {
    private transactions: Set<Hash> = new Set();
    private readonly maxTransactions: number = 2;

    addTransaction(hash: Hash): void {
        if (this.transactions.size >= this.maxTransactions) {
            logger.error('Attempting to add more than allowed transactions', {
                existingTransactions: Array.from(this.transactions),
                newTransaction: hash
            });
            throw new Error('Maximum transaction count exceeded');
        }
        this.transactions.add(hash);
        logger.debug('Transaction added to tracker', {
            hash: hash.toString(),
            totalTracked: this.transactions.size
        });
    }

    clear(): void {
        this.transactions.clear();
        logger.debug('Transaction tracker cleared');
    }
}
// Then add this function to your exports near the end of the file:

/**
 * Estimates the gas cost of an arbitrage transaction in USDC
 * @param config - Arbitrage configuration with trade data
 * @param publicClient - Viem public client for chain interaction
 * @returns Promise resolving to the estimated gas cost in USDC
 */
export async function estimateGasCostInUSDC(
    publicClient: PublicClient
): Promise<number> {
    try {
        // Get the current WAVAX price from our dedicated quoter
        const wavaxPriceInUSDC = await wavaxPriceQuoter.getPrice();

        // Get gas parameters
        const gasUtility = GasTransactionUtility.getInstance(publicClient);

        // Get current gas price
        const gasPrice = await gasUtility.getGasPrice();

        // Estimate gas units for the transaction
        const gasUnits = Number(BASE_GAS_ESTIMATE);

        // Convert gas price from wei to AVAX
        const gasPriceInAVAX = Number(formatUnits(gasPrice, 18));

        // Calculate gas cost in AVAX
        const gasCostInAVAX = gasPriceInAVAX * gasUnits;

        // Convert to USDC
        const gasCostInUSDC = gasCostInAVAX * wavaxPriceInUSDC;

        // Add buffer for safety
        const finalCost = gasCostInUSDC * GAS_BUFFER;

        logger.debug('Gas cost calculation', {
            wavaxPriceInUSDC,
            gasPrice: formatUnits(gasPrice, 9) + ' Gwei',
            gasUnits,
            gasCostInAVAX,
            gasCostInUSDC,
            finalCost
        });

        return finalCost;
    } catch (error) {
        // Fallback to fixed estimate if dynamic pricing fails
        logger.warn('Error getting dynamic gas price, using fallback', {
            error: getErrorMessage(error)
        });

        const gasUtility = GasTransactionUtility.getInstance(publicClient);
        return gasUtility.getFixedGasCostEstimate();
    }
}

/**
 * Network-aware gas cost estimation for both Avalanche and Arbitrum
 * @param publicClient - Viem public client for chain interaction
 * @param network - Target network for gas estimation
 * @returns Promise resolving to the estimated gas cost in USDC
 */
export async function estimateNetworkGasCostInUSDC(
    publicClient: PublicClient,
    network: NetworkKey = 'AVALANCHE'
): Promise<{
    gasCostUSDC: number;
    gasCostNative: number;
    nativePriceUSDC: number;
    nativeCurrency: string;
}> {
    try {
        const networkConfig = getNetworkConfig(network);
        const gasConfig = networkConfig.gasConfig;
        const nativeCurrency = networkConfig.network.nativeCurrency;

        // 🔧 FIX: Get real-time price based on network
        let nativePriceInUSDC: number;
        if (network === 'ARBITRUM') {
            // Use the fixed WETH price quoter
            nativePriceInUSDC = await wethPriceQuoter.getPrice();
            logger.debug('Using real-time WETH price for Arbitrum gas calculation', {
                network,
                wethPrice: nativePriceInUSDC.toFixed(2)
            });
        } else if (network === 'AVALANCHE') {
            // Use existing WAVAX price quoter
            const { wavaxPriceQuoter } = await import('./wavaxPriceQuoter.ts');
            nativePriceInUSDC = await wavaxPriceQuoter.getPrice();
            logger.debug('Using real-time WAVAX price for Avalanche gas calculation', {
                network,
                wavaxPrice: nativePriceInUSDC.toFixed(2)
            });
        } else {
            // Fallback to config price
            nativePriceInUSDC = gasConfig.NATIVE_PRICE_IN_USDC;
            logger.warn('Using fallback price for unknown network', {
                network,
                fallbackPrice: nativePriceInUSDC
            });
        }

        // Get dynamic gas price
        const gasPrice = await publicClient.getGasPrice();
        const gasUnits = 150000; // Conservative estimate

        // Calculate costs
        const gasCostInNative = (Number(gasPrice) * gasUnits) / 1e18;
        const gasCostInUSDC = gasCostInNative * nativePriceInUSDC;

        // Apply network-specific buffer
        const buffer = gasConfig.BUFFER_MULTIPLIER;
        const finalCostUSDC = gasCostInUSDC * buffer;

        logger.debug('Network-aware gas cost calculation', {
            network,
            nativeCurrency,
            nativePriceInUSDC: nativePriceInUSDC.toFixed(2),
            gasPrice: (Number(gasPrice) / 1e9).toFixed(2) + ' Gwei',
            gasUnits,
            gasCostInNative: gasCostInNative.toFixed(6),
            gasCostInUSDC: gasCostInUSDC.toFixed(6),
            buffer,
            finalCostUSDC: finalCostUSDC.toFixed(6)
        });

        return {
            gasCostUSDC: finalCostUSDC,
            gasCostNative: gasCostInNative,
            nativePriceUSDC: nativePriceInUSDC,
            nativeCurrency
        };
    } catch (error) {
        // Fallback to network-specific estimates
        logger.warn(`Error getting dynamic gas price for ${network}, using fallback`, {
            error: getErrorMessage(error),
            network
        });

        const networkConfig = getNetworkConfig(network);
        const fallbackPrice = networkConfig.gasConfig.NATIVE_PRICE_IN_USDC;
        const fallbackGasCost = fallbackPrice * 0.001; // Conservative estimate

        return {
            gasCostUSDC: fallbackGasCost,
            gasCostNative: 0.001, // Conservative gas amount
            nativePriceUSDC: fallbackPrice,
            nativeCurrency: networkConfig.network.nativeCurrency
        };
    }
}
/**
 * Enhanced error extraction with transaction context
 */
export function getTransactionError(error: unknown, context?: {
    tradeId?: string;
    network?: string;
    operation?: string;
    txHash?: string;
}): {
    message: string;
    type: string;
    recoverable: boolean;
    context?: any;
} {
    const baseMessage = getErrorMessage(error);
    let errorType = 'UNKNOWN_ERROR';
    let recoverable = false;

    if (baseMessage.toLowerCase().includes('nonce')) {
        errorType = 'NONCE_ERROR';
        recoverable = true; // Nonce errors can be retried
    } else if (baseMessage.toLowerCase().includes('gas')) {
        errorType = 'GAS_ERROR';
        recoverable = true; // Gas errors can be retried with higher gas
    } else if (baseMessage.toLowerCase().includes('slippage') || baseMessage.toLowerCase().includes('insufficient')) {
        errorType = 'SLIPPAGE_ERROR';
        recoverable = true; // Slippage errors can be retried
    } else if (baseMessage.toLowerCase().includes('network') || baseMessage.toLowerCase().includes('connection')) {
        errorType = 'NETWORK_ERROR';
        recoverable = true; // Network errors can be retried
    } else if (baseMessage.toLowerCase().includes('revert')) {
        errorType = 'REVERT_ERROR';
        recoverable = false; // Contract reverts usually aren't recoverable
    }

    return {
        message: baseMessage,
        type: errorType,
        recoverable,
        context
    };
}
/**
 * Retry wrapper for operations that can fail due to recoverable errors
 */
export async function retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000,
    context?: {
        operationName?: string;
        tradeId?: string;
        network?: string;
    }
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const errorDetails = getTransactionError(error, context);

            if (!errorDetails.recoverable || attempt === maxRetries) {
                logger.error('Operation failed - not retrying', {
                    attempt,
                    maxRetries,
                    errorType: errorDetails.type,
                    recoverable: errorDetails.recoverable,
                    message: errorDetails.message,
                    context
                });
                throw error;
            }

            logger.warn('Operation failed - retrying', {
                attempt,
                maxRetries,
                errorType: errorDetails.type,
                message: errorDetails.message,
                retryDelay: delayMs,
                context
            });

            // Wait before retry with exponential backoff
            await sleep(delayMs * Math.pow(1.5, attempt - 1));
        }
    }

    throw lastError;
}
/**
 * Safe contract write with nonce management and retry logic
 */
export async function safeContractWrite(
    walletClient: WalletClient,
    contractConfig: any,
    context?: {
        tradeId?: string;
        network?: string;
        operation?: string;
        nonceManager?: NonceManager;
    }
): Promise<`0x${string}`> {
    return retryOperation(async () => {
        // Get managed nonce if available
        if (context?.nonceManager) {
            const nonce = await context.nonceManager.getNextNonce(context.tradeId);
            contractConfig.nonce = nonce;

            const txPromise = walletClient.writeContract(contractConfig);
            context.nonceManager.registerTransaction(nonce, txPromise, context.tradeId);

            return txPromise;
        } else {
            return walletClient.writeContract(contractConfig);
        }
    }, 3, 2000, {
        operationName: context?.operation || 'contract_write',
        tradeId: context?.tradeId,
        network: context?.network
    });
}
export const timingUtils = {
    getPerformanceTime(): number {
        return performance.now();
    },
};
export async function writeContractWithNonce(
    walletClient: WalletClient,
    network: NetworkKey,
    contractCall: any,
    tradeId: string,
    webhookId?: string
): Promise<Hash> {

    if (!walletClient.account?.address) {
        throw new Error('Wallet account not available');
    }

    const nonceManager = getNetworkNonceManager(walletClient.account.address, network);
    const nonce = await nonceManager.getNextNonce(tradeId, webhookId);

    logger.debug('Executing contract write with managed nonce', {
        network,
        nonce,
        tradeId,
        webhookId: webhookId || 'cli',
        function: contractCall.functionName,
        contract: contractCall.address,
        account: walletClient.account.address
    });

    try {
        const txPromise = walletClient.writeContract({
            ...contractCall,
            nonce,
            account: walletClient.account,
            chain: undefined
        });

        // Register transaction for tracking
        nonceManager.registerTransaction(nonce, txPromise, tradeId, webhookId);

        const hash = await txPromise;

        logger.info('✅ Contract transaction sent successfully', {
            network,
            hash,
            nonce,
            tradeId,
            webhookId: webhookId || 'cli'
        });

        return hash;

    } catch (error) {
        const errorMessage = getErrorMessage(error);

        logger.error('Contract write failed with nonce management', {
            network,
            nonce,
            tradeId,
            webhookId: webhookId || 'cli',
            function: contractCall.functionName,
            error: errorMessage
        });

        // 🚨 ENHANCED: Specific error type handling
        if (errorMessage.includes('nonce')) {
            if (errorMessage.includes('higher than') || errorMessage.includes('too high')) {

                logger.error('🚨 "Nonce too high" error detected - initiating recovery', {
                    network,
                    tradeId,
                    webhookId: webhookId || 'cli',
                    error: errorMessage,
                    account: walletClient.account.address,
                    failedNonce: nonce,
                    errorType: 'nonce_too_high'
                });

                // Use the new specific error handler
                await nonceManager.handleNonceTooHighError(nonce, tradeId, webhookId);

                logger.info('✅ "Nonce too high" recovery completed', {
                    network,
                    account: walletClient.account.address,
                    webhookId: webhookId || 'cli',
                    failedNonce: nonce
                });

            } else if (errorMessage.includes('lower than') || errorMessage.includes('too low')) {

                logger.error('🚨 "Nonce too low" error detected - initiating recovery', {
                    network,
                    tradeId,
                    webhookId: webhookId || 'cli',
                    error: errorMessage,
                    account: walletClient.account.address,
                    failedNonce: nonce,
                    errorType: 'nonce_too_low'
                });

                // Use the new specific error handler
                await nonceManager.handleNonceTooLowError(nonce, tradeId, webhookId);

                logger.info('✅ "Nonce too low" recovery completed', {
                    network,
                    account: walletClient.account.address,
                    webhookId: webhookId || 'cli',
                    failedNonce: nonce
                });

            } else {
                logger.error('🔍 Generic nonce error detected', {
                    network,
                    tradeId,
                    webhookId: webhookId || 'cli',
                    error: errorMessage,
                    failedNonce: nonce,
                    errorType: 'nonce_generic'
                });
            }
        }

        throw error;
    }
}



