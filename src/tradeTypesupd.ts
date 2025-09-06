// src/tradeTypes.ts - FIXED v2.1.0 - Added Missing State Property to TradeResult
// 🔧 FIXES: Added 'state' property to TradeResult interface for mainUniswap.ts compatibility
// 🔧 FIXES: Complete compatibility with TradeExecutionResult interface
// 🔧 ENHANCED: Maintains all existing functionality while ensuring type safety

import type {
    Pool,
    Trade as UniswapTradeType,
    Route as UniswapRoute,
    SwapRouter as UniswapSwapRouter,
    AlphaRouter as UniswapAlphaRouter,
} from '@uniswap/v3-sdk';
import type {
    LBQuoter,
    LBRouter as TraderJoeRouter,
    Trade as TraderJoeTradeType,
    Route as TraderJoeRoute
} from '@traderjoe-xyz/sdk-v2';
import type { Hash, Address, TransactionReceipt, TransactionRequest } from 'viem';

// ==================== 🔧 BASIC TYPES ====================

export enum DexType {
    UNISWAP = 'uniswap',
    TRADERJOE = 'traderjoe'
}

export enum Direction {
    USDC_TO_WBTC = 'USDC_TO_WBTC',
    WBTC_TO_USDC = 'WBTC_TO_USDC',
    USDC_TO_WAVAX = 'USDC_TO_WAVAX',
    WAVAX_TO_USDC = 'WAVAX_TO_USDC'
}

// Transaction states
export enum TransactionState {
    Failed = 'Failed',
    New = 'New',
    Rejected = 'Rejected',
    Sending = 'Sending',
    Sent = 'Sent',
    Confirmed = 'Confirmed'
}

// ==================== 🔧 TRADE EXECUTION INTERFACES ====================

// Result of trade execution
export interface TradeExecutionResult {
    state: TransactionState;
    hash?: string;
    blockNumber?: bigint;
    gasUsed?: string;
    effectiveGasPrice?: string;
    success?: boolean;
    error?: string;
}

// 🔧 FIXED: Enhanced TradeResult interface with required 'state' property
export interface TradeResult {
    tradeId?: string;
    success: boolean;
    state: TransactionState;  // 🔧 ADDED: Required state property for TradeExecutionResult compatibility
    firstLegHash?: Hash;
    secondLegHash?: Hash;
    hash?: string;  // 🔧 ADDED: Additional hash property for compatibility
    amountOut?: string;
    profit?: string;
    expectedProfit?: string;
    error?: string;
    minProfit?: string;
    errorType?: string;          // Classification of the error
    isRecoverable?: boolean;     // Whether this error might succeed on retry
    gasUsed?: string;
    gasEstimate?: string;
    fee?: number;
    effectiveGasPrice?: string;
    receipt?: TransactionReceipt;
    totalCycleTime?: number;
    firstSwapCycleTime?: number;
    secondSwapCycleTime?: number;
    firstRouter?: string;
    secondRouter?: string;
    blockNumber?: bigint;  // 🔧 ADDED: Block number for compatibility

    // Additional properties for trade tracking
    actualAmountIn?: string;     // Actual input amount used in the trade
    expectedAmountOut?: string;  // Expected output amount from quote
    actualAmountOut?: string;    // Actual output amount received
    trade?: UniswapTradeType | TraderJoeTradeType; // The trade object itself
    executionTimeMs?: number;    // Trade execution time in milliseconds

    // Flash loan specific fields
    flashLoanFee?: string;      // The fee paid for the flash loan
    netProfit?: string;         // The profit after flash loan fee

    // Dex error info
    affectedDex?: DexType;      // Which DEX (uniswap or traderjoe) caused the error

    // Swap checkpoint data from contract events - using the SwapCheckpoint interface
    swapCheckpoints?: SwapCheckpoint[];

    tokensTraded?: {
        firstLeg: {
            input: {
                symbol: string;
                address: string;
            };
            output: {
                symbol: string;
                address: string;
            };
        };
        secondLeg?: {
            input: {
                symbol: string;
                address: string;
            };
            output: {
                symbol: string;
                address: string;
            };
        };
    };
    validationCheckpoints?: {
        stage: string;
        detail: string;
    }[];
    finalBalance?: string;
    /** Whether the contract call used `testMode=true` (if you want to mirror that in the result) */
    testMode?: boolean;
    tradeContext?: TradeContext;
    accountBalance?: string; // Total account balance
    firstLegOutput?: string; // Output amount from first leg
    secondLegOutput?: string; // Output amount from second leg

    // Enhanced protocol information
    protocolAddresses?: {
        routerAddress?: string;
        poolAddress?: string;
        factoryAddress?: string;
        quoterAddress?: string;
    };

    // Enhanced token information
    tokenAddresses?: {
        inputToken?: {
            address: string;
            symbol: string;
        };
        outputToken?: {
            address: string;
            symbol: string;
        };
    };

    // Enhanced timing information
    timingData?: {
        entrySignalTimestamp?: number;
        entryExecutionTimestamp?: number;
        exitSignalTimestamp?: number;
        exitExecutionTimestamp?: number;
        processingDelayMs?: number;
    };

    // Enhanced gas information
    gasData?: {
        gasUsed?: string;
        gasPrice?: string;
        gasCostUSDC?: number;
    };
}

// ==================== 🔧 TRADE CONTEXT AND CONFIGURATION ====================

export interface TradeContext {
    direction: Direction;
    amount: number;
    percentage?: number;
    useBalance: boolean;
    dex: DexType;
    testMode?: boolean;
}

export interface SwapCheckpoint {
    stage: string;
    gasUsed: string;
    detail: string;
}

export interface QuoteRequest {
    /** amount in lowest denomination, e.g., 1000000 for 1 USDC if USDC has 6 decimals */
    amount: string;
    /** source token address */
    sourceToken: Address;
    /** target token address */
    targetToken: Address;
    /** slippage as percentage, e.g., 1.5 for 1.5% */
    slippage: number;
    /** optional fee tier for Uniswap V3 pools */
    fee?: number;
    /** recipient address if different from the caller */
    recipient?: Address;
    /** deadline for the transaction (unix timestamp) */
    deadline?: number;
}

export interface QuoteResponse {
    amountOut: string;
    /** Raw calldata to execute the swap */
    calldata: string;
    /** Gas estimate for the transaction */
    gasEstimate: string;
    /** Value to send with the transaction (for ETH swaps) */
    value: string;
    /** price quote timestamp */
    timestamp: number;
    /** Gas related information */
    gas: {
        estimatedGasUsed: string;
        estimatedGasCostUSDC: string;
        effectiveGasPrice: string;
    };
    fee?: number;
    /** Additional metrics for monitoring and optimization */
    metrics?: {
        priceImpact: string;
        executionTime: string;
        swapPath: string;
        timestamp: number;
    };
    quoteTimestamp?: number;
    contractAddress?: Address;
    sourceToken?: Address;
    targetToken?: Address;
    sourceTokenSymbol?: string;
    targetTokenSymbol?: string;
    router?: Address;
}

// ==================== 🔧 TRADE TRACKING INTERFACES ====================

export interface TradeEntry {
    tradeId: string;
    tokenPair?: string;
    signal: string;
    entryDate: string;
    amountUSDC: number;
    txHash?: string;
    blockNumber?: number;
    gasUsed?: string;
    gasCostUSDC?: number;
    slippageTolerancePercent?: number;
    slippageActualPercent?: number;
    webhookId?: string;
    signalTimestamp?: number;
    executionTimestamp?: number;
    processingDelayMs?: number;

    // Enhanced address tracking
    tokenAddresses?: {
        inputToken?: {
            address: string;
            symbol: string;
        };
        outputToken?: {
            address: string;
            symbol: string;
        };
    };

    protocolAddresses?: {
        routerAddress?: string;
        poolAddress?: string;
        factoryAddress?: string;
        quoterAddress?: string;
    };

    // Enhanced timing data
    signalDateCDT?: string;
    executionDateCDT?: string;
    signalTimestampMs?: number;
    executionTimestampMs?: number;
    processingDelaySeconds?: number;

    // Enhanced gas tracking
    gasPrice?: string;
    gasEfficiency?: number;

    // Pool and slippage information
    poolFee?: number;
    priceImpact?: number;
    executionEfficiency?: number;
}

export interface CompletedTrade {
    tradePairId: string;
    tokenPair?: string;
    entrySignal: string;
    exitSignal: string;
    exitReason: string;
    entryDate: string;
    exitDate: string;
    tradeDurationMs?: number;
    entryAmountUSDC: number;
    exitAmountUSDC: number;
    grossProfitUSDC: number;
    gasCostUSDC: number;
    netProfitUSDC: number;
    profitPercentage: number;
    tradeCategory: string;

    // Enhanced timing fields
    entrySignalDate?: string;
    exitSignalDate?: string;
    entrySignalDateCDT?: string;
    exitSignalDateCDT?: string;
    signalDurationMs?: number;
    entryExecutionDateCDT?: string;
    exitExecutionDateCDT?: string;
    executionDurationMs?: number;
    avgProcessingDelaySeconds?: number;
    totalProcessingTimeSeconds?: number;

    // Enhanced profit tracking
    expectedGrossProfitUSDC?: number;
    actualVsExpectedDifference?: number;
    actualVsExpectedPercent?: number;
    totalSlippageImpact?: number;

    // Enhanced address tracking
    entryTxHash?: string;
    exitTxHash?: string;
    entryInputTokenAddress?: string;
    entryOutputTokenAddress?: string;
    exitInputTokenAddress?: string;
    exitOutputTokenAddress?: string;
    entryRouterAddress?: string;
    exitRouterAddress?: string;
    entryPoolAddress?: string;
    exitPoolAddress?: string;
    factoryAddress?: string;
    quoterAddress?: string;

    // Enhanced gas tracking
    entryGasUsed?: number;
    exitGasUsed?: number;
    entryGasPriceGwei?: number;
    exitGasPriceGwei?: number;
    avgGasPriceGwei?: number;
    gasEfficiencyPercent?: number;
    entryGasCostUSDC?: number;
    exitGasCostUSDC?: number;

    // Enhanced pool and execution tracking
    entryPoolFee?: number;
    exitPoolFee?: number;
    entrySlippageTolerance?: number;
    exitSlippageTolerance?: number;
    totalPriceImpact?: number;
    executionEfficiency?: number;

    // Address analytics
    uniqueAddressesCount?: number;
    routersUsedCount?: number;
    poolsUsedCount?: number;
    allRoutersUsed?: string;
    allPoolsUsed?: string;

    // Block and webhook tracking
    entryBlockNumber?: number;
    exitBlockNumber?: number;
    webhookEntryId?: string;
    webhookExitId?: string;

    // Timestamp tracking
    entrySignalTimestamp?: number;
    entryExecutionTimestamp?: number;
    exitSignalTimestamp?: number;
    exitExecutionTimestamp?: number;
    entryProcessingDelayMs?: number;
    exitProcessingDelayMs?: number;

    // Summary
    tradeSummary?: string;
}

export interface TradeSummary {
    totalTrades: number;
    profitableTrades: number;
    unprofitableTrades: number;
    winRate: number;
    totalNetProfit: number;
    totalGrossProfit: number;
    totalGasCost: number;
    avgTradeDurationMs: number;
    avgNetProfitPerTrade: number;
    bestTrade: number;
    worstTrade: number;
    totalVolume: number;
    lastUpdatedCDT: string;
}

// ==================== 🔧 GAS AND PERFORMANCE TRACKING ====================

export interface GasMetric {
    operation: string;
    gasUsed: string;
    gasPrice: string;
    gasCostUSDC: number;
    timestamp: number;
}

export interface PerformanceMetrics {
    tradeExecutionTime: number;
    gasEfficiency: number;
    slippageActual: number;
    priceImpact: number;
    successRate: number;
    profitability: number;
    gasMetrics: GasMetric[];
}

export interface TransactionConfig {
    gasLimit: bigint;
    gasPriceMultiplier: number;
    maxConfirmationAttempts: number;
    confirmationTimeout: number;
    pollingInterval: number;
    priorityFee: number;
}

export interface TradeTimings {
    startTime: number;
    firstTradeSubmitted?: number;
    firstTradeConfirmed?: number;
    secondTradeSubmitted?: number;
    secondTradeConfirmed?: number;
    endTime?: number;
}

export interface TokenConfig {
    isEnabled: boolean;        // Controls whether token is enabled for trading
    maxAmount: bigint;         // Maximum amount that can be traded at once
    minAmount: bigint;         // Minimum amount that can be traded at once
    decimals: bigint;          // Token decimals
    maxSlippage: bigint;       // Maximum slippage allowed (in basis points)
}

export interface PoolData {
    token0: Address;
    token1: Address;
    fee: number;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
}

export interface TradeBuilderResult {
    trade: UniswapTradeType;
    pool: Pool;
    poolData: PoolData;
}

export interface SwapCalldata {
    calldata: string;
    value: bigint;
    estimatedGas: bigint;
}

// ==================== 🔧 TYPE GUARDS AND UTILITIES ====================

// Export type guards
export const TypeGuards = {
    isUniswapTrade: (trade: UniswapTradeType | TraderJoeTradeType): trade is UniswapTradeType => {
        return (
            'route' in trade &&
            'inputAmount' in trade &&
            'outputAmount' in trade &&
            'executionPrice' in trade &&
            !('getLiquidityVariant' in trade) &&
            typeof trade.inputAmount?.toExact === 'function' &&
            typeof trade.outputAmount?.toExact === 'function'
        );
    },

    isTraderJoeTrade: (trade: UniswapTradeType | TraderJoeTradeType): trade is TraderJoeTradeType => {
        return (
            'route' in trade &&
            'getLiquidityVariant' in trade &&
            'inputAmount' in trade &&
            'outputAmount' in trade &&
            'token' in trade.inputAmount &&
            'token' in trade.outputAmount
        );
    },

    getTradeOutputAmount: (trade: UniswapTradeType | TraderJoeTradeType): string => {
        if (TypeGuards.isUniswapTrade(trade)) {
            return trade.outputAmount.toExact();
        } else if (TypeGuards.isTraderJoeTrade(trade)) {
            return trade.outputAmount.toExact();
        }
        throw new Error('Unknown trade type');
    },

    // 🔧 NEW: Type guard for TradeResult compatibility with TradeExecutionResult
    isTradeExecutionResult: (result: TradeResult | TradeExecutionResult): result is TradeExecutionResult => {
        return 'state' in result && result.state !== undefined;
    },

    // 🔧 NEW: Convert TradeResult to TradeExecutionResult
    toTradeExecutionResult: (tradeResult: TradeResult): TradeExecutionResult => {
        return {
            state: tradeResult.state || (tradeResult.success ? TransactionState.Confirmed : TransactionState.Failed),
            hash: tradeResult.hash || tradeResult.firstLegHash,
            blockNumber: tradeResult.blockNumber,
            gasUsed: tradeResult.gasUsed,
            effectiveGasPrice: tradeResult.effectiveGasPrice,
            success: tradeResult.success,
            error: tradeResult.error
        };
    }
};