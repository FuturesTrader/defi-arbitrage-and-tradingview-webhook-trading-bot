// scripts/generateReports.ts - Network-Aware Multi-Chain Report Generator v4.0.0
// 🔧 MAJOR UPGRADE: Full integration with tradeReporting.ts v4.0.0 multi-network architecture
// Supports Avalanche + Arbitrum with comprehensive network-specific and cross-network reporting

import { tradeReporting, type NetworkReportOptions } from '../src/tradeReporting.ts';
import { tradeTracker } from '../src/tradeTracker.ts';
import {
    getNetworkConfig,
    getCurrentNetworkKey,
    SUPPORTED_NETWORKS,
    type NetworkKey
} from '../src/constants.ts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../src/logger.ts';

// ==================== 🔧 ENHANCED COMMAND-LINE ARGUMENT PARSING ====================

interface GenerateReportsOptions extends NetworkReportOptions {
    help?: boolean;
    mode?: 'full' | 'daily' | 'weekly' | 'profit' | 'network-compare' | 'cross-network';
    minProfit?: number;
    verbose?: boolean;
    quiet?: boolean;
    outputDir?: string;
}

function parseCommandLineArgs(): GenerateReportsOptions {
    const args = process.argv.slice(2);
    const options: GenerateReportsOptions = {
        includeActiveTrades: true,
        includeAddressDetails: true,
        includeEnhancedTiming: true,
        verbose: false,
        quiet: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i].toLowerCase();

        switch (arg) {
            // 🔧 NEW: Network-specific options
            case '--network':
            case '-n':
                const networkValue = args[++i]?.toUpperCase() as NetworkKey;
                if (networkValue && SUPPORTED_NETWORKS[networkValue]) {
                    options.networkFilter = networkValue;
                } else {
                    console.error(`❌ Invalid network: ${args[i]}. Supported: ${Object.keys(SUPPORTED_NETWORKS).join(', ')}`);
                    process.exit(1);
                }
                break;

            case '--all-networks':
                options.networkFilter = undefined;
                options.includeNetworkBreakdown = true;
                options.compareNetworks = true;
                break;

            case '--network-breakdown':
                options.includeNetworkBreakdown = true;
                break;

            case '--compare-networks':
                options.compareNetworks = true;
                break;

            case '--cross-network-only':
                options.crossNetworkOnly = true;
                break;

            // Report mode selection
            case '--mode':
            case '-m':
                const modeValue = args[++i]?.toLowerCase();
                if (['full', 'daily', 'weekly', 'profit', 'network-compare', 'cross-network'].includes(modeValue)) {
                    options.mode = modeValue as GenerateReportsOptions['mode'];
                } else {
                    console.error(`❌ Invalid mode: ${args[i]}. Supported: full, daily, weekly, profit, network-compare, cross-network`);
                    process.exit(1);
                }
                break;

            // Date filtering
            case '--start-date':
                options.startDate = new Date(args[++i]);
                break;

            case '--end-date':
                options.endDate = new Date(args[++i]);
                break;

            // Token and profit filtering
            case '--token':
            case '-t':
                options.tokenFilter = args[++i];
                break;

            case '--min-profit':
            case '-p':
                options.minProfit = parseFloat(args[++i]);
                break;

            case '--min-profit-filter':
                options.minProfitFilter = parseFloat(args[++i]);
                break;

            // Output options
            case '--output-dir':
            case '-o':
                options.outputDir = args[++i];
                break;

            case '--format':
            case '-f':
                const formatValue = args[++i]?.toLowerCase();
                if (['csv', 'json', 'both'].includes(formatValue)) {
                    options.outputFormat = formatValue as 'csv' | 'json' | 'both';
                }
                break;

            // Feature flags
            case '--no-active':
                options.includeActiveTrades = false;
                break;

            case '--no-addresses':
                options.includeAddressDetails = false;
                break;

            case '--no-timing':
                options.includeEnhancedTiming = false;
                break;

            // Logging options
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;

            case '--quiet':
            case '-q':
                options.quiet = true;
                break;

            // Help
            case '--help':
            case '-h':
                options.help = true;
                break;

            default:
                if (arg.startsWith('-')) {
                    console.error(`❌ Unknown option: ${arg}`);
                    process.exit(1);
                }
        }
    }

    return options;
}

function displayHelp(): void {
    console.log(`
🔧 Network-Aware Multi-Chain Trade Report Generator v4.0.0

USAGE:
    tsx scripts/generateReports.ts [OPTIONS]

NETWORK OPTIONS:
    -n, --network <NETWORK>         Filter reports by network (AVALANCHE, ARBITRUM)
    --all-networks                  Generate reports for all networks with comparison
    --network-breakdown             Include detailed per-network breakdown
    --compare-networks              Generate network comparison analysis
    --cross-network-only            Only include cross-network trades

REPORT MODES:
    -m, --mode <MODE>               Report generation mode:
                                    full         Complete report suite (default)
                                    daily        Last 24 hours
                                    weekly       Last 7 days
                                    profit       Profitable trades only
                                    network-compare  Network comparison only
                                    cross-network    Cross-network trades only

FILTERING OPTIONS:
    --start-date <YYYY-MM-DD>       Filter trades from date
    --end-date <YYYY-MM-DD>         Filter trades to date
    -t, --token <TOKEN>             Filter by token symbol (BTC, AVAX, ETH)
    -p, --min-profit <AMOUNT>       Minimum profit threshold in USDC

FEATURE OPTIONS:
    --no-active                     Exclude active trades
    --no-addresses                  Exclude address analysis
    --no-timing                     Exclude timing analysis

OUTPUT OPTIONS:
    -o, --output-dir <DIR>          Custom output directory
    -f, --format <FORMAT>           Output format (csv, json, both)

LOGGING OPTIONS:
    -v, --verbose                   Verbose output
    -q, --quiet                     Minimal output
    -h, --help                      Show this help

EXAMPLES:
    # Generate full network-aware reports for all networks
    tsx scripts/generateReports.ts --all-networks

    # Generate reports for Avalanche network only
    tsx scripts/generateReports.ts --network AVALANCHE

    # Generate Arbitrum vs Avalanche comparison
    tsx scripts/generateReports.ts --compare-networks

    # Generate cross-network trades analysis
    tsx scripts/generateReports.ts --cross-network-only

    # Generate profitable trades on Arbitrum in last week
    tsx scripts/generateReports.ts --network ARBITRUM --mode weekly --min-profit 0.01

    # Generate comprehensive analysis with all network features
    tsx scripts/generateReports.ts --all-networks --include-network-breakdown

SUPPORTED NETWORKS:
    ${Object.entries(SUPPORTED_NETWORKS).map(([key, config]) =>
        `${key.padEnd(12)} - ${config.name} (${config.nativeCurrency})`
    ).join('\n    ')}

🔧 ENHANCED FEATURES:
    ✅ Multi-network support (Avalanche + Arbitrum)
    ✅ Cross-network trade detection and analysis
    ✅ Network-specific gas cost tracking (AVAX/ETH)
    ✅ L1 vs L2 performance comparison
    ✅ Network efficiency scoring and ranking
    ✅ Enhanced timing analysis (signal vs execution)
    ✅ Comprehensive address tracking and protocol analytics
    ✅ Backward compatibility with legacy trade data
`);
}

// ==================== 🔧 ENHANCED MAIN EXECUTION FUNCTION ====================

async function main(): Promise<void> {
    const startTime = performance.now();

    try {
        // Parse command line arguments
        const options = parseCommandLineArgs();

        if (options.help) {
            displayHelp();
            process.exit(0);
        }

        // Configure logging level
        if (!options.quiet) {
            console.log('🔧 Network-Aware Multi-Chain Report Generator v4.0.0');
            console.log('🔧 Enhanced with Avalanche + Arbitrum support\n');
        }

        // Validate environment and data availability
        await validateEnvironment(options);

        // Execute report generation based on mode
        const reportFiles = await executeReportGeneration(options);

        // Display results
        await displayResults(reportFiles, options, startTime);

    } catch (error) {
        console.error('❌ Enhanced report generation failed:');
        console.error(error instanceof Error ? error.message : String(error));
        console.error('\n🔧 TROUBLESHOOTING:');
        console.error('   1. Ensure tradeTracker.ts v3.0.0+ is being used with network support');
        console.error('   2. Check that data/trades/ directory exists and is writable');
        console.error('   3. Verify trade tracking is enabled in environment variables');
        console.error('   4. Ensure recent trades have been executed to populate network data');
        console.error('   5. Verify multi-network configuration is properly set up');
        console.error('   6. Check that both AVALANCHE_RPC_URL and ARBITRUM_RPC_URL are configured');
        process.exit(1);
    }
}

// ==================== 🔧 VALIDATION AND SETUP FUNCTIONS ====================

async function validateEnvironment(options: GenerateReportsOptions): Promise<void> {
    const dataDir = path.join(process.cwd(), 'data', 'trades');
    const reportsDir = path.join(process.cwd(), 'data', 'reports');

    // Check data files
    const hasActiveFile = fs.existsSync(path.join(dataDir, 'trades_active.json'));
    const hasCompletedFile = fs.existsSync(path.join(dataDir, 'trades_completed.json'));
    const hasSummaryFile = fs.existsSync(path.join(dataDir, 'trades_summary.json'));

    if (!options.quiet) {
        console.log('📁 Data Files Status:');
        console.log(`   Active trades: ${hasActiveFile ? '✅' : '❌'}`);
        console.log(`   Completed trades: ${hasCompletedFile ? '✅' : '❌'}`);
        console.log(`   Summary: ${hasSummaryFile ? '✅' : '❌'}`);
    }

    if (!hasActiveFile || !hasCompletedFile || !hasSummaryFile) {
        throw new Error('Missing required JSON data files. Please run some trades first to generate data.');
    }

    // Ensure reports directory exists
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
        if (!options.quiet) {
            console.log('📁 Created reports directory:', reportsDir);
        }
    }

    // Get current data and network analysis
    const activeTrades = tradeTracker.getActiveTrades();
    const completedTrades = tradeTracker.getCompletedTrades();
    const summary = tradeTracker.getTradeSummary();

    if (!options.quiet) {
        console.log('\n📊 Current Trade Data:');
        console.log(`   Active trades: ${activeTrades.length}`);
        console.log(`   Completed trade pairs: ${completedTrades.length}`);
        console.log(`   Total net profit: ${summary.totalNetProfit.toFixed(4)} USDC`);
        console.log(`   Win rate: ${summary.winRate.toFixed(2)}%`);

        // 🔧 NEW: Network breakdown
        if (summary.networkSummary && Object.keys(summary.networkSummary).length > 0) {
            console.log('\n🔧 Network Breakdown:');
            for (const [network, data] of Object.entries(summary.networkSummary)) {
                const networkConfig = getNetworkConfig(network as NetworkKey);
                console.log(`   ${network}: ${data.totalTrades} trades, ${data.totalNetProfit.toFixed(4)} USDC profit (${networkConfig.network.nativeCurrency})`);
            }
        }

        // 🔧 NEW: Cross-network analytics
        if (summary.crossNetworkAnalytics?.totalCrossNetworkTrades > 0) {
            console.log(`\n🔄 Cross-Network Trades: ${summary.crossNetworkAnalytics.totalCrossNetworkTrades}`);
        }
    }

    if (completedTrades.length === 0 && activeTrades.length === 0) {
        throw new Error('No trade data found to generate reports. Execute some trades first.');
    }

    // Network-specific validation
    if (options.networkFilter) {
        const networkTrades = completedTrades.filter(t => t.network === options.networkFilter);
        if (networkTrades.length === 0 && !options.quiet) {
            console.log(`⚠️  No trades found for network ${options.networkFilter}`);
        }
    }
}

// ==================== 🔧 REPORT GENERATION EXECUTION ====================

async function executeReportGeneration(options: GenerateReportsOptions): Promise<any> {
    if (!options.quiet) {
        console.log('\n🔄 Generating network-aware reports...');
        if (options.networkFilter) {
            const networkConfig = getNetworkConfig(options.networkFilter);
            console.log(`   Network Filter: ${networkConfig.network.name} (${networkConfig.network.nativeCurrency})`);
        }
        if (options.mode) {
            console.log(`   Mode: ${options.mode}`);
        }
    }

    let reportFiles: any;

    switch (options.mode) {
        case 'daily':
            if (!options.quiet) console.log('📅 Generating daily report...');
            const dailyFiles = await tradeReporting.generateDailyReport(options.networkFilter);
            reportFiles = { dailyFiles };
            break;

        case 'weekly':
            if (!options.quiet) console.log('📅 Generating weekly report...');
            const weeklyFiles = await tradeReporting.generateWeeklyReport(options.networkFilter);
            reportFiles = { weeklyFiles };
            break;

        case 'profit':
            if (!options.quiet) console.log('💰 Generating profit report...');
            const profitFile = await tradeReporting.generateProfitReport(
                options.minProfit || 0.01,
                options.networkFilter
            );
            reportFiles = { profitFile };
            break;

        case 'network-compare':
            if (!options.quiet) console.log('🔧 Generating network comparison report...');
            const comparisonFiles = await tradeReporting.generateNetworkComparisonReport();
            reportFiles = { comparisonFiles };
            break;

        case 'cross-network':
            if (!options.quiet) console.log('🔄 Generating cross-network report...');
            const crossNetworkFiles = await tradeReporting.generateCrossNetworkReport();
            reportFiles = { crossNetworkFiles };
            break;

        case 'full':
        default:
            if (!options.quiet) console.log('📊 Generating comprehensive network-aware report suite...');
            reportFiles = await tradeReporting.generateFullReport(options);
            break;
    }

    return reportFiles;
}

// ==================== 🔧 RESULTS DISPLAY AND SUMMARY ====================

async function displayResults(
    reportFiles: any,
    options: GenerateReportsOptions,
    startTime: number
): Promise<void> {
    const executionTime = ((performance.now() - startTime) / 1000).toFixed(2);

    if (!options.quiet) {
        console.log('\n✅ Network-aware report generation completed successfully!');
        console.log(`⏱️  Execution time: ${executionTime}s`);

        console.log('\n📋 Generated Reports:');

        // Handle different report modes
        if (reportFiles.completedTradesFile) {
            console.log(`   📈 Completed trades: ${path.basename(reportFiles.completedTradesFile)}`);
        }
        if (reportFiles.activeTradesFile) {
            console.log(`   🔄 Active trades: ${path.basename(reportFiles.activeTradesFile)}`);
        }
        if (reportFiles.summaryFile) {
            console.log(`   📊 Summary: ${path.basename(reportFiles.summaryFile)}`);
        }
        if (reportFiles.performanceFile) {
            console.log(`   📈 Performance: ${path.basename(reportFiles.performanceFile)}`);
        }
        if (reportFiles.dailyFile) {
            console.log(`   📅 Daily: ${path.basename(reportFiles.dailyFile)}`);
        }
        if (reportFiles.addressAnalysisFile) {
            console.log(`   📍 Address analysis: ${path.basename(reportFiles.addressAnalysisFile)}`);
        }
        if (reportFiles.protocolAnalyticsFile) {
            console.log(`   🔧 Protocol analytics: ${path.basename(reportFiles.protocolAnalyticsFile)}`);
        }
        if (reportFiles.timingAnalysisFile) {
            console.log(`   ⏱️  Timing analysis: ${path.basename(reportFiles.timingAnalysisFile)}`);
        }

        // 🔧 NEW: Network-specific reports
        if (reportFiles.networkComparisonFile) {
            console.log(`   🔧 Network comparison: ${path.basename(reportFiles.networkComparisonFile)}`);
        }
        if (reportFiles.networkBreakdownFile) {
            console.log(`   🔧 Network breakdown: ${path.basename(reportFiles.networkBreakdownFile)}`);
        }
        if (reportFiles.crossNetworkFile) {
            console.log(`   🔄 Cross-network trades: ${path.basename(reportFiles.crossNetworkFile)}`);
        }

        // Handle array results (daily, weekly, etc.)
        if (reportFiles.dailyFiles && Array.isArray(reportFiles.dailyFiles)) {
            console.log(`   📅 Daily reports: ${reportFiles.dailyFiles.length} files`);
        }
        if (reportFiles.weeklyFiles && Array.isArray(reportFiles.weeklyFiles)) {
            console.log(`   📅 Weekly reports: ${reportFiles.weeklyFiles.length} files`);
        }
        if (reportFiles.comparisonFiles && Array.isArray(reportFiles.comparisonFiles)) {
            console.log(`   🔧 Network comparison: ${reportFiles.comparisonFiles.length} files`);
        }
        if (reportFiles.crossNetworkFiles && Array.isArray(reportFiles.crossNetworkFiles)) {
            console.log(`   🔄 Cross-network: ${reportFiles.crossNetworkFiles.length} files`);
        }

        // Single file results
        if (reportFiles.profitFile) {
            console.log(`   💰 Profit trades: ${path.basename(reportFiles.profitFile)}`);
        }

        // Show directory info
        const reportsDir = path.join(process.cwd(), 'data', 'reports');
        console.log(`\n📁 Reports saved to: ${reportsDir}`);

        const csvFiles = fs.readdirSync(reportsDir).filter(file => file.endsWith('.csv'));
        console.log(`📋 Total CSV files: ${csvFiles.length}`);

        // 🔧 NEW: Enhanced features summary
        console.log('\n🔧 ENHANCED NETWORK FEATURES INCLUDED:');
        console.log('   🔧 Multi-Network Support: Avalanche + Arbitrum trade tracking');
        console.log('   🔧 Cross-Network Detection: Trades spanning multiple networks');
        console.log('   🔧 Network Gas Analysis: Native currency costs (AVAX/ETH) + USDC conversion');
        console.log('   🔧 L1 vs L2 Analytics: Performance comparison and optimization insights');
        console.log('   🔧 Network Efficiency Scoring: 0-100 scale rating per network');
        console.log('   ✅ Enhanced Timing Analysis: Signal vs execution performance tracking');
        console.log('   ✅ Protocol Address Tracking: Network-specific router/pool usage');
        console.log('   ✅ Backward Compatibility: Legacy trade data handled gracefully');

        console.log('\n💡 Next Steps:');
        console.log('   - Open data/reports/ folder to view CSV files');
        console.log('   - Import CSV files into Excel or Google Sheets for analysis');
        console.log('   - Use yarn reports:open to open the reports folder');
        console.log('   - Analyze network performance data for trading strategy optimization');
        console.log('   - Compare L1 (Avalanche) vs L2 (Arbitrum) efficiency metrics');

        // 🔧 NEW: Network-specific insights
        const summary = tradeTracker.getTradeSummary();
        if (summary.networkSummary && Object.keys(summary.networkSummary).length > 1) {
            console.log('\n🔧 MULTI-NETWORK INSIGHTS:');
            console.log('   - Compare gas costs between Avalanche (L1) and Arbitrum (L2)');
            console.log('   - Analyze network efficiency scores for optimal network selection');
            console.log('   - Review cross-network trade patterns for arbitrage opportunities');
            console.log('   - Use network breakdown data for strategic network allocation');
        }

        if (options.verbose) {
            console.log('\n🔧 TECHNICAL DETAILS:');
            console.log(`   - Report generation mode: ${options.mode || 'full'}`);
            console.log(`   - Network filter: ${options.networkFilter || 'all networks'}`);
            console.log(`   - Include network breakdown: ${options.includeNetworkBreakdown || false}`);
            console.log(`   - Compare networks: ${options.compareNetworks || false}`);
            console.log(`   - Cross-network only: ${options.crossNetworkOnly || false}`);
            console.log(`   - Enhanced timing: ${options.includeEnhancedTiming !== false}`);
            console.log(`   - Address details: ${options.includeAddressDetails !== false}`);
            console.log(`   - Active trades: ${options.includeActiveTrades !== false}`);
        }
    }
}

// ==================== 🔧 ES MODULE COMPATIBILITY ====================

const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
    main().catch((error) => {
        console.error('❌ Fatal error in network-aware report generation:', error);
        process.exit(1);
    });
}