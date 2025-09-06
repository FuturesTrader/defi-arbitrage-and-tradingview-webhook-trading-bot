// src/tradeTracker.ts - Network-Aware Multi-Chain Trading v3.0.0
// 🔧 MAJOR UPGRADE: Support for Avalanche + Arbitrum with network-aware trade tracking
// Extends existing timing features with multi-network support

import fs from 'fs';
import path from 'path';
import logger from './logger';
import { getCurrentTimestamp } from './utils';
import type { TradeResult, TradeExecutionResult, DexType } from './tradeTypes';
import {
    getNetworkConfig,
    SUPPORTED_NETWORKS,
    type NetworkKey
} from './constants';

// CDT timestamp formatting utility (unchanged)
function formatCDTTimestamp(unixTimestamp: number): string {
    const date = new Date(unixTimestamp * 1000);
    const datePart = date.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const timePart = date.toLocaleTimeString('en-GB', {
        timeZone: 'America/Chicago',
        hour12: false,
    });
    const timeZone = date.toLocaleDateString('en-US', {
        timeZone: 'America/Chicago',
        timeZoneName: 'short',
    }).split(', ')[1];
    return `${datePart} ${timePart} ${timeZone}`;
}

// ==================== 🔧 ENHANCED INTERFACES WITH NETWORK SUPPORT ====================

export interface TradeEntry {
    tradeId: string;
    entrySignal: 'buy' | 'sell' | 'sellsl' | 'selltp';
    product: string;
    network: NetworkKey;                    // 🔧 NEW: Network where trade was executed
    networkName: string;                    // 🔧 NEW: Human-readable network name
    chainId: number;                        // 🔧 NEW: Blockchain chain ID
    nativeCurrency: string;                 // 🔧 NEW: Native currency symbol (AVAX/ETH)
    exchange: string;
    tradeDirection: string;
    signal?: string;

    amountUSDC: number;
    txHash?: string;
    blockNumber?: number;
    gasUsed?: string;
    gasCostUSDC?: number;
    gasCostNative?: number;                 // 🔧 NEW: Gas cost in native currency
    nativePriceUSDC?: number;               // 🔧 NEW: Native currency price when trade executed
    slippageTolerancePercent?: number;
    slippageActualPercent?: number;

    processingDelayMs?: number;

    // Enhanced Signal and Execution Timestamps (existing)
    signalTimestamp: number;
    signalTimestampCDT: string;
    signalDate: string;
    signalTime: string;

    executionTimestamp: number;
    executionTimestampCDT: string;
    executionDate: string;
    executionTimeFormatted: string;

    entryTimestamp: number;
    entryTimestampCDT: string;
    entryDate: string;
    entryTime: string;
    entryTxHash?: string;
    entryGasUsed?: string;
    entryEffectiveGasPrice?: string;
    entryBlockNumber?: string;

    // Execution Performance Metrics (existing)
    signalToExecutionDelayMs: number;
    signalToExecutionDelayFormatted: string;

    // Trade Information (existing)
    entryPrice?: number;
    entryAmount: string;
    expectedOutput: string;
    actualOutput?: string;
    actualOutputVerified?: boolean;

    // Token Information (existing)
    inputToken: {
        symbol: string;
        address: string;
    };
    outputToken: {
        symbol: string;
        address: string;
    };

    // Enhanced Address Tracking with Network Context
    tokenAddresses?: {
        inputToken: {
            address: string;
            symbol: string;
            decimals: number;
        };
        outputToken: {
            address: string;
            symbol: string;
            decimals: number;
        };
    };
    protocolAddresses?: {
        routerAddress: string;
        poolAddress?: string;
        factoryAddress?: string;
        quoterAddress?: string;
        networkSpecific?: boolean;          // 🔧 NEW: Flag for network-specific addresses
    };

    // 🔧 NEW: Network-specific execution details
    networkExecutionDetails?: {
        explorerUrl: string;                // Network's block explorer URL
        rpcUrl?: string;                    // RPC endpoint used
        gasStrategy: string;                // L1/L2 specific gas strategy used
        l2Optimized?: boolean;              // Whether L2 optimizations were applied
    };

    // Execution Details (existing + enhanced)
    executionDetails?: {
        hash?: string;
        gasUsed?: string;
        gasPrice?: string;
        effectiveGasPrice?: string;
        priceImpact?: number;
        router?: string;
        pool?: string;
        slippageActual?: number;
        poolFee?: number;
        slippageTolerance?: number;
        executionPrice?: number;
        minimumAmountOut?: string;
    };

    dexUsed?: DexType;
    slippageActual?: number;
    poolFee?: number;
    priceImpact?: number;
    executionEfficiency?: number;

    // Trade State (existing)
    status: 'pending' | 'completed' | 'failed';
    errorMessage?: string;

    // Matching Info (existing)
    isEntry: boolean;
    tokenPair: string;
    baseToken: string;
    quoteToken: string;

    // Webhook Context (existing)
    webhookId?: string;
    signalType: 'Regular Buy' | 'Regular Sell' | 'Stop Loss' | 'Take Profit';

    // Additional metadata (enhanced)
    metadata?: {
        webhookReceived: number;
        tradeExecuted: number;
        processingDelay: number;
        networkSwitched?: boolean;          // 🔧 NEW: If network was switched for this trade
        originalNetwork?: NetworkKey;       // 🔧 NEW: Original network before switch
        crossChainTrade?: boolean;          // 🔧 NEW: Future support for cross-chain
    };
}

export interface TokenPerformanceData {
    trades: number;
    netProfit: number;
    winRate: number;
    gasUsage: number;
    averageTradeSize: number;
    tokenAddress?: string;
    // 🔧 NEW: Network-specific performance data
    networkBreakdown?: Partial<Record<NetworkKey, {
        trades: number;
        netProfit: number;
        gasUsage: number;
    }>>;
}

export interface CompletedTrade {
    tradeId: string;
    tradePairId: string;

    // 🔧 NEW: Network context for the completed trade pair
    network: NetworkKey;
    networkName: string;
    chainId: number;
    nativeCurrency: string;

    entryLeg: TradeEntry;
    exitLeg: TradeEntry;

    // 🔧 NEW: Cross-network trade detection
    isCrossNetwork: boolean;                // Whether entry and exit were on different networks
    networksUsed: NetworkKey[];             // All networks used in this trade pair

    // Multiple Duration Calculations (existing)
    signalDurationMs: number;
    signalDurationFormatted: string;
    executionDurationMs: number;
    executionDurationFormatted: string;
    tradeDurationMs: number;
    tradeDurationFormatted: string;

    // Performance Metrics (existing)
    avgSignalToExecutionDelay: number;
    totalProcessingTime: number;

    // Enhanced Signal Timing Details (existing)
    entrySignalCDT: string;
    exitSignalCDT: string;
    entryExecutionCDT: string;
    exitExecutionCDT: string;
    entryDateCDT: string;
    exitDateCDT: string;

    // P&L Calculations (enhanced with network context)
    grossProfitUSDC: number;
    gasCostUSDC: number;
    gasCostNative: number;                  // 🔧 NEW: Total gas cost in native currency
    netProfitUSDC: number;
    profitPercentage: number;
    expectedGrossProfitUSDC: number;
    actualVsExpectedDifference: number;
    actualVsExpectedPercent: number;
    totalSlippageImpact: number;

    // 🔧 NEW: Network-specific cost analysis
    networkCostAnalysis: {
        averageNativePrice: number;         // Average native currency price during trade
        gasCostComparison?: {               // Compare gas costs if cross-network
            [K in NetworkKey]?: {
                gasCostUSDC: number;
                gasCostNative: number;
                efficiency: number;
            };
        };
        networkEfficiencyScore: number;     // Overall network efficiency for this trade
    };

    // Performance Metrics (existing)
    priceImpactTotal: number;
    executionEfficiency: number;

    // Address Summary (enhanced)
    addressSummary?: AddressSummary & {
        networkSpecific: boolean;           // 🔧 NEW: Whether addresses are network-specific
        crossNetworkAddresses?: {           // 🔧 NEW: Track cross-network address usage
            [K in NetworkKey]?: {
                routers: string[];
                pools: string[];
            };
        };
    };

    // Gas Analysis (enhanced with network awareness)
    gasAnalysis: {
        entryGasCostUSDC: number;
        exitGasCostUSDC: number;
        totalGasCostUSDC: number;
        gasEfficiency: number;
        avgGasPriceGwei: number;
        // 🔧 NEW: Network-specific gas analysis
        networkGasAnalysis: {
            network: NetworkKey;
            nativeCurrency: string;
            entryGasCostNative: number;
            exitGasCostNative: number;
            totalGasCostNative: number;
            averageNativePrice: number;
            gasStrategy: string;            // L1 vs L2 strategy used
            l2Optimizations?: {             // Only for L2 networks
                feeSavingsVsL1: number;
                speedImprovementVsL1: number;
            };
        };
    };

    // Completion Details (existing)
    completedTimestamp: number;
    completedTimestampCDT: string;
    completedDate: string;

    // Classification (existing)
    tradeCategory: 'profitable' | 'loss' | 'breakeven';
    exitReason: string;

    // Summary (enhanced with network context)
    summary: string;
}

export interface AddressSummary {
    tokenPair?: string;
    entryTokens?: {
        input?: string;
        output?: string;
    };
    exitTokens?: {
        input?: string;
        output?: string;
    };
    routersUsed: string[];
    poolsUsed: string[];
    totalUniqueAddresses: number;
}

export interface TradeSummary {
    lastUpdated: number;
    lastUpdatedCDT: string;

    // 🔧 NEW: Network-level summary statistics
    networkSummary: {
        [K in NetworkKey]?: {
            totalTrades: number;
            profitableTrades: number;
            totalNetProfit: number;
            averageProfit: number;
            winRate: number;
            totalGasCosts: number;
            averageGasCost: number;
            nativeCurrency: string;
            averageTradeDuration: number;
        };
    };

    // Overall Statistics (existing)
    totalTrades: number;
    profitableTrades: number;
    losingTrades: number;
    breakevenTrades: number;
    totalGrossProfit: number;
    totalGasCosts: number;
    totalNetProfit: number;
    averageProfit: number;
    winRate: number;
    totalExpectedProfit: number;
    totalActualVsExpectedDiff: number;
    averageSlippageImpact: number;
    executionEfficiencyAvg: number;
    averageTradeDuration: number;
    longestTrade: number;
    shortestTrade: number;
    averageGasCost: number;

    // 🔧 NEW: Cross-network analytics
    crossNetworkAnalytics: {
        totalCrossNetworkTrades: number;
        networkDistribution: Partial<Record<NetworkKey, number>>;
        gasCostComparison: Partial<Record<NetworkKey, {
            totalTrades: number;
            averageGasCostUSDC: number;
            averageGasCostNative: number;
            averageNativePrice: number;
        }>>;
        networkEfficiencyRanking: Array<{
            network: NetworkKey;
            efficiencyScore: number;
            averageExecutionTime: number;
            gasCostRank: number;
        }>;
    };

    // Protocol Analytics (enhanced)
    protocolAnalytics: {
        totalUniqueTokens: number;
        totalUniquePools: number;
        totalUniqueRouters: number;
        mostUsedRouter: string;
        mostTradedTokenPair: string;
        averageGasPerTrade: number;
        gasEfficiencyTrend: number;
        // 🔧 NEW: Network-specific protocol analytics
        networkProtocolAnalytics: Record<NetworkKey, {
            uniqueTokens: number;
            uniquePools: number;
            uniqueRouters: number;
            mostUsedRouter: string;
            mostTradedPair: string;
            averageGasPerTrade: number;
        }>;
    };

    tokenPerformance: Record<string, TokenPerformanceData>;
    daily: Record<string, number>;
    weekly: Record<string, number>;
    monthly: Record<string, number>;

    // 🔧 NEW: Daily tracking by network
    dailyByNetwork: Partial<Record<NetworkKey, Record<string, number>>>;
}

// ==================== 🔧 NETWORK-AWARE PRICE QUOTER INTEGRATION ====================

interface INetworkPriceQuoter {
    getPrice(network: NetworkKey): Promise<number>;
    updatePrice(network: NetworkKey): Promise<number>;
}

class MultiNetworkPriceQuoter implements INetworkPriceQuoter {
    private static instance: MultiNetworkPriceQuoter;
    private prices: Map<NetworkKey, number> = new Map();
    private lastUpdateTime: Map<NetworkKey, number> = new Map();
    private readonly updateIntervalMs: number = 5 * 60 * 1000; // 5 minutes

    private constructor() {
        // Initialize with fallback prices
        this.prices.set('AVALANCHE', 17); // AVAX fallback price
        this.prices.set('ARBITRUM', 3500); // ETH fallback price
    }

    public static getInstance(): MultiNetworkPriceQuoter {
        if (!MultiNetworkPriceQuoter.instance) {
            MultiNetworkPriceQuoter.instance = new MultiNetworkPriceQuoter();
        }
        return MultiNetworkPriceQuoter.instance;
    }

    public async getPrice(network: NetworkKey): Promise<number> {
        const lastUpdate = this.lastUpdateTime.get(network) || 0;
        const now = Date.now();

        if (now - lastUpdate > this.updateIntervalMs) {
            try {
                await this.updatePrice(network);
            } catch (error) {
                logger.warn(`Failed to update ${network} price, using cached value`, {
                    error: error instanceof Error ? error.message : String(error),
                    network
                });
            }
        }

        return this.prices.get(network) || this.getFallbackPrice(network);
    }

    public async updatePrice(network: NetworkKey): Promise<number> {
        try {
            let price: number;

            if (network === 'AVALANCHE') {
                // Use existing AVAX price quoter
                try {
                    const { wavaxPriceQuoter } = await import('./wavaxPriceQuoter');
                    price = await wavaxPriceQuoter.getPrice();
                } catch {
                    price = this.getFallbackPrice(network);
                }
            } else if (network === 'ARBITRUM') {
                // 🔧 NEW: Use ETH price quoter
                try {
                    const { wethPriceQuoter } = await import('./wethPriceQuoter');
                    price = await wethPriceQuoter.getPrice();
                } catch {
                    price = this.getFallbackPrice(network);
                }
            } else {
                // Other networks use fallback
                price = this.getFallbackPrice(network);
            }

            this.prices.set(network, price);
            this.lastUpdateTime.set(network, Date.now());

            logger.debug(`Price updated for ${network}`, {
                network,
                price,
                nativeCurrency: SUPPORTED_NETWORKS[network].nativeCurrency
            });

            return price;
        } catch (error) {
            logger.error(`Failed to update ${network} price`, {
                error: error instanceof Error ? error.message : String(error),
                network
            });

            // Return fallback price
            const fallbackPrice = this.getFallbackPrice(network);
            this.prices.set(network, fallbackPrice);
            return fallbackPrice;
        }
    }

    private getFallbackPrice(network: NetworkKey): number {
        const networkConfig = getNetworkConfig(network);
        return networkConfig.gasConfig.NATIVE_PRICE_IN_USDC;
    }
}

// ==================== 🔧 ENHANCED TRADE TRACKER CLASS WITH NETWORK SUPPORT ====================

export class TradeTracker {
    private readonly dataDir: string;
    private readonly activeTradesFile: string;
    private readonly completedTradesFile: string;
    private readonly summaryFile: string;
    private readonly priceQuoter: MultiNetworkPriceQuoter;

    constructor() {
        this.dataDir = path.join(process.cwd(), 'data', 'trades');
        this.activeTradesFile = path.join(this.dataDir, 'trades_active.json');
        this.completedTradesFile = path.join(this.dataDir, 'trades_completed.json');
        this.summaryFile = path.join(this.dataDir, 'trades_summary.json');
        this.priceQuoter = MultiNetworkPriceQuoter.getInstance();

        this.ensureDirectoryExists();
        this.initializeFiles();
        this.verifyFileSystem();

        logger.info('🔧 Network-Aware TradeTracker v3.0.0 initialized', {
            dataDir: this.dataDir,
            supportedNetworks: Object.keys(SUPPORTED_NETWORKS),
            enhancedFeatures: [
                'Multi-network trade tracking',
                'Network-specific gas calculations',
                'Cross-network trade detection',
                'Network efficiency analysis',
                'L1/L2 optimization tracking'
            ]
        });
    }

    /**
     * 🔧 ENHANCED: Record trade with network context
     */
    public async recordTrade(params: {
        webhookData: {
            side: 'buy' | 'sell' | 'sellsl' | 'selltp';
            product: string;
            network: string;
            exchange: string;
        };
        tradeDirection: string;
        tradeResult: TradeResult;
        executionResult?: TradeExecutionResult;
        webhookId?: string;
        signalType: string;
        executionTime?: number;
        signalTimestamp?: number;
        executionTimestamp: number;
        addressInfo?: {
            tokenAddresses: {
                inputToken: { address: string; symbol: string; decimals: number };
                outputToken: { address: string; symbol: string; decimals: number };
            };
            protocolAddresses: {
                routerAddress: string;
                poolAddress?: string;
                factoryAddress?: string;
                quoterAddress?: string;
            };
            executionDetails?: {
                poolFee?: number;
                slippageTolerance?: number;
                priceImpact?: number;
                executionPrice?: number;
                minimumAmountOut?: string;
            };
        };
        // 🔧 NEW: Network context parameter
        networkContext?: {
            network: NetworkKey;
            networkName: string;
            chainId: number;
            nativeCurrency: string;
        };
    }): Promise<string> {
        try {
            const tradeId = this.generateTradeId();
            const { baseToken, quoteToken, tokenPair } = this.parseProduct(params.webhookData.product);
            const isEntry = this.isEntrySignal(params.webhookData.side);

            // 🔧 ENHANCED: Determine network context
            const networkContext = params.networkContext || this.parseNetworkFromWebhook(params.webhookData);

            // 🔧 FIXED: Enhanced timing information with proper signal capture
            const signalTimestamp = params.signalTimestamp || getCurrentTimestamp();
            const executionTimestamp = params.executionTimestamp || getCurrentTimestamp();

            // Ensure different timestamps for proper duration calculation
            const finalSignalTimestamp = signalTimestamp;
            const finalExecutionTimestamp = executionTimestamp === signalTimestamp ?
                executionTimestamp + 1 : executionTimestamp;

            const signalToExecutionDelayMs = Math.max(0, (finalExecutionTimestamp - finalSignalTimestamp) * 1000);

            // Format timestamps
            const signalTimestampCDT = formatCDTTimestamp(finalSignalTimestamp);
            const executionTimestampCDT = formatCDTTimestamp(finalExecutionTimestamp);

            // Extract date and time components
            const signalDateTimeParts = signalTimestampCDT.split(' ');
            const signalDate = signalDateTimeParts[0];
            const signalTime = signalDateTimeParts[1] + ' ' + signalDateTimeParts[2];

            const executionDateTimeParts = executionTimestampCDT.split(' ');
            const executionDate = executionDateTimeParts[0];
            const executionTimeFormatted = executionDateTimeParts[1] + ' ' + executionDateTimeParts[2];

            // 🔧 CRITICAL FIX: Proper amount calculation logic
            const calculateTradeAmounts = () => {
                // ✅ FIXED: Use only properties that exist in TradeResult interface
                const inputAmount = params.tradeResult.actualAmountIn || '0';  // ✅ This exists

                let outputAmount = '0';

                // ✅ FIXED: Use correct property names and safe access
                if (params.tradeResult.actualAmountOut) {
                    outputAmount = params.tradeResult.actualAmountOut;  // ✅ This exists
                } else if (params.tradeResult.expectedAmountOut) {
                    outputAmount = params.tradeResult.expectedAmountOut;  // ✅ This exists
                } else {
                    // ✅ SAFE: Type-safe access to potentially extended properties
                    const extendedTradeResult = params.tradeResult as any;
                    if (extendedTradeResult.actualOutputAmount) {
                        outputAmount = extendedTradeResult.actualOutputAmount;
                    }
                }

                // 🔧 CRITICAL: Determine USDC amount based on trade direction
                let amountUSDC: number;
                let entryAmount: string;

                if (params.tradeDirection?.includes('USDC_TO_')) {
                    // Buy trade: USDC → Token (input is USDC)
                    amountUSDC = parseFloat(inputAmount);
                    entryAmount = inputAmount;
                    logger.debug('🔧 Buy trade detected - using input amount as USDC', {
                        tradeDirection: params.tradeDirection,
                        inputAmount,
                        calculatedUSDC: amountUSDC
                    });
                } else if (params.tradeDirection?.includes('_TO_USDC')) {
                    // Sell trade: Token → USDC (output is USDC)
                    amountUSDC = parseFloat(outputAmount);
                    entryAmount = outputAmount;
                    logger.debug('🔧 Sell trade detected - using output amount as USDC', {
                        tradeDirection: params.tradeDirection,
                        outputAmount,
                        calculatedUSDC: amountUSDC
                    });
                } else {
                    // Fallback: Use existing method
                    amountUSDC = this.extractTradeAmountUSDC(params, isEntry);
                    entryAmount = amountUSDC.toString();
                    logger.debug('🔧 Using fallback extractTradeAmountUSDC method', {
                        tradeDirection: params.tradeDirection,
                        extractedUSDC: amountUSDC
                    });
                }

                return {
                    amountUSDC,
                    entryAmount,
                    rawInputAmount: inputAmount,
                    rawOutputAmount: outputAmount
                };
            };

            const amounts = calculateTradeAmounts();

            // 🔧 NEW: Calculate network-aware gas costs
            const gasCostData = await this.calculateNetworkAwareGasCost(params, networkContext.network);

            // 🔧 ENHANCED: Validation and logging
            logger.info('🔧 Recording network-aware trade', {
                tradeId,
                network: networkContext.network,
                networkName: networkContext.networkName,
                chainId: networkContext.chainId,
                nativeCurrency: networkContext.nativeCurrency,
                isEntry,
                signalTimestamp: finalSignalTimestamp,
                executionTimestamp: finalExecutionTimestamp,
                delayMs: signalToExecutionDelayMs,
                webhookId: params.webhookId,
                // 🔧 NEW: Amount validation logging
                amounts: {
                    calculatedUSDC: amounts.amountUSDC,
                    entryAmount: amounts.entryAmount,
                    rawInput: amounts.rawInputAmount,
                    rawOutput: amounts.rawOutputAmount,
                    tradeDirection: params.tradeDirection
                }
            });

            const trade: TradeEntry = {
                tradeId,
                entrySignal: params.webhookData.side,
                product: params.webhookData.product,

                // 🔧 NEW: Network context fields
                network: networkContext.network,
                networkName: networkContext.networkName,
                chainId: networkContext.chainId,
                nativeCurrency: networkContext.nativeCurrency,

                exchange: params.webhookData.exchange,
                tradeDirection: params.tradeDirection,
                entryTxHash: params.executionResult?.hash,
                entryGasUsed: params.executionResult?.gasUsed || params.tradeResult.gasUsed,
                entryEffectiveGasPrice: params.executionResult?.effectiveGasPrice || params.tradeResult.effectiveGasPrice,
                entryBlockNumber: params.executionResult?.blockNumber?.toString(),
                tokenAddresses: params.addressInfo?.tokenAddresses,

                // 🔧 ENHANCED: Protocol addresses with network context
                protocolAddresses: params.addressInfo?.protocolAddresses ? {
                    ...params.addressInfo.protocolAddresses,
                    networkSpecific: true
                } : undefined,

                // 🔧 NEW: Network-specific execution details
                networkExecutionDetails: {
                    explorerUrl: SUPPORTED_NETWORKS[networkContext.network].explorerUrl,
                    gasStrategy: networkContext.network === 'ARBITRUM' ? 'L2_OPTIMIZED' : 'L1_STANDARD',
                    l2Optimized: networkContext.network === 'ARBITRUM'
                },

                signal: params.webhookData.side,

                // 🔧 FIXED: Consistent USDC amounts
                amountUSDC: amounts.amountUSDC,
                entryAmount: amounts.entryAmount,  // Now consistently USDC

                // 🔧 NEW: Network-aware gas costs
                gasCostUSDC: gasCostData.gasCostUSDC,
                gasCostNative: gasCostData.gasCostNative,
                nativePriceUSDC: gasCostData.nativePriceUSDC,

                // 🔧 FIXED: Timing fields with proper signal capture
                signalTimestamp: finalSignalTimestamp,
                signalTimestampCDT,
                signalDate,
                signalTime,
                executionTimestamp: finalExecutionTimestamp,
                executionTimestampCDT,
                executionDate,
                executionTimeFormatted,
                entryTimestamp: finalSignalTimestamp,
                entryTimestampCDT: signalTimestampCDT,
                entryDate: signalTimestampCDT,
                entryTime: signalTime,
                signalToExecutionDelayMs,
                signalToExecutionDelayFormatted: this.formatDurationEnhanced(signalToExecutionDelayMs),

                // Trade information (existing with enhanced output detection)
                entryPrice: undefined,
                expectedOutput: params.tradeResult.expectedAmountOut || '0',
                actualOutput: amounts.rawOutputAmount,  // Keep raw output for reference
                actualOutputVerified: !!params.tradeResult.actualAmountOut,

                // Token information (existing - this should work with tokensTraded fix)
                inputToken: {
                    symbol: params.addressInfo?.tokenAddresses?.inputToken?.symbol ||
                        params.tradeResult.tokensTraded?.firstLeg?.input?.symbol ||
                        baseToken,
                    address: params.addressInfo?.tokenAddresses?.inputToken?.address ||
                        params.tradeResult.tokensTraded?.firstLeg?.input?.address ||
                        ''
                },
                outputToken: {
                    symbol: params.addressInfo?.tokenAddresses?.outputToken?.symbol ||
                        params.tradeResult.tokensTraded?.firstLeg?.output?.symbol ||
                        quoteToken,
                    address: params.addressInfo?.tokenAddresses?.outputToken?.address ||
                        params.tradeResult.tokensTraded?.firstLeg?.output?.address ||
                        ''
                },

                // Execution details (existing)
                executionDetails: {
                    hash: params.executionResult?.hash,
                    gasUsed: params.executionResult?.gasUsed || params.tradeResult.gasUsed,
                    gasPrice: params.tradeResult.effectiveGasPrice,
                    effectiveGasPrice: params.executionResult?.effectiveGasPrice || params.tradeResult.effectiveGasPrice,
                    priceImpact: 0,
                    router: params.tradeResult.firstRouter,
                    pool: params.addressInfo?.protocolAddresses?.poolAddress || 'UNKNOWN',
                    slippageActual: 0,
                    poolFee: params.addressInfo?.executionDetails?.poolFee,
                    slippageTolerance: params.addressInfo?.executionDetails?.slippageTolerance,
                    executionPrice: params.addressInfo?.executionDetails?.executionPrice,
                    minimumAmountOut: params.addressInfo?.executionDetails?.minimumAmountOut
                },

                dexUsed: params.tradeResult.affectedDex,
                slippageActual: this.calculateActualSlippage(params) || 0,

                // Trade state (existing)
                status: params.executionResult?.state === 'Confirmed' ? 'completed' :
                    params.executionResult?.state === 'Failed' ? 'failed' : 'pending',
                errorMessage: params.executionResult?.error || params.tradeResult.error,

                // Matching info (existing)
                isEntry,
                tokenPair,
                baseToken,
                quoteToken,

                // Webhook context (existing)
                webhookId: params.webhookId,
                signalType: this.mapSignalType(params.webhookData.side),

                // 🔧 ENHANCED: Metadata with network context
                metadata: {
                    webhookReceived: finalSignalTimestamp,
                    tradeExecuted: finalExecutionTimestamp,
                    processingDelay: signalToExecutionDelayMs,
                    networkSwitched: false, // TODO: Implement network switching detection
                    crossChainTrade: false  // TODO: Implement cross-chain detection
                }
            };

            await this.storeTrade(trade);
            await this.attemptTradeMatching();

            logger.info('🔧 Network-aware trade recorded successfully', {
                tradeId: trade.tradeId,
                network: networkContext.network,
                signalTime: signalTimestampCDT,
                executionTime: executionTimestampCDT,
                processingDelay: `${signalToExecutionDelayMs.toFixed(0)}ms`,
                isEntry: trade.isEntry,
                tokenPair: trade.tokenPair,
                amountUSDC: amounts.amountUSDC.toFixed(4),
                entryAmount: amounts.entryAmount,
                gasCostUSDC: gasCostData.gasCostUSDC.toFixed(6),
                gasCostNative: gasCostData.gasCostNative.toFixed(6),
                nativeCurrency: networkContext.nativeCurrency
            });
            return tradeId;
        } catch (error) {
            logger.error('Failed to record network-aware trade', {
                error: error instanceof Error ? error.message : String(error),
                webhookId: params.webhookId,
                network: params.networkContext?.network || 'unknown',
                tradeDirection: params.tradeDirection
            });
            throw error;
        }
    }
    private formatDurationEnhanced(durationMs: number): string {
        if (durationMs < 1000) {
            // Show milliseconds for sub-second durations
            return `${Math.round(durationMs)}ms`;
        }

        const seconds = Math.floor(durationMs / 1000);
        if (seconds < 60) {
            return `${seconds}s`;
        }

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;

        if (minutes < 60) {
            return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
        }

        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }
    /**
     * Calculate actual slippage based on expected vs actual output
     */
    private calculateActualSlippage(params: any): number {
        try {
            const expectedOutput = params.tradeResult.expectedAmountOut;
            const actualOutput = params.tradeResult.actualAmountOut;

            if (!expectedOutput || !actualOutput) return 0;

            const expected = parseFloat(expectedOutput);
            const actual = parseFloat(actualOutput);

            if (expected === 0) return 0;

            // Calculate slippage percentage: (expected - actual) / expected * 100
            const slippagePercent = ((expected - actual) / expected) * 100;
            return Math.max(0, slippagePercent); // Return 0 if negative (better than expected)
        } catch (error) {
            logger.warn('Failed to calculate actual slippage', {
                error: error instanceof Error ? error.message : String(error)
            });
            return 0;
        }
    }
    // ==================== 🔧 NEW NETWORK-AWARE HELPER METHODS ====================

    /**
     * Parse network context from webhook data
     */
    private parseNetworkFromWebhook(webhookData: {
        network: string;
        [key: string]: any;
    }): {
        network: NetworkKey;
        networkName: string;
        chainId: number;
        nativeCurrency: string;
    } {
        const networkString = webhookData.network?.toLowerCase();

        // Network mapping
        const networkMap: Record<string, NetworkKey> = {
            'avalanche': 'AVALANCHE',
            'arbitrum': 'ARBITRUM',
            'arbitrum one': 'ARBITRUM',
            'arb': 'ARBITRUM',
            'avax': 'AVALANCHE',
            'avax-c': 'AVALANCHE'
        };

        const networkKey = networkMap[networkString] || 'AVALANCHE'; // Safe default
        const networkConfig = SUPPORTED_NETWORKS[networkKey];

        return {
            network: networkKey,
            networkName: networkConfig.name,
            chainId: networkConfig.chainId,
            nativeCurrency: networkConfig.nativeCurrency
        };
    }

    /**
     * Calculate network-aware gas costs
     */
    private async calculateNetworkAwareGasCost(params: any, network: NetworkKey): Promise<{
        gasCostUSDC: number;
        gasCostNative: number;
        nativePriceUSDC: number;
    }> {
        try {
            // 🔧 FIX: Get real-time network-specific price
            let nativePriceUSDC: number;
            if (network === 'ARBITRUM') {
                const { wethPriceQuoter } = await import('./wethPriceQuoter.ts');
                nativePriceUSDC = await wethPriceQuoter.getPrice();
            } else if (network === 'AVALANCHE') {
                const { wavaxPriceQuoter } = await import('./wavaxPriceQuoter.ts');
                nativePriceUSDC = await wavaxPriceQuoter.getPrice();
            } else {
                const networkConfig = getNetworkConfig(network);
                nativePriceUSDC = networkConfig.gasConfig.NATIVE_PRICE_IN_USDC;
            }

            // Extract gas information
            const gasUsed = parseFloat(params.executionResult?.gasUsed || params.tradeResult?.gasUsed || '150000');
            const gasPrice = parseFloat(params.executionResult?.effectiveGasPrice || params.tradeResult?.effectiveGasPrice || '25000000000');

            // Calculate costs
            const gasCostWei = gasUsed * gasPrice;
            const gasCostNative = gasCostWei / 1e18;
            const gasCostUSDC = gasCostNative * nativePriceUSDC;

            logger.debug('Network-aware gas cost calculated', {
                network,
                gasUsed,
                gasPrice: (gasPrice / 1e9).toFixed(2) + ' Gwei',
                gasCostNative: gasCostNative.toFixed(6),
                nativePriceUSDC: nativePriceUSDC.toFixed(2),
                gasCostUSDC: gasCostUSDC.toFixed(6),
                nativeCurrency: SUPPORTED_NETWORKS[network].nativeCurrency
            });

            return {
                gasCostUSDC,
                gasCostNative,
                nativePriceUSDC
            };
        } catch (error) {
            logger.error('Error calculating network-aware gas cost', {
                error: error instanceof Error ? error.message : String(error),
                network
            });

            // Fallback calculation
            const networkConfig = getNetworkConfig(network);
            const fallbackPrice = networkConfig.gasConfig.NATIVE_PRICE_IN_USDC;
            const fallbackGasCost = 0.01; // Conservative fallback

            return {
                gasCostUSDC: fallbackGasCost,
                gasCostNative: fallbackGasCost / fallbackPrice,
                nativePriceUSDC: fallbackPrice
            };
        }
    }

    /**
     * 🔧 ENHANCED: Create completed trade with network awareness
     */
    private async createCompletedTrade(tradeA: TradeEntry, tradeB: TradeEntry): Promise<CompletedTrade> {
        // Normalize entries for compatibility
        const normalizedTradeA = this.normalizeTradeEntry(tradeA);
        const normalizedTradeB = this.normalizeTradeEntry(tradeB);

        // Determine chronological order
        const isTradeAFirst = normalizedTradeA.signalTimestamp <= normalizedTradeB.signalTimestamp;
        const firstTrade = isTradeAFirst ? normalizedTradeA : normalizedTradeB;
        const secondTrade = isTradeAFirst ? normalizedTradeB : normalizedTradeA;

        // Determine entry/exit with null checks
        const entryLeg = normalizedTradeA.isEntry ? normalizedTradeA : normalizedTradeB;
        const exitLeg = normalizedTradeA.isEntry ? normalizedTradeB : normalizedTradeA;

        // 🔧 NEW: Detect cross-network trading
        const isCrossNetwork = entryLeg.network !== exitLeg.network;
        const networksUsed = Array.from(new Set([entryLeg.network, exitLeg.network]));
        const primaryNetwork = entryLeg.network; // Use entry network as primary

        logger.info('🔧 Creating network-aware completed trade', {
            entryNetwork: entryLeg.network,
            exitNetwork: exitLeg.network,
            isCrossNetwork,
            networksUsed,
            primaryNetwork
        });

        // Financial calculations
        const entryAmountUSDC = this.safeToNumber(entryLeg.amountUSDC);
        const exitAmountUSDC = this.safeToNumber(exitLeg.amountUSDC);
        // Validate amounts before calculation
        if (entryAmountUSDC <= 0 || exitAmountUSDC <= 0) {
            logger.warn('🔧 Invalid trade amounts in completed trade calculation', {
                entryAmount: entryAmountUSDC,
                exitAmount: exitAmountUSDC,
                entryLegId: entryLeg.tradeId,
                exitLegId: exitLeg.tradeId,
                entryLegEntryAmount: entryLeg.entryAmount,
                exitLegEntryAmount: exitLeg.entryAmount
            });
        }
        const grossProfitUSDC = exitAmountUSDC - entryAmountUSDC;

        const entryGasCostUSDC = entryLeg.gasCostUSDC || 0;
        const exitGasCostUSDC = exitLeg.gasCostUSDC || 0;
        const gasCostUSDC = entryGasCostUSDC + exitGasCostUSDC;

        // 🔧 NEW: Calculate network-aware gas costs in native currencies
        const entryGasCostNative = entryLeg.gasCostNative || 0;
        const exitGasCostNative = exitLeg.gasCostNative || 0;
        const gasCostNative = entryGasCostNative + exitGasCostNative;

        const netProfitUSDC = grossProfitUSDC - gasCostUSDC;
        const profitPercentage = entryAmountUSDC > 0 ? (netProfitUSDC / entryAmountUSDC) * 100 : 0;

        // 🔧 FIX: Calculate actual vs expected differences using only available TradeEntry properties
        const getExpectedProfit = (): number => {
            // Use the expectedOutput values from entry and exit legs
            // For a round-trip trade: buy USDC->Token, then sell Token->USDC

            // Entry leg: we spend amountUSDC, expect to get expectedOutput tokens
            // Exit leg: we spend tokens, expect to get expectedOutput USDC back

            try {
                // Parse expected outputs
                const entryExpectedOutput = parseFloat(entryLeg.expectedOutput || '0');
                const exitExpectedOutput = parseFloat(exitLeg.expectedOutput || '0');

                // For profit calculation:
                // Expected profit = what we expect to get back (USDC) - what we put in (USDC)
                const entryAmountUSDC = entryLeg.amountUSDC || 0;

                // If this is a sell trade (Token->USDC), expectedOutput should be in USDC
                if (exitLeg.tradeDirection?.includes('_TO_USDC')) {
                    return exitExpectedOutput - entryAmountUSDC;
                }

                // Default case: assume break-even if we can't determine expected profit
                logger.debug('🔧 Cannot determine expected profit - using default 0', {
                    entryExpectedOutput,
                    exitExpectedOutput,
                    entryAmountUSDC,
                    exitTradeDirection: exitLeg.tradeDirection
                });

                return 0;

            } catch (error) {
                logger.warn('🔧 Error calculating expected profit', {
                    error: error instanceof Error ? error.message : String(error),
                    entryExpectedOutput: entryLeg.expectedOutput,
                    exitExpectedOutput: exitLeg.expectedOutput
                });
                return 0;
            }
        };
        // 🔧 FIX: Calculate actual vs expected differences
        const expectedGrossProfitUSDC = getExpectedProfit();
        const actualVsExpectedDifference = grossProfitUSDC - expectedGrossProfitUSDC;

        let actualVsExpectedPercent = 0;
        if (expectedGrossProfitUSDC !== 0) {
            actualVsExpectedPercent = ((grossProfitUSDC - expectedGrossProfitUSDC) / Math.abs(expectedGrossProfitUSDC)) * 100;
        }

        logger.debug('🔧 Actual vs Expected Analysis', {
            tradeId: entryLeg.tradeId,
            actualGrossProfit: grossProfitUSDC,
            expectedGrossProfit: expectedGrossProfitUSDC,
            difference: actualVsExpectedDifference,
            percentDifference: actualVsExpectedPercent
        });

        // Timing calculations (existing logic)
        const signalDurationMs = Math.max(0, (secondTrade.signalTimestamp - firstTrade.signalTimestamp) * 1000);
        const signalDurationFormatted = this.formatDurationEnhanced(signalDurationMs);
        const executionDurationMs = secondTrade.executionTimestamp - firstTrade.executionTimestamp;
        const avgProcessingDelaySeconds = ((entryLeg.processingDelayMs || 0) + (exitLeg.processingDelayMs || 0)) / 2 / 1000;
        const totalProcessingTimeSeconds = ((entryLeg.processingDelayMs || 0) + (exitLeg.processingDelayMs || 0)) / 1000;

        logger.info('🔧 Completed trade calculation summary', {
            entryAmount: entryAmountUSDC,
            exitAmount: exitAmountUSDC,
            grossProfit: grossProfitUSDC,
            expectedProfit: expectedGrossProfitUSDC,
            actualVsExpectedDiff: actualVsExpectedDifference,
            actualVsExpectedPercent: actualVsExpectedPercent,
            gasCosts: gasCostUSDC,
            netProfit: netProfitUSDC,
            profitPercent: profitPercentage.toFixed(2) + '%',
            duration: signalDurationFormatted,
            primaryNetwork
        });
        // Date formatting
        const entrySignalDateCDT = formatCDTTimestamp(firstTrade.signalTimestamp);
        const exitSignalDateCDT = formatCDTTimestamp(secondTrade.signalTimestamp);
        const entryExecutionDateCDT = formatCDTTimestamp(firstTrade.executionTimestamp);
        const exitExecutionDateCDT = formatCDTTimestamp(secondTrade.executionTimestamp);

        // 🔧 NEW: Network cost analysis
        const averageNativePrice = ((entryLeg.nativePriceUSDC || 0) + (exitLeg.nativePriceUSDC || 0)) / 2;
        const networkCostAnalysis = {
            averageNativePrice,
            networkEfficiencyScore: this.calculateNetworkEfficiencyScore(entryLeg, exitLeg),
            gasCostComparison: isCrossNetwork ? this.buildGasCostComparison(entryLeg, exitLeg) : undefined
        };

        // 🔧 ENHANCED: Address summary with network context
        const routersUsed = [
            entryLeg.protocolAddresses?.routerAddress,
            exitLeg.protocolAddresses?.routerAddress
        ].filter((router): router is string => Boolean(router) && typeof router === 'string');

        const poolsUsed = [
            entryLeg.protocolAddresses?.poolAddress,
            exitLeg.protocolAddresses?.poolAddress
        ].filter((pool): pool is string => Boolean(pool) && typeof pool === 'string');

        const addressSummary = {
            tokenPair: entryLeg.tokenPair,
            entryTokens: {
                input: entryLeg.inputToken?.address || entryLeg.tokenAddresses?.inputToken?.address,
                output: entryLeg.outputToken?.address || entryLeg.tokenAddresses?.outputToken?.address
            },
            exitTokens: {
                input: exitLeg.inputToken?.address || exitLeg.tokenAddresses?.inputToken?.address,
                output: exitLeg.outputToken?.address || exitLeg.tokenAddresses?.outputToken?.address
            },
            routersUsed: [...new Set(routersUsed)],
            poolsUsed: [...new Set(poolsUsed)],
            totalUniqueAddresses: new Set([...routersUsed, ...poolsUsed]).size,
            networkSpecific: !isCrossNetwork,
            crossNetworkAddresses: isCrossNetwork ? {
                [entryLeg.network]: {
                    routers: [entryLeg.protocolAddresses?.routerAddress].filter(Boolean) as string[],
                    pools: [entryLeg.protocolAddresses?.poolAddress].filter(Boolean) as string[]
                },
                [exitLeg.network]: {
                    routers: [exitLeg.protocolAddresses?.routerAddress].filter(Boolean) as string[],
                    pools: [exitLeg.protocolAddresses?.poolAddress].filter(Boolean) as string[]
                }
            } : undefined
        };

        // 🔧 ENHANCED: Gas analysis with network awareness
        const gasEfficiency = entryAmountUSDC > 0 ? (gasCostUSDC / entryAmountUSDC) * 100 : 0;
        const primaryNetworkConfig = getNetworkConfig(primaryNetwork);

        const gasAnalysis = {
            entryGasCostUSDC,
            exitGasCostUSDC,
            totalGasCostUSDC: gasCostUSDC,
            gasEfficiency,
            avgGasPriceGwei: this.calculateAverageGasPrice(entryLeg, exitLeg),
            networkGasAnalysis: {
                network: primaryNetwork,
                nativeCurrency: primaryNetworkConfig.network.nativeCurrency,
                entryGasCostNative,
                exitGasCostNative,
                totalGasCostNative: gasCostNative,
                averageNativePrice,
                gasStrategy: primaryNetwork === 'ARBITRUM' ? 'L2_OPTIMIZED' : 'L1_STANDARD',
                l2Optimizations: primaryNetwork === 'ARBITRUM' ? {
                    feeSavingsVsL1: this.calculateL2Savings(gasCostUSDC),
                    speedImprovementVsL1: this.calculateL2SpeedImprovement(executionDurationMs)
                } : undefined
            }
        };

        const tradePairId = `pair_${entryLeg.tradeId}_${exitLeg.tradeId}`;

        // 🔧 ENHANCED: Build completed trade with network awareness
        const completedTrade: CompletedTrade = {
            tradeId: `${entryLeg.tradeId}-${exitLeg.tradeId}`,
            tradePairId,

            // 🔧 NEW: Network context
            network: primaryNetwork,
            networkName: primaryNetworkConfig.network.name,
            chainId: primaryNetworkConfig.network.chainId,
            nativeCurrency: primaryNetworkConfig.network.nativeCurrency,
            isCrossNetwork,
            networksUsed,

            entryLeg,
            exitLeg,

            // Timing (existing)
            signalDurationMs,
            signalDurationFormatted: this.formatDuration(signalDurationMs),
            executionDurationMs,
            executionDurationFormatted: this.formatDuration(executionDurationMs),
            tradeDurationMs: signalDurationMs,
            tradeDurationFormatted: this.formatDuration(signalDurationMs),
            avgSignalToExecutionDelay: avgProcessingDelaySeconds,
            totalProcessingTime: totalProcessingTimeSeconds,

            // Dates (existing)
            entrySignalCDT: entrySignalDateCDT,
            exitSignalCDT: exitSignalDateCDT,
            entryExecutionCDT: entryExecutionDateCDT,
            exitExecutionCDT: exitExecutionDateCDT,
            entryDateCDT: entrySignalDateCDT,
            exitDateCDT: exitSignalDateCDT,

            // Financial data (enhanced)
            grossProfitUSDC,
            gasCostUSDC,
            gasCostNative,
            netProfitUSDC,
            profitPercentage,
            expectedGrossProfitUSDC,  // 🔧 FIXED: Now uses actual expected profit
            actualVsExpectedDifference,  // 🔧 FIXED: Now calculated properly
            actualVsExpectedPercent,     // 🔧 FIXED: Now calculated properly
            totalSlippageImpact: (entryLeg.slippageActual || 0) + (exitLeg.slippageActual || 0),

            // 🔧 NEW: Network cost analysis
            networkCostAnalysis,

            // Performance (existing)
            priceImpactTotal: (entryLeg.priceImpact || 0) + (exitLeg.priceImpact || 0),
            executionEfficiency: this.calculateExecutionEfficiency(entryLeg, exitLeg),

            // Enhanced structures
            addressSummary,
            gasAnalysis,

            // Completion details (existing)
            completedTimestamp: getCurrentTimestamp(),
            completedTimestampCDT: formatCDTTimestamp(getCurrentTimestamp()),
            completedDate: new Date().toISOString(),

            // Classification (existing)
            tradeCategory: netProfitUSDC > 0.01 ? 'profitable' : netProfitUSDC < -0.01 ? 'loss' : 'breakeven',
            exitReason: this.determineExitReason(exitLeg.signal || exitLeg.signalType),

            // 🔧 ENHANCED: Summary with network context
            summary: `${entryLeg.tokenPair} on ${primaryNetworkConfig.network.name}: ${netProfitUSDC > 0 ? '+' : ''}${netProfitUSDC.toFixed(4)} USDC (${profitPercentage.toFixed(2)}%) in ${this.formatDuration(signalDurationMs)}${isCrossNetwork ? ' [Cross-Network]' : ''}`
        };

        logger.info('🔧 Network-aware completed trade created', {
            tradePairId,
            primaryNetwork,
            isCrossNetwork,
            networksUsed,
            entryAmount: entryAmountUSDC,
            exitAmount: exitAmountUSDC,
            grossProfit: grossProfitUSDC,
            expectedProfit: expectedGrossProfitUSDC,
            actualVsExpectedDiff: actualVsExpectedDifference,
            actualVsExpectedPercent: actualVsExpectedPercent,
            netProfit: netProfitUSDC,
            gasCostUSDC: gasCostUSDC.toFixed(6),
            gasCostNative: gasCostNative.toFixed(6),
            nativeCurrency: primaryNetworkConfig.network.nativeCurrency
        });

        return completedTrade;
    }

    // ==================== 🔧 NEW NETWORK-SPECIFIC CALCULATION METHODS ====================

    private calculateNetworkEfficiencyScore(entryLeg: TradeEntry, exitLeg: TradeEntry): number {
        const entryDelay = entryLeg.signalToExecutionDelayMs || 0;
        const exitDelay = exitLeg.signalToExecutionDelayMs || 0;
        const avgDelay = (entryDelay + exitDelay) / 2;

        // Score based on execution speed (lower delay = higher score)
        const speedScore = Math.max(0, 100 - (avgDelay / 1000)); // Convert to seconds

        // Score based on gas efficiency
        const entryGasRatio = (entryLeg.gasCostUSDC || 0) / (entryLeg.amountUSDC || 1);
        const exitGasRatio = (exitLeg.gasCostUSDC || 0) / (exitLeg.amountUSDC || 1);
        const avgGasRatio = (entryGasRatio + exitGasRatio) / 2;
        const gasScore = Math.max(0, 100 - (avgGasRatio * 1000)); // Scale appropriately

        return (speedScore + gasScore) / 2;
    }

    private buildGasCostComparison(entryLeg: TradeEntry, exitLeg: TradeEntry) {
        const comparison: Record<string, any> = {};

        if (entryLeg.network) {
            comparison[entryLeg.network] = {
                gasCostUSDC: entryLeg.gasCostUSDC || 0,
                gasCostNative: entryLeg.gasCostNative || 0,
                efficiency: this.calculateLegEfficiency(entryLeg)
            };
        }

        if (exitLeg.network && exitLeg.network !== entryLeg.network) {
            comparison[exitLeg.network] = {
                gasCostUSDC: exitLeg.gasCostUSDC || 0,
                gasCostNative: exitLeg.gasCostNative || 0,
                efficiency: this.calculateLegEfficiency(exitLeg)
            };
        }

        return comparison;
    }

    private calculateLegEfficiency(leg: TradeEntry): number {
        const gasRatio = (leg.gasCostUSDC || 0) / (leg.amountUSDC || 1);
        return Math.max(0, 100 - (gasRatio * 1000));
    }

    private calculateL2Savings(gasCostUSDC: number): number {
        // Estimate L1 equivalent cost (rough approximation)
        const estimatedL1Cost = gasCostUSDC * 10; // L2 is roughly 10x cheaper
        return ((estimatedL1Cost - gasCostUSDC) / estimatedL1Cost) * 100;
    }

    private calculateL2SpeedImprovement(executionDurationMs: number): number {
        // Estimate L1 equivalent time (rough approximation)
        const estimatedL1Duration = executionDurationMs * 3; // L2 is roughly 3x faster
        return ((estimatedL1Duration - executionDurationMs) / estimatedL1Duration) * 100;
    }

    // ==================== 🔧 ENHANCED SUMMARY METHODS ====================

    /**
     * 🔧 ENHANCED: Update trade summary with network awareness
     */
    private async updateTradeSummary(completedTrade: CompletedTrade): Promise<void> {
        try {
            const summary = this.getTradeSummary();

            // Basic trade statistics (existing)
            summary.totalTrades++;
            summary.totalGrossProfit += completedTrade.grossProfitUSDC;
            summary.totalGasCosts += completedTrade.gasCostUSDC;
            summary.totalNetProfit += completedTrade.netProfitUSDC;

            // Update trade categories (existing)
            if (completedTrade.tradeCategory === 'profitable') {
                summary.profitableTrades++;
            } else if (completedTrade.tradeCategory === 'loss') {
                summary.losingTrades++;
            } else {
                summary.breakevenTrades++;
            }

            // Update averages and rates (existing)
            summary.winRate = summary.totalTrades > 0 ? (summary.profitableTrades / summary.totalTrades) * 100 : 0;
            summary.averageProfit = summary.totalTrades > 0 ? summary.totalNetProfit / summary.totalTrades : 0;
            summary.averageGasCost = summary.totalTrades > 0 ? summary.totalGasCosts / summary.totalTrades : 0;

            // 🔧 NEW: Update network-specific summary
            const network = completedTrade.network;
            if (!summary.networkSummary[network]) {
                summary.networkSummary[network] = {
                    totalTrades: 0,
                    profitableTrades: 0,
                    totalNetProfit: 0,
                    averageProfit: 0,
                    winRate: 0,
                    totalGasCosts: 0,
                    averageGasCost: 0,
                    nativeCurrency: completedTrade.nativeCurrency,
                    averageTradeDuration: 0
                };
            }

            const networkSummary = summary.networkSummary[network];
            if (networkSummary) {
                networkSummary.totalTrades++;
                networkSummary.totalNetProfit += completedTrade.netProfitUSDC;
                networkSummary.totalGasCosts += completedTrade.gasCostUSDC;
                if (completedTrade.tradeCategory === 'profitable') {
                    networkSummary.profitableTrades++;
                }
                networkSummary.winRate = (networkSummary.profitableTrades / networkSummary.totalTrades) * 100;
                networkSummary.averageProfit = networkSummary.totalNetProfit / networkSummary.totalTrades;
                networkSummary.averageGasCost = networkSummary.totalGasCosts / networkSummary.totalTrades;
            }

            // 🔧 NEW: Update cross-network analytics
            summary.crossNetworkAnalytics.networkDistribution[network] =
                (summary.crossNetworkAnalytics.networkDistribution[network] || 0) + 1;

            if (completedTrade.isCrossNetwork) {
                summary.crossNetworkAnalytics.totalCrossNetworkTrades++;
            }

            // Update gas cost comparison per network
            if (!summary.crossNetworkAnalytics.gasCostComparison[network]) {
                summary.crossNetworkAnalytics.gasCostComparison[network] = {
                    totalTrades: 0,
                    averageGasCostUSDC: 0,
                    averageGasCostNative: 0,
                    averageNativePrice: 0
                };
            }

            const gasCostComparison = summary.crossNetworkAnalytics.gasCostComparison[network];
            if (gasCostComparison) {
                const prevTotalTrades = gasCostComparison.totalTrades;
                gasCostComparison.totalTrades++;
                gasCostComparison.averageGasCostUSDC =
                    (gasCostComparison.averageGasCostUSDC * prevTotalTrades + completedTrade.gasCostUSDC) / gasCostComparison.totalTrades;
                gasCostComparison.averageGasCostNative =
                    (gasCostComparison.averageGasCostNative * prevTotalTrades + completedTrade.gasCostNative) / gasCostComparison.totalTrades;
                gasCostComparison.averageNativePrice =
                    (gasCostComparison.averageNativePrice * prevTotalTrades + completedTrade.networkCostAnalysis.averageNativePrice) / gasCostComparison.totalTrades;
            }

            // Timing statistics (existing logic)
            const signalDurationMinutes = (completedTrade.signalDurationMs || completedTrade.tradeDurationMs || 0) / (1000 * 60);
            if (summary.totalTrades === 1) {
                summary.averageTradeDuration = signalDurationMinutes;
                summary.longestTrade = signalDurationMinutes;
                summary.shortestTrade = signalDurationMinutes;
                if (networkSummary) {
                    networkSummary.averageTradeDuration = signalDurationMinutes;
                }
            } else {
                summary.averageTradeDuration = (summary.averageTradeDuration * (summary.totalTrades - 1) + signalDurationMinutes) / summary.totalTrades;
                summary.longestTrade = Math.max(summary.longestTrade, signalDurationMinutes);
                summary.shortestTrade = Math.min(summary.shortestTrade, signalDurationMinutes);
                if (networkSummary) {
                    networkSummary.averageTradeDuration = (networkSummary.averageTradeDuration * (networkSummary.totalTrades - 1) + signalDurationMinutes) / networkSummary.totalTrades;
                }
            }

            // Enhanced tracking (existing)
            summary.totalExpectedProfit += completedTrade.expectedGrossProfitUSDC || 0;
            summary.totalActualVsExpectedDiff += completedTrade.actualVsExpectedDifference || 0;
            summary.averageSlippageImpact = summary.totalTrades > 0 ?
                (summary.averageSlippageImpact * (summary.totalTrades - 1) + (completedTrade.totalSlippageImpact || 0)) / summary.totalTrades : 0;
            summary.executionEfficiencyAvg = summary.totalTrades > 0 ?
                (summary.executionEfficiencyAvg * (summary.totalTrades - 1) + (completedTrade.executionEfficiency || 1.0)) / summary.totalTrades : 1.0;

            // Token performance (enhanced with network breakdown)
            const tokenSymbol = completedTrade.entryLeg.baseToken;
            if (!summary.tokenPerformance[tokenSymbol]) {
                summary.tokenPerformance[tokenSymbol] = {
                    trades: 0,
                    netProfit: 0,
                    winRate: 0,
                    gasUsage: 0,
                    averageTradeSize: 0,
                    tokenAddress: completedTrade.entryLeg.tokenAddresses?.inputToken?.address ||
                        completedTrade.entryLeg.inputToken?.address || 'Unknown',
                    networkBreakdown: {} as Partial<Record<NetworkKey, {
                        trades: number;
                        netProfit: number;
                        gasUsage: number;
                    }>>
                };
            }

            const tokenPerf = summary.tokenPerformance[tokenSymbol];
            tokenPerf.trades += 1;
            tokenPerf.netProfit += completedTrade.netProfitUSDC;
            tokenPerf.gasUsage += completedTrade.gasCostUSDC;

            // Update network breakdown for token
            if (!tokenPerf.networkBreakdown![network]) {
                tokenPerf.networkBreakdown![network] = {
                    trades: 0,
                    netProfit: 0,
                    gasUsage: 0
                };
            }
            tokenPerf.networkBreakdown![network].trades++;
            tokenPerf.networkBreakdown![network].netProfit += completedTrade.netProfitUSDC;
            tokenPerf.networkBreakdown![network].gasUsage += completedTrade.gasCostUSDC;

            const entryAmountNum = parseFloat(completedTrade.entryLeg.entryAmount || '0');
            if (entryAmountNum > 0) {
                tokenPerf.averageTradeSize = (tokenPerf.averageTradeSize * (tokenPerf.trades - 1) + entryAmountNum) / tokenPerf.trades;
            }

            // Calculate token win rate across all networks
            const allCompletedTrades = this.getCompletedTrades();
            const tokenTrades = allCompletedTrades.filter(t => t.entryLeg.baseToken === tokenSymbol);
            const tokenProfitableTrades = tokenTrades.filter(t => t.tradeCategory === 'profitable').length;
            tokenPerf.winRate = tokenTrades.length > 0 ? (tokenProfitableTrades / tokenTrades.length) * 100 : 0;

            // Protocol analytics (enhanced with network context)
            this.updateNetworkProtocolAnalytics(summary, completedTrade, allCompletedTrades);

            // Daily/weekly/monthly tracking (existing + network-specific)
            const tradeDate = new Date(completedTrade.completedTimestamp * 1000);
            const dateKey = tradeDate.toISOString().split('T')[0];
            const weekKey = `${tradeDate.getFullYear()}-W${this.getWeekNumber(tradeDate)}`;
            const monthKey = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, '0')}`;

            if (!summary.daily[dateKey]) summary.daily[dateKey] = 0;
            summary.daily[dateKey] += completedTrade.netProfitUSDC;

            if (!summary.weekly[weekKey]) summary.weekly[weekKey] = 0;
            summary.weekly[weekKey] += completedTrade.netProfitUSDC;

            if (!summary.monthly[monthKey]) summary.monthly[monthKey] = 0;
            summary.monthly[monthKey] += completedTrade.netProfitUSDC;

            // 🔧 NEW: Daily tracking by network
            if (!summary.dailyByNetwork[network]) {
                summary.dailyByNetwork[network] = {};
            }
            if (!summary.dailyByNetwork[network][dateKey]) {
                summary.dailyByNetwork[network][dateKey] = 0;
            }
            summary.dailyByNetwork[network][dateKey] += completedTrade.netProfitUSDC;

            // Update timestamps
            summary.lastUpdated = getCurrentTimestamp();
            summary.lastUpdatedCDT = this.formatCDTTimestamp(summary.lastUpdated);

            // Save updated summary
            fs.writeFileSync(this.summaryFile, this.safeJsonStringify(summary));

            logger.info('🔧 Network-aware trade summary updated', {
                totalTrades: summary.totalTrades,
                network,
                networkTrades: networkSummary.totalTrades,
                totalNetProfit: summary.totalNetProfit.toFixed(4),
                networkNetProfit: networkSummary.totalNetProfit.toFixed(4),
                winRate: summary.winRate.toFixed(2) + '%',
                networkWinRate: networkSummary.winRate.toFixed(2) + '%',
                isCrossNetwork: completedTrade.isCrossNetwork
            });

        } catch (error) {
            logger.error('Failed to update network-aware trade summary', {
                error: error instanceof Error ? error.message : String(error),
                completedTradeId: completedTrade.tradePairId,
                network: completedTrade.network
            });
            throw error;
        }
    }

    /**
     * 🔧 NEW: Update network-specific protocol analytics
     */
    private updateNetworkProtocolAnalytics(summary: TradeSummary, completedTrade: CompletedTrade, allTrades: CompletedTrade[]): void {
        try {
            // Overall protocol analytics (existing logic)
            const allTokens = new Set<string>();
            const allPools = new Set<string>();
            const allRouters = new Set<string>();
            const routerUsage: Record<string, number> = {};
            const tokenPairUsage: Record<string, number> = {};

            // 🔧 NEW: Network-specific analytics
            const networkAnalytics: Record<NetworkKey, any> = {
                AVALANCHE: { tokens: new Set(), pools: new Set(), routers: new Set(), routerUsage: {}, tokenPairUsage: {} },
                ARBITRUM: { tokens: new Set(), pools: new Set(), routers: new Set(), routerUsage: {}, tokenPairUsage: {} }
            };

            for (const trade of allTrades) {
                const network = trade.network;

                // Overall tracking (existing)
                if (trade.entryLeg.tokenAddresses?.inputToken?.address) {
                    allTokens.add(trade.entryLeg.tokenAddresses.inputToken.address);
                }
                if (trade.entryLeg.tokenAddresses?.outputToken?.address) {
                    allTokens.add(trade.entryLeg.tokenAddresses.outputToken.address);
                }

                // Network-specific tracking
                if (network && networkAnalytics[network]) {
                    const netAnalytics = networkAnalytics[network];

                    if (trade.entryLeg.tokenAddresses?.inputToken?.address) {
                        netAnalytics.tokens.add(trade.entryLeg.tokenAddresses.inputToken.address);
                    }
                    if (trade.entryLeg.tokenAddresses?.outputToken?.address) {
                        netAnalytics.tokens.add(trade.entryLeg.tokenAddresses.outputToken.address);
                    }

                    if (trade.entryLeg.protocolAddresses?.poolAddress) {
                        allPools.add(trade.entryLeg.protocolAddresses.poolAddress);
                        netAnalytics.pools.add(trade.entryLeg.protocolAddresses.poolAddress);
                    }

                    const entryRouter = trade.entryLeg.protocolAddresses?.routerAddress;
                    if (entryRouter) {
                        allRouters.add(entryRouter);
                        netAnalytics.routers.add(entryRouter);
                        routerUsage[entryRouter] = (routerUsage[entryRouter] || 0) + 1;
                        netAnalytics.routerUsage[entryRouter] = (netAnalytics.routerUsage[entryRouter] || 0) + 1;
                    }

                    const tokenPair = trade.entryLeg.tokenPair;
                    tokenPairUsage[tokenPair] = (tokenPairUsage[tokenPair] || 0) + 1;
                    netAnalytics.tokenPairUsage[tokenPair] = (netAnalytics.tokenPairUsage[tokenPair] || 0) + 1;
                }
            }

            // Update overall analytics (existing)
            summary.protocolAnalytics.totalUniqueTokens = allTokens.size;
            summary.protocolAnalytics.totalUniquePools = allPools.size;
            summary.protocolAnalytics.totalUniqueRouters = allRouters.size;

            const mostUsedRouterEntry = Object.entries(routerUsage).reduce((a, b) => a[1] > b[1] ? a : b, ['N/A', 0]);
            summary.protocolAnalytics.mostUsedRouter = mostUsedRouterEntry[0];

            const mostTradedPairEntry = Object.entries(tokenPairUsage).reduce((a, b) => a[1] > b[1] ? a : b, ['N/A', 0]);
            summary.protocolAnalytics.mostTradedTokenPair = mostTradedPairEntry[0];

            summary.protocolAnalytics.averageGasPerTrade = summary.averageGasCost;

            // 🔧 NEW: Update network-specific protocol analytics
            for (const [networkKey, analytics] of Object.entries(networkAnalytics)) {
                const network = networkKey as NetworkKey;
                summary.protocolAnalytics.networkProtocolAnalytics[network] = {
                    uniqueTokens: analytics.tokens.size,
                    uniquePools: analytics.pools.size,
                    uniqueRouters: analytics.routers.size,
                    mostUsedRouter: Object.keys(analytics.routerUsage).length > 0 ?
                        (Object.entries(analytics.routerUsage) as [string, number][]).reduce((a, b) => a[1] > b[1] ? a : b)[0] : 'N/A',
                    mostTradedPair: Object.keys(analytics.tokenPairUsage).length > 0 ?
                        (Object.entries(analytics.routerUsage) as [string, number][]).reduce((a, b) => a[1] > b[1] ? a : b)[0] : 'N/A',
                    averageGasPerTrade: summary.networkSummary[network]?.averageGasCost || 0
                };
            }

            // Calculate gas efficiency trend (existing)
            if (allTrades.length >= 6) {
                const recentTrades = allTrades.slice(-3);
                const olderTrades = allTrades.slice(0, 3);

                const recentAvgGas = recentTrades.reduce((sum, t) => sum + t.gasCostUSDC, 0) / recentTrades.length;
                const olderAvgGas = olderTrades.reduce((sum, t) => sum + t.gasCostUSDC, 0) / olderTrades.length;

                summary.protocolAnalytics.gasEfficiencyTrend = olderAvgGas > 0 ?
                    ((olderAvgGas - recentAvgGas) / olderAvgGas) * 100 : 0;
            } else {
                summary.protocolAnalytics.gasEfficiencyTrend = 0;
            }

        } catch (error) {
            logger.warn('Failed to update network protocol analytics', {
                error: error instanceof Error ? error.message : String(error),
                network: completedTrade.network
            });

            // Fallback analytics
            summary.protocolAnalytics = {
                totalUniqueTokens: 0,
                totalUniquePools: 0,
                totalUniqueRouters: 0,
                mostUsedRouter: 'Unknown',
                mostTradedTokenPair: 'Unknown',
                averageGasPerTrade: summary.averageGasCost,
                gasEfficiencyTrend: 0,
                networkProtocolAnalytics: {
                    AVALANCHE: {
                        uniqueTokens: 0, uniquePools: 0, uniqueRouters: 0,
                        mostUsedRouter: 'N/A', mostTradedPair: 'N/A', averageGasPerTrade: 0
                    },
                    ARBITRUM: {
                        uniqueTokens: 0, uniquePools: 0, uniqueRouters: 0,
                        mostUsedRouter: 'N/A', mostTradedPair: 'N/A', averageGasPerTrade: 0
                    }
                }
            };
        }
    }

    /**
     * 🔧 ENHANCED: Create default summary with network support
     */
    private createDefaultSummary(): TradeSummary {
        const currentTimestamp = getCurrentTimestamp();
        return {
            lastUpdated: currentTimestamp,
            lastUpdatedCDT: formatCDTTimestamp(currentTimestamp),

            // 🔧 NEW: Network-specific summaries
            networkSummary: {},

            // Overall statistics (existing)
            totalTrades: 0,
            profitableTrades: 0,
            losingTrades: 0,
            breakevenTrades: 0,
            totalGrossProfit: 0,
            totalGasCosts: 0,
            totalNetProfit: 0,
            averageProfit: 0,
            winRate: 0,
            totalExpectedProfit: 0,
            totalActualVsExpectedDiff: 0,
            averageSlippageImpact: 0,
            executionEfficiencyAvg: 0,
            averageTradeDuration: 0,
            longestTrade: 0,
            shortestTrade: 0,
            averageGasCost: 0,

            // 🔧 NEW: Cross-network analytics
            crossNetworkAnalytics: {
                totalCrossNetworkTrades: 0,
                networkDistribution: {},
                gasCostComparison: {},
                networkEfficiencyRanking: []
            },

            // Protocol analytics (enhanced)
            protocolAnalytics: {
                totalUniqueTokens: 0,
                totalUniquePools: 0,
                totalUniqueRouters: 0,
                mostUsedRouter: 'N/A',
                mostTradedTokenPair: 'N/A',
                averageGasPerTrade: 0,
                gasEfficiencyTrend: 0,
                networkProtocolAnalytics: {
                    AVALANCHE: {
                        uniqueTokens: 0, uniquePools: 0, uniqueRouters: 0,
                        mostUsedRouter: 'N/A', mostTradedPair: 'N/A', averageGasPerTrade: 0
                    },
                    ARBITRUM: {
                        uniqueTokens: 0, uniquePools: 0, uniqueRouters: 0,
                        mostUsedRouter: 'N/A', mostTradedPair: 'N/A', averageGasPerTrade: 0
                    }
                }
            },

            tokenPerformance: {} as Record<string, TokenPerformanceData>,
            daily: {},
            weekly: {},
            monthly: {},

            // 🔧 NEW: Daily tracking by network
            dailyByNetwork: {}
        };
    }

    // ==================== EXISTING METHODS (ENHANCED WHERE NEEDED) ====================

    // Keep all existing methods but add network context to logging where appropriate

    public getActiveTrades(): TradeEntry[] {
        try {
            const data = fs.readFileSync(this.activeTradesFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.warn('Failed to read active trades, returning empty array', {
                error: error instanceof Error ? error.message : String(error)
            });
            return [];
        }
    }

    public getCompletedTrades(): CompletedTrade[] {
        try {
            const data = fs.readFileSync(this.completedTradesFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.warn('Failed to read completed trades, returning empty array', {
                error: error instanceof Error ? error.message : String(error)
            });
            return [];
        }
    }

    public getTradeSummary(): TradeSummary {
        try {
            const data = fs.readFileSync(this.summaryFile, 'utf8');
            const summary = JSON.parse(data) as TradeSummary;

            // 🔧 NEW: Ensure network-aware fields exist for backward compatibility
            if (!summary.networkSummary) {
                summary.networkSummary = {};
            }
            if (!summary.crossNetworkAnalytics) {
                summary.crossNetworkAnalytics = {
                    totalCrossNetworkTrades: 0,
                    networkDistribution: {},
                    gasCostComparison: {},
                    networkEfficiencyRanking: []
                };
            }
            if (!summary.dailyByNetwork) {
                summary.dailyByNetwork = {};
            }
            if (!summary.protocolAnalytics.networkProtocolAnalytics) {
                summary.protocolAnalytics.networkProtocolAnalytics = {
                    AVALANCHE: { uniqueTokens: 0, uniquePools: 0, uniqueRouters: 0, mostUsedRouter: 'N/A', mostTradedPair: 'N/A', averageGasPerTrade: 0 },
                    ARBITRUM: { uniqueTokens: 0, uniquePools: 0, uniqueRouters: 0, mostUsedRouter: 'N/A', mostTradedPair: 'N/A', averageGasPerTrade: 0 }
                };
            }

            return summary;
        } catch (error) {
            logger.warn('Failed to read trade summary, returning default', {
                error: error instanceof Error ? error.message : String(error)
            });
            this.verifyFileSystem();
            return this.createDefaultSummary();
        }
    }

    // All other existing methods remain the same but with enhanced logging...
    // [Include all existing helper methods with network context in logs where appropriate]

    // ==================== EXISTING HELPER METHODS (KEEP UNCHANGED) ====================

    private extractActualOutput(tradeResult: any, webhookData: any): string {
        // [Keep existing implementation]
        if (tradeResult?.actualAmountOut && tradeResult.actualAmountOut !== '0') {
            return tradeResult.actualAmountOut;
        }
        if (tradeResult?.amountOut && tradeResult.amountOut !== '0') {
            return tradeResult.amountOut;
        }
        if (tradeResult?.trade?._outputAmount) {
            const outputAmount = tradeResult.trade._outputAmount;
            if (outputAmount.numerator && outputAmount.denominator) {
                const rawAmount = outputAmount.numerator[0] / outputAmount.denominator[0];
                const decimals = outputAmount.currency?.decimals || 6;
                const amount = rawAmount / Math.pow(10, decimals);
                if (!isNaN(amount) && amount > 0) {
                    return amount.toString();
                }
            }
        }
        return '0';
    }

    private extractTradeAmountUSDC(params: any, isEntry: boolean): number {
        // [Keep existing implementation]
        try {
            if (isEntry) {
                if (params.tradeResult?.actualAmountIn) {
                    const amount = parseFloat(params.tradeResult.actualAmountIn);
                    if (!isNaN(amount) && amount > 0) {
                        return amount;
                    }
                }
            } else {
                if (params.tradeResult?.actualAmountOut) {
                    const amount = parseFloat(params.tradeResult.actualAmountOut);
                    if (!isNaN(amount) && amount > 1) {
                        return amount;
                    }
                }
            }
            return 0;
        } catch (error) {
            logger.error('Error extracting trade amount USDC', { error, isEntry });
            return 0;
        }
    }

    private normalizeTradeEntry(entry: TradeEntry): TradeEntry {
        // [Keep existing implementation but ensure network fields exist]
        return {
            ...entry,
            network: entry.network || 'AVALANCHE', // Default fallback
            networkName: entry.networkName || 'Avalanche',
            chainId: entry.chainId || 43114,
            nativeCurrency: entry.nativeCurrency || 'AVAX',
            slippageActual: entry.slippageActual ?? entry.slippageActualPercent,
            signalType: entry.signalType ?? entry.signal,
            inputToken: entry.inputToken ?? entry.tokenAddresses?.inputToken,
            outputToken: entry.outputToken ?? entry.tokenAddresses?.outputToken,
            executionDetails: entry.executionDetails ?? {
                poolFee: entry.poolFee,
                slippageTolerance: entry.slippageTolerancePercent,
                priceImpact: entry.priceImpact,
                router: entry.protocolAddresses?.routerAddress,
                pool: entry.protocolAddresses?.poolAddress
            }
        };
    }

    // [Keep all other existing helper methods unchanged:
    //  storeTrade, attemptTradeMatching, calculateAverageGasPrice,
    //  calculateExecutionEfficiency, determineExitReason, etc.]

    private async storeTrade(trade: TradeEntry): Promise<void> {
        try {
            const activeTrades = this.getActiveTrades();
            activeTrades.push(trade);
            activeTrades.sort((a, b) => b.entryTimestamp - a.entryTimestamp);

            const jsonContent = this.safeJsonStringify(activeTrades);
            fs.writeFileSync(this.activeTradesFile, jsonContent);

            logger.debug('Network-aware trade stored successfully', {
                tradeId: trade.tradeId,
                network: trade.network,
                activeTradesCount: activeTrades.length
            });

        } catch (error) {
            logger.error('Failed to store network-aware trade', {
                tradeId: trade.tradeId,
                network: trade.network,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    private async attemptTradeMatching(): Promise<void> {
        try {
            const activeTrades = this.getActiveTrades();
            const completedTrades = this.getCompletedTrades();

            const entryTrades = activeTrades.filter(t => t.isEntry);
            const exitTrades = activeTrades.filter(t => !t.isEntry);

            logger.debug('🔧 Trade matching analysis', {
                totalActive: activeTrades.length,
                entryCount: entryTrades.length,
                exitCount: exitTrades.length,
                entryTrades: entryTrades.map(t => ({
                    id: t.tradeId,
                    tokenPair: t.tokenPair,
                    network: t.network,
                    timestamp: t.signalTimestamp,
                    timestampCDT: t.signalTimestampCDT,
                    amountUSDC: t.amountUSDC,
                    entryAmount: t.entryAmount
                })),
                exitTrades: exitTrades.map(t => ({
                    id: t.tradeId,
                    tokenPair: t.tokenPair,
                    network: t.network,
                    timestamp: t.signalTimestamp,
                    timestampCDT: t.signalTimestampCDT,
                    amountUSDC: t.amountUSDC,
                    entryAmount: t.entryAmount
                }))
            });

            for (const entryTrade of entryTrades) {
                // 🔧 ENHANCED: More robust matching criteria with detailed logging
                const potentialMatches = exitTrades.filter(exit => {
                    const tokenPairMatch = exit.tokenPair === entryTrade.tokenPair;
                    const networkMatch = exit.network === entryTrade.network;
                    const timeSequence = exit.signalTimestamp >= entryTrade.signalTimestamp;

                    // 🔧 NEW: Amount proximity check (within 25% tolerance for safety)
                    const amountCheck = this.checkAmountProximity(entryTrade.amountUSDC, exit.amountUSDC, 25);

                    logger.debug('🔧 Evaluating trade match', {
                        entryId: entryTrade.tradeId,
                        exitId: exit.tradeId,
                        tokenPairMatch,
                        networkMatch,
                        timeSequence,
                        amountCheck,
                        entryAmount: entryTrade.amountUSDC,
                        exitAmount: exit.amountUSDC,
                        timeDifference: exit.signalTimestamp - entryTrade.signalTimestamp
                    });

                    return tokenPairMatch && networkMatch && timeSequence && amountCheck;
                });

                if (potentialMatches.length === 0) {
                    logger.debug('🔧 No matching exit trades found', {
                        entryTradeId: entryTrade.tradeId,
                        entryTokenPair: entryTrade.tokenPair,
                        entryNetwork: entryTrade.network,
                        entryAmount: entryTrade.amountUSDC,
                        entryTimestamp: entryTrade.signalTimestamp,
                        availableExits: exitTrades.map(t => ({
                            id: t.tradeId,
                            tokenPair: t.tokenPair,
                            network: t.network,
                            amount: t.amountUSDC,
                            timestamp: t.signalTimestamp
                        }))
                    });
                    continue;
                }

                // Sort by timestamp (earliest exit wins) and then by amount proximity
                potentialMatches.sort((a, b) => {
                    const timeDiff = a.signalTimestamp - b.signalTimestamp;
                    if (timeDiff !== 0) return timeDiff;

                    // If times are equal, prefer closer amounts
                    const aProximity = Math.abs(a.amountUSDC - entryTrade.amountUSDC);
                    const bProximity = Math.abs(b.amountUSDC - entryTrade.amountUSDC);
                    return aProximity - bProximity;
                });

                const matchingExitTrade = potentialMatches[0];

                // 🔧 ENHANCED: Validate amounts before creating completed trade
                const entryAmountValid = entryTrade.amountUSDC > 0;
                const exitAmountValid = matchingExitTrade.amountUSDC > 0;

                if (!entryAmountValid || !exitAmountValid) {
                    logger.warn('🔧 Skipping trade pair due to invalid amounts', {
                        entryId: entryTrade.tradeId,
                        exitId: matchingExitTrade.tradeId,
                        entryAmount: entryTrade.amountUSDC,
                        exitAmount: matchingExitTrade.amountUSDC,
                        entryValid: entryAmountValid,
                        exitValid: exitAmountValid
                    });
                    continue;
                }

                const timeDiffSeconds = matchingExitTrade.signalTimestamp - entryTrade.signalTimestamp;
                const timeDiffMs = timeDiffSeconds * 1000;

                logger.info('🔧 Valid trade pair found and matched', {
                    entryId: entryTrade.tradeId,
                    exitId: matchingExitTrade.tradeId,
                    tokenPair: entryTrade.tokenPair,
                    network: entryTrade.network,
                    entryAmount: entryTrade.amountUSDC,
                    exitAmount: matchingExitTrade.amountUSDC,
                    timeDifferenceSeconds: timeDiffSeconds,
                    formattedDuration: this.formatDurationEnhanced(timeDiffMs),
                    alternatives: potentialMatches.length - 1
                });

                const completedTrade = await this.createCompletedTrade(entryTrade, matchingExitTrade);
                completedTrades.push(completedTrade);

                // Remove matched trades from active list
                const remainingTrades = activeTrades.filter(
                    t => t.tradeId !== entryTrade.tradeId && t.tradeId !== matchingExitTrade.tradeId
                );

                // Save updates
                fs.writeFileSync(this.activeTradesFile, this.safeJsonStringify(remainingTrades));
                fs.writeFileSync(this.completedTradesFile, this.safeJsonStringify(completedTrades));

                await this.updateTradeSummary(completedTrade);
                await this.triggerAutoReporting();

                logger.info('🔧 Network-aware trade pair completed', {
                    tradePairId: completedTrade.tradePairId,
                    network: completedTrade.network,
                    isCrossNetwork: completedTrade.isCrossNetwork,
                    signalDuration: completedTrade.signalDurationFormatted,
                    grossProfit: completedTrade.grossProfitUSDC.toFixed(4),
                    netProfit: completedTrade.netProfitUSDC.toFixed(4),
                    gasCostUSDC: completedTrade.gasCostUSDC.toFixed(6),
                    gasCostNative: completedTrade.gasCostNative.toFixed(6),
                    nativeCurrency: completedTrade.nativeCurrency
                });
            }
        } catch (error) {
            logger.error('Failed to match network-aware trades', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private checkAmountProximity(amount1: number, amount2: number, tolerancePercent: number = 25): boolean {
        if (amount1 === 0 || amount2 === 0) {
            logger.debug('🔧 Amount proximity check: Zero amount detected', {
                amount1, amount2
            });
            return false;
        }

        const difference = Math.abs(amount1 - amount2);
        const average = (amount1 + amount2) / 2;
        const percentDifference = (difference / average) * 100;

        const isWithinTolerance = percentDifference <= tolerancePercent;

        logger.debug('🔧 Amount proximity check', {
            amount1,
            amount2,
            difference,
            percentDifference: percentDifference.toFixed(2) + '%',
            tolerance: tolerancePercent + '%',
            isWithinTolerance
        });

        return isWithinTolerance;
    }

    private async triggerAutoReporting(): Promise<void> {
        if (process.env.AUTO_GENERATE_REPORTS === 'true') {
            try {
                const { tradeReporting } = await import('./tradeReporting.ts');
                await tradeReporting.generateFullReport();
                logger.info('Auto-generated reports after network-aware trade completion');
            } catch (error) {
                logger.error('Failed to auto-generate reports', {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }

    // Keep all other existing utility methods...
    private formatDuration(milliseconds: number): string {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    private generateTradeId(): string {
        return `trade_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    private parseProduct(product: string): { baseToken: string; quoteToken: string; tokenPair: string } {
        const [baseToken, quoteToken] = product.split('/');
        return {
            baseToken: baseToken.replace('AVAX', 'WAVAX'),
            quoteToken,
            tokenPair: `${baseToken.replace('AVAX', 'WAVAX')}-${quoteToken}`
        };
    }

    private isEntrySignal(side: string): boolean {
        return side === 'buy';
    }

    private mapSignalType(side: string): 'Regular Buy' | 'Regular Sell' | 'Stop Loss' | 'Take Profit' {
        switch (side) {
            case 'buy': return 'Regular Buy';
            case 'sell': return 'Regular Sell';
            case 'sellsl': return 'Stop Loss';
            case 'selltp': return 'Take Profit';
            default: return 'Regular Sell';
        }
    }

    private safeToNumber(value: string | number | undefined): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const num = parseFloat(value);
            return isNaN(num) ? 0 : num;
        }
        return 0;
    }

    private calculateAverageGasPrice(entryLeg: TradeEntry, exitLeg: TradeEntry): number {
        const entryGas = entryLeg.executionDetails?.effectiveGasPrice ?
            parseFloat(entryLeg.executionDetails.effectiveGasPrice) / 1e9 : 25;
        const exitGas = exitLeg.executionDetails?.effectiveGasPrice ?
            parseFloat(exitLeg.executionDetails.effectiveGasPrice) / 1e9 : 25;
        return (entryGas + exitGas) / 2;
    }

    private calculateExecutionEfficiency(entryLeg: TradeEntry, exitLeg: TradeEntry): number {
        const entryExpected = this.safeToNumber(entryLeg.expectedOutput);
        const entryActual = this.safeToNumber(entryLeg.actualOutput);
        const exitExpected = this.safeToNumber(exitLeg.expectedOutput);
        const exitActual = this.safeToNumber(exitLeg.actualOutput);

        if (entryExpected === 0 || exitExpected === 0) return 1.0;

        const entryEfficiency = entryExpected > 0 ? entryActual / entryExpected : 1.0;
        const exitEfficiency = exitExpected > 0 ? exitActual / exitExpected : 1.0;

        return (entryEfficiency + exitEfficiency) / 2;
    }

    private determineExitReason(signal: string): string {
        switch (signal?.toLowerCase()) {
            case 'stop loss':
            case 'stoploss':
                return 'Stop Loss Triggered';
            case 'take profit':
            case 'takeprofit':
                return 'Take Profit Achieved';
            case 'sell':
                return 'Regular Exit Signal';
            default:
                return 'Regular Exit Signal';
        }
    }

    private ensureDirectoryExists(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    private initializeFiles(): void {
        if (!fs.existsSync(this.activeTradesFile)) {
            fs.writeFileSync(this.activeTradesFile, '[]');
        }
        if (!fs.existsSync(this.completedTradesFile)) {
            fs.writeFileSync(this.completedTradesFile, '[]');
        }
        if (!fs.existsSync(this.summaryFile)) {
            fs.writeFileSync(this.summaryFile, JSON.stringify(this.createDefaultSummary()));
        }
    }

    private verifyFileSystem(): void {
        try {
            fs.accessSync(this.dataDir, fs.constants.W_OK);
        } catch (error) {
            logger.error('Trade tracking directory not writable', {
                dataDir: this.dataDir,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private safeJsonStringify(obj: any): string {
        return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            return value;
        }, 2);
    }

    private formatCDTTimestamp(unixTimestamp: number): string {
        return formatCDTTimestamp(unixTimestamp);
    }

    private getWeekNumber(date: Date): number {
        const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
        const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
        return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    }

    // ==================== 🔧 NEW NETWORK-AWARE PUBLIC METHODS ====================

    /**
     * Get trades filtered by network
     */
    public getTradesByNetwork(network: NetworkKey): {
        activeTrades: TradeEntry[];
        completedTrades: CompletedTrade[];
    } {
        const activeTrades = this.getActiveTrades().filter(t => t.network === network);
        const completedTrades = this.getCompletedTrades().filter(t => t.network === network);

        return { activeTrades, completedTrades };
    }

    /**
     * Get network comparison report
     */
    public getNetworkComparison(): {
        [K in NetworkKey]?: {
            totalTrades: number;
            totalProfit: number;
            averageGasCost: number;
            winRate: number;
            efficiency: number;
        };
    } {
        const summary = this.getTradeSummary();
        const comparison: any = {};

        for (const [network, data] of Object.entries(summary.networkSummary)) {
            comparison[network] = {
                totalTrades: data.totalTrades,
                totalProfit: data.totalNetProfit,
                averageGasCost: data.averageGasCost,
                winRate: data.winRate,
                efficiency: summary.crossNetworkAnalytics.networkEfficiencyRanking
                    .find(r => r.network === network)?.efficiencyScore || 0
            };
        }

        return comparison;
    }

    /**
     * Recalculate summary with network awareness
     */
    public async recalculateSummaryFromCompletedTrades(): Promise<void> {
        try {
            logger.info('🔧 Recalculating network-aware summary from completed trades');

            const completedTrades = this.getCompletedTrades();

            if (completedTrades.length === 0) {
                logger.warn('No completed trades found to recalculate summary');
                return;
            }

            // Start with a fresh network-aware summary
            const summary = this.createDefaultSummary();

            // Recalculate everything from completed trades with network context
            for (const trade of completedTrades) {
                const network = trade.network || 'AVALANCHE'; // Fallback for legacy trades

                // Basic stats
                summary.totalTrades++;
                summary.totalGrossProfit += trade.grossProfitUSDC;
                summary.totalGasCosts += trade.gasCostUSDC;
                summary.totalNetProfit += trade.netProfitUSDC;

                // Trade categories
                if (trade.tradeCategory === 'profitable') {
                    summary.profitableTrades++;
                } else if (trade.tradeCategory === 'loss') {
                    summary.losingTrades++;
                } else {
                    summary.breakevenTrades++;
                }

                // Network-specific updates
                if (!summary.networkSummary[network]) {
                    summary.networkSummary[network] = {
                        totalTrades: 0,
                        profitableTrades: 0,
                        totalNetProfit: 0,
                        averageProfit: 0,
                        winRate: 0,
                        totalGasCosts: 0,
                        averageGasCost: 0,
                        nativeCurrency: trade.nativeCurrency || SUPPORTED_NETWORKS[network].nativeCurrency,
                        averageTradeDuration: 0
                    };
                }

                const networkSummary = summary.networkSummary[network];
                if (networkSummary) {
                    networkSummary.totalTrades++;
                    networkSummary.totalNetProfit += trade.netProfitUSDC;
                    networkSummary.totalGasCosts += trade.gasCostUSDC;
                    if (trade.tradeCategory === 'profitable') {
                        networkSummary.profitableTrades++;
                    }
                }

                // Cross-network analytics
                summary.crossNetworkAnalytics.networkDistribution[network] =
                    (summary.crossNetworkAnalytics.networkDistribution[network] || 0) + 1;

                if (trade.isCrossNetwork) {
                    summary.crossNetworkAnalytics.totalCrossNetworkTrades++;
                }
            }

            // Calculate averages
            summary.winRate = summary.totalTrades > 0 ? (summary.profitableTrades / summary.totalTrades) * 100 : 0;
            summary.averageProfit = summary.totalTrades > 0 ? summary.totalNetProfit / summary.totalTrades : 0;
            summary.averageGasCost = summary.totalTrades > 0 ? summary.totalGasCosts / summary.totalTrades : 0;

            // Calculate network-specific averages
            for (const [network, networkSummary] of Object.entries(summary.networkSummary)) {
                if (networkSummary && networkSummary.totalTrades > 0) {
                    networkSummary.winRate = (networkSummary.profitableTrades / networkSummary.totalTrades) * 100;
                    networkSummary.averageProfit = networkSummary.totalNetProfit / networkSummary.totalTrades;
                    networkSummary.averageGasCost = networkSummary.totalGasCosts / networkSummary.totalTrades;
                }
            }

            // Update timestamps
            const currentTimestamp = getCurrentTimestamp();
            summary.lastUpdated = currentTimestamp;
            summary.lastUpdatedCDT = formatCDTTimestamp(currentTimestamp);

            // Save the corrected network-aware summary
            fs.writeFileSync(this.summaryFile, this.safeJsonStringify(summary));

            logger.info('✅ Network-aware summary recalculated successfully', {
                totalTrades: summary.totalTrades,
                totalNetProfit: summary.totalNetProfit.toFixed(4) + ' USDC',
                networkBreakdown: Object.entries(summary.networkSummary).map(([network, data]) => ({
                    network,
                    trades: data.totalTrades,
                    profit: data.totalNetProfit.toFixed(4),
                    winRate: data.winRate.toFixed(2) + '%'
                }))
            });

        } catch (error) {
            logger.error('Failed to recalculate network-aware summary', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    // Keep all other existing public methods (listAllTrades, clearActiveTrades, removeTradeById, etc.)
    // but add network context to their logging...

    public listAllTrades(): void {
        try {
            const completedTrades = this.getCompletedTrades();
            const activeTrades = this.getActiveTrades();

            console.log('\n=== COMPLETED TRADES BY NETWORK ===');

            // Group by network
            const tradesByNetwork = completedTrades.reduce((acc, trade) => {
                const network = trade.network || 'UNKNOWN';
                if (!acc[network]) acc[network] = [];
                acc[network].push(trade);
                return acc;
            }, {} as Record<string, CompletedTrade[]>);

            for (const [network, trades] of Object.entries(tradesByNetwork)) {
                console.log(`\n--- ${network} (${trades.length} trades) ---`);
                trades.forEach((trade, index) => {
                    console.log(`${index + 1}. ${trade.tradePairId || trade.tradeId}`);
                    console.log(`   Entry: ${trade.entryLeg?.signalType || 'N/A'} at ${trade.entryLeg?.signalTimestampCDT || 'N/A'}`);
                    console.log(`   Exit: ${trade.exitLeg?.signalType || 'N/A'} at ${trade.exitLeg?.signalTimestampCDT || 'N/A'}`);
                    console.log(`   Profit: ${trade.netProfitUSDC?.toFixed(4) || 'N/A'} USDC`);
                    console.log(`   Gas: ${trade.gasCostUSDC?.toFixed(6) || 'N/A'} USDC (${trade.gasCostNative?.toFixed(6) || 'N/A'} ${trade.nativeCurrency || 'NATIVE'})`);
                    if (trade.isCrossNetwork) console.log(`   🔄 Cross-Network Trade`);
                    console.log('');
                });
            }

            console.log('\n=== ACTIVE TRADES BY NETWORK ===');
            const activeByNetwork = activeTrades.reduce((acc, trade) => {
                const network = trade.network || 'UNKNOWN';
                if (!acc[network]) acc[network] = [];
                acc[network].push(trade);
                return acc;
            }, {} as Record<string, TradeEntry[]>);

            for (const [network, trades] of Object.entries(activeByNetwork)) {
                console.log(`\n--- ${network} (${trades.length} active) ---`);
                trades.forEach((trade, index) => {
                    console.log(`${index + 1}. ${trade.tradeId}`);
                    console.log(`   Type: ${trade.signalType} ${trade.tradeDirection}`);
                    console.log(`   Date: ${trade.signalTimestampCDT || trade.entryTimestampCDT}`);
                    console.log(`   Status: ${trade.status}`);
                    console.log('');
                });
            }

            const summary = this.getTradeSummary();
            console.log('\n=== NETWORK SUMMARY ===');
            console.log(`Total Trades: ${summary.totalTrades}`);
            console.log(`Total Gas Costs: ${summary.totalGasCosts.toFixed(4)} USDC`);
            console.log(`Total Net Profit: ${summary.totalNetProfit.toFixed(4)} USDC`);

            if (summary.networkSummary) {
                console.log('\n--- Per Network ---');
                for (const [network, data] of Object.entries(summary.networkSummary)) {
                    console.log(`${network}: ${data.totalTrades} trades, ${data.totalNetProfit.toFixed(4)} USDC profit, ${data.winRate.toFixed(2)}% win rate`);
                }
            }

        } catch (error) {
            logger.error('Failed to list network-aware trades', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    // Keep existing removeTradeById and clearActiveTrades methods unchanged...
    public async removeTradeById(tradePairId: string): Promise<void> {
        // [Keep existing implementation but add network logging]
        try {
            logger.info('🗑️ Removing trade pair', { tradePairId });

            const completedTrades = this.getCompletedTrades();
            const originalCount = completedTrades.length;

            const filteredCompleted = completedTrades.filter(trade =>
                trade.tradePairId !== tradePairId &&
                trade.tradeId !== tradePairId
            );

            const removedCount = originalCount - filteredCompleted.length;

            if (removedCount === 0) {
                logger.warn('Trade pair not found in completed trades', { tradePairId });
            } else {
                fs.writeFileSync(this.completedTradesFile, this.safeJsonStringify(filteredCompleted));
                logger.info('✅ Removed completed trade pair', {
                    tradePairId,
                    removedCount,
                    remainingTrades: filteredCompleted.length
                });
            }

            const activeTrades = this.getActiveTrades();
            const originalActiveCount = activeTrades.length;

            const tradeIdParts = tradePairId.replace('pair_', '').split('_trade_');
            const possibleTradeIds = tradeIdParts.map(part => `trade_${part}`);

            const filteredActive = activeTrades.filter(trade =>
                !possibleTradeIds.includes(trade.tradeId) &&
                trade.tradeId !== tradePairId
            );

            const removedActiveCount = originalActiveCount - filteredActive.length;

            if (removedActiveCount > 0) {
                fs.writeFileSync(this.activeTradesFile, this.safeJsonStringify(filteredActive));
                logger.info('✅ Removed active trade legs', {
                    removedActiveCount,
                    remainingActiveTrades: filteredActive.length
                });
            }

            if (removedCount > 0) {
                await this.recalculateSummaryFromCompletedTrades();
                logger.info('✅ Network-aware summary recalculated after trade removal');
            }

        } catch (error) {
            logger.error('Failed to remove trade pair', {
                tradePairId,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    public clearActiveTrades(options: {
        confirm?: boolean;
        backup?: boolean;
        olderThanMinutes?: number;
        tradeId?: string;
        network?: NetworkKey;  // 🔧 NEW: Network-specific clearing
    } = {}): number {
        try {
            const activeTrades = this.getActiveTrades();

            if (activeTrades.length === 0) {
                logger.info('No active trades to clear');
                return 0;
            }

            // 🔧 ENHANCED: Show network breakdown
            const tradesByNetwork = activeTrades.reduce((acc, t) => {
                const network = t.network || 'UNKNOWN';
                if (!acc[network]) acc[network] = [];
                acc[network].push(t);
                return acc;
            }, {} as Record<string, TradeEntry[]>);

            logger.info('🔍 Found active trades by network:', {
                totalCount: activeTrades.length,
                networkBreakdown: Object.entries(tradesByNetwork).map(([network, trades]) => ({
                    network,
                    count: trades.length,
                    trades: trades.map(t => ({
                        id: t.tradeId,
                        type: t.signalType,
                        pair: t.tokenPair,
                        date: t.signalTimestampCDT || t.entryTimestampCDT,
                        status: t.status
                    }))
                }))
            });

            // Filter trades based on criteria
            let tradesToClear = activeTrades;
            let remainingTrades: typeof activeTrades = [];

            if (options.network) {
                // Clear trades for specific network
                tradesToClear = activeTrades.filter(t => t.network === options.network);
                remainingTrades = activeTrades.filter(t => t.network !== options.network);
            } else if (options.tradeId) {
                // Clear specific trade ID
                tradesToClear = activeTrades.filter(t => t.tradeId === options.tradeId);
                remainingTrades = activeTrades.filter(t => t.tradeId !== options.tradeId);
            } else if (options.olderThanMinutes) {
                // Clear trades older than specified minutes
                const cutoffTime = Date.now() / 1000 - (options.olderThanMinutes * 60);
                tradesToClear = activeTrades.filter(t =>
                    (t.signalTimestamp || t.entryTimestamp) < cutoffTime
                );
                remainingTrades = activeTrades.filter(t =>
                    (t.signalTimestamp || t.entryTimestamp) >= cutoffTime
                );
            } else {
                // Clear all active trades
                tradesToClear = activeTrades;
                remainingTrades = [];
            }

            if (tradesToClear.length === 0) {
                logger.info('No trades match the clearing criteria', {
                    criteria: options
                });
                return 0;
            }

            // Backup if requested
            if (options.backup) {
                const backupFile = path.join(this.dataDir, `trades_active_backup_${Date.now()}.json`);
                fs.writeFileSync(backupFile, this.safeJsonStringify(activeTrades));
                logger.info('📁 Backup created', { backupFile });
            }

            // Confirmation check
            if (options.confirm === false) {
                logger.warn('⚠️ Confirmation required to clear active trades');
                logger.info('Trades that would be cleared by network:', {
                    totalCount: tradesToClear.length,
                    networkBreakdown: tradesToClear.reduce((acc, t) => {
                        const network = t.network || 'UNKNOWN';
                        if (!acc[network]) acc[network] = [];
                        acc[network].push(t.tradeId);
                        return acc;
                    }, {} as Record<string, string[]>)
                });
                return 0;
            }

            // Clear the trades
            fs.writeFileSync(this.activeTradesFile, this.safeJsonStringify(remainingTrades));

            const clearedByNetwork = tradesToClear.reduce((acc, t) => {
                const network = t.network || 'UNKNOWN';
                if (!acc[network]) acc[network] = [];
                acc[network].push({
                    id: t.tradeId,
                    type: t.signalType,
                    pair: t.tokenPair
                });
                return acc;
            }, {} as Record<string, any[]>);

            logger.info('✅ Active trades cleared successfully', {
                clearedCount: tradesToClear.length,
                remainingCount: remainingTrades.length,
                clearedByNetwork
            });

            return tradesToClear.length;

        } catch (error) {
            logger.error('Failed to clear active trades', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
}

// Create and export singleton instance
export const tradeTracker = new TradeTracker();