#!/usr/bin/env node
/**
 * getDetailTransactions.ts
 *
 * A standalone utility to fetch and analyze transaction details from Avalanche blockchain.
 * This script focuses on extracting detailed transaction information and storing it for
 * later analysis.
 *
 * Usage:
 * ts-node getDetailTransactions.ts <tx_hash1> <tx_hash2> ... <tx_hash_n>
 *
 * Options:
 * --format=json|console (default: console)
 * --output=<directory> (default: ./transaction_data)
 */

import {
    Hash,
    formatUnits,
    type Address
} from 'viem';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
    getTransactionDetails,
    safeBigInt,
    determineRoute,
    extractArbitrageExecutedData,
    extractFirstLegData,
    extractSecondLegData,
    type DetailedTransaction
} from './transactionUtils';
import { TOKEN_CONFIGS } from './constants';

// Initialize environment variables
dotenv.config();

// Define CLI options
interface CliOptions {
    format: 'json' | 'console';
    outputDir: string;
    batchSize: number;
}

/**
 * Parse command line arguments
 */
function parseArgs(): { txHashes: Hash[], options: CliOptions } {
    const args = process.argv.slice(2);
    const txHashes: Hash[] = [];
    const options: CliOptions = {
        format: 'console',
        outputDir: './transaction_data',
        batchSize: 3
    };

    for (const arg of args) {
        if (arg.startsWith('--')) {
            // Handle options
            if (arg.startsWith('--format=')) {
                const format = arg.split('=')[1];
                if (format === 'json' || format === 'console') {
                    options.format = format;
                }
            } else if (arg.startsWith('--output=')) {
                options.outputDir = arg.split('=')[1];
            } else if (arg.startsWith('--batch-size=')) {
                const size = parseInt(arg.split('=')[1]);
                if (!isNaN(size) && size > 0) {
                    options.batchSize = size;
                }
            }
        } else {
            // Handle transaction hash
            const hash = arg.startsWith('0x') ? arg as Hash : `0x${arg}` as Hash;
            txHashes.push(hash);
        }
    }

    return { txHashes, options };
}

/**
 * Process a batch of transaction hashes
 */
async function processTransactions(txHashes: Hash[], options: CliOptions): Promise<DetailedTransaction[]> {
    console.log(`Processing ${txHashes.length} transactions...`);

    // Create output directory if it doesn't exist
    if (!fs.existsSync(options.outputDir)) {
        fs.mkdirSync(options.outputDir, { recursive: true });
    }

    const results: DetailedTransaction[] = [];

    // Process in batches to avoid rate limiting
    for (let i = 0; i < txHashes.length; i += options.batchSize) {
        const batch = txHashes.slice(i, i + options.batchSize);
        console.log(`Processing batch ${Math.floor(i/options.batchSize) + 1}/${Math.ceil(txHashes.length/options.batchSize)}`);

        // Process batch in parallel
        const batchResults = await Promise.all(
            batch.map(async (hash) => {
                try {
                    console.log(`Fetching details for transaction ${hash}...`);
                    const txDetails = await getTransactionDetails(hash);

                    // Store transaction data directly
                    const filePath = path.join(options.outputDir, `${hash}.json`);
                    const jsonSafeData = prepareBigIntForJson(txDetails);
                    await fs.promises.writeFile(
                        filePath,
                        JSON.stringify(jsonSafeData, null, 2),
                        'utf-8'
                    );

                    // Print transaction summary
                    printTransactionSummary(txDetails);

                    return txDetails;
                } catch (error) {
                    console.error(`Error processing ${hash}:`, error);
                    return null;
                }
            })
        );

        // Filter out errors and add valid results
        const validResults = batchResults.filter((tx): tx is DetailedTransaction => tx !== null);
        results.push(...validResults);

        // Wait between batches to avoid rate limiting
        if (i + options.batchSize < txHashes.length) {
            console.log('Waiting between batches...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    return results;
}
function prepareBigIntForJson(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'bigint') {
        return obj.toString();
    }

    if (Array.isArray(obj)) {
        return obj.map(prepareBigIntForJson);
    }

    if (typeof obj === 'object') {
        const result: any = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                result[key] = prepareBigIntForJson(obj[key]);
            }
        }
        return result;
    }

    return obj;
}

function printTransactionSummary(tx: DetailedTransaction): void {
    console.log('\n=======================================================================================');
    console.log(`TRANSACTION: ${tx.hash}`);
    console.log('=======================================================================================');

    // Basic transaction details
    console.log('Transaction Details:');
    console.log(`  Block: ${tx.blockNumber} (${new Date(Number(tx.timestamp) * 1000).toISOString()})`);
    console.log(`  Status: ${tx.status}`);
    console.log(`  From: ${tx.from}`);
    console.log(`  To: ${tx.to || 'N/A'}`);
    console.log(`  Value: ${tx.valueFormatted} AVAX`);

    // Robust gas data logging
    try {
        console.log(`  Gas Used: ${tx.gasData.gasUsed.toString()} (${(Number(tx.gasData.gasUsed) / Number(tx.gasData.gasLimit) * 100).toFixed(1)}% of limit)`);
        console.log(`  Gas Price: ${formatUnits(tx.gasData.effectiveGasPrice, 9)} Gwei`);
        console.log(`  Gas Cost: ${tx.gasData.gasCostInAVAX} AVAX`);
    } catch (error) {
        console.log('  Gas Data: Unable to parse gas information');
    }

    // Check if this is an arbitrage transaction
    const arbitrageData = extractArbitrageExecutedData(tx);
    if (arbitrageData) {
        console.log('\nArbitrage Transaction Details:');

        // Robust route determination
        const route = determineRoute(tx.logs);
        console.log(`  Route: ${route}`);

        // Safely get token symbols with fallback
        const sourceToken = safeGetTokenSymbol(arbitrageData.sourceToken);
        const targetToken = safeGetTokenSymbol(arbitrageData.targetToken);

        console.log(`  Source Token: ${sourceToken} (${arbitrageData.sourceToken})`);
        console.log(`  Target Token: ${targetToken} (${arbitrageData.targetToken})`);

        // Safe formatting with error handling
        try {
            const sourceDecimals = getTokenDecimals(arbitrageData.sourceToken);

            const amountInFormatted = safeFormatBigInt(
                safeBigInt(arbitrageData.amountIn),
                sourceDecimals
            );
            const finalBalanceFormatted = safeFormatBigInt(
                safeBigInt(arbitrageData.finalBalance),
                sourceDecimals
            );
            const profitFormatted = safeFormatBigInt(
                safeBigInt(arbitrageData.profit),
                sourceDecimals
            );

            console.log(`  Amount In: ${amountInFormatted} ${sourceToken}`);
            console.log(`  Final Balance: ${finalBalanceFormatted} ${sourceToken}`);
            console.log(`  Profit: ${profitFormatted} ${sourceToken}`);
        } catch (error) {
            console.log('  Unable to format arbitrage amounts');
        }

        console.log(`  Test Mode: ${arbitrageData.testMode ? 'Yes' : 'No'}`);

        // First leg data with error handling
        try {
            const firstLegData = extractFirstLegData(tx);
            if (firstLegData && Object.keys(firstLegData).length > 0) {
                console.log('\n  First Leg Details:');
                console.log(`    Router: ${firstLegData.router || 'N/A'}`);
                console.log(`    Start Balance: ${firstLegData.startBalance || 'N/A'}`);
                console.log(`    Expected Output: ${firstLegData.expectedOutput || 'N/A'}`);
            }
        } catch (error) {
            console.log('  Unable to extract first leg data');
        }

        // Second leg data with error handling
        try {
            const secondLegData = extractSecondLegData(tx);
            if (secondLegData && Object.keys(secondLegData).length > 0) {
                console.log('\n  Second Leg Details:');
                console.log(`    Router: ${secondLegData.router || 'N/A'}`);
                console.log(`    Start Balance: ${secondLegData.startBalance || 'N/A'}`);
                console.log(`    Expected Output: ${secondLegData.expectedOutput || 'N/A'}`);
            }
        } catch (error) {
            console.log('  Unable to extract second leg data');
        }
    }

    // Token transfers with error handling
    try {
        if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
            console.log('\nToken Transfers:');
            tx.tokenTransfers.forEach((transfer, i) => {
                const tokenSymbol = safeGetTokenSymbol(transfer.token);
                console.log(`  ${i + 1}. ${transfer.from.slice(0, 8)}...${transfer.from.slice(-6)} → ` +
                    `${transfer.to.slice(0, 8)}...${transfer.to.slice(-6)}: ` +
                    `${transfer.valueFormatted} ${tokenSymbol}`);
            });
        }
    } catch (error) {
        console.log('  Unable to process token transfers');
    }

    // Event types logging with error handling
    try {
        const eventTypes = Array.from(new Set(
            tx.logs
                .filter(log => log.decoded?.name)
                .map(log => log.decoded?.name)
        ));

        if (eventTypes.length > 0) {
            console.log('\nEvent Types:');
            console.log(`  ${eventTypes.join(', ')}`);
        }
    } catch (error) {
        console.log('  Unable to extract event types');
    }

    console.log('=======================================================================================');
}

// Helper functions
function safeGetTokenSymbol(address: Address): string {
    try {
        return getTokenSymbol(address);
    } catch {
        return address.slice(0, 6) + '...' + address.slice(-4);
    }
}

function safeFormatBigInt(value: bigint, decimals: number): string {
    try {
        return formatUnits(value, decimals);
    } catch {
        return value.toString();
    }
}
/**
 * Helper function to get token symbol
 */
function getTokenSymbol(address: Address): string {
    const lowerCaseAddr = address.toLowerCase();

    if (lowerCaseAddr === TOKEN_CONFIGS.USDC.address.toLowerCase()) {
        return TOKEN_CONFIGS.USDC.symbol;
    } else if (lowerCaseAddr === TOKEN_CONFIGS.WAVAX.address.toLowerCase()) {
        return TOKEN_CONFIGS.WAVAX.symbol;
    }

    // For unknown tokens, return shortened address
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Helper function to get token decimals
 */
function getTokenDecimals(address: Address): number {
    const lowerCaseAddr = address.toLowerCase();

    if (lowerCaseAddr === TOKEN_CONFIGS.USDC.address.toLowerCase()) {
        return TOKEN_CONFIGS.USDC.decimals;
    } else if (lowerCaseAddr === TOKEN_CONFIGS.WAVAX.address.toLowerCase()) {
        return TOKEN_CONFIGS.WAVAX.decimals;
    }

    // Default for unknown tokens
    return 18;
}

/**
 * Main function
 */
async function main() {
    const { txHashes, options } = parseArgs();

    if (txHashes.length === 0) {
        console.error('Please provide at least one transaction hash as a command line argument.');
        console.error('Usage: ts-node getDetailTransactions.ts <tx_hash1> <tx_hash2> ... <tx_hash_n>');
        console.error('Options:');
        console.error('  --format=json|console (default: console)');
        console.error('  --output=<directory> (default: ./transaction_data)');
        console.error('  --batch-size=<n> (default: 3)');
        process.exit(1);
    }

    try {
        console.log(`Saving transaction data to: ${options.outputDir}`);
        const results = await processTransactions(txHashes, options);

        console.log(`\nSuccessfully processed ${results.length} of ${txHashes.length} transactions.`);
        console.log(`All transaction details have been saved to: ${options.outputDir}`);

        // If any arbitrage transactions were found, suggest using analyzeArbitrageTxs.ts
        const arbitrageCount = results.filter(tx => extractArbitrageExecutedData(tx) !== null).length;
        if (arbitrageCount > 0) {
            console.log(`\nFound ${arbitrageCount} arbitrage transactions.`);
            console.log('For more detailed arbitrage analysis, try using:');
            console.log(`ts-node analyzeArbitrageTxs.ts ${txHashes.join(' ')}`);
        }

    } catch (error) {
        console.error('Error processing transactions:', error);
        process.exit(1);
    }
}

// Run the main function
main().catch(console.error);