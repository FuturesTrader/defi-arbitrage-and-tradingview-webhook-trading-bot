// scripts/migrateTradeData.ts - Fix Historical Duration Calculations
// Run with: tsx scripts/migrateTradeData.ts [option]
// Options: analyze, recalculate, backup, fresh-start

import fs from 'fs';
import path from 'path';

// Import the fixed duration calculation logic
function formatDuration(milliseconds: number): string {
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

interface CompletedTrade {
    tradePairId: string;
    entryLeg: any;
    exitLeg: any;
    signalDurationMs?: number;
    signalDurationFormatted?: string;
    executionDurationMs?: number;
    executionDurationFormatted?: string;
    tradeDurationMs?: number;
    tradeDurationFormatted?: string;
    entrySignalCDT?: string;
    exitSignalCDT?: string;
    entryExecutionCDT?: string;
    exitExecutionCDT?: string;
    entryDateCDT?: string;
    exitDateCDT?: string;
    summary?: string;
    netProfitUSDC?: number;
    profitPercentage?: number;
    [key: string]: any;
}

class TradeDataMigration {
    private readonly dataDir: string;
    private readonly completedTradesFile: string;
    private readonly backupDir: string;

    constructor() {
        this.dataDir = path.join(process.cwd(), 'data', 'trades');
        this.completedTradesFile = path.join(this.dataDir, 'trades_completed.json');
        this.backupDir = path.join(this.dataDir, 'backups');

        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    /**
     * Analyze existing trade data to identify duration calculation issues
     */
    public analyzeExistingData(): void {
        console.log('🔍 ANALYZING EXISTING TRADE DATA...\n');

        if (!fs.existsSync(this.completedTradesFile)) {
            console.log('❌ No completed trades file found. No data to analyze.');
            return;
        }

        try {
            const data = fs.readFileSync(this.completedTradesFile, 'utf8');
            const completedTrades: CompletedTrade[] = JSON.parse(data);

            console.log(`📊 Found ${completedTrades.length} completed trades\n`);

            if (completedTrades.length === 0) {
                console.log('ℹ️  No trades to analyze.');
                return;
            }

            let issuesFound = 0;
            let tradesWithGoodTimestamps = 0;
            let tradesWithBadTimestamps = 0;

            for (const trade of completedTrades) {
                const hasSignalTimestamps = trade.entryLeg?.signalTimestamp && trade.exitLeg?.signalTimestamp;
                const hasExecutionTimestamps = trade.entryLeg?.executionTimestamp && trade.exitLeg?.executionTimestamp;

                if (hasSignalTimestamps) {
                    tradesWithGoodTimestamps++;

                    // Calculate what the duration SHOULD be
                    const correctSignalDurationMs = (trade.exitLeg.signalTimestamp - trade.entryLeg.signalTimestamp) * 1000;
                    const currentDurationMs = trade.signalDurationMs || trade.tradeDurationMs || 0;

                    if (Math.abs(correctSignalDurationMs - currentDurationMs) > 1000) { // More than 1 second difference
                        issuesFound++;
                        console.log(`❌ Trade ${trade.tradePairId}:`);
                        console.log(`   Current Duration: ${trade.signalDurationFormatted || trade.tradeDurationFormatted || 'N/A'}`);
                        console.log(`   Correct Duration: ${formatDuration(correctSignalDurationMs)}`);
                        console.log(`   Entry Signal: ${formatCDTTimestamp(trade.entryLeg.signalTimestamp)}`);
                        console.log(`   Exit Signal: ${formatCDTTimestamp(trade.exitLeg.signalTimestamp)}`);
                        console.log('');
                    }
                } else {
                    tradesWithBadTimestamps++;
                    console.log(`⚠️  Trade ${trade.tradePairId}: Missing signal timestamps (cannot be fixed)`);
                }
            }

            console.log('📋 ANALYSIS SUMMARY:');
            console.log(`   Total trades: ${completedTrades.length}`);
            console.log(`   Trades with good timestamps: ${tradesWithGoodTimestamps}`);
            console.log(`   Trades with bad timestamps: ${tradesWithBadTimestamps}`);
            console.log(`   Trades with duration issues: ${issuesFound}`);
            console.log('');

            if (issuesFound > 0) {
                console.log('🔧 RECOMMENDED ACTION: Run recalculate to fix duration issues');
            } else if (tradesWithGoodTimestamps > 0) {
                console.log('✅ All duration calculations appear correct');
            } else {
                console.log('⚠️  No trades have proper timestamp data for recalculation');
            }

        } catch (error) {
            console.error('❌ Error analyzing data:', error);
        }
    }

    /**
     * Recalculate durations for existing completed trades
     */
    public recalculateExistingTrades(): void {
        console.log('🔄 RECALCULATING EXISTING TRADE DURATIONS...\n');

        if (!fs.existsSync(this.completedTradesFile)) {
            console.log('❌ No completed trades file found.');
            return;
        }

        // Create backup first
        this.createBackup();

        try {
            const data = fs.readFileSync(this.completedTradesFile, 'utf8');
            const completedTrades: CompletedTrade[] = JSON.parse(data);

            console.log(`📊 Processing ${completedTrades.length} completed trades...\n`);

            let fixedTrades = 0;
            let skippedTrades = 0;

            for (const trade of completedTrades) {
                if (trade.entryLeg?.signalTimestamp && trade.exitLeg?.signalTimestamp) {
                    // Determine chronological order
                    const firstTrade = trade.entryLeg.signalTimestamp <= trade.exitLeg.signalTimestamp ?
                        trade.entryLeg : trade.exitLeg;
                    const secondTrade = trade.entryLeg.signalTimestamp <= trade.exitLeg.signalTimestamp ?
                        trade.exitLeg : trade.entryLeg;

                    // 🔧 FIXED: Calculate durations using chronological order
                    const signalDurationMs = (secondTrade.signalTimestamp - firstTrade.signalTimestamp) * 1000;
                    const executionDurationMs = firstTrade.executionTimestamp && secondTrade.executionTimestamp ?
                        (secondTrade.executionTimestamp - firstTrade.executionTimestamp) * 1000 : signalDurationMs;

                    // Update the trade with corrected values
                    trade.signalDurationMs = signalDurationMs;
                    trade.signalDurationFormatted = formatDuration(signalDurationMs);
                    trade.executionDurationMs = executionDurationMs;
                    trade.executionDurationFormatted = formatDuration(executionDurationMs);

                    // Update legacy fields for backward compatibility
                    trade.tradeDurationMs = signalDurationMs;
                    trade.tradeDurationFormatted = formatDuration(signalDurationMs);

                    // Update timing details using chronological order
                    trade.entrySignalCDT = formatCDTTimestamp(firstTrade.signalTimestamp);
                    trade.exitSignalCDT = formatCDTTimestamp(secondTrade.signalTimestamp);
                    trade.entryExecutionCDT = formatCDTTimestamp(firstTrade.executionTimestamp || firstTrade.signalTimestamp);
                    trade.exitExecutionCDT = formatCDTTimestamp(secondTrade.executionTimestamp || secondTrade.signalTimestamp);

                    // Update legacy timing fields
                    trade.entryDateCDT = trade.entrySignalCDT;
                    trade.exitDateCDT = trade.exitSignalCDT;

                    // Update summary with corrected duration
                    if (trade.summary && trade.netProfitUSDC !== undefined && trade.profitPercentage !== undefined) {
                        const tokenPair = trade.entryLeg.tokenPair || 'Unknown';
                        trade.summary = `${tokenPair}: ${trade.netProfitUSDC > 0 ? '+' : ''}${trade.netProfitUSDC.toFixed(4)} USDC (${trade.profitPercentage.toFixed(2)}%) in ${formatDuration(signalDurationMs)}`;
                    }

                    fixedTrades++;
                    console.log(`✅ Fixed ${trade.tradePairId}: ${formatDuration(signalDurationMs)}`);
                } else {
                    skippedTrades++;
                    console.log(`⚠️  Skipped ${trade.tradePairId}: Missing timestamps`);
                }
            }

            // Save the corrected data
            fs.writeFileSync(this.completedTradesFile, JSON.stringify(completedTrades, null, 2));

            console.log('\n📋 RECALCULATION SUMMARY:');
            console.log(`   Trades fixed: ${fixedTrades}`);
            console.log(`   Trades skipped: ${skippedTrades}`);
            console.log(`   Backup created: ${this.getBackupPath()}`);
            console.log('\n✅ Recalculation complete! Generate new CSV reports to see corrected durations.');

        } catch (error) {
            console.error('❌ Error recalculating trades:', error);
        }
    }

    /**
     * Create backup of current data
     */
    public createBackup(): string {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const backupPath = this.getBackupPath(timestamp);

        if (fs.existsSync(this.completedTradesFile)) {
            fs.copyFileSync(this.completedTradesFile, backupPath);
            console.log(`💾 Backup created: ${backupPath}`);
        }

        return backupPath;
    }

    /**
     * Start fresh by clearing all trade data
     */
    public startFresh(): void {
        console.log('🔄 STARTING FRESH...\n');

        // Create backup first
        this.createBackup();

        const filesToClear = [
            path.join(this.dataDir, 'trades_active.json'),
            path.join(this.dataDir, 'trades_completed.json'),
            path.join(this.dataDir, 'trades_summary.json')
        ];

        for (const file of filesToClear) {
            if (fs.existsSync(file)) {
                if (file.includes('summary')) {
                    // Reset summary to default
                    const defaultSummary = {
                        lastUpdated: Math.floor(Date.now() / 1000),
                        lastUpdatedCDT: formatCDTTimestamp(Math.floor(Date.now() / 1000)),
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
                        protocolAnalytics: {
                            totalUniqueTokens: 0,
                            totalUniquePools: 0,
                            totalUniqueRouters: 0,
                            mostUsedRouter: 'N/A',
                            mostTradedTokenPair: 'N/A',
                            averageGasPerTrade: 0,
                            gasEfficiencyTrend: 0
                        },
                        tokenPerformance: {},
                        daily: {},
                        weekly: {},
                        monthly: {}
                    };
                    fs.writeFileSync(file, JSON.stringify(defaultSummary, null, 2));
                } else {
                    // Clear array files
                    fs.writeFileSync(file, '[]');
                }
                console.log(`🗑️  Cleared: ${path.basename(file)}`);
            }
        }

        console.log('\n✅ Fresh start complete! All trade data cleared.');
        console.log('📋 Next trades will use the fixed duration calculation.');
    }

    private getBackupPath(timestamp?: string): string {
        const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        return path.join(this.backupDir, `trades_completed_backup_${ts}.json`);
    }
}

// Command line interface
function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';

    const migration = new TradeDataMigration();

    switch (command.toLowerCase()) {
        case 'analyze':
            migration.analyzeExistingData();
            break;

        case 'recalculate':
            migration.recalculateExistingTrades();
            break;

        case 'backup':
            migration.createBackup();
            console.log('✅ Backup created successfully.');
            break;

        case 'fresh-start':
            console.log('⚠️  This will clear ALL trade data. Type "yes" to confirm:');
            process.stdin.setEncoding('utf8');
            process.stdin.on('readable', () => {
                const chunk = process.stdin.read();
                if (chunk !== null && chunk.trim().toLowerCase() === 'yes') {
                    migration.startFresh();
                    process.exit(0);
                } else if (chunk !== null) {
                    console.log('❌ Operation cancelled.');
                    process.exit(0);
                }
            });
            break;

        case 'help':
        default:
            console.log('🔧 TRADE DATA MIGRATION TOOL\n');
            console.log('Usage: tsx scripts/migrateTradeData.ts [command]\n');
            console.log('Commands:');
            console.log('  analyze      - Check existing data for duration calculation issues');
            console.log('  recalculate  - Fix duration calculations for existing completed trades');
            console.log('  backup       - Create backup of current trade data');
            console.log('  fresh-start  - Clear all trade data and start fresh');
            console.log('  help         - Show this help message\n');
            console.log('Recommended workflow:');
            console.log('  1. tsx scripts/migrateTradeData.ts analyze');
            console.log('  2. tsx scripts/migrateTradeData.ts backup');
            console.log('  3. tsx scripts/migrateTradeData.ts recalculate');
            console.log('  4. yarn reports:generate');
            break;
    }
}

if (require.main === module) {
    main();
}