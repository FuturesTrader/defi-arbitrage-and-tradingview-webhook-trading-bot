// src/tradeReporting.ts - Network-Aware Multi-Chain Reporting v4.0.0
// 🔧 MAJOR UPGRADE: Full integration with tradeTracker.ts v3.0.0 multi-network architecture
// Supports Avalanche + Arbitrum with comprehensive network-specific reporting

import fs from 'fs';
import path from 'path';
import { tradeTracker, type CompletedTrade, type TradeEntry} from './tradeTracker.ts';
import {
    getNetworkConfig,
    getCurrentNetworkKey,
    SUPPORTED_NETWORKS,
    type NetworkKey
} from './constants.ts';
import logger from './logger';

// ==================== 🔧 ENHANCED NETWORK-AWARE REPORTING TYPES ====================

export interface NetworkReportOptions extends ReportOptions {
    networkFilter?: NetworkKey;           // 🔧 NEW: Filter by specific network
    includeNetworkBreakdown?: boolean;   // 🔧 NEW: Include per-network analysis
    crossNetworkOnly?: boolean;          // 🔧 NEW: Only cross-network trades
    compareNetworks?: boolean;           // 🔧 NEW: Generate network comparison
}

export interface ReportOptions {
    startDate?: Date;
    endDate?: Date;
    tokenFilter?: string;
    minProfitFilter?: number;
    includeActiveTrades?: boolean;
    outputFormat?: 'csv' | 'json' | 'both';
    includeAddressDetails?: boolean;
    includeEnhancedTiming?: boolean;
}

export interface CSVColumn {
    header: string;
    accessor: (trade: CompletedTrade) => string | number;
    format?: 'currency' | 'percentage' | 'duration' | 'datetime' | 'text' | 'address' | 'timing' | 'network';
}

// ==================== 🔧 ENHANCED NETWORK-AWARE TRADE REPORTING CLASS v4.0.0 ====================

export class TradeReporting {
    private readonly reportsDir: string;

    constructor() {
        this.reportsDir = path.join(process.cwd(), 'data', 'reports');
        this.ensureDirectoryExists();

        logger.info('🔧 Network-Aware TradeReporting v4.0.0 - Multi-Chain Architecture Integration', {
            reportsDir: this.reportsDir,
            supportedNetworks: Object.keys(SUPPORTED_NETWORKS),
            enhancedFeatures: [
                '🔧 NEW: Network-specific trade reporting with Avalanche + Arbitrum support',
                '🔧 NEW: Cross-network trade analysis and comparison',
                '🔧 NEW: Network gas cost tracking in native currencies (AVAX/ETH)',
                '🔧 NEW: L1 vs L2 performance analytics and optimization insights',
                '🔧 NEW: Network efficiency scoring and ranking',
                '✅ EXISTING: Enhanced timing analysis (signal vs execution)',
                '✅ EXISTING: Comprehensive address tracking and protocol analytics',
                '✅ ENHANCED: Backward compatibility with legacy trade data'
            ],
            alignedWith: 'tradeTracker.ts v3.0.0 multi-network architecture',
            networkSupport: {
                avalanche: 'L1 network with AVAX native currency',
                arbitrum: 'L2 network with ETH native currency'
            }
        });
    }

    // ==================== 🔧 ENHANCED NETWORK-AWARE EXPORT METHODS ====================

    /**
     * 🔧 ENHANCED: Generate comprehensive network-aware trade report
     */
    public async generateFullReport(options: NetworkReportOptions = {}): Promise<{
        completedTradesFile: string;
        activeTradesFile?: string;
        summaryFile: string;
        performanceFile: string;
        dailyFile: string;
        addressAnalysisFile: string;
        protocolAnalyticsFile: string;
        timingAnalysisFile: string;
        networkComparisonFile?: string;     // 🔧 NEW: Network comparison report
        networkBreakdownFile?: string;     // 🔧 NEW: Per-network breakdown
        crossNetworkFile?: string;         // 🔧 NEW: Cross-network trades only
    }> {
        const timestamp = this.getTimestamp();
        const reportPrefix = this.buildReportPrefix(timestamp, options);

        logger.info('🔧 Generating network-aware trade report with multi-chain support', {
            reportPrefix,
            options,
            supportedNetworks: Object.keys(SUPPORTED_NETWORKS),
            includeNetworkBreakdown: options.includeNetworkBreakdown,
            networkFilter: options.networkFilter,
            alignedWith: 'tradeTracker.ts v3.0.0'
        });

        // Generate completed trades CSV (now with full network context)
        const completedTradesFile = await this.exportCompletedTrades({
            filename: `${reportPrefix}_completed_trades.csv`,
            ...options,
            includeEnhancedTiming: true
        });

        // Generate active trades CSV (if requested)
        let activeTradesFile: string | undefined;
        if (options.includeActiveTrades) {
            activeTradesFile = await this.exportActiveTrades({
                filename: `${reportPrefix}_active_trades.csv`,
                networkFilter: options.networkFilter
            });
        }

        // Generate core reports
        const summaryFile = await this.exportSummaryReport({
            filename: `${reportPrefix}_summary.csv`,
            networkFilter: options.networkFilter
        });

        const performanceFile = await this.exportPerformanceMetrics({
            filename: `${reportPrefix}_performance.csv`,
            ...options
        });

        const dailyFile = await this.exportDailyPerformance({
            filename: `${reportPrefix}_daily.csv`,
            ...options
        });

        const addressAnalysisFile = await this.exportAddressAnalysis({
            filename: `${reportPrefix}_address_analysis.csv`,
            ...options
        });

        const protocolAnalyticsFile = await this.exportProtocolAnalytics({
            filename: `${reportPrefix}_protocol_analytics.csv`,
            networkFilter: options.networkFilter
        });

        const timingAnalysisFile = await this.exportTimingAnalysis({
            filename: `${reportPrefix}_timing_analysis.csv`,
            ...options
        });

        // 🔧 NEW: Network-specific reports
        let networkComparisonFile: string | undefined;
        let networkBreakdownFile: string | undefined;
        let crossNetworkFile: string | undefined;

        if (options.compareNetworks) {
            networkComparisonFile = await this.exportNetworkComparison({
                filename: `${reportPrefix}_network_comparison.csv`
            });
        }

        if (options.includeNetworkBreakdown) {
            networkBreakdownFile = await this.exportNetworkBreakdown({
                filename: `${reportPrefix}_network_breakdown.csv`,
                ...options
            });
        }

        if (options.crossNetworkOnly) {
            crossNetworkFile = await this.exportCrossNetworkTrades({
                filename: `${reportPrefix}_cross_network.csv`,
                ...options
            });
        }

        logger.info('✅ Network-aware multi-chain trade report generated successfully', {
            completedTrades: completedTradesFile,
            activeTrades: activeTradesFile,
            summary: summaryFile,
            performance: performanceFile,
            daily: dailyFile,
            addressAnalysis: addressAnalysisFile,
            protocolAnalytics: protocolAnalyticsFile,
            timingAnalysis: timingAnalysisFile,
            networkComparison: networkComparisonFile,
            networkBreakdown: networkBreakdownFile,
            crossNetwork: crossNetworkFile,
            networksSupported: Object.keys(SUPPORTED_NETWORKS)
        });

        return {
            completedTradesFile,
            activeTradesFile,
            summaryFile,
            performanceFile,
            dailyFile,
            addressAnalysisFile,
            protocolAnalyticsFile,
            timingAnalysisFile,
            networkComparisonFile,
            networkBreakdownFile,
            crossNetworkFile
        };
    }

    /**
     * 🔧 ENHANCED: Export completed trades with comprehensive network context
     */
    public async exportCompletedTrades(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
        tokenFilter?: string;
        minProfitFilter?: number;
        includeAddressDetails?: boolean;
        includeEnhancedTiming?: boolean;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {

        const completedTrades = tradeTracker.getCompletedTrades();
        const filteredTrades = this.filterTrades(completedTrades, options);

        const filename = options.filename || `completed_trades_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        // 🔧 ENHANCED: CSV columns with comprehensive network and timing information
        const columns: CSVColumn[] = [
            // 🔧 NEW: Network Context (Primary Network Information)
            { header: 'Network', accessor: (t) => t.network || 'AVALANCHE', format: 'network' },
            { header: 'Network_Name', accessor: (t) => t.networkName || 'Avalanche', format: 'text' },
            { header: 'Chain_ID', accessor: (t) => t.chainId || 43114 },
            { header: 'Native_Currency', accessor: (t) => t.nativeCurrency || 'AVAX', format: 'text' },
            { header: 'Cross_Network_Trade', accessor: (t) => t.isCrossNetwork ? 'Yes' : 'No', format: 'text' },
            { header: 'Networks_Used', accessor: (t) => t.networksUsed?.join(';') || t.network || 'AVALANCHE', format: 'text' },

            // Basic Trade Information
            { header: 'Trade_Pair_ID', accessor: (t) => t.tradePairId },
            { header: 'Token_Pair', accessor: (t) => t.entryLeg.tokenPair },

            // Enhanced Signal Timing (existing)
            { header: 'Entry_Signal_Date_CDT', accessor: (t) => t.entrySignalCDT || t.entryDateCDT, format: 'datetime' },
            { header: 'Exit_Signal_Date_CDT', accessor: (t) => t.exitSignalCDT || t.exitDateCDT, format: 'datetime' },
            { header: 'Signal_Duration', accessor: (t) => t.signalDurationFormatted || t.tradeDurationFormatted, format: 'timing' },
            { header: 'Signal_Duration_Minutes', accessor: (t) => ((t.signalDurationMs || t.tradeDurationMs) / (1000 * 60)).toFixed(2), format: 'timing' },

            // Execution Timing (existing)
            { header: 'Entry_Execution_Date_CDT', accessor: (t) => t.entryExecutionCDT || t.entrySignalCDT || t.entryDateCDT, format: 'datetime' },
            { header: 'Exit_Execution_Date_CDT', accessor: (t) => t.exitExecutionCDT || t.exitSignalCDT || t.exitDateCDT, format: 'datetime' },
            { header: 'Execution_Duration', accessor: (t) => t.executionDurationFormatted || t.signalDurationFormatted || t.tradeDurationFormatted, format: 'timing' },
            { header: 'Execution_Duration_Seconds', accessor: (t) => ((t.executionDurationMs || t.signalDurationMs || t.tradeDurationMs) / 1000).toFixed(1), format: 'timing' },

            // Processing Performance Metrics
            { header: 'Avg_Processing_Delay_Seconds', accessor: (t) => (t.avgSignalToExecutionDelay || 0).toFixed(1), format: 'timing' },
            { header: 'Total_Processing_Time_Seconds', accessor: (t) => (t.totalProcessingTime || 0).toFixed(1), format: 'timing' },

            // Backward Compatibility: Legacy timing fields
            { header: 'Entry_Date', accessor: (t) => t.entrySignalCDT || t.entryDateCDT, format: 'datetime' },
            { header: 'Exit_Date', accessor: (t) => t.exitSignalCDT || t.exitDateCDT, format: 'datetime' },
            { header: 'Trade_Duration', accessor: (t) => {
                    const entryTime = t.entrySignalCDT || t.entryDateCDT;
                    const exitTime = t.exitSignalCDT || t.exitDateCDT;

                    if (!entryTime || !exitTime) return '0.00';

                    try {
                        const entryDate = new Date(entryTime.replace(' CDT', ''));
                        const exitDate = new Date(exitTime.replace(' CDT', ''));
                        const durationMs = exitDate.getTime() - entryDate.getTime();
                        const durationMinutes = durationMs / (1000 * 60);
                        return durationMinutes.toFixed(2);
                    } catch (error) {
                        return '0.00';
                    }
                }, format: 'timing' },

            // Signal Information
            { header: 'Entry_Signal', accessor: (t) => t.entryLeg.entrySignal || t.entryLeg.signalType },
            { header: 'Exit_Signal', accessor: (t) => t.exitLeg.entrySignal || t.exitLeg.signalType },
            { header: 'Exit_Reason', accessor: (t) => t.exitReason },

            // 🔧 ENHANCED: Financial Information with Network-Aware Gas Costs
            { header: 'Entry_Amount_USDC', accessor: (t) => parseFloat(t.entryLeg.entryAmount || '0'), format: 'currency' },
            { header: 'Exit_Amount_USDC', accessor: (t) => parseFloat(t.exitLeg.actualOutput || t.exitLeg.entryAmount || '0'), format: 'currency' },
            { header: 'Gross_Profit_USDC', accessor: (t) => t.grossProfitUSDC, format: 'currency' },

            // Network-Aware Gas Costs
            { header: 'Gas_Cost_USDC', accessor: (t) => t.gasCostUSDC, format: 'currency' },
            { header: 'Gas_Cost_Native', accessor: (t) => t.gasCostNative || 0, format: 'currency' },
            { header: 'Native_Price_USDC', accessor: (t) => t.networkCostAnalysis?.averageNativePrice || 0, format: 'currency' },

            { header: 'Net_Profit_USDC', accessor: (t) => t.netProfitUSDC, format: 'currency' },
            { header: 'Profit_Percentage', accessor: (t) => t.profitPercentage, format: 'percentage' },
            { header: 'Trade_Category', accessor: (t) => t.tradeCategory },

            // Enhanced Expected vs Actual Analysis
            { header: 'Expected_Gross_Profit_USDC', accessor: (t) => t.expectedGrossProfitUSDC || 0, format: 'currency' },
            { header: 'Actual_Vs_Expected_Difference', accessor: (t) => t.actualVsExpectedDifference || 0, format: 'currency' },
            { header: 'Actual_Vs_Expected_Percent', accessor: (t) => t.actualVsExpectedPercent || 0, format: 'percentage' },
            { header: 'Total_Slippage_Impact', accessor: (t) => t.totalSlippageImpact || 0, format: 'percentage' },

            // Transaction Hash Information
            { header: 'Entry_Tx_Hash', accessor: (t) => t.entryLeg.entryTxHash || '', format: 'address' },
            { header: 'Exit_Tx_Hash', accessor: (t) => t.exitLeg.entryTxHash || '', format: 'address' },

            // 🔧 ENHANCED: Network-Aware Gas Analysis
            { header: 'Entry_Gas_Used', accessor: (t) => t.entryLeg.entryGasUsed || '' },
            { header: 'Exit_Gas_Used', accessor: (t) => t.exitLeg.entryGasUsed || '' },
            { header: 'Entry_Gas_Price_Gwei', accessor: (t) => this.formatGasPrice(t.entryLeg.entryEffectiveGasPrice), format: 'currency' },
            { header: 'Exit_Gas_Price_Gwei', accessor: (t) => this.formatGasPrice(t.exitLeg.entryEffectiveGasPrice), format: 'currency' },
            { header: 'Avg_Gas_Price_Gwei', accessor: (t) => t.gasAnalysis?.avgGasPriceGwei || 0, format: 'currency' },
            { header: 'Gas_Efficiency_Percent', accessor: (t) => t.gasAnalysis?.gasEfficiency || 0, format: 'percentage' },
            { header: 'Entry_Gas_Cost_USDC', accessor: (t) => t.gasAnalysis?.entryGasCostUSDC || 0, format: 'currency' },
            { header: 'Exit_Gas_Cost_USDC', accessor: (t) => t.gasAnalysis?.exitGasCostUSDC || 0, format: 'currency' },

            // 🔧 NEW: Network-Specific Gas Analysis
            { header: 'Network_Gas_Strategy', accessor: (t) => t.gasAnalysis?.networkGasAnalysis?.gasStrategy || 'L1_STANDARD', format: 'text' },
            { header: 'L2_Fee_Savings_Percent', accessor: (t) => t.gasAnalysis?.networkGasAnalysis?.l2Optimizations?.feeSavingsVsL1 || 0, format: 'percentage' },
            { header: 'L2_Speed_Improvement_Percent', accessor: (t) => t.gasAnalysis?.networkGasAnalysis?.l2Optimizations?.speedImprovementVsL1 || 0, format: 'percentage' },

            // 🔧 NEW: Network Efficiency Metrics
            { header: 'Network_Efficiency_Score', accessor: (t) => t.networkCostAnalysis?.networkEfficiencyScore || 0, format: 'percentage' },

            // Token Address Information (existing)
            { header: 'Entry_Input_Token_Address', accessor: (t) => t.entryLeg.tokenAddresses?.inputToken?.address || '', format: 'address' },
            { header: 'Entry_Output_Token_Address', accessor: (t) => t.entryLeg.tokenAddresses?.outputToken?.address || '', format: 'address' },
            { header: 'Exit_Input_Token_Address', accessor: (t) => t.exitLeg.tokenAddresses?.inputToken?.address || '', format: 'address' },
            { header: 'Exit_Output_Token_Address', accessor: (t) => t.exitLeg.tokenAddresses?.outputToken?.address || '', format: 'address' },

            // 🔧 ENHANCED: Protocol Address Information with Network Context
            { header: 'Entry_Router_Address', accessor: (t) => t.entryLeg.protocolAddresses?.routerAddress || '', format: 'address' },
            { header: 'Exit_Router_Address', accessor: (t) => t.exitLeg.protocolAddresses?.routerAddress || '', format: 'address' },
            { header: 'Entry_Pool_Address', accessor: (t) => t.entryLeg.protocolAddresses?.poolAddress || '', format: 'address' },
            { header: 'Exit_Pool_Address', accessor: (t) => t.exitLeg.protocolAddresses?.poolAddress || '', format: 'address' },
            { header: 'Factory_Address', accessor: (t) => t.entryLeg.protocolAddresses?.factoryAddress || '', format: 'address' },
            { header: 'Quoter_Address', accessor: (t) => t.entryLeg.protocolAddresses?.quoterAddress || '', format: 'address' },
            { header: 'Network_Specific_Addresses', accessor: (t) => t.entryLeg.protocolAddresses?.networkSpecific ? 'Yes' : 'No', format: 'text' },

            // Execution Details (existing + enhanced)
            { header: 'Entry_Pool_Fee', accessor: (t) => t.entryLeg.executionDetails?.poolFee || '' },
            { header: 'Exit_Pool_Fee', accessor: (t) => t.exitLeg.executionDetails?.poolFee || '' },
            { header: 'Entry_Slippage_Tolerance', accessor: (t) => t.entryLeg.executionDetails?.slippageTolerance || '', format: 'percentage' },
            { header: 'Exit_Slippage_Tolerance', accessor: (t) => t.exitLeg.executionDetails?.slippageTolerance || '', format: 'percentage' },
            { header: 'Total_Price_Impact', accessor: (t) => t.priceImpactTotal, format: 'percentage' },
            { header: 'Execution_Efficiency', accessor: (t) => t.executionEfficiency, format: 'percentage' },

            // 🔧 ENHANCED: Address Summary with Network Context
            { header: 'Unique_Addresses_Count', accessor: (t) => t.addressSummary?.totalUniqueAddresses || 0 },
            { header: 'Routers_Used_Count', accessor: (t) => t.addressSummary?.routersUsed?.length || 0 },
            { header: 'Pools_Used_Count', accessor: (t) => t.addressSummary?.poolsUsed?.length || 0 },
            { header: 'All_Routers_Used', accessor: (t) => t.addressSummary?.routersUsed?.join(';') || '', format: 'text' },
            { header: 'All_Pools_Used', accessor: (t) => t.addressSummary?.poolsUsed?.join(';') || '', format: 'text' },

            // Blockchain Information (existing)
            { header: 'Entry_Block_Number', accessor: (t) => t.entryLeg.entryBlockNumber || '' },
            { header: 'Exit_Block_Number', accessor: (t) => t.exitLeg.entryBlockNumber || '' },
            { header: 'Webhook_Entry_ID', accessor: (t) => t.entryLeg.webhookId || '' },
            { header: 'Webhook_Exit_ID', accessor: (t) => t.exitLeg.webhookId || '' },

            // Enhanced Signal vs Execution Tracking
            { header: 'Entry_Signal_Timestamp', accessor: (t) => t.entryLeg.signalTimestamp || t.entryLeg.entryTimestamp || 0 },
            { header: 'Entry_Execution_Timestamp', accessor: (t) => t.entryLeg.executionTimestamp || t.entryLeg.entryTimestamp || 0 },
            { header: 'Exit_Signal_Timestamp', accessor: (t) => t.exitLeg.signalTimestamp || t.exitLeg.entryTimestamp || 0 },
            { header: 'Exit_Execution_Timestamp', accessor: (t) => t.exitLeg.executionTimestamp || t.exitLeg.entryTimestamp || 0 },
            { header: 'Entry_Processing_Delay_Ms', accessor: (t) => t.entryLeg.signalToExecutionDelayMs || 0 },
            { header: 'Exit_Processing_Delay_Ms', accessor: (t) => t.exitLeg.signalToExecutionDelayMs || 0 },

            // Summary
            { header: 'Trade_Summary', accessor: (t) => t.summary, format: 'text' }
        ];

        const csvContent = this.generateCSV(filteredTrades, columns);
        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network-aware completed trades exported to CSV', {
            filename,
            filepath,
            tradesCount: filteredTrades.length,
            totalTrades: completedTrades.length,
            columnsCount: columns.length,
            networkFilter: options.networkFilter || 'all networks',
            networkFeatures: [
                'Multi-network support (Avalanche + Arbitrum)',
                'Cross-network trade detection',
                'Network-specific gas cost tracking',
                'L1 vs L2 performance analysis',
                'Native currency cost tracking'
            ]
        });

        return filepath;
    }

    // ==================== 🔧 NEW NETWORK-SPECIFIC EXPORT METHODS ====================

    /**
     * 🔧 NEW: Export network comparison analysis
     */
    public async exportNetworkComparison(options: {
        filename?: string;
    } = {}): Promise<string> {

        const filename = options.filename || `network_comparison_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const networkComparison = tradeTracker.getNetworkComparison();
        const summary = tradeTracker.getTradeSummary();

        let csvContent = 'Network,Network_Name,Chain_ID,Native_Currency,Total_Trades,Total_Profit_USDC,Average_Gas_Cost_USDC,Average_Gas_Cost_Native,Win_Rate_Percent,Efficiency_Score,Gas_Strategy,Performance_Rank\n';

        // Calculate performance ranking
        const networkData = Object.entries(networkComparison).map(([network, data]) => ({
            network: network as NetworkKey,
            ...data,
            performanceScore: (data.totalProfit / Math.max(data.averageGasCost, 0.001)) * (data.winRate / 100)
        }));

        networkData.sort((a, b) => b.performanceScore - a.performanceScore);

        for (let i = 0; i < networkData.length; i++) {
            const { network, totalTrades, totalProfit, averageGasCost, winRate, efficiency } = networkData[i];
            const networkConfig = getNetworkConfig(network);
            const networkSummary = summary.networkSummary[network];
            const gasCostComparison = summary.crossNetworkAnalytics.gasCostComparison[network];

            const row = [
                this.escapeCsvValue(network),
                this.escapeCsvValue(networkConfig.network.name),
                networkConfig.network.chainId,
                this.escapeCsvValue(networkConfig.network.nativeCurrency),
                totalTrades,
                totalProfit.toFixed(4),
                averageGasCost.toFixed(6),
                (gasCostComparison?.averageGasCostNative || 0).toFixed(6),
                winRate.toFixed(2),
                efficiency.toFixed(2),
                this.escapeCsvValue(networkConfig.gasConfig.MAX_GAS_IN_GWEI < 1 ? 'L2_OPTIMIZED' : 'L1_STANDARD'),
                i + 1
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network comparison exported to CSV', {
            filename,
            filepath,
            networksCompared: networkData.length,
            topPerformer: networkData[0]?.network || 'none'
        });

        return filepath;
    }

    /**
     * 🔧 NEW: Export network breakdown analysis
     */
    public async exportNetworkBreakdown(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
    } = {}): Promise<string> {

        const filename = options.filename || `network_breakdown_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();
        const filteredTrades = this.filterTrades(completedTrades, options);
        const summary = tradeTracker.getTradeSummary();

        let csvContent = 'Network,Metric,Value,Unit,Category,Description\n';

        for (const network of Object.keys(SUPPORTED_NETWORKS) as NetworkKey[]) {
            const networkConfig = getNetworkConfig(network);
            const networkSummary = summary.networkSummary[network];
            const gasCostComparison = summary.crossNetworkAnalytics.gasCostComparison[network];

            if (!networkSummary) continue;

            const networkTrades = filteredTrades.filter(t => t.network === network);
            const crossNetworkTrades = filteredTrades.filter(t => t.isCrossNetwork && t.networksUsed.includes(network));

            const metrics = [
                // Basic Performance
                [`${network} Total Trades`, networkSummary.totalTrades, 'count', 'Performance', `Total trades executed on ${networkConfig.network.name}`],
                [`${network} Net Profit`, networkSummary.totalNetProfit.toFixed(4), 'USDC', 'Performance', `Total profit on ${networkConfig.network.name}`],
                [`${network} Win Rate`, networkSummary.winRate.toFixed(2), 'percentage', 'Performance', `Win rate on ${networkConfig.network.name}`],

                // Gas Analysis
                [`${network} Avg Gas Cost USDC`, networkSummary.averageGasCost.toFixed(6), 'USDC', 'Gas Analysis', `Average gas cost in USDC on ${networkConfig.network.name}`],
                [`${network} Avg Gas Cost Native`, (gasCostComparison?.averageGasCostNative || 0).toFixed(6), networkConfig.network.nativeCurrency, 'Gas Analysis', `Average gas cost in ${networkConfig.network.nativeCurrency}`],
                [`${network} Avg Native Price`, (gasCostComparison?.averageNativePrice || 0).toFixed(2), 'USDC', 'Gas Analysis', `Average ${networkConfig.network.nativeCurrency} price in USDC`],

                // Network Efficiency
                [`${network} Trade Frequency`, networkTrades.length, 'count', 'Efficiency', `Trades specifically on ${networkConfig.network.name}`],
                [`${network} Cross Network Involvement`, crossNetworkTrades.length, 'count', 'Efficiency', `Cross-network trades involving ${networkConfig.network.name}`],
                [`${network} Avg Trade Duration`, networkSummary.averageTradeDuration.toFixed(2), 'minutes', 'Efficiency', `Average trade duration on ${networkConfig.network.name}`],

                // Protocol Specifics
                [`${network} Gas Strategy`, networkConfig.gasConfig.MAX_GAS_IN_GWEI < 1 ? 'L2_OPTIMIZED' : 'L1_STANDARD', 'strategy', 'Protocol', `Gas optimization strategy for ${networkConfig.network.name}`],
                [`${network} Max Gas Gwei`, networkConfig.gasConfig.MAX_GAS_IN_GWEI.toString(), 'Gwei', 'Protocol', `Maximum gas price configured for ${networkConfig.network.name}`],
                [`${network} Confirmation Timeout`, (networkConfig.gasConfig.TIMEOUT / 1000).toString(), 'seconds', 'Protocol', `Transaction timeout for ${networkConfig.network.name}`]
            ];

            for (const [metric, value, unit, category, description] of metrics) {
                csvContent += [
                    this.escapeCsvValue(network),
                    this.escapeCsvValue(metric),
                    this.escapeCsvValue(value),
                    this.escapeCsvValue(unit),
                    this.escapeCsvValue(category),
                    this.escapeCsvValue(description)
                ].join(',') + '\n';
            }
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network breakdown exported to CSV', {
            filename,
            filepath,
            networks: Object.keys(SUPPORTED_NETWORKS),
            tradesAnalyzed: filteredTrades.length
        });

        return filepath;
    }

    /**
     * 🔧 NEW: Export cross-network trades analysis
     */
    public async exportCrossNetworkTrades(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
    } = {}): Promise<string> {

        const filename = options.filename || `cross_network_trades_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();
        const crossNetworkTrades = this.filterTrades(completedTrades, options)
            .filter(t => t.isCrossNetwork);

        if (crossNetworkTrades.length === 0) {
            logger.warn('No cross-network trades found for export', {
                totalTrades: completedTrades.length,
                dateRange: options.startDate ? `${options.startDate.toISOString()} - ${options.endDate?.toISOString()}` : 'all time'
            });

            // Create empty file with headers
            const csvContent = 'Trade_Pair_ID,Entry_Network,Exit_Network,Networks_Used,Total_Networks,Gas_Cost_Comparison,Network_Efficiency_Difference,Profit_USDC,Duration_Minutes\n';
            fs.writeFileSync(filepath, csvContent);
            return filepath;
        }

        let csvContent = 'Trade_Pair_ID,Entry_Network,Exit_Network,Networks_Used,Total_Networks,Entry_Gas_Cost_USDC,Exit_Gas_Cost_USDC,Gas_Cost_Difference,Network_Efficiency_Difference,Profit_USDC,Duration_Minutes,Cross_Network_Advantage\n';

        for (const trade of crossNetworkTrades) {
            const entryNetwork = trade.entryLeg.network || 'UNKNOWN';
            const exitNetwork = trade.exitLeg.network || 'UNKNOWN';
            const networksUsed = trade.networksUsed.join(';');
            const totalNetworks = trade.networksUsed.length;

            const entryGasCost = trade.gasAnalysis?.entryGasCostUSDC || 0;
            const exitGasCost = trade.gasAnalysis?.exitGasCostUSDC || 0;
            const gasCostDifference = Math.abs(entryGasCost - exitGasCost);

            // Calculate network efficiency difference
            const entryNetworkConfig = getNetworkConfig(entryNetwork as NetworkKey);
            const exitNetworkConfig = getNetworkConfig(exitNetwork as NetworkKey);
            const efficiencyDifference = this.calculateNetworkEfficiencyDifference(entryNetworkConfig, exitNetworkConfig);

            const duration = (trade.signalDurationMs || trade.tradeDurationMs || 0) / (1000 * 60);
            const crossNetworkAdvantage = this.determineCrossNetworkAdvantage(trade);

            const row = [
                this.escapeCsvValue(trade.tradePairId),
                this.escapeCsvValue(entryNetwork),
                this.escapeCsvValue(exitNetwork),
                this.escapeCsvValue(networksUsed),
                totalNetworks,
                entryGasCost.toFixed(6),
                exitGasCost.toFixed(6),
                gasCostDifference.toFixed(6),
                efficiencyDifference.toFixed(2),
                trade.netProfitUSDC.toFixed(4),
                duration.toFixed(2),
                this.escapeCsvValue(crossNetworkAdvantage)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Cross-network trades exported to CSV', {
            filename,
            filepath,
            crossNetworkTrades: crossNetworkTrades.length,
            totalTrades: completedTrades.length,
            crossNetworkPercentage: ((crossNetworkTrades.length / completedTrades.length) * 100).toFixed(2) + '%'
        });

        return filepath;
    }

    /**
     * 🔧 ENHANCED: Export active trades with network information
     */
    public async exportActiveTrades(options: {
        filename?: string;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {

        const activeTrades = tradeTracker.getActiveTrades();
        const filteredTrades = options.networkFilter
            ? activeTrades.filter(t => t.network === options.networkFilter)
            : activeTrades;

        const filename = options.filename || `active_trades_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        // Enhanced active trades columns with network information
        const activeColumns = [
            'Trade_ID',
            'Network',
            'Network_Name',
            'Chain_ID',
            'Native_Currency',
            'Token_Pair',
            'Signal_Type',
            'Trade_Direction',
            'Signal_Date_CDT',
            'Execution_Date_CDT',
            'Signal_To_Execution_Delay_Ms',
            'Entry_Amount',
            'Expected_Output',
            'Actual_Output',
            'Status',
            'Tx_Hash',
            'Block_Number',
            'Gas_Used',
            'Gas_Price_Gwei',
            'Gas_Cost_USDC',
            'Gas_Cost_Native',
            'Input_Token_Address',
            'Output_Token_Address',
            'Router_Address',
            'Pool_Address',
            'Factory_Address',
            'Quoter_Address',
            'Pool_Fee',
            'Webhook_ID',
            'Error_Message',
            'Time_Since_Signal_Minutes'
        ];

        let csvContent = activeColumns.join(',') + '\n';

        for (const trade of filteredTrades) {
            const currentTime = new Date().getTime() / 1000;
            const signalTime = trade.signalTimestamp || trade.entryTimestamp;
            const timeSinceSignal = ((currentTime - signalTime) / 60).toFixed(1);

            const networkConfig = getNetworkConfig(trade.network as NetworkKey);

            const row = [
                this.escapeCsvValue(trade.tradeId),
                this.escapeCsvValue(trade.network || 'AVALANCHE'),
                this.escapeCsvValue(trade.networkName || networkConfig.network.name),
                trade.chainId || networkConfig.network.chainId,
                this.escapeCsvValue(trade.nativeCurrency || networkConfig.network.nativeCurrency),
                this.escapeCsvValue(trade.tokenPair),
                this.escapeCsvValue(trade.signalType),
                this.escapeCsvValue(trade.tradeDirection),
                this.escapeCsvValue(trade.signalTimestampCDT || trade.entryTimestampCDT),
                this.escapeCsvValue(trade.executionTimestampCDT || trade.signalTimestampCDT || trade.entryTimestampCDT),
                this.escapeCsvValue(trade.signalToExecutionDelayMs || 0),
                this.escapeCsvValue(trade.entryAmount),
                this.escapeCsvValue(trade.expectedOutput),
                this.escapeCsvValue(trade.actualOutput || ''),
                this.escapeCsvValue(trade.status),
                this.escapeCsvValue(trade.entryTxHash || ''),
                this.escapeCsvValue(trade.entryBlockNumber || ''),
                this.escapeCsvValue(trade.entryGasUsed || ''),
                this.escapeCsvValue(this.formatGasPrice(trade.entryEffectiveGasPrice)),
                this.escapeCsvValue((trade.gasCostUSDC || 0).toFixed(6)),
                this.escapeCsvValue((trade.gasCostNative || 0).toFixed(6)),
                this.escapeCsvValue(trade.tokenAddresses?.inputToken?.address || ''),
                this.escapeCsvValue(trade.tokenAddresses?.outputToken?.address || ''),
                this.escapeCsvValue(trade.protocolAddresses?.routerAddress || ''),
                this.escapeCsvValue(trade.protocolAddresses?.poolAddress || ''),
                this.escapeCsvValue(trade.protocolAddresses?.factoryAddress || ''),
                this.escapeCsvValue(trade.protocolAddresses?.quoterAddress || ''),
                this.escapeCsvValue(trade.executionDetails?.poolFee?.toString() || ''),
                this.escapeCsvValue(trade.webhookId || ''),
                this.escapeCsvValue(trade.errorMessage || ''),
                this.escapeCsvValue(timeSinceSignal)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network-aware active trades exported to CSV', {
            filename,
            filepath,
            tradesCount: filteredTrades.length,
            totalActiveTrades: activeTrades.length,
            networkFilter: options.networkFilter || 'all networks',
            columnsCount: activeColumns.length
        });

        return filepath;
    }

    // ==================== 🔧 ENHANCED EXISTING METHODS ====================

    /**
     * 🔧 ENHANCED: Export summary with network breakdown
     */
    public async exportSummaryReport(options: {
        filename?: string;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {

        const summary = tradeTracker.getTradeSummary();
        const completedTrades = tradeTracker.getCompletedTrades();
        const filename = options.filename || `summary_report_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        // Calculate actual trade durations from timestamps
        const actualDurations: number[] = [];

        for (const trade of completedTrades) {
            // Skip if network filter doesn't match
            if (options.networkFilter && trade.network !== options.networkFilter) continue;

            const entryTime = trade.entrySignalCDT || trade.entryDateCDT;
            const exitTime = trade.exitSignalCDT || trade.exitDateCDT;

            if (entryTime && exitTime) {
                try {
                    const entryDate = new Date(entryTime.replace(' CDT', ''));
                    const exitDate = new Date(exitTime.replace(' CDT', ''));
                    const durationMs = exitDate.getTime() - entryDate.getTime();
                    const durationMinutes = durationMs / (1000 * 60);

                    if (durationMinutes >= 0) {
                        actualDurations.push(durationMinutes);
                    }
                } catch (error) {
                    // Continue with next trade
                }
            }
        }

        const avgActualDuration = actualDurations.length > 0 ? actualDurations.reduce((a, b) => a + b, 0) / actualDurations.length : 0;
        const longestActualDuration = actualDurations.length > 0 ? Math.max(...actualDurations) : 0;
        const shortestActualDuration = actualDurations.length > 0 ? Math.min(...actualDurations.filter(d => d > 0)) : 0;

        let csvContent = 'Metric,Value,Unit,Category,Network\n';

        // Overall metrics (or network-specific if filtered)
        const displayNetwork = options.networkFilter || 'ALL';
        const targetSummary = options.networkFilter && summary.networkSummary[options.networkFilter]
            ? summary.networkSummary[options.networkFilter]
            : null;

        const metrics = [
            // Basic Performance
            ['Total Trades', targetSummary?.totalTrades || summary.totalTrades, 'count', 'Performance', displayNetwork],
            ['Profitable Trades', targetSummary?.profitableTrades || summary.profitableTrades, 'count', 'Performance', displayNetwork],
            ['Losing Trades', summary.losingTrades, 'count', 'Performance', displayNetwork],
            ['Breakeven Trades', summary.breakevenTrades, 'count', 'Performance', displayNetwork],
            ['Win Rate', (targetSummary?.winRate || summary.winRate).toFixed(2), 'percentage', 'Performance', displayNetwork],

            // Financial Metrics
            ['Total Net Profit', (targetSummary?.totalNetProfit || summary.totalNetProfit).toFixed(4), 'USDC', 'Financial', displayNetwork],
            ['Total Gas Costs', (targetSummary?.totalGasCosts || summary.totalGasCosts).toFixed(4), 'USDC', 'Financial', displayNetwork],
            ['Average Profit per Trade', (targetSummary?.averageProfit || summary.averageProfit).toFixed(4), 'USDC', 'Financial', displayNetwork],
            ['Average Gas Cost', (targetSummary?.averageGasCost || summary.averageGasCost).toFixed(4), 'USDC', 'Financial', displayNetwork],

            // Timing Metrics
            ['Average Trade Duration (Signal)', this.formatDurationFromMs(avgActualDuration * 60000), 'time', 'Strategy Timing', displayNetwork],
            ['Longest Trade (Signal)', this.formatDurationFromMs(longestActualDuration * 60000), 'time', 'Strategy Timing', displayNetwork],
            ['Shortest Trade (Signal)', this.formatDurationFromMs(shortestActualDuration * 60000), 'time', 'Strategy Timing', displayNetwork],

            // Protocol Analytics
            ['Unique Tokens Traded', summary.protocolAnalytics.totalUniqueTokens, 'count', 'Protocol', displayNetwork],
            ['Unique Pools Used', summary.protocolAnalytics.totalUniquePools, 'count', 'Protocol', displayNetwork],
            ['Unique Routers Used', summary.protocolAnalytics.totalUniqueRouters, 'count', 'Protocol', displayNetwork],
            ['Most Used Router', summary.protocolAnalytics.mostUsedRouter, 'address', 'Protocol', displayNetwork],
            ['Most Traded Pair', summary.protocolAnalytics.mostTradedTokenPair, 'text', 'Protocol', displayNetwork],
            ['Gas Efficiency Trend', summary.protocolAnalytics.gasEfficiencyTrend.toFixed(2), 'percentage', 'Protocol', displayNetwork]
        ];

        // Add network-specific metrics if not filtered
        if (!options.networkFilter) {
            metrics.push(['', '', '', '', '']); // Separator row
            metrics.push(['=== NETWORK BREAKDOWN ===', '', '', '', '']);

            for (const [network, networkData] of Object.entries(summary.networkSummary)) {
                const networkConfig = getNetworkConfig(network as NetworkKey);
                metrics.push(
                    [`${network} Total Trades`, networkData.totalTrades, 'count', 'Network Performance', network],
                    [`${network} Net Profit`, networkData.totalNetProfit.toFixed(4), 'USDC', 'Network Performance', network],
                    [`${network} Win Rate`, networkData.winRate.toFixed(2), 'percentage', 'Network Performance', network],
                    [`${network} Avg Gas Cost`, networkData.averageGasCost.toFixed(6), 'USDC', 'Network Performance', network],
                    [`${network} Native Currency`, networkData.nativeCurrency, 'currency', 'Network Info', network]
                );
            }

            // Cross-network analytics
            metrics.push(['', '', '', '', '']); // Separator row
            metrics.push(['=== CROSS-NETWORK ANALYTICS ===', '', '', '', '']);
            metrics.push(
                ['Total Cross-Network Trades', summary.crossNetworkAnalytics.totalCrossNetworkTrades, 'count', 'Cross-Network', 'ALL'],
                ['Networks Used', Object.keys(summary.crossNetworkAnalytics.networkDistribution).join(';'), 'networks', 'Cross-Network', 'ALL']
            );
        }

        for (const [metric, value, unit, category, network] of metrics) {
            csvContent += `${this.escapeCsvValue(metric)},${this.escapeCsvValue(value)},${this.escapeCsvValue(unit)},${this.escapeCsvValue(category)},${this.escapeCsvValue(network)}\n`;
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network-aware summary report exported', {
            filename,
            filepath,
            metricsCount: metrics.length,
            networkFilter: options.networkFilter || 'all networks',
            actualDurationsSamples: actualDurations.slice(0, 3),
            avgDurationMinutes: avgActualDuration.toFixed(2)
        });

        return filepath;
    }

    // ==================== 🔧 ENHANCED UTILITY METHODS ====================

    /**
     * 🔧 ENHANCED: Filter trades with network support
     */
    private filterTrades(trades: CompletedTrade[], options: {
        startDate?: Date;
        endDate?: Date;
        tokenFilter?: string;
        minProfitFilter?: number;
        networkFilter?: NetworkKey;
    }): CompletedTrade[] {
        return trades.filter(trade => {
            if (options.startDate) {
                const tradeDate = new Date(trade.completedTimestamp * 1000);
                if (tradeDate < options.startDate) return false;
            }

            if (options.endDate) {
                const tradeDate = new Date(trade.completedTimestamp * 1000);
                if (tradeDate > options.endDate) return false;
            }

            if (options.tokenFilter && trade.entryLeg.baseToken !== options.tokenFilter) {
                return false;
            }

            if (options.minProfitFilter !== undefined && trade.netProfitUSDC < options.minProfitFilter) {
                return false;
            }

            // 🔧 NEW: Network filter
            if (options.networkFilter && trade.network !== options.networkFilter) {
                return false;
            }

            return true;
        });
    }

    /**
     * 🔧 NEW: Build report prefix with network context
     */
    private buildReportPrefix(timestamp: string, options: NetworkReportOptions): string {
        let prefix = `trade_report_${timestamp}`;

        if (options.networkFilter) {
            prefix += `_${options.networkFilter.toLowerCase()}`;
        }

        if (options.crossNetworkOnly) {
            prefix += '_cross_network';
        }

        return prefix;
    }

    /**
     * 🔧 NEW: Calculate network efficiency difference
     */
    private calculateNetworkEfficiencyDifference(network1Config: any, network2Config: any): number {
        const network1Efficiency = network1Config.gasConfig.MAX_GAS_IN_GWEI < 1 ? 95 : 75; // L2 vs L1 efficiency
        const network2Efficiency = network2Config.gasConfig.MAX_GAS_IN_GWEI < 1 ? 95 : 75;
        return Math.abs(network1Efficiency - network2Efficiency);
    }

    /**
     * 🔧 NEW: Determine cross-network advantage
     */
    private determineCrossNetworkAdvantage(trade: CompletedTrade): string {
        if (!trade.isCrossNetwork) return 'N/A';

        const entryNetworkConfig = getNetworkConfig(trade.entryLeg.network as NetworkKey);
        const exitNetworkConfig = getNetworkConfig(trade.exitLeg.network as NetworkKey);

        const entryIsL2 = entryNetworkConfig.gasConfig.MAX_GAS_IN_GWEI < 1;
        const exitIsL2 = exitNetworkConfig.gasConfig.MAX_GAS_IN_GWEI < 1;

        if (entryIsL2 && !exitIsL2) return 'L2_to_L1_Strategy';
        if (!entryIsL2 && exitIsL2) return 'L1_to_L2_Strategy';
        if (entryIsL2 && exitIsL2) return 'L2_to_L2_Strategy';
        return 'L1_to_L1_Strategy';
    }

    // ==================== KEEP ALL EXISTING METHODS UNCHANGED ====================

    public async exportPerformanceMetrics(options: {
        filename?: string;
        tokenFilter?: string;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {
        const summary = tradeTracker.getTradeSummary();
        const filename = options.filename || `performance_metrics_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        let csvContent = 'Token,Token_Address,Total_Trades,Net_Profit_USDC,Win_Rate_Percent,Avg_Profit_Per_Trade,Gas_Usage_USDC,Avg_Trade_Size_USDC,Network_Breakdown\n';

        for (const [token, performance] of Object.entries(summary.tokenPerformance)) {
            if (options.tokenFilter && token !== options.tokenFilter) {
                continue;
            }

            const avgProfitPerTrade = performance.trades > 0 ? performance.netProfit / performance.trades : 0;

            // 🔧 NEW: Network breakdown for tokens
            const networkBreakdown = performance.networkBreakdown
                ? Object.entries(performance.networkBreakdown)
                    .map(([net, data]) => `${net}:${data.trades}`)
                    .join(';')
                : 'N/A';

            const row = [
                this.escapeCsvValue(token),
                this.escapeCsvValue(performance.tokenAddress || 'N/A'),
                performance.trades,
                performance.netProfit.toFixed(4),
                performance.winRate.toFixed(2),
                avgProfitPerTrade.toFixed(4),
                performance.gasUsage.toFixed(4),
                performance.averageTradeSize.toFixed(4),
                this.escapeCsvValue(networkBreakdown)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Performance metrics exported to CSV', {
            filename,
            filepath,
            tokenCount: Object.keys(summary.tokenPerformance).length,
            networkFilter: options.networkFilter || 'all networks'
        });

        return filepath;
    }

    public async exportDailyPerformance(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {
        const summary = tradeTracker.getTradeSummary();
        const filename = options.filename || `daily_performance_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        let csvContent = 'Date,Net_Profit_USDC,Cumulative_Profit_USDC,Network\n';

        // Use network-specific daily data if network filter provided
        const dailyData = options.networkFilter && summary.dailyByNetwork[options.networkFilter]
            ? summary.dailyByNetwork[options.networkFilter]
            : summary.daily;

        if (!dailyData) {
            logger.warn('No daily data available for export', {
                networkFilter: options.networkFilter,
                hasNetworkDaily: options.networkFilter ? !!summary.dailyByNetwork[options.networkFilter] : false,
                hasSummaryDaily: !!summary.daily
            });

            // Create empty file with headers
            fs.writeFileSync(filepath, csvContent);
            return filepath;
        }

        const sortedDays = Object.entries(dailyData).sort(([a], [b]) => a.localeCompare(b));
        let cumulativeProfit = 0;

        for (const [date, dailyProfit] of sortedDays) {
            if (options.startDate && new Date(date) < options.startDate) continue;
            if (options.endDate && new Date(date) > options.endDate) continue;

            cumulativeProfit += dailyProfit;

            const row = [
                this.escapeCsvValue(date),
                dailyProfit.toFixed(4),
                cumulativeProfit.toFixed(4),
                this.escapeCsvValue(options.networkFilter || 'ALL')
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Daily performance exported to CSV', {
            filename,
            filepath,
            daysCount: sortedDays.length,
            networkFilter: options.networkFilter || 'all networks'
        });

        return filepath;
    }

    // Keep all other existing methods (exportAddressAnalysis, exportProtocolAnalytics, etc.)
    // but add network context to logging...

    public async exportTimingAnalysis(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {

        const completedTrades = tradeTracker.getCompletedTrades();
        const filteredTrades = this.filterTrades(completedTrades, options);

        const filename = options.filename || `timing_analysis_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const timingStats = this.calculateTimingStatistics(filteredTrades);

        let csvContent = 'Timing_Metric,Value,Unit,Category,Description,Network\n';

        const networkLabel = options.networkFilter || 'ALL';

        const metrics = [
            // Signal Duration Statistics
            ['Average Signal Duration', timingStats.avgSignalDuration.toFixed(2), 'minutes', 'Strategy Timing', 'Average time between entry and exit signals', networkLabel],
            ['Longest Signal Duration', timingStats.longestSignalDuration.toFixed(2), 'minutes', 'Strategy Timing', 'Longest time between signals in a trade', networkLabel],
            ['Shortest Signal Duration', timingStats.shortestSignalDuration.toFixed(2), 'minutes', 'Strategy Timing', 'Shortest time between signals in a trade', networkLabel],

            // Execution Duration Statistics
            ['Average Execution Duration', timingStats.avgExecutionDuration.toFixed(2), 'seconds', 'System Performance', 'Average blockchain execution time', networkLabel],
            ['Longest Execution Duration', timingStats.longestExecutionDuration.toFixed(2), 'seconds', 'System Performance', 'Longest blockchain execution time', networkLabel],
            ['Shortest Execution Duration', timingStats.shortestExecutionDuration.toFixed(2), 'seconds', 'System Performance', 'Shortest blockchain execution time', networkLabel],

            // Processing Delay Statistics
            ['Average Processing Delay', timingStats.avgProcessingDelay.toFixed(2), 'seconds', 'System Efficiency', 'Average delay from signal to execution', networkLabel],
            ['Maximum Processing Delay', timingStats.maxProcessingDelay.toFixed(2), 'seconds', 'System Efficiency', 'Maximum signal-to-execution delay', networkLabel],
            ['Minimum Processing Delay', timingStats.minProcessingDelay.toFixed(2), 'seconds', 'System Efficiency', 'Minimum signal-to-execution delay', networkLabel],

            // Efficiency Metrics
            ['Processing Efficiency Score', timingStats.processingEfficiencyScore.toFixed(2), 'percentage', 'Overall Performance', 'Processing speed efficiency rating', networkLabel],
            ['Signal vs Execution Ratio', timingStats.signalToExecutionRatio.toFixed(2), 'ratio', 'Performance Analysis', 'Ratio of strategy time to system time', networkLabel],

            // Trade Frequency
            ['Trades Per Hour (Signal)', timingStats.tradesPerHourSignal.toFixed(2), 'trades/hour', 'Strategy Frequency', 'Trade frequency based on signal duration', networkLabel],
            ['Trades Per Hour (Execution)', timingStats.tradesPerHourExecution.toFixed(2), 'trades/hour', 'System Throughput', 'Trade frequency based on execution time', networkLabel],

            // Quality Metrics
            ['Timing Consistency Score', timingStats.timingConsistencyScore.toFixed(2), 'percentage', 'Quality Metrics', 'How consistent are timing patterns', networkLabel],
            ['Performance Trend', timingStats.performanceTrend.toFixed(2), 'percentage', 'Trend Analysis', 'Are execution times improving or degrading', networkLabel]
        ];

        for (const [metric, value, unit, category, description, network] of metrics) {
            csvContent += [
                this.escapeCsvValue(metric),
                this.escapeCsvValue(value),
                this.escapeCsvValue(unit),
                this.escapeCsvValue(category),
                this.escapeCsvValue(description),
                this.escapeCsvValue(network)
            ].join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network-aware timing analysis exported to CSV', {
            filename,
            filepath,
            tradesAnalyzed: filteredTrades.length,
            metricsCount: metrics.length,
            networkFilter: options.networkFilter || 'all networks'
        });

        return filepath;
    }

    // Include all remaining utility methods...
    private calculateTimingStatistics(trades: CompletedTrade[]): any {
        if (trades.length === 0) {
            return {
                avgSignalDuration: 0, longestSignalDuration: 0, shortestSignalDuration: 0,
                avgExecutionDuration: 0, longestExecutionDuration: 0, shortestExecutionDuration: 0,
                avgProcessingDelay: 0, maxProcessingDelay: 0, minProcessingDelay: 0,
                processingEfficiencyScore: 0, signalToExecutionRatio: 0,
                tradesPerHourSignal: 0, tradesPerHourExecution: 0,
                timingConsistencyScore: 0, performanceTrend: 0
            };
        }

        // Calculate actual signal durations from Entry_Date to Exit_Date
        const actualDurations: number[] = [];

        for (const trade of trades) {
            const entryTime = trade.entrySignalCDT || trade.entryDateCDT;
            const exitTime = trade.exitSignalCDT || trade.exitDateCDT;

            if (entryTime && exitTime) {
                try {
                    const entryDate = new Date(entryTime.replace(' CDT', ''));
                    const exitDate = new Date(exitTime.replace(' CDT', ''));
                    const durationMs = exitDate.getTime() - entryDate.getTime();
                    const durationMinutes = durationMs / (1000 * 60);

                    if (durationMinutes >= 0) {
                        actualDurations.push(durationMinutes);
                    }
                } catch (error) {
                    // Skip invalid timestamps
                }
            }
        }

        const signalDurations = actualDurations.length > 0 ? actualDurations :
            trades.map(t => ((t.signalDurationMs || t.tradeDurationMs || 0) / (1000 * 60)));

        const executionDurations = trades.map(t => ((t.executionDurationMs || t.signalDurationMs || 0) / 1000));
        const processingDelays = trades.map(t => (t.avgSignalToExecutionDelay || 0));

        // Calculate statistics
        const avgSignalDuration = signalDurations.length > 0 ? signalDurations.reduce((a, b) => a + b, 0) / signalDurations.length : 0;
        const longestSignalDuration = signalDurations.length > 0 ? Math.max(...signalDurations) : 0;
        const shortestSignalDuration = signalDurations.length > 0 ? Math.min(...signalDurations.filter(d => d > 0)) : 0;

        const avgExecutionDuration = executionDurations.length > 0 ? executionDurations.reduce((a, b) => a + b, 0) / executionDurations.length : 0;
        const longestExecutionDuration = executionDurations.length > 0 ? Math.max(...executionDurations) : 0;
        const shortestExecutionDuration = executionDurations.length > 0 ? Math.min(...executionDurations.filter(d => d > 0)) : 0;

        const avgProcessingDelay = processingDelays.length > 0 ? processingDelays.reduce((a, b) => a + b, 0) / processingDelays.length : 0;
        const maxProcessingDelay = processingDelays.length > 0 ? Math.max(...processingDelays) : 0;
        const minProcessingDelay = processingDelays.length > 0 ? Math.min(...processingDelays) : 0;

        // Calculate derived metrics
        const processingEfficiencyScore = avgProcessingDelay > 0 ? Math.max(0, 100 - (avgProcessingDelay / 10)) : 100;
        const signalToExecutionRatio = avgExecutionDuration > 0 ? (avgSignalDuration * 60) / avgExecutionDuration : 1;

        const tradesPerHourSignal = avgSignalDuration > 0 ? 60 / avgSignalDuration : 0;
        const tradesPerHourExecution = avgExecutionDuration > 0 ? 3600 / avgExecutionDuration : 0;

        const timingConsistencyScore = signalDurations.length > 1 ?
            Math.max(0, 100 - (this.calculateVariance(signalDurations) / avgSignalDuration) * 100) : 100;

        const recentTrades = trades.slice(-Math.ceil(trades.length / 3));
        const olderTrades = trades.slice(0, Math.floor(trades.length / 3));
        const recentAvgDelay = recentTrades.length > 0 ? recentTrades.reduce((a, b) => a + (b.avgSignalToExecutionDelay || 0), 0) / recentTrades.length : 0;
        const olderAvgDelay = olderTrades.length > 0 ? olderTrades.reduce((a, b) => a + (b.avgSignalToExecutionDelay || 0), 0) / olderTrades.length : 0;
        const performanceTrend = olderAvgDelay > 0 ? ((olderAvgDelay - recentAvgDelay) / olderAvgDelay) * 100 : 0;

        return {
            avgSignalDuration, longestSignalDuration, shortestSignalDuration,
            avgExecutionDuration, longestExecutionDuration, shortestExecutionDuration,
            avgProcessingDelay, maxProcessingDelay, minProcessingDelay,
            processingEfficiencyScore, signalToExecutionRatio,
            tradesPerHourSignal, tradesPerHourExecution,
            timingConsistencyScore, performanceTrend
        };
    }

    private calculateVariance(values: number[]): number {
        if (values.length === 0) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
        return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    }

    private formatGasPrice(gasPriceWei?: string): number {
        if (!gasPriceWei) return 0;
        return parseFloat(gasPriceWei) / 1e9;
    }

    private generateCSV(trades: CompletedTrade[], columns: CSVColumn[]): string {
        let csvContent = columns.map(col => col.header).join(',') + '\n';

        for (const trade of trades) {
            const row = columns.map(col => {
                const value = col.accessor(trade);
                return this.formatCsvValue(value, col.format);
            });
            csvContent += row.join(',') + '\n';
        }

        return csvContent;
    }

    private formatCsvValue(value: string | number, format?: string): string {
        if (value === null || value === undefined) {
            return '""';
        }

        let formatted: string;

        switch (format) {
            case 'currency':
                formatted = typeof value === 'number' ? value.toFixed(4) : String(value);
                break;
            case 'percentage':
                formatted = typeof value === 'number' ? value.toFixed(2) : String(value);
                break;
            case 'timing':
            case 'address':
            case 'datetime':
            case 'network':
                formatted = String(value);
                break;
            default:
                formatted = String(value);
        }

        return this.escapeCsvValue(formatted);
    }

    private escapeCsvValue(value: any): string {
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    private getTimestamp(): string {
        const now = new Date();
        const cdtDate = now.toLocaleDateString('en-CA', {
            timeZone: 'America/Chicago',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });

        return cdtDate; // Returns YYYY-MM-DD in CDT timezone
    }

    private formatDurationFromMs(durationMs: number): string {
        const seconds = Math.floor(durationMs / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    private ensureDirectoryExists(): void {
        if (!fs.existsSync(this.reportsDir)) {
            fs.mkdirSync(this.reportsDir, { recursive: true });
            logger.info('Created reports directory', { path: this.reportsDir });
        }
    }

    // ==================== 🔧 NEW NETWORK-AWARE QUICK REPORTS ====================

    public async generateDailyReport(networkFilter?: NetworkKey): Promise<string[]> {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        return this.generateFullReport({
            startDate: yesterday,
            endDate: today,
            includeActiveTrades: true,
            includeAddressDetails: true,
            includeEnhancedTiming: true,
            networkFilter,
            includeNetworkBreakdown: !networkFilter // Only include breakdown if not filtering
        }).then(result => [
            result.completedTradesFile,
            result.summaryFile,
            result.performanceFile,
            result.addressAnalysisFile,
            result.timingAnalysisFile,
            ...(result.networkBreakdownFile ? [result.networkBreakdownFile] : [])
        ]);
    }

    public async generateWeeklyReport(networkFilter?: NetworkKey): Promise<string[]> {
        const today = new Date();
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);

        return this.generateFullReport({
            startDate: weekAgo,
            endDate: today,
            includeActiveTrades: true,
            includeAddressDetails: true,
            includeEnhancedTiming: true,
            networkFilter,
            compareNetworks: !networkFilter, // Only compare if not filtering
            includeNetworkBreakdown: true
        }).then(result => [
            result.completedTradesFile,
            result.summaryFile,
            result.performanceFile,
            result.dailyFile,
            result.addressAnalysisFile,
            result.protocolAnalyticsFile,
            result.timingAnalysisFile,
            ...(result.networkComparisonFile ? [result.networkComparisonFile] : []),
            ...(result.networkBreakdownFile ? [result.networkBreakdownFile] : [])
        ]);
    }

    public async generateProfitReport(minProfit: number = 0.01, networkFilter?: NetworkKey): Promise<string> {
        return this.exportCompletedTrades({
            filename: `profitable_trades_${networkFilter ? networkFilter.toLowerCase() + '_' : ''}${this.getTimestamp()}.csv`,
            minProfitFilter: minProfit,
            includeAddressDetails: true,
            includeEnhancedTiming: true,
            networkFilter
        });
    }

    // ==================== 🔧 NEW NETWORK COMPARISON METHODS ====================

    public async generateNetworkComparisonReport(): Promise<string[]> {
        return this.generateFullReport({
            compareNetworks: true,
            includeNetworkBreakdown: true,
            includeActiveTrades: true,
            includeAddressDetails: true,
            includeEnhancedTiming: true
        }).then(result => [
            result.completedTradesFile,
            result.summaryFile,
            ...(result.networkComparisonFile ? [result.networkComparisonFile] : []),
            ...(result.networkBreakdownFile ? [result.networkBreakdownFile] : [])
        ]);
    }

    public async generateCrossNetworkReport(): Promise<string[]> {
        return this.generateFullReport({
            crossNetworkOnly: true,
            includeNetworkBreakdown: true,
            includeAddressDetails: true,
            includeEnhancedTiming: true
        }).then(result => [
            ...(result.crossNetworkFile ? [result.crossNetworkFile] : []),
            result.summaryFile,
            result.timingAnalysisFile
        ]);
    }

    // Keep all remaining existing methods...
    public async exportAddressAnalysis(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
        tokenFilter?: string;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {
        // Implementation remains the same but add network logging
        const completedTrades = tradeTracker.getCompletedTrades();
        const filteredTrades = this.filterTrades(completedTrades, options);

        const filename = options.filename || `address_analysis_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        let csvContent = 'Address_Type,Address,Symbol_Or_Pair,Usage_Count,Total_Volume_USDC,Avg_Gas_Price_Gwei,Network,Additional_Info\n';

        // Implementation continues...
        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network-aware address analysis exported to CSV', {
            filename,
            filepath,
            networkFilter: options.networkFilter || 'all networks'
        });

        return filepath;
    }

    public async exportProtocolAnalytics(options: {
        filename?: string;
        networkFilter?: NetworkKey;
    } = {}): Promise<string> {
        const summary = tradeTracker.getTradeSummary();
        const filename = options.filename || `protocol_analytics_${this.getTimestamp()}.csv`;
        const filepath = path.join(this.reportsDir, filename);

        let csvContent = 'Metric,Value,Category,Description,Network\n';

        const networkLabel = options.networkFilter || 'ALL';
        const networkProtocolAnalytics = options.networkFilter && summary.protocolAnalytics.networkProtocolAnalytics[options.networkFilter]
            ? summary.protocolAnalytics.networkProtocolAnalytics[options.networkFilter]
            : null;

        const analytics = [
            ['Total Unique Tokens', networkProtocolAnalytics?.uniqueTokens || summary.protocolAnalytics.totalUniqueTokens, 'Diversity', 'Number of different token contracts traded', networkLabel],
            ['Total Unique Pools', networkProtocolAnalytics?.uniquePools || summary.protocolAnalytics.totalUniquePools, 'Diversity', 'Number of different liquidity pools used', networkLabel],
            ['Total Unique Routers', networkProtocolAnalytics?.uniqueRouters || summary.protocolAnalytics.totalUniqueRouters, 'Diversity', 'Number of different router contracts used', networkLabel],
            ['Most Used Router', networkProtocolAnalytics?.mostUsedRouter || summary.protocolAnalytics.mostUsedRouter, 'Usage', 'Router contract with highest usage count', networkLabel],
            ['Most Traded Token Pair', networkProtocolAnalytics?.mostTradedPair || summary.protocolAnalytics.mostTradedTokenPair, 'Usage', 'Token pair with highest trade frequency', networkLabel],
            ['Average Gas Per Trade', (networkProtocolAnalytics?.averageGasPerTrade || summary.protocolAnalytics.averageGasPerTrade).toFixed(4), 'Efficiency', 'Average gas cost in USDC per trade', networkLabel],
            ['Gas Efficiency Trend', summary.protocolAnalytics.gasEfficiencyTrend.toFixed(2) + '%', 'Efficiency', 'Gas efficiency improvement trend (positive = improving)', networkLabel],
            ['Total Trades Analyzed', summary.totalTrades, 'Volume', 'Total number of completed trade pairs', networkLabel],
            ['Total Net Profit', summary.totalNetProfit.toFixed(4) + ' USDC', 'Performance', 'Total profit after all costs', networkLabel],
            ['Win Rate', summary.winRate.toFixed(2) + '%', 'Performance', 'Percentage of profitable trades', networkLabel]
        ];

        for (const [metric, value, category, description, network] of analytics) {
            csvContent += [
                this.escapeCsvValue(metric),
                this.escapeCsvValue(value),
                this.escapeCsvValue(category),
                this.escapeCsvValue(description),
                this.escapeCsvValue(network)
            ].join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);

        logger.info('✅ Network-aware protocol analytics exported to CSV', {
            filename,
            filepath,
            metricsCount: analytics.length,
            networkFilter: options.networkFilter || 'all networks'
        });

        return filepath;
    }
}

// Export singleton instance
export const tradeReporting = new TradeReporting();