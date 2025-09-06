// src/tradeReporting.ts - FIXED DATA MAPPING v7.3.0 - COMPATIBLE WITH FIXED TRACKER
// 🔧 CRITICAL FIX: Now fully compatible with fixed tradeTracker.ts data structure
// 🔧 FIXED: All address fields, transaction hashes, and metadata properly extracted
// 🔧 ENHANCED: Comprehensive null safety and error handling maintained

import fs from 'fs';
import path from 'path';
import { tradeTracker, type TradeEntry, type CompletedTrade, type TradeSummary, type TokenPerformanceData } from './tradeTracker';
import logger from './logger';

// ==================== 🔧 ENHANCED REPORTING TYPES ====================

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
    format?: 'currency' | 'percentage' | 'duration' | 'datetime' | 'text' | 'address' | 'timing';
}

export interface ReportFiles {
    completedTradesFile: string;
    activeTradesFile?: string;
    summaryFile: string;
    performanceFile: string;
    protocolAnalyticsFile: string;
    dailyFile: string;
    addressAnalysisFile: string;
    timingAnalysisFile: string;
}

// ==================== 🔧 TRADE REPORTING CLASS - FIXED COMPATIBILITY ====================

class TradeReporting {
    private readonly reportsDir: string;

    constructor() {
        this.reportsDir = path.join(process.cwd(), 'data', 'reports');
        this.ensureDirectoryExists();

        logger.info('🔧 FIXED TradeReporting v7.3.0 - COMPATIBLE WITH FIXED TRACKER', {
            reportsDir: this.reportsDir,
            fixes: [
                '✅ FIXED: Full compatibility with fixed tradeTracker.ts data structure',
                '✅ FIXED: All address fields now properly extracted from flat structure',
                '✅ FIXED: Transaction hashes and metadata correctly mapped',
                '✅ FIXED: Date/time fields properly formatted and extracted',
                '✅ FIXED: Compatible with mainUniswap.ts tradeDirection parameter',
                '✅ ENHANCED: Complete null safety with comprehensive error prevention',
                '✅ MAINTAINED: Full backward compatibility with existing interfaces'
            ]
        });
    }

    private ensureDirectoryExists(): void {
        if (!fs.existsSync(this.reportsDir)) {
            fs.mkdirSync(this.reportsDir, { recursive: true });
            logger.info('Created reports directory', { path: this.reportsDir });
        }
    }

    // ==================== 🔧 ENHANCED UTILITY METHODS ====================

    private getTimestamp(): string {
        return new Date().toISOString().split('T')[0];
    }

    private escapeCsvValue(value: any): string {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    private formatNumber(value: number | undefined | null, decimals: number = 4): string {
        if (value === null || value === undefined || isNaN(Number(value))) {
            return '0.' + '0'.repeat(decimals);
        }
        return Number(value).toFixed(decimals);
    }

    private formatPercentage(value: number | undefined | null, decimals: number = 2): string {
        if (value === null || value === undefined || isNaN(Number(value))) {
            return '0.' + '0'.repeat(decimals);
        }
        return Number(value).toFixed(decimals);
    }

    private safeNumericValue(value: any, defaultValue: number = 0): number {
        if (value === null || value === undefined || value === '' || isNaN(Number(value))) {
            return defaultValue;
        }
        return Number(value);
    }

    private safeStringValue(value: any, defaultValue: string = 'N/A'): string {
        if (value === null || value === undefined || value === '') {
            return defaultValue;
        }
        return String(value);
    }

    private formatDateTime(value: any): string {
        if (!value || value === 'N/A') return 'N/A';

        try {
            // Handle different date formats
            if (typeof value === 'number') {
                return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
            } else if (typeof value === 'string') {
                // If already formatted, return as is
                if (value.includes(' ') && !value.includes('T')) {
                    return value;
                }
                // Convert ISO to space format
                return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
            }
            return 'N/A';
        } catch (error) {
            return 'N/A';
        }
    }

    // ==================== 🔧 COMPLETED TRADES CSV HEADERS ====================

    private getCompletedTradesHeaders(): string[] {
        return [
            'Trade_Pair_ID',
            'Token_Pair',
            'Entry_Signal_Date_CDT',
            'Exit_Signal_Date_CDT',
            'Signal_Duration',
            'Signal_Duration_Minutes',
            'Entry_Execution_Date_CDT',
            'Exit_Execution_Date_CDT',
            'Execution_Duration',
            'Execution_Duration_Seconds',
            'Avg_Processing_Delay_Seconds',
            'Total_Processing_Time_Seconds',
            'Entry_Date',
            'Exit_Date',
            'Trade_Duration',
            'Entry_Signal',
            'Exit_Signal',
            'Exit_Reason',
            'Entry_Amount_USDC',
            'Exit_Amount_USDC',
            'Gross_Profit_USDC',
            'Gas_Cost_USDC',
            'Net_Profit_USDC',
            'Profit_Percentage',
            'Trade_Category',
            'Expected_Gross_Profit_USDC',
            'Actual_Vs_Expected_Difference',
            'Actual_Vs_Expected_Percent',
            'Total_Slippage_Impact',
            'Entry_Tx_Hash',
            'Exit_Tx_Hash',
            'Entry_Gas_Used',
            'Exit_Gas_Used',
            'Entry_Gas_Price_Gwei',
            'Exit_Gas_Price_Gwei',
            'Avg_Gas_Price_Gwei',
            'Gas_Efficiency_Percent',
            'Entry_Gas_Cost_USDC',
            'Exit_Gas_Cost_USDC',
            'Entry_Input_Token_Address',
            'Entry_Output_Token_Address',
            'Exit_Input_Token_Address',
            'Exit_Output_Token_Address',
            'Entry_Router_Address',
            'Exit_Router_Address',
            'Entry_Pool_Address',
            'Exit_Pool_Address',
            'Factory_Address',
            'Quoter_Address',
            'Entry_Pool_Fee',
            'Exit_Pool_Fee',
            'Entry_Slippage_Tolerance',
            'Exit_Slippage_Tolerance',
            'Total_Price_Impact',
            'Execution_Efficiency',
            'Unique_Addresses_Count',
            'Routers_Used_Count',
            'Pools_Used_Count',
            'All_Routers_Used',
            'All_Pools_Used',
            'Entry_Block_Number',
            'Exit_Block_Number',
            'Webhook_Entry_ID',
            'Webhook_Exit_ID',
            'Entry_Signal_Timestamp',
            'Entry_Execution_Timestamp',
            'Exit_Signal_Timestamp',
            'Exit_Execution_Timestamp',
            'Entry_Processing_Delay_Ms',
            'Exit_Processing_Delay_Ms',
            'Trade_Summary'
        ];
    }

    // ==================== 🔧 FIXED: COMPLETED TRADE ROW FORMATTING ====================

    private formatCompletedTradeRow(trade: CompletedTrade): (string | number)[] {
        // 🔧 CRITICAL FIX: Validate trade object first
        if (!trade) {
            logger.error('Null or undefined trade object passed to formatCompletedTradeRow');
            return new Array(this.getCompletedTradesHeaders().length).fill('ERROR');
        }

        try {
            return [
                // Basic trade info
                this.escapeCsvValue(trade.tradePairId || 'N/A'),
                this.escapeCsvValue(trade.tokenPair || 'Unknown'),

                // 🔧 FIXED: Date/time fields - now properly extracted from flat structure
                this.formatDateTime(trade.entrySignalDateCDT || trade.entrySignalDate),
                this.formatDateTime(trade.exitSignalDateCDT || trade.exitSignalDate),
                this.escapeCsvValue(trade.signalDuration || 'N/A'),
                this.safeNumericValue(trade.signalDurationMinutes, 0),
                this.formatDateTime(trade.entryExecutionDateCDT || trade.entryExecutionDate),
                this.formatDateTime(trade.exitExecutionDateCDT || trade.exitExecutionDate),
                this.escapeCsvValue(trade.executionDuration || 'N/A'),
                this.safeNumericValue(trade.executionDurationSeconds, 0),
                this.safeNumericValue(trade.avgProcessingDelaySeconds, 0),
                this.safeNumericValue(trade.totalProcessingTimeSeconds, 0),

                // Entry/Exit dates (legacy format)
                this.escapeCsvValue(trade.entrySignalDate || 'N/A'),
                this.escapeCsvValue(trade.exitSignalDate || 'N/A'),
                this.escapeCsvValue(trade.tradeDuration || 'N/A'),

                // Trade signals and amounts
                this.escapeCsvValue(trade.entrySignal || 'Unknown'),
                this.escapeCsvValue(trade.exitSignal || 'Unknown'),
                this.escapeCsvValue(trade.exitReason || 'Unknown'),
                this.formatNumber(trade.entryAmountUSDC, 4),
                this.formatNumber(trade.exitAmountUSDC, 4),

                // P&L calculations
                this.formatNumber(trade.grossProfitUSDC, 4),
                this.formatNumber(trade.gasCostUSDC, 4),
                this.formatNumber(trade.netProfitUSDC, 4),
                this.formatPercentage(trade.profitPercentage, 2),
                this.escapeCsvValue(trade.tradeCategory || 'Unknown'),
                this.formatNumber(trade.expectedGrossProfitUSDC, 4),
                this.formatNumber(trade.actualVsExpectedDifference, 4),
                this.formatPercentage(trade.actualVsExpectedPercent, 2),
                this.formatNumber(trade.totalSlippageImpact, 4),

                // 🔧 FIXED: Transaction hashes - now properly extracted from flat structure
                this.escapeCsvValue(trade.entryTxHash || 'N/A'),
                this.escapeCsvValue(trade.exitTxHash || 'N/A'),
                this.safeNumericValue(trade.entryGasUsed, 0),
                this.safeNumericValue(trade.exitGasUsed, 0),
                this.safeNumericValue(trade.entryGasPrice, 0),
                this.safeNumericValue(trade.exitGasPrice, 0),
                this.safeNumericValue((trade.entryGasPrice || 0) + (trade.exitGasPrice || 0) / 2, 0), // Avg gas price
                this.safeNumericValue(trade.executionEfficiency, 100), // Gas efficiency placeholder
                this.formatNumber(trade.entryGasCostUSDC, 4),
                this.formatNumber(trade.exitGasCostUSDC, 4),

                // 🔧 FIXED: All address fields - now properly extracted from flat structure
                this.escapeCsvValue(trade.entryInputTokenAddress || 'N/A'),
                this.escapeCsvValue(trade.entryOutputTokenAddress || 'N/A'),
                this.escapeCsvValue(trade.exitInputTokenAddress || 'N/A'),
                this.escapeCsvValue(trade.exitOutputTokenAddress || 'N/A'),
                this.escapeCsvValue(trade.entryRouterAddress || 'N/A'),
                this.escapeCsvValue(trade.exitRouterAddress || 'N/A'),
                this.escapeCsvValue(trade.entryPoolAddress || 'N/A'),
                this.escapeCsvValue(trade.exitPoolAddress || 'N/A'),
                this.escapeCsvValue(trade.factoryAddress || 'N/A'),
                this.escapeCsvValue(trade.quoterAddress || 'N/A'),

                // Pool and execution details
                this.safeNumericValue(trade.entryPoolFee, 0),
                this.safeNumericValue(trade.exitPoolFee, 0),
                this.safeNumericValue(trade.entrySlippageTolerance, 0),
                this.safeNumericValue(trade.exitSlippageTolerance, 0),
                this.safeNumericValue(trade.totalPriceImpact, 0),
                this.safeNumericValue(trade.executionEfficiency, 0),

                // Protocol analytics
                this.safeNumericValue(trade.uniqueAddressesCount, 0),
                this.safeNumericValue(trade.routersUsedCount, 0),
                this.safeNumericValue(trade.poolsUsedCount, 0),
                this.escapeCsvValue(trade.allRoutersUsed || 'N/A'),
                this.escapeCsvValue(trade.allPoolsUsed || 'N/A'),

                // Block information
                this.safeNumericValue(trade.entryBlockNumber, 0),
                this.safeNumericValue(trade.exitBlockNumber, 0),

                // 🔧 FIXED: Webhook tracking - now properly extracted from flat structure
                this.escapeCsvValue(trade.webhookEntryId || 'N/A'),
                this.escapeCsvValue(trade.webhookExitId || 'N/A'),
                this.safeNumericValue(trade.entrySignalTimestamp, 0),
                this.safeNumericValue(trade.entryExecutionTimestamp, 0),
                this.safeNumericValue(trade.exitSignalTimestamp, 0),
                this.safeNumericValue(trade.exitExecutionTimestamp, 0),
                this.safeNumericValue(trade.entryProcessingDelayMs, 0),
                this.safeNumericValue(trade.exitProcessingDelayMs, 0),

                // Trade summary
                this.escapeCsvValue(trade.tradeSummary || 'N/A')
            ];
        } catch (error) {
            logger.error('Error formatting trade row', {
                error: error instanceof Error ? error.message : String(error),
                tradePairId: trade.tradePairId || 'Unknown',
                tradeKeys: Object.keys(trade || {}),
                hasAddresses: !!(trade.entryInputTokenAddress && trade.entryRouterAddress)
            });

            // Return error row with the same number of columns
            const headers = this.getCompletedTradesHeaders();
            const errorRow = new Array(headers.length).fill('ERROR');
            errorRow[0] = trade.tradePairId || 'ERROR_TRADE';
            errorRow[1] = trade.tokenPair || 'ERROR';
            return errorRow;
        }
    }

    // ==================== 🔧 ENHANCED EXPORT COMPLETED TRADES ====================

    public async exportCompletedTrades(options: {
        filename?: string;
        startDate?: Date;
        endDate?: Date;
        tokenFilter?: string;
        minProfitFilter?: number;
    } = {}): Promise<string> {
        try {
            const filename = options.filename || `trade_report_${this.getTimestamp()}_completed_trades.csv`;
            const filepath = path.join(this.reportsDir, filename);

            const completedTrades = tradeTracker.getCompletedTrades();

            logger.info('🔧 FIXED: Starting CSV export with complete data mapping', {
                totalTrades: completedTrades.length,
                filename,
                sampleTradeData: completedTrades.length > 0 ? {
                    tradePairId: completedTrades[0].tradePairId,
                    hasAddresses: !!(completedTrades[0].entryInputTokenAddress && completedTrades[0].entryRouterAddress),
                    hasTransactionData: !!(completedTrades[0].entryTxHash && completedTrades[0].entryTxHash !== 'N/A'),
                    hasTimingData: !!(completedTrades[0].entrySignalDateCDT && completedTrades[0].entrySignalDateCDT !== 'N/A')
                } : 'No trades'
            });

            // Filter trades if options provided
            let filteredTrades = completedTrades;

            if (options.startDate || options.endDate || options.tokenFilter || options.minProfitFilter !== undefined) {
                filteredTrades = completedTrades.filter(trade => {
                    // Date filtering
                    if (options.startDate || options.endDate) {
                        const tradeDate = new Date(trade.entrySignalDate || 0);
                        if (options.startDate && tradeDate < options.startDate) return false;
                        if (options.endDate && tradeDate > options.endDate) return false;
                    }

                    // Token filtering
                    if (options.tokenFilter && !trade.tokenPair.toLowerCase().includes(options.tokenFilter.toLowerCase())) {
                        return false;
                    }

                    // Profit filtering
                    if (options.minProfitFilter !== undefined && (trade.netProfitUSDC || 0) < options.minProfitFilter) {
                        return false;
                    }

                    return true;
                });
            }

            // Generate CSV content
            const headers = this.getCompletedTradesHeaders();
            let csvContent = headers.join(',') + '\n';

            for (const trade of filteredTrades) {
                const row = this.formatCompletedTradeRow(trade);
                csvContent += row.join(',') + '\n';
            }

            // Write file
            fs.writeFileSync(filepath, csvContent);

            logger.info('🔧 FIXED: Completed trades exported successfully', {
                filename,
                filepath,
                totalTrades: filteredTrades.length,
                dataValidation: {
                    hasNonNAAddresses: filteredTrades.filter(t => t.entryInputTokenAddress && t.entryInputTokenAddress !== 'N/A').length,
                    hasNonNAHashes: filteredTrades.filter(t => t.entryTxHash && t.entryTxHash !== 'N/A').length,
                    hasNonNADates: filteredTrades.filter(t => t.entrySignalDateCDT && t.entrySignalDateCDT !== 'N/A').length
                }
            });

            return filepath;
        } catch (error) {
            logger.error('Error exporting completed trades', {
                error: error instanceof Error ? error.message : String(error),
                filename: options.filename || 'default_filename'
            });
            throw error;
        }
    }

    // ==================== 🔧 EXPORT ACTIVE TRADES ====================

    public async exportActiveTrades(options: {
        filename?: string;
    } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_active_trades.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const activeTrades = tradeTracker.getActiveTrades();

        const headers = [
            'Trade_ID',
            'Entry_Signal',
            'Product',
            'Network',
            'Exchange',
            'Trade_Direction',
            'Entry_Amount',
            'Signal_Timestamp',
            'Execution_Timestamp',
            'Entry_Tx_Hash',
            'Entry_Router_Address',
            'Entry_Pool_Address',
            'Status',
            'Webhook_ID'
        ];

        let csvContent = headers.join(',') + '\n';

        for (const trade of activeTrades) {
            const row = [
                this.escapeCsvValue(trade.tradeId || 'N/A'),
                this.escapeCsvValue(trade.entrySignal || 'Unknown'),
                this.escapeCsvValue(trade.product || 'Unknown'),
                this.escapeCsvValue(trade.network || 'Unknown'),
                this.escapeCsvValue(trade.exchange || 'Unknown'),
                this.escapeCsvValue(trade.tradeDirection || 'Unknown'),
                this.safeStringValue(trade.entryAmount, 'N/A'),
                this.safeNumericValue(trade.signalTimestamp, 0),
                this.safeNumericValue(trade.executionTimestamp, 0),
                this.escapeCsvValue(trade.entryTxHash || 'N/A'),
                this.escapeCsvValue(trade.protocolAddresses?.routerAddress || 'N/A'),
                this.escapeCsvValue(trade.protocolAddresses?.poolAddress || 'N/A'),
                'Active',
                this.escapeCsvValue(trade.webhookId || 'N/A')
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Active trades exported', { filename, filepath, tradeCount: activeTrades.length });
        return filepath;
    }

    // ==================== 🔧 EXPORT SUMMARY REPORT ====================

    public async exportSummaryReport(options: {
        filename?: string;
    } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_summary.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const summary = tradeTracker.getTradeSummary();

        const headers = [
            'Metric',
            'Value',
            'Unit',
            'Description'
        ];

        let csvContent = headers.join(',') + '\n';

        const metrics = [
            ['Total Trades', summary.totalTrades, 'count', 'Total number of completed trades'],
            ['Active Trades', summary.activeTrades, 'count', 'Currently active unmatched trades'],
            ['Completed Trades', summary.completedTrades, 'count', 'Successfully matched trade pairs'],
            ['Total Net Profit', this.formatNumber(summary.totalNetProfit, 4), 'USDC', 'Total profit after all costs'],
            ['Total Gross Profit', this.formatNumber(summary.totalGrossProfitUSDC, 4), 'USDC', 'Total profit before gas costs'],
            ['Total Gas Costs', this.formatNumber(summary.totalGasCostUSDC, 4), 'USDC', 'Total gas fees paid'],
            ['Win Rate', this.formatPercentage(summary.winRate, 2), '%', 'Percentage of profitable trades'],
            ['Average Trade Profit', this.formatNumber(summary.averageTradeProfit, 4), 'USDC', 'Average profit per trade'],
            ['Average Trade Duration', this.formatNumber(summary.averageTradeDuration / 60000, 2), 'minutes', 'Average time from entry to exit'],
            ['Best Trade', this.formatNumber(summary.bestTrade, 4), 'USDC', 'Most profitable single trade'],
            ['Worst Trade', this.formatNumber(summary.worstTrade, 4), 'USDC', 'Least profitable single trade'],
            ['Total Volume', this.formatNumber(summary.totalVolume, 2), 'USDC', 'Total trading volume'],
            ['Profitable Trades', summary.profitableTrades, 'count', 'Number of winning trades'],
            ['Losing Trades', summary.unprofitableTrades, 'count', 'Number of losing trades'],
            ['Last Updated', summary.lastUpdatedCDT, 'timestamp', 'When summary was last calculated']
        ];

        for (const [metric, value, unit, description] of metrics) {
            const row = [
                this.escapeCsvValue(metric),
                this.escapeCsvValue(value),
                this.escapeCsvValue(unit),
                this.escapeCsvValue(description)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Summary report exported', { filename, filepath });
        return filepath;
    }

    // ==================== 🔧 EXPORT ALL REPORTS ====================

    public async generateAllReports(options: ReportOptions = {}): Promise<ReportFiles> {
        try {
            logger.info('🔧 FIXED: Generating all reports with complete data mapping');

            const timestamp = this.getTimestamp();

            const reportFiles: ReportFiles = {
                completedTradesFile: await this.exportCompletedTrades({
                    filename: `trade_report_${timestamp}_completed_trades.csv`,
                    ...options
                }),
                summaryFile: await this.exportSummaryReport({
                    filename: `trade_report_${timestamp}_summary.csv`
                }),
                performanceFile: await this.exportPerformanceAnalysis({
                    filename: `trade_report_${timestamp}_performance.csv`
                }),
                protocolAnalyticsFile: await this.exportProtocolAnalytics({
                    filename: `trade_report_${timestamp}_protocol.csv`
                }),
                dailyFile: await this.exportDailyBreakdown({
                    filename: `trade_report_${timestamp}_daily.csv`
                }),
                addressAnalysisFile: await this.exportAddressAnalysis({
                    filename: `trade_report_${timestamp}_addresses.csv`
                }),
                timingAnalysisFile: await this.exportTimingAnalysis({
                    filename: `trade_report_${timestamp}_timing.csv`
                })
            };

            if (options.includeActiveTrades) {
                reportFiles.activeTradesFile = await this.exportActiveTrades({
                    filename: `trade_report_${timestamp}_active_trades.csv`
                });
            }

            logger.info('🔧 FIXED: All reports generated successfully', {
                files: Object.keys(reportFiles).length,
                timestamp
            });

            return reportFiles;
        } catch (error) {
            logger.error('Error generating all reports', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    // ==================== 🔧 ADDITIONAL EXPORT METHODS ====================

    private async exportPerformanceAnalysis(options: { filename?: string } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_performance.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();
        const summary = tradeTracker.getTradeSummary();

        const headers = ['Token_Pair', 'Total_Trades', 'Win_Rate', 'Total_Profit', 'Avg_Profit', 'Best_Trade', 'Worst_Trade'];
        let csvContent = headers.join(',') + '\n';

        // Group by token pair
        const byTokenPair: Record<string, CompletedTrade[]> = {};
        completedTrades.forEach(trade => {
            const pair = trade.tokenPair || 'Unknown';
            if (!byTokenPair[pair]) byTokenPair[pair] = [];
            byTokenPair[pair].push(trade);
        });

        for (const [tokenPair, trades] of Object.entries(byTokenPair)) {
            const totalTrades = trades.length;
            const profitableTrades = trades.filter(t => (t.netProfitUSDC || 0) > 0).length;
            const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;
            const totalProfit = trades.reduce((sum, t) => sum + (t.netProfitUSDC || 0), 0);
            const avgProfit = totalTrades > 0 ? totalProfit / totalTrades : 0;
            const bestTrade = trades.length > 0 ? Math.max(...trades.map(t => t.netProfitUSDC || 0)) : 0;
            const worstTrade = trades.length > 0 ? Math.min(...trades.map(t => t.netProfitUSDC || 0)) : 0;

            const row = [
                this.escapeCsvValue(tokenPair),
                totalTrades,
                this.formatPercentage(winRate, 2),
                this.formatNumber(totalProfit, 4),
                this.formatNumber(avgProfit, 4),
                this.formatNumber(bestTrade, 4),
                this.formatNumber(worstTrade, 4)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Performance analysis exported', { filename, filepath });
        return filepath;
    }

    private async exportProtocolAnalytics(options: { filename?: string } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_protocol.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();

        const headers = ['Metric', 'Value', 'Description'];
        let csvContent = headers.join(',') + '\n';

        // Calculate protocol metrics
        const uniqueRouters = new Set(completedTrades.map(t => t.entryRouterAddress).filter(addr => addr && addr !== 'N/A'));
        const uniquePools = new Set(completedTrades.map(t => t.entryPoolAddress).filter(addr => addr && addr !== 'N/A'));
        const totalGasCost = completedTrades.reduce((sum, t) => sum + (t.gasCostUSDC || 0), 0);
        const avgGasPerTrade = completedTrades.length > 0 ? totalGasCost / completedTrades.length : 0;

        const metrics = [
            ['Total Unique Routers', uniqueRouters.size, 'Number of different router contracts used'],
            ['Total Unique Pools', uniquePools.size, 'Number of different pool contracts used'],
            ['Average Gas Cost Per Trade', this.formatNumber(avgGasPerTrade, 4) + ' USDC', 'Average gas cost across all trades'],
            ['Total Gas Costs', this.formatNumber(totalGasCost, 4) + ' USDC', 'Total gas fees paid across all trades']
        ];

        for (const [metric, value, description] of metrics) {
            const row = [
                this.escapeCsvValue(metric),
                this.escapeCsvValue(value),
                this.escapeCsvValue(description)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Protocol analytics exported', { filename, filepath });
        return filepath;
    }

    private async exportDailyBreakdown(options: { filename?: string } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_daily.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();

        const headers = ['Date', 'Trades', 'Profit_USDC', 'Win_Rate', 'Avg_Profit'];
        let csvContent = headers.join(',') + '\n';

        // Group by date
        const byDate: Record<string, CompletedTrade[]> = {};
        completedTrades.forEach(trade => {
            const date = (trade.entrySignalDate || '').split('T')[0] || 'Unknown';
            if (!byDate[date]) byDate[date] = [];
            byDate[date].push(trade);
        });

        for (const [date, trades] of Object.entries(byDate)) {
            const totalTrades = trades.length;
            const profitableTrades = trades.filter(t => (t.netProfitUSDC || 0) > 0).length;
            const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;
            const totalProfit = trades.reduce((sum, t) => sum + (t.netProfitUSDC || 0), 0);
            const avgProfit = totalTrades > 0 ? totalProfit / totalTrades : 0;

            const row = [
                this.escapeCsvValue(date),
                totalTrades,
                this.formatNumber(totalProfit, 4),
                this.formatPercentage(winRate, 2),
                this.formatNumber(avgProfit, 4)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Daily breakdown exported', { filename, filepath });
        return filepath;
    }

    private async exportAddressAnalysis(options: { filename?: string } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_addresses.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();

        const headers = ['Trade_Pair_ID', 'Entry_Router', 'Exit_Router', 'Entry_Pool', 'Exit_Pool', 'Token_Addresses'];
        let csvContent = headers.join(',') + '\n';

        for (const trade of completedTrades) {
            const tokenAddresses = [
                trade.entryInputTokenAddress,
                trade.entryOutputTokenAddress,
                trade.exitInputTokenAddress,
                trade.exitOutputTokenAddress
            ].filter(addr => addr && addr !== 'N/A').join('; ');

            const row = [
                this.escapeCsvValue(trade.tradePairId || 'N/A'),
                this.escapeCsvValue(trade.entryRouterAddress || 'N/A'),
                this.escapeCsvValue(trade.exitRouterAddress || 'N/A'),
                this.escapeCsvValue(trade.entryPoolAddress || 'N/A'),
                this.escapeCsvValue(trade.exitPoolAddress || 'N/A'),
                this.escapeCsvValue(tokenAddresses || 'N/A')
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Address analysis exported', { filename, filepath });
        return filepath;
    }

    private async exportTimingAnalysis(options: { filename?: string } = {}): Promise<string> {
        const filename = options.filename || `trade_report_${this.getTimestamp()}_timing.csv`;
        const filepath = path.join(this.reportsDir, filename);

        const completedTrades = tradeTracker.getCompletedTrades();

        const headers = ['Trade_Pair_ID', 'Signal_Duration_Min', 'Execution_Duration_Sec', 'Trade_Duration_Min', 'Entry_Processing_Delay_Ms', 'Exit_Processing_Delay_Ms'];
        let csvContent = headers.join(',') + '\n';

        for (const trade of completedTrades) {
            const row = [
                this.escapeCsvValue(trade.tradePairId || 'N/A'),
                this.safeNumericValue(trade.signalDurationMinutes, 0),
                this.safeNumericValue(trade.executionDurationSeconds, 0),
                this.safeNumericValue((trade.tradeDurationMs || 0) / 60000, 0),
                this.safeNumericValue(trade.entryProcessingDelayMs, 0),
                this.safeNumericValue(trade.exitProcessingDelayMs, 0)
            ];
            csvContent += row.join(',') + '\n';
        }

        fs.writeFileSync(filepath, csvContent);
        logger.info('Timing analysis exported', { filename, filepath });
        return filepath;
    }
}

// Export singleton instance
export const tradeReporting = new TradeReporting();
export default tradeReporting;