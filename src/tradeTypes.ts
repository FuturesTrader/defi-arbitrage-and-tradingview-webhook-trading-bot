// src/tradeTypes.ts - Updated with missing properties for trade tracking
import type {
    TradeType as UniTradeType,
    Currency,
} from '@uniswap/sdk-core';
import type { Trade as UniTrade, Pool, Trade} from '@uniswap/v3-sdk';
import type { TradeV2 as TraderJoeTrade } from '@traderjoe-xyz/sdk-v2';
import type {
    Address,
    Hash,
    TransactionReceipt,
    WriteContractParameters
} from 'viem';
import { ARBITRAGE_ABI } from './services/constants/arbitrageAbi';
import { Token as UniswapToken } from '@uniswap/sdk-core';
import { Token as TraderJoeToken } from '@traderjoe-xyz/sdk-core';


// Re-export token types for convenience
export type { UniswapToken, TraderJoeToken };

// Basic types
export type DexType = 'uniswap' | 'traderjoe';

// Re-export TradeV2 directly to support existing imports
export type { TradeV2 as TraderJoeTrade } from '@traderjoe-xyz/sdk-v2';
export type { TradeType as UniTradeType } from '@uniswap/sdk-core';

// Trade types for each DEX
export type UniswapTradeType = UniTrade<Currency, Currency, UniTradeType>;
export type TraderJoeTradeType = TraderJoeTrade;
// Type alias for TradeV2 to maintain backward compatibility
export type TradeV2 = TraderJoeTrade;

// Gas configuration
export interface GasOptions {
    gasPrice: bigint;
    gasLimit: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}
export interface GasParameters extends Required<Pick<GasOptions, 'gasPrice' | 'gasLimit'>> {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}

export interface GasTrackingResult {
    hash: Hash;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    blockNumber:bigint;
    timestamp: number;
}

export interface ArbitrageOpportunity {
    /** The DEX to start the arbitrage (USDC->WAVAX) */
    startDex: DexType;

    /** The DEX to complete the arbitrage (WAVAX->USDC) */
    endDex: DexType;

    /** The starting price from the first leg */
    startPrice: number;

    /** The ending price from the second leg */
    endPrice: number;

    /** The percentage profit expected from the arbitrage */
    profitPercent: number;

    /** Initial USDC amount to send to the first leg */
    amountIn: string;

    /** Expected WAVAX output from the first leg */
    expectedWAVAX: string;

    /** The complete pre-built trade object for the first leg (USDC->WAVAX) */
    firstLeg: SimulatedQuoteResult;

    /** The complete pre-built trade object for the second leg (WAVAX->USDC) */
    secondLeg: SimulatedQuoteResult;

    /** The computed net profit (USDC) for the round-trip after gas costs */
    expectedProfit: string;

    /** Gas cost information for the complete round trip */
    gasCosts?: {
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

// 🔧 UPDATED: Enhanced TradeResult interface with missing properties
export interface TradeResult {
    tradeId?: string;
    success: boolean;
    firstLegHash?: Hash;
    secondLegHash?: Hash;
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

    // 🔧 NEW: Additional properties for trade tracking
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
    firstLegOutput?: string; // Formatted actual first leg output
    secondLegOutput?: string; // Formatted actual second leg output
    expectedFirstLegOutput?: string; // Formatted expected first leg output
    expectedSecondLegOutput?: string; // Formatted expected second leg output
}

export interface ValidationCheckpoint {
    stage: string;   // The validation stage being checked
    detail: string;  // The result or details of the validation
}
export interface SwapCheckpoint {
    stage: string;          // The execution stage (BeforeFirstSwap, AfterFirstSwap, etc.)
    token: Address;         // The token address being tracked
    actualBalance: string;  // The actual balance at the checkpoint
    expectedBalance: string; // The expected balance (if available)
    accountTotalBalance?: string; // Make this optional with ?
    timestamp: string;      // When the checkpoint was recorded
    difference: string;     // The difference between actual and expected
}
// New interface for atomic swap parameters
export interface AtomicSwapParams {
    sourceToken: Address;
    targetToken: Address;
    amount: bigint;
    firstSwapData: `0x${string}`;
    secondSwapData: `0x${string}`;
    firstRouter: Address;
    secondRouter: Address;
    testMode?: boolean;
}
export interface TradeContext {
    tradeInputAmount: bigint;
    tradeFinalBalance: bigint;
    expectedFirstOutput: bigint;
    actualFirstOutput: bigint;
    expectedSecondOutput: bigint;
    actualSecondOutput: bigint;
    executed: boolean;
}
export type ArbitrageTransactionParams = {
    address: Address;
    abi: typeof ARBITRAGE_ABI;
    functionName: 'executeArbitrage';
    args: [
        Address,      // sourceToken
        Address,      // targetToken
        bigint,       // amount
        `0x${string}`,// firstSwapData
        `0x${string}`,// secondSwapData
        Address,      // firstRouter
        Address,      // secondRouter
        boolean       // testMode
    ];
    gas: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
};

export interface ArbitrageExecutionArgs {
    sourceToken: Address;
    targetToken: Address;
    amount: bigint;
    firstSwapData: `0x${string}`;
    secondSwapData: `0x${string}`;
    firstRouter: Address;
    secondRouter: Address;
    expectedFirstOutput: bigint;
    expectedSecondOutput: bigint;
}

// Generic quote result interface
export interface SimulatedQuoteResult {
    trade: UniswapTradeType | TraderJoeTradeType;
    formattedPrice: string;
    expectedOutput: string;
    poolAddress?: Address;
    fee?: number;
    gasPrice?: string;
    priceImpact?: number;
    minAmountOut?: string;
    swapCalldata: string;
    estimatedGas: string;
    routerAddress: Address;
    quoteTimestamp?: bigint;
}
// Enhanced validation types
export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}
export interface ValidationCheckpointEvent {
    executionId: `0x${string}`;
    stage: string;
    detail: string;
}

export interface InputValidationEvent {
    executionId: `0x${string}`;
    sourceToken: Address;
    targetToken: Address;
    amount: bigint;
}

export interface GasValidationEvent {
    executionId: `0x${string}`;
    gasPrice: bigint;
    maxGasPrice: bigint;
}

export interface TokenValidationEvent {
    executionId: `0x${string}`;
    token: Address;
    isEnabled: boolean;
    minAmount: bigint;
    maxAmount: bigint;
}
export interface ArbitrageConfig {
    startDex: DexType;
    endDex: DexType;
    /** Input amount in USDC, e.g. "5" */
    inputAmount: string;

    /** Slippage tolerance in basis points (e.g., 100 = 1%) */
    slippageBps?: number;
    /**
     * (Optional) Pre-simulated trade data for the first leg.
     * The second leg is now built or re-quoted on the fly by arbitrageService.
     */
    simulatedTradeData?: {
        firstLeg?: SimulatedQuoteResult;
        secondLeg?: SimulatedQuoteResult;
        trade?: UniswapTradeType | TraderJoeTradeType;
    };
    fee?: number;
    quoteTimestamp?: number;
    testMode?: boolean;
}
export interface SwapCheckpointEvent {
    executionId: `0x${string}`;
    stage: string;
    token: Address;
    actualBalance: bigint;
    expectedBalance: bigint;
    timestamp: bigint;
}
// Smart contract event types
export interface ArbitrageExecutedEvent {
    sourceToken: Address;
    targetToken: Address;
    amountIn: bigint;       // matches contract
    finalBalance: bigint;   // matches contract
    profit: bigint;         // matches contract
    expectedProfit: bigint; // matches contract
    testMode: boolean;      // matches contract
    accountBalance: bigint;
    tradeProfit: bigint;
    tradeFinalBalance: bigint;
    finalAccountBalance: bigint;
}

export interface GasMetric {
    gasUsed: string;
    effectiveGasPrice: string;
    blockNumber: number;
    timestamp: number;
}
export function isUniswapToken(currency: Currency): currency is UniswapToken {
    // The `instanceof Token` check works if the SDK exports the `Token` class.
    // Alternatively, you can check `'address' in currency` if you prefer.
    return currency instanceof UniswapToken;
}
// Interfaces for timing metrics
export interface TimingMetrics {
    startTime: number;
    lastCheckpoint: number;
    checkpoints: Record<string, number>;
    cycleCount: number;

    totalTrades: number;            // total attempts
    successfulTrades: number;       // on-chain success
    failedTrades: number;           // on-chain revert/fail
    profitableTrades: number;       // chain-confirmed + profit > 0
    unprofitableTrades: number;     // chain-confirmed + profit ≤ 0

    totalProfit: number;            // net sum of profits across all successful trades
    gasMetrics?: GasMetric[];
}

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
    }
};
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

export enum TransactionState {
    Failed = 'Failed',
    New = 'New',
    Rejected = 'Rejected',
    Sending = 'Sending',
    Sent = 'Sent',
    Confirmed = 'Confirmed'
}
// Result of trade execution
export interface TradeExecutionResult {
    state: TransactionState;
    hash?: string;
    blockNumber?: bigint;
    gasUsed?: string;
    effectiveGasPrice?: string;
    error?: string;

    // 🔧 NEW: Additional properties that are being used in executeUniswapTrade
    actualOutputAmount?: string;        // Actual output amount calculated from balance difference
    expectedOutputAmount?: string;      // Expected output amount from trade
    outputTokenSymbol?: string;         // Symbol of the output token
    outputDeterminedBy?: 'balance_difference' | 'expected_fallback';  // How output was determined

    // 🔧 NEW: Enhanced execution details
    executionTimeMs?: number;          // Total execution time in milliseconds
    confirmationTimeMs?: number;       // Time taken for transaction confirmation
    slippageActual?: number;           // Actual slippage experienced
    priceImpact?: number;              // Price impact of the trade
}