//src/analyzeArbitrageTxs.ts
/**
 *
 *
 * A specialized utility for analyzing arbitrage transactions, extracting metrics,
 * and generating insights.
 *
 * Usage:
 * tsx analyzeArbitrageTxs.ts <tx_hash1> <tx_hash2> ... <tx_hash_n>
 *
 * Options:
 * --json: Output results as JSON
 * --csv: Output results as CSV
 * --summary: Output only summary (default includes detailed + summary)
 * --output=<dir>: Specify output directory (default: ./arbitrage_analysis)
 * --avax-price=<price>: AVAX price in USD for gas calculations (default: 17)
 * --batch-size=<n>: Number of transactions to process in parallel (default: 3)
 */

import {
    Hash,
    formatUnits,
    formatEther,
    type Address
} from 'viem';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
    getTransactionDetails,
    FileTransactionStorage,
    determineRoute,
    extractArbitrageExecutedData,
    extractFirstLegData,
    extractSecondLegData,
    getTokenDecimals,
    getTokenAddress,
    getTokenSymbol,
    type DetailedTransaction,
    type DecodedLog
} from './transactionUtils';

// Initialize environment variables
dotenv.config();

// Define output options
interface OutputOptions {
    json: boolean;
    csv: boolean;
    summary: boolean;
    detailed: boolean;
    outputDir: string;
    avaxPrice: number;
    batchSize: number;
}

// Define transaction metrics
interface ArbitrageMetrics {
    hash: Hash;
    timestamp: Date;
    blockNumber: bigint;
    status: 'success' | 'reverted' | 'unknown';
    route: 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap' | 'unknown';
    sourceToken: string;
    targetToken: string;
    amountIn: string;
    amountInFormatted: string;
    finalBalance: string;
    finalBalanceFormatted: string;
    profit: string;
    profitFormatted: string;
    profitPercent: number;
    gasUsed: bigint;
    gasPrice: bigint;
    gasCost: string;
    gasCostInUSD: string; // Estimated USD gas cost
    testMode: boolean;
    firstLeg: {
        router: string;
        startBalance: string;
        expectedOutput: string;
        actualOutput?: string;
        priceImpact?: number;
        fee?: number;
        gasUsed?: bigint;
    };
    secondLeg: {
        router: string;
        startBalance: string;
        expectedOutput: string;
        actualOutput?: string;
        priceImpact?: number;
        fee?: number;
        gasUsed?: bigint;
    };
    executionTime?: number; // milliseconds from first to last event
    slippage?: {
        firstLeg: number;
        secondLeg: number;
        total: number;
    };
}

// Summary metrics for the entire batch
interface ArbitrageSummary {
    totalTransactions: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    totalProfit: Record<string, { raw: bigint; formatted: string }>;
    averageProfit: Record<string, { raw: number; formatted: string }>;
    medianProfit: Record<string, { raw: number; formatted: string }>;
    routeDistribution: Record<string, number>;
    totalGasCost: { avax: string; usd: string };
    averageGasCost: { avax: string; usd: string };
    profitAfterGas: Record<string, { raw: string; formatted: string }>;
    profitableAfterGas: number;
    bestTxHash: Hash | null;
    worstTxHash: Hash | null;
    bestProfit: { raw: bigint; formatted: string; token: string };
    worstProfit: { raw: bigint; formatted: string; token: string };
    testModeCount: number;
    timeRange: { first: Date; last: Date };
}

/**
 * Parse command line arguments and options
 */
function parseOptions(): { hashes: Hash[]; options: OutputOptions } {
    const args = process.argv.slice(2);
    const hashes: Hash[] = [];

    // Default options
    const options: OutputOptions = {
        json: false,
        csv: false,
        summary: false,
        detailed: true,
        outputDir: './arbitrage_analysis',
        avaxPrice: 17, // Default AVAX price in USD
        batchSize: 3   // Default batch size
    };

    for (const arg of args) {
        if (arg.startsWith('--')) {
            // Handle options
            if (arg === '--json') options.json = true;
            else if (arg === '--csv') options.csv = true;
            else if (arg === '--summary') {
                options.summary = true;
                options.detailed = false;
            } else if (arg.startsWith('--output=')) {
                options.outputDir = arg.split('=')[1];
            } else if (arg.startsWith('--avax-price=')) {
                const price = parseFloat(arg.split('=')[1]);
                if (!isNaN(price)) options.avaxPrice = price;
            } else if (arg.startsWith('--batch-size=')) {
                const size = parseInt(arg.split('=')[1]);
                if (!isNaN(size) && size > 0) options.batchSize = size;
            }
        } else {
            // Handle transaction hash
            const hash = arg.startsWith('0x') ? arg as Hash : `0x${arg}` as Hash;
            hashes.push(hash);
        }
    }

    return { hashes, options };
}

/**
 * Process a batch of transactions and extract metrics
 */
async function processTransactions(hashes: Hash[], options: OutputOptions): Promise<ArbitrageMetrics[]> {
    console.log(`Processing ${hashes.length} transactions...`);
    const results: ArbitrageMetrics[] = [];
    const storage = new FileTransactionStorage(options.outputDir);

    // Process in batches
    for (let i = 0; i < hashes.length; i += options.batchSize) {
        const batch = hashes.slice(i, i + options.batchSize);
        console.log(`Processing batch ${Math.floor(i/options.batchSize) + 1}/${Math.ceil(hashes.length/options.batchSize)}`);

        // Process batch in parallel
        const batchResults = await Promise.all(
            batch.map(async (hash) => {
                try {
                    return await processTransaction(hash, options);
                } catch (error) {
                    console.error(`Error processing ${hash}:`, error);
                    return null;
                }
            })
        );

        // Add valid results
        batchResults.filter((r): r is ArbitrageMetrics => r !== null).forEach(metrics => {
            results.push(metrics);

            // Save individual transaction results if JSON output is enabled
            if (options.json) {
                const txDir = path.join(options.outputDir, 'transactions');
                if (!fs.existsSync(txDir)) {
                    fs.mkdirSync(txDir, { recursive: true });
                }
                fs.writeFileSync(
                    path.join(txDir, `${metrics.hash}.json`),
                    JSON.stringify(metrics, (_, value) =>
                            typeof value === 'bigint' ? value.toString() : value,
                        2)
                );
            }
        });

        // Wait between batches to avoid rate limiting
        if (i + options.batchSize < hashes.length) {
            console.log('Waiting between batches...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    return results;
}

/**
 * Process a single transaction and extract arbitrage metrics
 */
async function processTransaction(hash: Hash, options: OutputOptions): Promise<ArbitrageMetrics | null> {
    console.log(`Processing transaction ${hash}...`);

    // Get transaction details
    const txDetails = await getTransactionDetails(hash);

    // Extract arbitrage data
    const arbitrageData = extractArbitrageExecutedData(txDetails);
    if (!arbitrageData) {
        console.warn(`Transaction ${hash} does not appear to be an arbitrage transaction.`);
        return null;
    }

    // Extract important metrics
    const route = determineRoute(txDetails.logs);
    const firstLegData = extractFirstLegData(txDetails);
    const secondLegData = extractSecondLegData(txDetails);

    // Convert BigInt values to strings for easier display/JSON serialization
    const sourceTokenDecimals = getTokenDecimals(arbitrageData.sourceToken as Address);
    const targetTokenDecimals = getTokenDecimals(arbitrageData.targetToken as Address);

    const amountIn = arbitrageData.amountIn || '0';
    const finalBalance = arbitrageData.finalBalance || '0';
    const profit = arbitrageData.profit || '0';

    // Calculate profit percentage
    const amountInBigInt = BigInt(amountIn);
    const profitBigInt = BigInt(profit);
    const profitPercent = amountInBigInt > 0n
        ? parseFloat(formatUnits(profitBigInt * 10000n / amountInBigInt, 2))
        : 0;

    // Calculate gas costs
    const gasCost = txDetails.gasData.gasCost;
    const gasCostInAVAX = formatEther(gasCost);
    const gasCostInUSD = (parseFloat(gasCostInAVAX) * options.avaxPrice).toFixed(2);

    // Create metrics object
    const metrics: ArbitrageMetrics = {
        hash,
        timestamp: new Date(Number(txDetails.timestamp) * 1000),
        blockNumber: txDetails.blockNumber,
        status: txDetails.status,
        route,
        sourceToken: getTokenSymbol(arbitrageData.sourceToken as Address),
        targetToken: getTokenSymbol(arbitrageData.targetToken as Address),
        amountIn,
        amountInFormatted: formatUnits(BigInt(amountIn), sourceTokenDecimals),
        finalBalance,
        finalBalanceFormatted: formatUnits(BigInt(finalBalance), sourceTokenDecimals),
        profit,
        profitFormatted: formatUnits(BigInt(profit), sourceTokenDecimals),
        profitPercent,
        gasUsed: txDetails.gasData.gasUsed,
        gasPrice: txDetails.gasData.effectiveGasPrice,
        gasCost: gasCostInAVAX,
        gasCostInUSD,
        testMode: arbitrageData.testMode || false,
        firstLeg: {
            router: firstLegData?.router || 'Unknown',
            startBalance: firstLegData?.startBalance || '0',
            expectedOutput: firstLegData?.expectedOutput || '0'
        },
        secondLeg: {
            router: secondLegData?.router || 'Unknown',
            startBalance: secondLegData?.startBalance || '0',
            expectedOutput: secondLegData?.expectedOutput || '0'
        }
    };

    // Extract event timing information to calculate execution time
    try {
        const executionTime = calculateExecutionTime(txDetails.logs);
        if (executionTime) {
            metrics.executionTime = executionTime;
        }
    } catch (error) {
        console.warn(`Could not calculate execution time for ${hash}:`, error);
    }

    // Calculate slippage if possible
    try {
        const slippage = calculateSlippage(txDetails, firstLegData, secondLegData);
        if (slippage) {
            metrics.slippage = slippage;
        }
    } catch (error) {
        console.warn(`Could not calculate slippage for ${hash}:`, error);
    }

    // Print brief summary if detailed output is enabled
    if (options.detailed) {
        console.log(`\nTransaction ${hash} processed:`);
        console.log(`  Status: ${metrics.status}`);
        console.log(`  Route: ${metrics.route}`);
        console.log(`  Profit: ${metrics.profitFormatted} ${metrics.sourceToken} (${metrics.profitPercent.toFixed(2)}%)`);
        console.log(`  Gas Cost: ${metrics.gasCost} AVAX (${metrics.gasCostInUSD})`);
        console.log(`  Test Mode: ${metrics.testMode ? 'Yes' : 'No'}`);
    }

    return metrics;
}

/**
 * Calculate execution time from transaction logs
 */
function calculateExecutionTime(logs: DecodedLog[]): number | null {
    const events = logs
        .filter(log =>
            log.decoded?.name === 'SwapInitiated' ||
            log.decoded?.name === 'SwapCompleted' ||
            log.decoded?.name === 'ArbitrageExecuted'
        )
        .map(log => ({
            name: log.decoded?.name || '',
            args: log.decoded?.args || {},
            logIndex: log.logIndex
        }))
        .sort((a, b) => a.logIndex - b.logIndex);

    if (events.length < 2) return null;

    // Find the first and last relevant events
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];

    // We don't have actual timestamps for individual logs,
    // so this is a simplified representation based on log ordering
    return lastEvent.logIndex - firstEvent.logIndex;
}

/**
 * Calculate slippage based on expected vs actual output
 */
function calculateSlippage(
    tx: DetailedTransaction,
    firstLegData: ReturnType<typeof extractFirstLegData>,
    secondLegData: ReturnType<typeof extractSecondLegData>
): { firstLeg: number; secondLeg: number; total: number } | null {
    // This function would need access to actual output values to calculate slippage
    // For now, return placeholder values
    return {
        firstLeg: 0,
        secondLeg: 0,
        total: 0
    };
}

/**
 * Calculate summary statistics for a batch of transactions
 */
function calculateSummary(metrics: ArbitrageMetrics[]): ArbitrageSummary {
    if (metrics.length === 0) {
        throw new Error('Cannot calculate summary for empty metrics array');
    }

    // Count successes/failures
    const successCount = metrics.filter(m => m.status === 'success').length;
    const failureCount = metrics.length - successCount;
    const successRate = successCount / metrics.length;

    // Group by token for profit calculations
    const tokenGroups: Record<string, ArbitrageMetrics[]> = {};
    metrics.forEach(m => {
        if (!tokenGroups[m.sourceToken]) {
            tokenGroups[m.sourceToken] = [];
        }
        tokenGroups[m.sourceToken].push(m);
    });

    // Calculate total and average profit by token
    const totalProfit: Record<string, { raw: bigint; formatted: string }> = {};
    const averageProfit: Record<string, { raw: number; formatted: string }> = {};
    const medianProfit: Record<string, { raw: number; formatted: string }> = {};

    Object.entries(tokenGroups).forEach(([token, txs]) => {
        // Only include successful transactions in profit calculations
        const successfulTxs = txs.filter((tx): tx is ArbitrageMetrics => tx.status === 'success');

        if (successfulTxs.length === 0) {
            totalProfit[token] = { raw: 0n, formatted: '0' };
            averageProfit[token] = { raw: 0, formatted: '0' };
            medianProfit[token] = { raw: 0, formatted: '0' };
            return;
        }

        // Calculate total profit
        const totalBigInt = successfulTxs.reduce(
            (sum, tx) => sum + BigInt(tx.profit), 0n
        );

        // Get token decimals for formatting
        const tokenAddress = getTokenAddress(token);
        const decimals = getTokenDecimals(tokenAddress);

        totalProfit[token] = {
            raw: totalBigInt,
            formatted: formatUnits(totalBigInt, decimals)
        };

        // Calculate average profit
        const avgRaw = Number(totalBigInt) / successfulTxs.length;
        averageProfit[token] = {
            raw: avgRaw,
            formatted: formatUnits(BigInt(Math.floor(avgRaw)), decimals)
        };

        // Calculate median profit
        const sortedProfits = [...successfulTxs]
            .map(tx => BigInt(tx.profit))
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        const middle = Math.floor(sortedProfits.length / 2);
        const medianValue = sortedProfits.length % 2 === 0
            ? (Number(sortedProfits[middle - 1]) + Number(sortedProfits[middle])) / 2
            : Number(sortedProfits[middle]);

        medianProfit[token] = {
            raw: medianValue,
            formatted: formatUnits(BigInt(Math.floor(medianValue)), decimals)
        };
    });

    // Calculate route distribution
    const routeDistribution: Record<string, number> = {
        'uniswap-to-traderjoe': 0,
        'traderjoe-to-uniswap': 0,
        'unknown': 0
    };

    metrics.forEach(m => {
        routeDistribution[m.route]++;
    });

    // Calculate gas costs
    const totalGasInAVAX = metrics.reduce(
        (sum, m) => sum + parseFloat(m.gasCost), 0
    );
    const totalGasInUSD = metrics.reduce(
        (sum, m) => sum + parseFloat(m.gasCostInUSD), 0
    );

    const avgGasInAVAX = totalGasInAVAX / metrics.length;
    const avgGasInUSD = totalGasInUSD / metrics.length;

    // Find best and worst transactions
    let bestTx: ArbitrageMetrics | null = null;
    let worstTx: ArbitrageMetrics | null = null;

    // Create a typed array of successful transactions
    const successfulMetrics = metrics.filter((m): m is ArbitrageMetrics => m.status === 'success');
// If there are any successful transactions
    if (successfulMetrics.length > 0) {
        // Find best transaction
        bestTx = successfulMetrics.reduce((best, current) => {
            const bestProfit = best ? BigInt(best.profit) : 0n;
            const currentProfit = BigInt(current.profit);
            return currentProfit > bestProfit ? current : best;
        }, null as ArbitrageMetrics | null);

        // Find worst transaction
        worstTx = successfulMetrics.reduce((worst, current) => {
            // Initialize with the first transaction if worst is null
            if (!worst) return current;

            const worstProfit = BigInt(worst.profit);
            const currentProfit = BigInt(current.profit);
            return currentProfit < worstProfit ? current : worst;
        }, null as ArbitrageMetrics | null);
    }
    successfulMetrics.forEach(m => {
        const profitValue = BigInt(m.profit);

        if (!bestTx || profitValue > BigInt(bestTx.profit)) {
            bestTx = m;
        }

        if (!worstTx || profitValue < BigInt(worstTx.profit)) {
            worstTx = m;
        }
    });

    // Calculate profit after gas costs (crude approximation)
    const profitAfterGas: Record<string, { raw: string; formatted: string }> = {};
    let profitableAfterGas = 0;

    // Assuming all transactions are in same token for simplicity in this calculation
    Object.entries(totalProfit).forEach(([token, profit]) => {
        // Assuming all gas costs are paid in the same token (simplified)
        const tokenAddress = getTokenAddress(token);
        const decimals = getTokenDecimals(tokenAddress);

        // Convert gas cost to token (very crude approximation)
        // In reality, this would need oracle price data for accurate conversion
        const gasInToken = totalGasInUSD / 10; // Assuming token is worth $10 each

        const netProfit = Number(profit.raw) - gasInToken;
        profitAfterGas[token] = {
            raw: netProfit.toString(),
            formatted: netProfit > 0 ? formatUnits(BigInt(Math.floor(netProfit)), decimals) : '0'
        };
    });

    // Count profitable transactions after gas
    metrics.forEach(m => {
        const profitValue = parseFloat(m.profitFormatted);
        const gasCostInToken = parseFloat(m.gasCostInUSD) / 10; // Same crude approximation

        if (profitValue > gasCostInToken) {
            profitableAfterGas++;
        }
    });

    // Count test mode transactions
    const testModeCount = metrics.filter(m => m.testMode).length;

    // Get time range
    const timestamps = metrics.map(m => m.timestamp.getTime());
    const first = new Date(Math.min(...timestamps));
    const last = new Date(Math.max(...timestamps));

    return {
        totalTransactions: metrics.length,
        successCount,
        failureCount,
        successRate,
        totalProfit,
        averageProfit,
        medianProfit,
        routeDistribution,
        totalGasCost: {
            avax: totalGasInAVAX.toFixed(6),
            usd: totalGasInUSD.toFixed(2)
        },
        averageGasCost: {
            avax: avgGasInAVAX.toFixed(6),
            usd: avgGasInUSD.toFixed(2)
        },
        profitAfterGas,
        profitableAfterGas,
        bestTxHash: bestTx ? bestTx.hash : null,
        worstTxHash: worstTx ? worstTx.hash : null,
        bestProfit: bestTx ? {
            raw: BigInt(bestTx.profit),
            formatted: bestTx.profitFormatted,
            token: bestTx.sourceToken
        } : { raw: 0n, formatted: '0', token: 'UNKNOWN' },
        worstProfit: worstTx ? {
            raw: BigInt(worstTx.profit),
            formatted: worstTx.profitFormatted,
            token: worstTx.sourceToken
        } : { raw: 0n, formatted: '0', token: 'UNKNOWN' },
        testModeCount,
        timeRange: { first, last }
    };
}

/**
 * Generate CSV file from transaction metrics
 */
function generateCSV(metrics: ArbitrageMetrics[], outputPath: string): void {
    if (metrics.length === 0) return;

    // Define CSV headers
    const headers = [
        'hash',
        'timestamp',
        'blockNumber',
        'status',
        'route',
        'sourceToken',
        'targetToken',
        'amountInFormatted',
        'finalBalanceFormatted',
        'profitFormatted',
        'profitPercent',
        'gasUsed',
        'gasPrice',
        'gasCost',
        'gasCostInUSD',
        'testMode',
        'executionTime'
    ].join(',');

    // Generate CSV rows
    const rows = metrics.map(m => [
        m.hash,
        m.timestamp.toISOString(),
        m.blockNumber.toString(),
        m.status,
        m.route,
        m.sourceToken,
        m.targetToken,
        m.amountInFormatted,
        m.finalBalanceFormatted,
        m.profitFormatted,
        m.profitPercent.toFixed(2),
        m.gasUsed.toString(),
        m.gasPrice.toString(),
        m.gasCost,
        m.gasCostInUSD,
        m.testMode.toString(),
        m.executionTime || 'N/A'
    ].join(','));

    // Combine headers and rows
    const csv = [headers, ...rows].join('\n');

    // Write to file
    fs.writeFileSync(outputPath, csv);
    console.log(`CSV file generated: ${outputPath}`);
}

/**
 * Print summary to console
 */
function printSummary(summary: ArbitrageSummary): void {
    console.log('\n=======================================================================================');
    console.log('ARBITRAGE TRANSACTION SUMMARY');
    console.log('=======================================================================================');

    console.log(`Total Transactions: ${summary.totalTransactions}`);
    console.log(`Success Rate: ${summary.successCount}/${summary.totalTransactions} (${(summary.successRate * 100).toFixed(1)}%)`);
    console.log(`Test Mode Transactions: ${summary.testModeCount}`);
    console.log(`Time Range: ${summary.timeRange.first.toISOString()} to ${summary.timeRange.last.toISOString()}`);

    console.log('\nRoute Distribution:');
    Object.entries(summary.routeDistribution).forEach(([route, count]) => {
        console.log(`  ${route}: ${count} (${(count / summary.totalTransactions * 100).toFixed(1)}%)`);
    });

    console.log('\nProfit Summary:');
    Object.entries(summary.totalProfit).forEach(([token, profit]) => {
        console.log(`  Total ${token} Profit: ${profit.formatted}`);
        console.log(`  Average ${token} Profit: ${summary.averageProfit[token].formatted}`);
        console.log(`  Median ${token} Profit: ${summary.medianProfit[token].formatted}`);
    });

    console.log('\nGas Costs:');
    console.log(`  Total Gas Cost: ${summary.totalGasCost.avax} AVAX (${summary.totalGasCost.usd})`);
    console.log(`  Average Gas Cost: ${summary.averageGasCost.avax} AVAX (${summary.averageGasCost.usd})`);

    console.log('\nProfit After Gas:');
    Object.entries(summary.profitAfterGas).forEach(([token, profit]) => {
        console.log(`  Net ${token} Profit: ${profit.formatted}`);
    });
    console.log(`  Profitable After Gas: ${summary.profitableAfterGas}/${summary.totalTransactions} (${(summary.profitableAfterGas / summary.totalTransactions * 100).toFixed(1)}%)`);

    if (summary.bestTxHash) {
        console.log('\nBest Transaction:');
        console.log(`  Hash: ${summary.bestTxHash}`);
        console.log(`  Profit: ${summary.bestProfit.formatted} ${summary.bestProfit.token}`);
    }

    if (summary.worstTxHash) {
        console.log('\nWorst Transaction:');
        console.log(`  Hash: ${summary.worstTxHash}`);
        console.log(`  Profit: ${summary.worstProfit.formatted} ${summary.worstProfit.token}`);
    }

    console.log('=======================================================================================');
}