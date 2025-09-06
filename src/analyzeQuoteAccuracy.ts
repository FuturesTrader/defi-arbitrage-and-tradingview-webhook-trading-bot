// src/analyzeQuoteAccuracy.ts
// Enhanced to support WBTC trading and updated data format from runDataCollection.ts

import { Hash, formatUnits, decodeEventLog, type Address, type TransactionReceipt}  from 'viem';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
    getTransactionDetails,
    determineRoute,
    extractArbitrageExecutedData,
    extractFirstLegData,
    extractSecondLegData,
    getTokenDecimals,
    getTokenSymbol,
    getTokenAddress,
} from './transactionUtils';
import { wavaxPriceQuoter } from './wavaxPriceQuoter';
import { TOKEN_CONFIGS, ADDRESSES } from './constants';
import { ARBITRAGE_ABI } from './services/constants/arbitrageAbi';
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
    indexFile: string | null;
    dataDir: string | null;
    verbose: boolean;
    writeSuggestedCode: boolean;
    applySmoothingFactor: boolean;
    smoothingFactor: number;
    adjustForOutliers: boolean;
    confidenceThreshold: number;
    minSampleSize: number;
}

// Define interface for accuracy metrics
interface AccuracyMetrics {
    hash: Hash;
    timestamp: Date;
    blockNumber: bigint;
    route: 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap' | 'unknown';
    status: 'success' | 'reverted' | 'unknown';
    testMode: boolean;
    sourceToken: string;
    targetToken: string;
    tokenPair: string; // Added to track USDC-WAVAX or USDC-WBTC
    tradeInputAmount: string;
    tradeFinalBalance: string;
    accountBalance: string; // Total account balance
    // Input and output amounts
    amountIn: string;
    amountInFormatted: string;
    finalBalance: string;
    finalBalanceFormatted: string;
    profit: string;
    profitFormatted: string;
    profitPercent: number;

    // First leg metrics
    firstLeg: {
        dex: string;
        router: string;
        startBalance: string;
        expectedOutput: string;
        actualOutput: string;
        actualOutputFormatted?: string;
        outputDelta: string;
        accuracyPercent: number; // Positive = better than expected, negative = worse
        gasUsed?: string;
    };

    // Second leg metrics
    secondLeg: {
        dex: string;
        router: string;
        startBalance: string;
        expectedOutput: string;
        actualOutput: string;
        outputDelta: string;
        actualOutputFormatted?: string;
        accuracyPercent: number;
        gasUsed?: string;
        _originalActualOutput?: string;
        _originalOutputDelta?: string;
        _originalAccuracyPercent?: number;
    };

    // Gas metrics
    gasUsed: bigint;
    gasPrice: bigint;
    gasCost: string;
    gasCostInUSD: string;
    // Flash loan specific fields
    isFlashLoan?: boolean;
    flashLoanFee?: string;
    netProfit?: string;
    // Overall metrics
    overallAccuracy: number;
    profitPredictionAccuracy: number; // How accurate was our profit prediction
    profitImpact: number; // How much accuracy affected profit
    quoteAge?: number; // If available
    executionTime?: number; // If available
    tradeContext?: {
        expectedFirstOutput: string;
        actualFirstOutput: string;
        expectedSecondOutput: string;
        actualSecondOutput: string;
    };
}

/**
 * Parse command line arguments and options
 */
function parseOptions(): {
    hashes: Hash[];
    options: OutputOptions;
    dataFiles: string[] | null;
} {
    const args = process.argv.slice(2);
    let dataFiles: string[] | null = null;

    // Default options
    const options: OutputOptions = {
        json: false,
        csv: false,
        summary: true,
        detailed: true,
        outputDir: './quote_accuracy_analysis',
        avaxPrice: 17, // Default AVAX price in USD
        batchSize: 3,   // Default batch size
        indexFile: null,
        dataDir: null,
        verbose: false,
        writeSuggestedCode: true,
        applySmoothingFactor: true,
        smoothingFactor: 0.15, // 15% smoothing to avoid overcompensation
        adjustForOutliers: true,
        confidenceThreshold: 0.8, // 80% confidence needed for high confidence
        minSampleSize: 10  // At least 10 samples needed for high confidence
    };

    // Extract transaction hashes
    const hashes: Hash[] = [];

    for (const arg of args) {
        if (arg.startsWith('--')) {
            // Handle options
            if (arg === '--json') options.json = true;
            else if (arg === '--csv') options.csv = true;
            else if (arg === '--summary') {
                options.summary = true;
                options.detailed = false;
            }
            else if (arg === '--detailed') options.detailed = true;
            else if (arg === '--verbose') options.verbose = true;
            else if (arg === '--no-suggested-code') options.writeSuggestedCode = false;
            else if (arg === '--no-smoothing') options.applySmoothingFactor = false;
            else if (arg === '--no-outlier-adjustment') options.adjustForOutliers = false;
            else if (arg.startsWith('--output=')) {
                options.outputDir = arg.split('=')[1];
            }
            else if (arg.startsWith('--avax-price=')) {
                const price = parseFloat(arg.split('=')[1]);
                if (!isNaN(price)) options.avaxPrice = price;
            }
            else if (arg.startsWith('--batch-size=')) {
                const size = parseInt(arg.split('=')[1]);
                if (!isNaN(size) && size > 0) options.batchSize = size;
            }
            else if (arg.startsWith('--smoothing=')) {
                const factor = parseFloat(arg.split('=')[1]);
                if (!isNaN(factor) && factor >= 0 && factor <= 1) {
                    options.smoothingFactor = factor;
                }
            }
            else if (arg.startsWith('--confidence=')) {
                const threshold = parseFloat(arg.split('=')[1]);
                if (!isNaN(threshold) && threshold >= 0 && threshold <= 1) {
                    options.confidenceThreshold = threshold;
                }
            }
            else if (arg.startsWith('--min-samples=')) {
                const samples = parseInt(arg.split('=')[1]);
                if (!isNaN(samples) && samples > 0) {
                    options.minSampleSize = samples;
                }
            }
            else if (arg.startsWith('--index=')) {
                options.indexFile = arg.split('=')[1];
            }
            else if (arg.startsWith('--data-dir=')) {
                options.dataDir = arg.split('=')[1];
            }
        } else if (arg.endsWith('.json')) {
            // Treat as data file
            if (!dataFiles) dataFiles = [];
            dataFiles.push(arg);
        } else {
            // Handle transaction hash
            const hash = arg.startsWith('0x') ? arg as Hash : `0x${arg}` as Hash;
            hashes.push(hash);
        }
    }

    // If indexFile is specified, read transaction hashes from it
    if (options.indexFile && fs.existsSync(options.indexFile)) {
        try {
            const indexContent = fs.readFileSync(options.indexFile, 'utf-8');
            const lines = indexContent.split('\n');

            // Skip header row if it starts with "trade_id"
            const startIdx = lines[0].startsWith('trade_id') ? 1 : 0;

            for (let i = startIdx; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const parts = line.split(',');
                if (parts.length >= 13) { // Updated to accommodate the expanded CSV format
                    const hash = parts[4].trim(); // tx_hash column (index adjusted for new format)
                    if (hash && hash !== 'NULL' && hash.startsWith('0x')) {
                        hashes.push(hash as Hash);
                    }

                    // Check for data file path (now at index 12)
                    if (parts[12] && parts[12].endsWith('.json')) {
                        // This is a data file path
                        if (!dataFiles) dataFiles = [];
                        dataFiles.push(parts[12].trim());
                    }
                }
            }
        } catch (error) {
            console.error(`Error reading index file: ${options.indexFile}`, error);
        }
    }

    // If dataDir is specified, collect all JSON files from it
    if (options.dataDir && fs.existsSync(options.dataDir)) {
        try {
            const files = fs.readdirSync(options.dataDir);
            if (!dataFiles) dataFiles = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    dataFiles.push(path.join(options.dataDir, file));
                }
            }
        } catch (error) {
            console.error(`Error reading data directory: ${options.dataDir}`, error);
        }
    }

    // Create output directory
    if (!fs.existsSync(options.outputDir)) {
        fs.mkdirSync(options.outputDir, { recursive: true });
    }

    return { hashes, options, dataFiles };
}

/**
 * Analyze quote accuracy for a single transaction hash
 * @param txHash The transaction hash to analyze
 * @param avaxPrice The AVAX price in USD for gas calculations
 */
async function analyzeQuoteAccuracy(txHash: Hash, avaxPrice: number = 17): Promise<AccuracyMetrics | null> {
    try {
        // Get transaction details
        const tx = await getTransactionDetails(txHash);

        // Extract arbitrage data
        const arbitrageData = extractArbitrageExecutedData(tx);
        if (!arbitrageData) {
            console.warn(`${txHash} is not an arbitrage transaction`);
            return null;
        }
        // Use trade-specific balance data when available
        const amountIn = arbitrageData.amountIn || '0';
        const amountInBigInt = safeBigInt(amountIn);

        // Get token decimals for formatting
        const sourceTokenAddress = arbitrageData.sourceToken as Address;
        const targetTokenAddress = arbitrageData.targetToken as Address;
        const sourceDecimals = getTokenDecimals(sourceTokenAddress);
        const sourceSymbol = getTokenSymbol(sourceTokenAddress);
        const targetSymbol = getTokenSymbol(targetTokenAddress);

        // Determine token pair (new field)
        const tokenPair = sourceSymbol === 'USDC' && targetSymbol === 'WAVAX' ? 'USDC-WAVAX' :
            sourceSymbol === 'USDC' && targetSymbol === 'BTC.b' ? 'USDC-WBTC' :
                'unknown';

        const amountInFormatted = formatUnits(safeBigInt(amountIn), sourceDecimals);
        const tradeFinalBalance = arbitrageData.finalBalance?.toString() || "0";
        // Calculate the actual profit
        const tradeInputAmount = arbitrageData.amountIn?.toString() || "0";
        const accountBalance = arbitrageData.accountBalance || tradeFinalBalance || '0';

        // Use trade-specific profit when available
        const profit = calculateProfit(tradeInputAmount, tradeFinalBalance);
        const profitFormatted = formatUnits(safeBigInt(profit), sourceDecimals);

        // Extract leg data
        const firstLegData = extractFirstLegData(tx);
        const secondLegData = extractSecondLegData(tx);
        const finalBalance = arbitrageData.finalBalance || '0';
        const finalBalanceFormatted = formatUnits(safeBigInt(finalBalance), sourceDecimals);
        // Calculate profit percentage

        const profitBigInt = safeBigInt(profit);
        const profitPercent = amountInBigInt > 0n
            ? Number(profitBigInt * 10000n / amountInBigInt) / 100
            : 0;

        // Calculate gas costs
        const gasUsed = tx.gasData.gasUsed;
        const gasPrice = tx.gasData.effectiveGasPrice;
        const gasCost = tx.gasData.gasCostInAVAX;
        const gasCostInUSD = (parseFloat(gasCost) * avaxPrice).toFixed(2);
        // Determine route
        const route = determineRoute(tx.logs);
        // Determine DEX for each leg based on route
        const firstLegDex = route === 'uniswap-to-traderjoe' ? 'uniswap' : 'traderjoe';
        const secondLegDex = route === 'uniswap-to-traderjoe' ? 'traderjoe' : 'uniswap';

        // Build accuracy metrics object with defaults
        const metrics: AccuracyMetrics = {
            hash: txHash,
            timestamp: new Date(Number(tx.timestamp) * 1000),
            blockNumber: tx.blockNumber,
            route,
            status: tx.status,
            testMode: arbitrageData.testMode || false,
            sourceToken: sourceSymbol,
            targetToken: targetSymbol,
            tokenPair, // Added token pair field
            tradeInputAmount: amountIn,
            tradeFinalBalance: tradeFinalBalance,
            accountBalance: accountBalance,
            // Token amounts
            amountIn,
            amountInFormatted,
            finalBalance,
            finalBalanceFormatted,
            profit,
            profitFormatted,
            profitPercent,

            // First leg metrics - initialize with available data
            firstLeg: {
                dex: firstLegDex,
                router: firstLegData?.router || 'Unknown',
                startBalance: firstLegData?.startBalance || '0',
                expectedOutput: firstLegData?.expectedOutput || '0',
                actualOutput: '0', // Will fill below
                outputDelta: '0', // Will calculate below
                accuracyPercent: 0, // Will calculate below
                gasUsed: firstLegData?.gasUsed
            },

            // Second leg metrics - initialize with available data
            secondLeg: {
                dex: secondLegDex,
                router: secondLegData?.router || 'Unknown',
                startBalance: firstLegData?.expectedOutput || '0', // Use the expected output from first leg
                expectedOutput: secondLegData?.expectedOutput || '0',
                // Use the final balance as the actual output of the second leg
                actualOutput: tradeFinalBalance,
                outputDelta: "0", // Will calculate below
                accuracyPercent: 0, // Will calculate below
            },

            // Gas metrics
            gasUsed,
            gasPrice,
            gasCost,
            gasCostInUSD,

            // Overall metrics - will calculate below
            overallAccuracy: 0,
            profitPredictionAccuracy: 0,
            profitImpact: 0
        };

        // Try to determine actual output for first leg from swap events
        const intermediateBalanceReceived = tx.logs.find(log =>
            log.decoded?.name === 'SwapCheckpoint' &&
            log.decoded.args?.stage === 'AfterFirstSwap'
        );

        if (intermediateBalanceReceived && intermediateBalanceReceived.decoded?.args) {
            const actualBalance = intermediateBalanceReceived.decoded.args.actualBalance || '0';
            metrics.firstLeg.actualOutput = actualBalance.toString();
        }

        // For second leg: Use finalBalance for the actual output
        metrics.secondLeg.actualOutput = finalBalance;

        // Handle first leg calculation - first leg outputs targetToken (WAVAX or WBTC)
        if (metrics.firstLeg.expectedOutput && metrics.firstLeg.expectedOutput !== '0' &&
            metrics.firstLeg.actualOutput && metrics.firstLeg.actualOutput !== '0') {

            // Convert to decimal format
            const expectedOutputDecimal = convertRawToDecimal(metrics.firstLeg.expectedOutput, targetSymbol);
            const actualOutputDecimal = convertRawToDecimal(metrics.firstLeg.actualOutput, targetSymbol);

            // Store the decimal formatted actual value in the existing field
            metrics.firstLeg.actualOutputFormatted = actualOutputDecimal;

            // Use decimal values for comparison
            const expected = parseFloat(expectedOutputDecimal);
            const actual = parseFloat(actualOutputDecimal);

            // Validate and calculate accuracy
            if (!isNaN(expected) && !isNaN(actual) && expected > 0) {
                // Calculate as percentage difference
                metrics.firstLeg.accuracyPercent = ((actual - expected) / expected) * 100;

                // Validate for extreme values
                if (Math.abs(metrics.firstLeg.accuracyPercent) > 100) {
                    console.warn(`Warning: Extreme first leg accuracy (${metrics.firstLeg.accuracyPercent.toFixed(2)}%) in tx ${txHash}`);
                    console.warn(`  Expected: ${expectedOutputDecimal} ${targetSymbol}, Actual: ${actualOutputDecimal} ${targetSymbol}`);

                    // Cap to reasonable range if needed
                    if (Math.abs(metrics.firstLeg.accuracyPercent) > 200) {
                        metrics.firstLeg.accuracyPercent = Math.sign(metrics.firstLeg.accuracyPercent) * 100;
                    }
                }

                // Calculate output delta using decimal values
                metrics.firstLeg.outputDelta = (actual - expected).toString();
            } else {
                console.warn(`Warning: Invalid values for first leg comparison in tx ${txHash}`);
                metrics.firstLeg.accuracyPercent = 0;
                metrics.firstLeg.outputDelta = '0';
            }
        }

        // Handle second leg calculation - second leg outputs sourceToken (USDC)
        if (metrics.secondLeg.expectedOutput && metrics.secondLeg.expectedOutput !== '0') {
            // First, store the raw value from the data
            const rawActualOutput = metrics.secondLeg.actualOutput;

            // Calculate what the actual output should be based on input amount and profit
            const inputAmountRaw = safeBigInt(metrics.amountIn);
            const profitRaw =safeBigInt(metrics.profit);
            const calculatedActualOutput = (inputAmountRaw + profitRaw).toString();

            // Store original value for reference
            metrics.secondLeg._originalActualOutput = rawActualOutput;

            // Replace with calculated value
            metrics.secondLeg.actualOutput = calculatedActualOutput;

            // Now convert to decimal for formatting and calculations
            const expectedOutputDecimal = convertRawToDecimal(metrics.secondLeg.expectedOutput, sourceSymbol);
            const actualOutputDecimal = convertRawToDecimal(calculatedActualOutput, sourceSymbol);

            metrics.secondLeg.actualOutputFormatted = actualOutputDecimal;

            // Use decimal values for comparison
            const expected = parseFloat(expectedOutputDecimal);
            const actual = parseFloat(actualOutputDecimal);

            if (!isNaN(expected) && !isNaN(actual) && expected > 0) {
                // Calculate original accuracy (for debugging)
                const originalAccuracy = ((actual - expected) / expected) * 100;
                metrics.secondLeg._originalAccuracyPercent = originalAccuracy;

                // Calculate as percentage difference
                metrics.secondLeg.accuracyPercent = ((actual - expected) / expected) * 100;

                // Calculate original delta (for debugging)
                const originalDelta = rawActualOutput ?
                    (parseFloat(convertRawToDecimal(rawActualOutput, sourceSymbol)) - expected).toString() : '0';
                metrics.secondLeg._originalOutputDelta = originalDelta;

                // Calculate output delta using decimal values
                metrics.secondLeg.outputDelta = (actual - expected).toString();
            }
        }

        // Calculate overall accuracy - weighted towards second leg which affects final profit
        metrics.overallAccuracy = (metrics.firstLeg.accuracyPercent + metrics.secondLeg.accuracyPercent * 2) / 3;

        // Calculate profit prediction accuracy using properly converted decimal values
        if (metrics.secondLeg.expectedOutput && metrics.amountInFormatted) {
            // Convert expected output to decimal
            const expectedOutputDecimal = convertRawToDecimal(metrics.secondLeg.expectedOutput, sourceSymbol);
            const expectedOutput = parseFloat(expectedOutputDecimal);
            const inputAmount = parseFloat(metrics.amountInFormatted);
            const actualProfit = parseFloat(metrics.profitFormatted);

            // Calculate expected profit
            const expectedProfit = expectedOutput - inputAmount;

            // Calculate prediction accuracy
            if (expectedProfit > 0 && !isNaN(expectedProfit)) {
                metrics.profitPredictionAccuracy = (actualProfit / expectedProfit) * 100;

                // Cap extreme values
                if (Math.abs(metrics.profitPredictionAccuracy) > 200) {
                    console.warn(`Warning: Extreme profit prediction accuracy (${metrics.profitPredictionAccuracy.toFixed(2)}%) in tx ${txHash}`);
                    metrics.profitPredictionAccuracy = Math.sign(metrics.profitPredictionAccuracy) *
                        Math.min(Math.abs(metrics.profitPredictionAccuracy), 200);
                }
            } else if (actualProfit > 0) {
                metrics.profitPredictionAccuracy = 0;
            } else {
                metrics.profitPredictionAccuracy = 100;
            }

            // Calculate profit impact as percentage of input
            if (inputAmount > 0) {
                metrics.profitImpact = ((actualProfit - expectedProfit) / inputAmount) * 100;
            }
        }

        // Extract execution time from log indices or timestamps (unchanged)
        try {
            const checkpoints = tx.logs
                .filter(log => log.decoded?.name === 'SwapCheckpoint')
                .map(log => ({
                    stage: log.decoded?.args?.stage,
                    timestamp: log.decoded?.args?.timestamp?.toString()
                }))
                .filter(cp => cp.stage && cp.timestamp);

            if (checkpoints.length >= 2) {
                metrics.executionTime = calculateExecutionTimeFromCheckpoints(checkpoints);
            }
        } catch (error) {
            console.warn(`Could not extract execution time for ${txHash}: ${error}`);
        }

        // Extract quote age if available (unchanged)
        try {
            const firstSwapEvent = tx.logs.find(log =>
                log.decoded?.name === 'SwapCheckpoint' &&
                log.decoded.args?.stage === 'BeforeFirstSwap'
            );

            if (firstSwapEvent?.decoded?.args?.timestamp) {
                const txTime = Number(tx.timestamp);
                const quoteTime = Number(firstSwapEvent.decoded.args.timestamp);
                metrics.quoteAge = txTime - quoteTime;
            }
        } catch (error) {
            console.warn(`Could not extract quote age for ${txHash}`);
        }

        return metrics;
    } catch (error) {
        console.error(`Error analyzing transaction ${txHash}:`, error);
        return null;
    }
}

function calculateExecutionTimeFromCheckpoints(checkpoints: any[]): number | undefined {
    if (!checkpoints || checkpoints.length < 2) return undefined;

    // Define stage order for correct time calculation
    const stageOrder = [
        'BeforeFirstSwap',
        'AfterFirstSwap',
        'BeforeSecondSwap',
        'AfterSecondSwap'
    ];

    // Sort checkpoints by stage order
    const sortedCheckpoints = [...checkpoints].sort((a, b) => {
        const stageA = stageOrder.indexOf(a.stage);
        const stageB = stageOrder.indexOf(b.stage);

        // If stage isn't in our list, put it at the end
        return (stageA === -1 ? 999 : stageA) - (stageB === -1 ? 999 : stageB);
    });

    // Find first and last valid timestamps
    const firstTimestamp = sortedCheckpoints[0]?.timestamp;
    const lastTimestamp = sortedCheckpoints[sortedCheckpoints.length - 1]?.timestamp;

    if (firstTimestamp && lastTimestamp) {
        // Handle both string and number types
        const startTime = typeof firstTimestamp === 'string'
            ? parseInt(firstTimestamp)
            : firstTimestamp;

        const endTime = typeof lastTimestamp === 'string'
            ? parseInt(lastTimestamp)
            : lastTimestamp;

        if (!isNaN(startTime) && !isNaN(endTime)) {
            const executionTime = endTime - startTime;

            // Debug log
            console.log('Checkpoint execution time:', {
                firstStage: sortedCheckpoints[0]?.stage,
                lastStage: sortedCheckpoints[sortedCheckpoints.length - 1]?.stage,
                startTime,
                endTime,
                executionTime
            });

            return executionTime;
        }
    }

    return undefined;
}

// Safe conversion to BigInt with validation
function safeBigInt(value: any): bigint {
    if (value === undefined || value === null || value === 'N/A') {
        return BigInt(0); // Return zero as fallback
    }

    try {
        // Check if value is a decimal string
        if (typeof value === 'string' && value.includes('.')) {
            // For decimal strings, we can't convert directly to BigInt
            // Instead, we can parse as float and then convert to integer representation
            // This approach avoids the errors for profit calculations
            return BigInt(Math.floor(parseFloat(value) * 1000000)); // Convert to micros
        }
        return BigInt(value);
    } catch (error) {
        console.warn(`Could not convert ${value} to BigInt, using 0 instead`);
        return BigInt(0);
    }
}

/**
 * Analyze quote accuracy from a stored JSON trade data file
 * @param filePath Path to the JSON file with trade data
 * @param avaxPrice AVAX price in USD for gas calculations
 */
async function analyzeStoredTradeData(filePath: string, avaxPrice: number = 17): Promise<AccuracyMetrics | null> {
    try {
        if (!fs.existsSync(filePath)) {
            console.warn(`Trade data file not found: ${filePath}`);
            return null;
        }

        // Read and parse the JSON file
        const rawData = fs.readFileSync(filePath, 'utf-8');
        const tradeData = JSON.parse(rawData);

        // Extract the token pair information from the file
        const tokenPair = tradeData.tokenPair ||
            (tradeData.config?.firstLeg?.dex === 'uniswap' &&
            tradeData.config?.secondLeg?.dex === 'traderjoe' ? 'USDC-WAVAX' : 'unknown');

        // Check if this is a flash loan transaction
        const isFlashLoan = tradeData.useFlashLoan === true ||
            (tradeData.result && tradeData.result.flashLoanFee !== undefined) ||
            (tradeData.flashLoanDetails !== undefined);

        // Extract transaction hash
        const transactionHash = tradeData.result?.transactionHash ||
            tradeData.result?.firstLegHash || null;

        // Create metrics from file data
        const metrics = createMetricsFromFileOnly(tradeData, filePath, avaxPrice);

        // If this is a flash loan transaction, update with flash loan specific data
        if (isFlashLoan && metrics) {
            // Add flash loan data
            // Use Balancer flash loan fee calculation if not directly provided
            const flashLoanFee = tradeData.result?.flashLoanFee ||
                tradeData.flashLoanDetails?.flashLoanFee ||
                (tradeData.config?.inputAmount &&
                    ((parseFloat(tradeData.config.inputAmount) * ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS) / 10000).toString());

            let netProfit;
            if (tradeData.result?.netProfit) {
                // If net profit is directly provided, use it
                netProfit = tradeData.result.netProfit;
            } else if (tradeData.result?.profit && flashLoanFee) {
                // Otherwise calculate it from profit and fee
                netProfit = (parseFloat(tradeData.result.profit) - parseFloat(flashLoanFee)).toString();
            } else {
                netProfit = null;
            }

            // Update the metrics with flash loan specific data
            metrics.isFlashLoan = true;
            metrics.flashLoanFee = flashLoanFee;
            metrics.netProfit = netProfit;

            // Adjust profit calculation to account for flash loan fee
            if (netProfit) {
                // Use net profit (after fee) for profit metrics
                metrics.profit = netProfit;
                metrics.profitFormatted = convertRawToDecimal(netProfit, metrics.sourceToken);

                // Recalculate profit percentage
                const inputAmount = parseFloat(metrics.amountInFormatted);
                const profit = parseFloat(metrics.profitFormatted);
                if (inputAmount > 0) {
                    metrics.profitPercent = (profit / inputAmount) * 100;
                }
            }
        }

        return metrics;
    } catch (error) {
        console.error(`Error analyzing trade data file ${filePath}:`, error);
        return null;
    }
}

/**
 * Create metrics from file data only, without on-chain data
 */
function createMetricsFromFileOnly(tradeData: any, filePath: string, avaxPrice: number): AccuracyMetrics | null {
    try {
        // Extract the core transaction info
        const transactionHash = (tradeData.result?.transactionHash || tradeData.result?.firstLegHash) as Hash;
        if (!transactionHash) {
            console.warn(`No transaction hash found in ${filePath}`);
            return null;
        }

        // Check if this is a flash loan transaction
        const isFlashLoan = tradeData.useFlashLoan === true ||
            (tradeData.result && tradeData.result.flashLoanFee !== undefined) ||
            (tradeData.flashLoanDetails !== undefined);

        // Extract token pair information (new in updated format)
        const tokenPair = tradeData.tokenPair || 'USDC-WAVAX'; // Default to USDC-WAVAX if not specified

        // Extract direction to determine the route and DEXes
        const direction = tradeData.direction as 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap' | undefined;
        if (!direction) {
            console.warn(`No direction found in ${filePath}`);
            return null;
        }

        // Determine DEXes based on direction
        const firstLegDex = direction === 'uniswap-to-traderjoe' ? 'uniswap' : 'traderjoe';
        const secondLegDex = direction === 'uniswap-to-traderjoe' ? 'traderjoe' : 'uniswap';

        // Extract trade context if available
        const tradeContext = tradeData.result?.tradeContext;

        // Set token info based on token pair
        let sourceToken = "USDC"; // Default source token is always USDC
        let targetToken: string;

        if (tokenPair === 'USDC-WBTC') {
            targetToken = "BTC.b";
        } else { // Default to USDC-WAVAX
            targetToken = "WAVAX";
        }

        // Extract timestamps
        const timestamp = new Date(tradeData.timestamp * 1000 || Date.now());

        // Extract blockNumber
        const blockNumber = BigInt(tradeData.result?.receipt?.blockNumber || 0);

        // For the secondLeg actualOutput, we should use the final balance, not the profit
        const tradeFinalBalance = tradeContext?.tradeFinalBalance?.toString()
            || tradeData.result?.finalBalance
            || "0";

        // Calculate the actual profit
        const tradeInputAmount = tradeContext?.tradeInputAmount?.toString()
            || tradeData.config?.inputAmount
            || "0";

        // Default profit calculation (for non-flash loan transactions)
        let profit = calculateProfit(tradeInputAmount, tradeFinalBalance);
        let profitFormatted = convertRawToDecimal(profit, sourceToken);

        // Flash loan specific data
        let flashLoanFee: string = "0";
        let netProfit: string = "0";

        // If this is a flash loan transaction, update profit calculation
        if (isFlashLoan) {
            // Extract flash loan fee
            flashLoanFee = tradeData.result?.flashLoanFee ||
                tradeData.flashLoanDetails?.flashLoanFee ||
                ((parseFloat(tradeInputAmount) * ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS / 10000).toFixed(6));

            // Check for net profit (use non-null assertion with caution)
            if (tradeData.result?.netProfit) {
                netProfit = tradeData.result.netProfit;
                // For flash loans, use net profit as the main profit value
                profit = netProfit; // Non-null assertion
                profitFormatted = convertRawToDecimal(netProfit, sourceToken);
            } else if (flashLoanFee && profit) {
                // Calculate net profit by subtracting fee from gross profit
                const grossProfitValue = parseFloat(convertRawToDecimal(profit, sourceToken));
                const feeValue = parseFloat(flashLoanFee);
                const netProfitValue = grossProfitValue - feeValue;
                netProfit = netProfitValue.toString();

                // Update profit to be net profit
                profit = safeBigInt(Math.floor(netProfitValue * 1000000)).toString();
                profitFormatted = netProfitValue.toFixed(6);
            }
        }

        // Create base metrics
        const metrics: AccuracyMetrics = {
            hash: transactionHash,
            timestamp,
            blockNumber,
            route: direction as 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap' | 'unknown',
            status: tradeData.result?.success ? 'success' : 'reverted',
            testMode: !!tradeData.config?.testMode,
            sourceToken,
            targetToken,
            tokenPair, // Include token pair information

            // Input and trade amounts - update these with actual data from file
            tradeInputAmount: tradeContext?.tradeInputAmount?.toString() || tradeData.config?.inputAmount || "0",
            tradeFinalBalance: tradeFinalBalance,
            accountBalance: tradeData.result?.accountBalance || "0",

            // Process amounts with proper formatting
            amountIn: tradeContext?.tradeInputAmount?.toString() || tradeData.config?.inputAmount || "0",
            amountInFormatted: convertRawToDecimal(
                tradeContext?.tradeInputAmount?.toString() || tradeData.config?.inputAmount || "0",
                sourceToken
            ),

            finalBalance: tradeFinalBalance,
            finalBalanceFormatted: convertRawToDecimal(
                tradeFinalBalance,
                sourceToken
            ),

            // Use calculated profit values
            profit: profit,
            profitFormatted: profitFormatted,

            // Calculate profit percentage
            profitPercent: calculateProfitPercent(
                tradeInputAmount,
                tradeFinalBalance
            ),

            // Flash loan specific fields
            isFlashLoan: isFlashLoan,
            flashLoanFee: flashLoanFee, // Guaranteed to be a string
            netProfit: netProfit, // Guaranteed to be a string

            // Other metrics placeholders
            firstLeg: {
                dex: firstLegDex,
                router: 'Unknown',
                startBalance: '0',
                expectedOutput: '0',
                actualOutput: '0',
                outputDelta: '0',
                accuracyPercent: 0
            },
            secondLeg: {
                dex: secondLegDex,
                router: 'Unknown',
                startBalance: '0',
                expectedOutput: '0',
                actualOutput: '0',
                outputDelta: '0',
                accuracyPercent: 0
            },
            gasUsed: 0n,
            gasPrice: 0n,
            gasCost: '0',
            gasCostInUSD: '0',
            overallAccuracy: 0,
            profitPredictionAccuracy: 0,
            profitImpact: 0
        };

        return metrics;
    } catch (error) {
        console.error(`Error creating metrics from file only: ${error}`);
        return null;
    }
}

// Summary metrics for a batch of transactions
/**
 * Calculate mean (average) of an array of numbers
 */
function calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Calculate median of an array of numbers
 */
function calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;

    // Sort values
    const sorted = [...values].sort((a, b) => a - b);

    // Get median
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    } else {
        return sorted[middle];
    }
}

/**
 * Calculate standard deviation of an array of numbers
 */
function calculateStdDev(values: number[]): number {
    if (values.length <= 1) return 0;

    const mean = calculateMean(values);
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
}

/**
 * Remove outliers from an array using the IQR method
 */
function removeOutliers(values: number[]): number[] {
    if (values.length <= 4) return values; // Not enough data points

    // Sort values
    const sorted = [...values].sort((a, b) => a - b);

    // Calculate Q1 and Q3
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);
    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];

    // Calculate IQR and bounds
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    // Filter out outliers
    return values.filter(val => val >= lowerBound && val <= upperBound);
}

/**
 * Calculate an adjustment factor based on observed accuracy
 * If accuracy is negative (actual < expected), return a factor < 1 to reduce estimates
 * If accuracy is positive (actual > expected), return a factor > 1 to increase estimates
 *
 * @param accuracyPercent The average accuracy percentage observed
 * @param smoothingFactor A factor to reduce overcompensation (0-1)
 */
function calculateAdjustmentFactor(
    accuracyPercent: number,
    smoothingFactor: number = 0.15
): number {
    // Convert accuracy percentage to a factor
    // Example:
    // -5% accuracy means actual was 95% of expected, so factor = 0.95
    // +10% accuracy means actual was 110% of expected, so factor = 1.10

    // Apply smoothing to avoid overcorrection
    const smoothedAccuracy = accuracyPercent * (1 - smoothingFactor);

    // Calculate factor: 100 / (100 + accuracy)
    // For +10% accuracy: 100 / 110 = 0.909 (factor to multiply expected by to get actual)
    // For -5% accuracy: 100 / 95 = 1.053 (factor to multiply expected by to get actual)
    const rawFactor = 100 / (100 + smoothedAccuracy);

    // However, this is counterintuitive. We want to adjust our estimates to be more accurate.
    // So we need the reciprocal: what to multiply our current estimates by to get better estimates
    const adjustmentFactor = 1 / rawFactor;

    // For +10% accuracy: 1 / 0.909 = 1.10 (increase estimates by 10%)
    // For -5% accuracy: 1 / 1.053 = 0.95 (decrease estimates by 5%)

    // Round to 4 decimal places for readability
    return Math.round(adjustmentFactor * 10000) / 10000;
}

/**
 * Calculate data-specific statistical properties and accuracy stats
 */
function calculateAccuracyStats(
    values: number[],
    options: {
        adjustForOutliers?: boolean;
        smoothingFactor?: number;
        maxReasonableValue?: number;
        verbose?: boolean;
    } = {}
): {
    count: number;
    average: number;
    median: number;
    stdDev: number;
    min: number;
    max: number;
    data: number[];
    adjustmentFactor: number;
    confidence: 'high' | 'medium' | 'low';
} {
    if (values.length === 0) {
        return {
            count: 0,
            average: 0,
            median: 0,
            stdDev: 0,
            min: 0,
            max: 0,
            data: [],
            adjustmentFactor: 1,
            confidence: 'low'
        };
    }

    // Set default for max reasonable value
    const MAX_REASONABLE_VALUE = options.maxReasonableValue || 100;

    // Phase 1: Basic validation - remove NaN, Infinity, null, etc.
    const validValues = values.filter(val =>
        val !== undefined &&
        val !== null &&
        !isNaN(val) &&
        isFinite(val)
    );

    // Phase 2: Filter out truly unreasonable values
    // For accuracy percentage, anything over ±MAX_REASONABLE_VALUE is likely an error
    const reasonableValues = validValues.filter(val =>
        Math.abs(val) <= MAX_REASONABLE_VALUE
    );

    if (reasonableValues.length < validValues.length && options.verbose) {
        console.warn(`Filtered out ${validValues.length - reasonableValues.length} unreasonable values`);
    }

    // Phase 3: Apply standard outlier detection if requested
    const dataPoints = options.adjustForOutliers ?
        removeOutliers(reasonableValues) :
        reasonableValues;

    // Check if we have too few points after filtering
    if (dataPoints.length < values.length * 0.5 && values.length > 10) {
        console.warn(`Warning: Filtered out more than 50% of data points (${values.length} -> ${dataPoints.length})`);
    }

    // Calculate statistics on our filtered dataset
    const count = dataPoints.length;
    const average = calculateMean(dataPoints);
    const median = calculateMedian(dataPoints);
    const stdDev = calculateStdDev(dataPoints);
    const min = Math.min(...dataPoints);
    const max = Math.max(...dataPoints);

    // Calculate adjustment factor
    const smoothingFactor = options.smoothingFactor || 0;
    const adjustmentFactor = calculateAdjustmentFactor(average, smoothingFactor);

    // Determine confidence level based on sample size and consistency
    let confidence: 'high' | 'medium' | 'low' = 'low';

    // Criteria for confidence levels:
    // 1. Sample size
    // 2. Consistency (low standard deviation relative to mean)
    // 3. Percentage of filtered points
    const coefficientOfVariation = Math.abs(stdDev / average);
    const unfilteredRatio = dataPoints.length / values.length;

    if (count >= 20 && coefficientOfVariation < 0.3 && unfilteredRatio > 0.8) {
        confidence = 'high';
    } else if (count >= 10 && coefficientOfVariation < 0.5 && unfilteredRatio > 0.7) {
        confidence = 'medium';
    }

    return {
        count,
        average,
        median,
        stdDev,
        min,
        max,
        data: dataPoints,
        adjustmentFactor,
        confidence
    };
}

/**
 * Calculate summary statistics from a batch of trade metrics
 */
function calculateSummary(
    metrics: AccuracyMetrics[],
    options: OutputOptions
): AccuracySummary {
    if (metrics.length === 0) {
        throw new Error('Cannot calculate summary for empty metrics array');
    }

    // Count success/failures and test mode transactions
    const successCount = metrics.filter(m => m.status === 'success').length;
    const failureCount = metrics.length - successCount;
    const successRate = successCount / metrics.length;
    const testModeCount = metrics.filter(m => m.testMode).length;

    // Calculate route distribution
    const routeDistribution = {
        'uniswap-to-traderjoe': metrics.filter(m => m.route === 'uniswap-to-traderjoe').length,
        'traderjoe-to-uniswap': metrics.filter(m => m.route === 'traderjoe-to-uniswap').length,
        'unknown': metrics.filter(m => m.route === 'unknown').length
    };

    // Add token pair distribution (new)
    const tokenPairDistribution = {
        'USDC-WAVAX': metrics.filter(m => m.tokenPair === 'USDC-WAVAX').length,
        'USDC-WBTC': metrics.filter(m => m.tokenPair === 'USDC-WBTC').length,
        'unknown': metrics.filter(m => m.tokenPair === 'unknown' || !m.tokenPair).length
    };

    const flashLoanCount = metrics.filter(m => m.isFlashLoan).length;
    const regularCount = metrics.length - flashLoanCount;

    const flashLoanSuccessCount = metrics.filter(m => m.isFlashLoan && m.status === 'success').length;
    const flashLoanFailureCount = flashLoanCount - flashLoanSuccessCount;

    // Calculate total flash loan profit
    let totalFlashLoanProfit = "0";
    let totalFlashLoanFees = "0";
    let totalFlashLoanNetProfit = "0";

    if (flashLoanCount > 0) {
        const flashLoanMetrics = metrics.filter(m => m.isFlashLoan && m.status === 'success');

        // Calculate total gross profit
        const totalGrossProfit = flashLoanMetrics
            .reduce((sum, m) => {
                // If netProfit exists, calculate gross profit by adding back the fee
                if (m.netProfit && m.flashLoanFee) {
                    return sum + parseFloat(m.netProfit) + parseFloat(m.flashLoanFee);
                }
                // Otherwise use profit directly
                return sum + parseFloat(m.profitFormatted || "0");
            }, 0)
            .toFixed(6);

        // Calculate total fees
        totalFlashLoanFees = flashLoanMetrics
            .reduce((sum, m) => sum + parseFloat(m.flashLoanFee || "0"), 0)
            .toFixed(6);

        // Calculate total net profit
        totalFlashLoanNetProfit = flashLoanMetrics
            .reduce((sum, m) => sum + parseFloat(m.netProfit || m.profitFormatted || "0"), 0)
            .toFixed(6);

        totalFlashLoanProfit = totalGrossProfit;
    }

    // Add flash loan metrics to the summary
    const flashLoanMetrics = {
        count: flashLoanCount,
        successCount: flashLoanSuccessCount,
        failureCount: flashLoanFailureCount,
        successRate: flashLoanCount > 0 ? flashLoanSuccessCount / flashLoanCount : 0,
        totalGrossProfit: totalFlashLoanProfit,
        totalFees: totalFlashLoanFees,
        totalNetProfit: totalFlashLoanNetProfit,
        averageNetProfit: flashLoanSuccessCount > 0 ?
            (parseFloat(totalFlashLoanNetProfit) / flashLoanSuccessCount).toFixed(6) : "0",
        feeBps: ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS
    };

    // Separate metrics by token pair, DEX, and leg for accuracy calculations
    // For USDC-WAVAX
    const wavaxMetrics = metrics.filter(m => m.tokenPair === 'USDC-WAVAX' || (!m.tokenPair && m.targetToken === 'WAVAX'));

    const uniswapFirstLegWavax = wavaxMetrics
        .filter(m => m.firstLeg.dex === 'uniswap')
        .map(m => filterOutlier(m.firstLeg.accuracyPercent));

    const uniswapSecondLegWavax = wavaxMetrics
        .filter(m => m.secondLeg.dex === 'uniswap')
        .map(m => filterOutlier(m.secondLeg.accuracyPercent));

    const traderjoeFirstLegWavax = wavaxMetrics
        .filter(m => m.firstLeg.dex === 'traderjoe')
        .map(m => filterOutlier(m.firstLeg.accuracyPercent));

    const traderjoeSecondLegWavax = wavaxMetrics
        .filter(m => m.secondLeg.dex === 'traderjoe')
        .map(m => filterOutlier(m.secondLeg.accuracyPercent));

    // For USDC-WBTC
    const wbtcMetrics = metrics.filter(m => m.tokenPair === 'USDC-WBTC' || (!m.tokenPair && m.targetToken === 'BTC.b'));

    const uniswapFirstLegWbtc = wbtcMetrics
        .filter(m => m.firstLeg.dex === 'uniswap')
        .map(m => filterOutlier(m.firstLeg.accuracyPercent));

    const uniswapSecondLegWbtc = wbtcMetrics
        .filter(m => m.secondLeg.dex === 'uniswap')
        .map(m => filterOutlier(m.secondLeg.accuracyPercent));

    const traderjoeFirstLegWbtc = wbtcMetrics
        .filter(m => m.firstLeg.dex === 'traderjoe')
        .map(m => filterOutlier(m.firstLeg.accuracyPercent));

    const traderjoeSecondLegWbtc = wbtcMetrics
        .filter(m => m.secondLeg.dex === 'traderjoe')
        .map(m => filterOutlier(m.secondLeg.accuracyPercent));

    // Helper function to filter outliers for clarity
    function filterOutlier(value: number): number {
        // Safety check - ensure values are reasonable
        if (Math.abs(value) > 100) {
            console.warn(`Suspicious accuracy value of ${value}% detected. Capping to a reasonable range.`);
            // Return a more reasonable value
            return Math.sign(value) * Math.min(Math.abs(value), 50);
        }
        return value;
    }

    // Calculate DEX-specific statistics for each token pair
    const wavaxDexAccuracy = {
        uniswap: {
            firstLeg: calculateAccuracyStats(uniswapFirstLegWavax, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            }),
            secondLeg: calculateAccuracyStats(uniswapSecondLegWavax, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            })
        },
        traderjoe: {
            firstLeg: calculateAccuracyStats(traderjoeFirstLegWavax, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            }),
            secondLeg: calculateAccuracyStats(traderjoeSecondLegWavax, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            })
        }
    };

    const wbtcDexAccuracy = {
        uniswap: {
            firstLeg: calculateAccuracyStats(uniswapFirstLegWbtc, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            }),
            secondLeg: calculateAccuracyStats(uniswapSecondLegWbtc, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            })
        },
        traderjoe: {
            firstLeg: calculateAccuracyStats(traderjoeFirstLegWbtc, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            }),
            secondLeg: calculateAccuracyStats(traderjoeSecondLegWbtc, {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            })
        }
    };

    // Combined metrics for backward compatibility
    const dexAccuracy = {
        uniswap: {
            firstLeg: calculateAccuracyStats([...uniswapFirstLegWavax, ...uniswapFirstLegWbtc], {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            }),
            secondLeg: calculateAccuracyStats([...uniswapSecondLegWavax, ...uniswapSecondLegWbtc], {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            })
        },
        traderjoe: {
            firstLeg: calculateAccuracyStats([...traderjoeFirstLegWavax, ...traderjoeFirstLegWbtc], {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            }),
            secondLeg: calculateAccuracyStats([...traderjoeSecondLegWavax, ...traderjoeSecondLegWbtc], {
                adjustForOutliers: options.adjustForOutliers,
                smoothingFactor: options.applySmoothingFactor ? options.smoothingFactor : 0
            })
        }
    };

    // Group metrics by token for profit calculations
    const tokenGroups: Record<string, AccuracyMetrics[]> = {};
    metrics.forEach(m => {
        if (!tokenGroups[m.sourceToken]) {
            tokenGroups[m.sourceToken] = [];
        }
        tokenGroups[m.sourceToken].push(m);
    });

    // Calculate profit metrics by token
    const profitMetrics: Record<string, {
        totalProfit: string;
        averageProfit: string;
        medianProfit: string;
        profitPredictionAccuracy: number;
        profitableTradeCount: number;
        unprofitableTradeCount: number;
    }> = {};

    Object.entries(tokenGroups).forEach(([token, txs]) => {
        // Filter successful transactions for profit calculations
        const successfulTxs = txs.filter(tx => tx.status === 'success');

        if (successfulTxs.length === 0) {
            profitMetrics[token] = {
                totalProfit: '0',
                averageProfit: '0',
                medianProfit: '0',
                profitPredictionAccuracy: 0,
                profitableTradeCount: 0,
                unprofitableTradeCount: 0
            };
            return;
        }

        // Calculate total profit
        const totalProfit = successfulTxs.reduce(
            (sum, tx) => sum + safeBigInt(tx.profit || '0'), 0n
        );

        // Get token decimals for formatting
        const tokenAddress = getTokenAddress(token);
        const decimals = getTokenDecimals(tokenAddress);

        // Calculate profit metrics
        const profitableTradeCount = successfulTxs.filter(tx => safeBigInt(tx.profit || '0') > 0n).length;
        const unprofitableTradeCount = successfulTxs.length - profitableTradeCount;

        // Calculate average profit
        const avgProfit = totalProfit / safeBigInt(successfulTxs.length);

        // Calculate median profit
        const profits = successfulTxs.map(tx => safeBigInt(tx.profit || '0'));
        profits.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        const medianProfit = profits.length % 2 === 0
            ? (profits[profits.length / 2 - 1] + profits[profits.length / 2]) / 2n
            : profits[Math.floor(profits.length / 2)];

        // Calculate average profit prediction accuracy
        const profitPredictionAccuracy = successfulTxs.reduce(
            (sum, tx) => sum + tx.profitPredictionAccuracy, 0
        ) / successfulTxs.length;

        profitMetrics[token] = {
            totalProfit: formatUnits(totalProfit, decimals),
            averageProfit: formatUnits(avgProfit, decimals),
            medianProfit: formatUnits(medianProfit, decimals),
            profitPredictionAccuracy,
            profitableTradeCount,
            unprofitableTradeCount
        };
    });

    // Calculate suggested adjustment factors based on DEX accuracy stats
    const suggestedAdjustmentFactors = {
        uniswap: {
            firstLeg: {
                factor: dexAccuracy.uniswap.firstLeg.adjustmentFactor,
                confidence: dexAccuracy.uniswap.firstLeg.confidence,
                sampleSize: dexAccuracy.uniswap.firstLeg.count
            },
            secondLeg: {
                factor: dexAccuracy.uniswap.secondLeg.adjustmentFactor,
                confidence: dexAccuracy.uniswap.secondLeg.confidence,
                sampleSize: dexAccuracy.uniswap.secondLeg.count
            }
        },
        traderjoe: {
            firstLeg: {
                factor: dexAccuracy.traderjoe.firstLeg.adjustmentFactor,
                confidence: dexAccuracy.traderjoe.firstLeg.confidence,
                sampleSize: dexAccuracy.traderjoe.firstLeg.count
            },
            secondLeg: {
                factor: dexAccuracy.traderjoe.secondLeg.adjustmentFactor,
                confidence: dexAccuracy.traderjoe.secondLeg.confidence,
                sampleSize: dexAccuracy.traderjoe.secondLeg.count
            }
        }
    };

    // Analyze by trade size
    const tradeGroups: Record<string, AccuracyMetrics[]> = {
        'small': [],  // < 1 USDC
        'medium': [], // 1-5 USDC
        'large': []   // > 5 USDC
    };

    metrics.forEach(m => {
        const amount = parseFloat(m.amountInFormatted);
        if (amount < 1) {
            tradeGroups.small.push(m);
        } else if (amount <= 5) {
            tradeGroups.medium.push(m);
        } else {
            tradeGroups.large.push(m);
        }
    });
    const scenarioByTokenPair: Record<string, {
        count: number;
        accuracyUniFirst: number;
        accuracyJoeFirst: number;
        accuracyUniSecond: number;
        accuracyJoeSecond: number;
    }> = {
        'USDC-WAVAX': {
            count: wavaxMetrics.length,
            accuracyUniFirst: uniswapFirstLegWavax.length > 0
                ? uniswapFirstLegWavax.reduce((sum, val) => sum + val, 0) / uniswapFirstLegWavax.length
                : 0,
            accuracyJoeFirst: traderjoeFirstLegWavax.length > 0
                ? traderjoeFirstLegWavax.reduce((sum, val) => sum + val, 0) / traderjoeFirstLegWavax.length
                : 0,
            accuracyUniSecond: uniswapSecondLegWavax.length > 0
                ? uniswapSecondLegWavax.reduce((sum, val) => sum + val, 0) / uniswapSecondLegWavax.length
                : 0,
            accuracyJoeSecond: traderjoeSecondLegWavax.length > 0
                ? traderjoeSecondLegWavax.reduce((sum, val) => sum + val, 0) / traderjoeSecondLegWavax.length
                : 0
        },
        'USDC-WBTC': {
            count: wbtcMetrics.length,
            accuracyUniFirst: uniswapFirstLegWbtc.length > 0
                ? uniswapFirstLegWbtc.reduce((sum, val) => sum + val, 0) / uniswapFirstLegWbtc.length
                : 0,
            accuracyJoeFirst: traderjoeFirstLegWbtc.length > 0
                ? traderjoeFirstLegWbtc.reduce((sum, val) => sum + val, 0) / traderjoeFirstLegWbtc.length
                : 0,
            accuracyUniSecond: uniswapSecondLegWbtc.length > 0
                ? uniswapSecondLegWbtc.reduce((sum, val) => sum + val, 0) / uniswapSecondLegWbtc.length
                : 0,
            accuracyJoeSecond: traderjoeSecondLegWbtc.length > 0
                ? traderjoeSecondLegWbtc.reduce((sum, val) => sum + val, 0) / traderjoeSecondLegWbtc.length
                : 0
        }
    };
    const scenarioByTradeSize: Record<string, {
        count: number;
        accuracyUniFirst: number;
        accuracyJoeFirst: number;
        accuracyUniSecond: number;
        accuracyJoeSecond: number;
    }> = {};

    Object.entries(tradeGroups).forEach(([size, sizeTxs]) => {
        if (sizeTxs.length === 0) {
            scenarioByTradeSize[size] = {
                count: 0,
                accuracyUniFirst: 0,
                accuracyJoeFirst: 0,
                accuracyUniSecond: 0,
                accuracyJoeSecond: 0
            };
            return;
        }

        const uniFirstGroup = sizeTxs.filter(tx => tx.firstLeg.dex === 'uniswap');
        const joeFirstGroup = sizeTxs.filter(tx => tx.firstLeg.dex === 'traderjoe');
        const uniSecondGroup = sizeTxs.filter(tx => tx.secondLeg.dex === 'uniswap');
        const joeSecondGroup = sizeTxs.filter(tx => tx.secondLeg.dex === 'traderjoe');

        scenarioByTradeSize[size] = {
            count: sizeTxs.length,
            accuracyUniFirst: uniFirstGroup.length > 0
                ? uniFirstGroup.reduce((sum, tx) => sum + tx.firstLeg.accuracyPercent, 0) / uniFirstGroup.length
                : 0,
            accuracyJoeFirst: joeFirstGroup.length > 0
                ? joeFirstGroup.reduce((sum, tx) => sum + tx.firstLeg.accuracyPercent, 0) / joeFirstGroup.length
                : 0,
            accuracyUniSecond: uniSecondGroup.length > 0
                ? uniSecondGroup.reduce((sum, tx) => sum + tx.secondLeg.accuracyPercent, 0) / uniSecondGroup.length
                : 0,
            accuracyJoeSecond: joeSecondGroup.length > 0
                ? joeSecondGroup.reduce((sum, tx) => sum + tx.secondLeg.accuracyPercent, 0) / joeSecondGroup.length
                : 0
        };
    });

    // Analyze by profitability
    const profitableTxs = metrics.filter(m => safeBigInt(m.profit || '0') > 0n);
    const unprofitableTxs = metrics.filter(m => safeBigInt(m.profit || '0') <= 0n);

    const calculateGroupAccuracy = (txGroup: AccuracyMetrics[], dex: string, leg: 'first' | 'second') => {
        const group = txGroup.filter(tx => tx[`${leg}Leg`].dex === dex);
        return group.length > 0
            ? group.reduce((sum, tx) => sum + tx[`${leg}Leg`].accuracyPercent, 0) / group.length
            : 0;
    };

    const calculateGroupFactor = (txGroup: AccuracyMetrics[], dex: string, leg: 'first' | 'second') => {
        const accuracy = calculateGroupAccuracy(txGroup, dex, leg);
        return calculateAdjustmentFactor(accuracy, options.smoothingFactor);
    };

    const scenarioByProfitability = {
        profitable: {
            count: profitableTxs.length,
            avgAccuracy: profitableTxs.length > 0
                ? profitableTxs.reduce((sum, tx) => sum + tx.overallAccuracy, 0) / profitableTxs.length
                : 0,
            adjustmentFactors: {
                uniswapFirst: calculateGroupFactor(profitableTxs, 'uniswap', 'first'),
                uniswapSecond: calculateGroupFactor(profitableTxs, 'uniswap', 'second'),
                traderjoeFirst: calculateGroupFactor(profitableTxs, 'traderjoe', 'first'),
                traderjoeSecond: calculateGroupFactor(profitableTxs, 'traderjoe', 'second')
            }
        },
        unprofitable: {
            count: unprofitableTxs.length,
            avgAccuracy: unprofitableTxs.length > 0
                ? unprofitableTxs.reduce((sum, tx) => sum + tx.overallAccuracy, 0) / unprofitableTxs.length
                : 0,
            adjustmentFactors: {
                uniswapFirst: calculateGroupFactor(unprofitableTxs, 'uniswap', 'first'),
                uniswapSecond: calculateGroupFactor(unprofitableTxs, 'uniswap', 'second'),
                traderjoeFirst: calculateGroupFactor(unprofitableTxs, 'traderjoe', 'first'),
                traderjoeSecond: calculateGroupFactor(unprofitableTxs, 'traderjoe', 'second')
            }
        }
    };

    // Calculate time-based analysis
    // Group transactions by hour
    const txsByHour: Record<string, AccuracyMetrics[]> = {};
    metrics.forEach(m => {
        const hour = m.timestamp.toISOString().substring(0, 13); // YYYY-MM-DDTHH
        if (!txsByHour[hour]) {
            txsByHour[hour] = [];
        }
        txsByHour[hour].push(m);
    });

    const accuracyTrend = Object.entries(txsByHour).map(([hour, hourTxs]) => ({
        timeRange: hour + ':00',
        count: hourTxs.length,
        averageAccuracy: hourTxs.reduce((sum, tx) => sum + tx.overallAccuracy, 0) / hourTxs.length
    })).sort((a, b) => a.timeRange.localeCompare(b.timeRange));

    const adjustmentFactorTrend = Object.entries(txsByHour).map(([hour, hourTxs]) => ({
        timeRange: hour + ':00',
        uniswapFirstLeg: calculateGroupFactor(hourTxs, 'uniswap', 'first'),
        uniswapSecondLeg: calculateGroupFactor(hourTxs, 'uniswap', 'second'),
        traderjoeFirstLeg: calculateGroupFactor(hourTxs, 'traderjoe', 'first'),
        traderjoeSecondLeg: calculateGroupFactor(hourTxs, 'traderjoe', 'second')
    })).sort((a, b) => a.timeRange.localeCompare(b.timeRange));

    // Get time range
    const timestamps = metrics.map(m => m.timestamp.getTime());
    const first = new Date(Math.min(...timestamps));
    const last = new Date(Math.max(...timestamps));
    // Define tokenPairDistribution if not already defined

// Define tokenPairAdjustmentFactors if not already defined
    const tokenPairAdjustmentFactors = {
        wavax: {
            uniswap: {
                firstLeg: {
                    factor: wavaxDexAccuracy.uniswap.firstLeg.adjustmentFactor,
                    confidence: wavaxDexAccuracy.uniswap.firstLeg.confidence,
                    sampleSize: wavaxDexAccuracy.uniswap.firstLeg.count
                },
                secondLeg: {
                    factor: wavaxDexAccuracy.uniswap.secondLeg.adjustmentFactor,
                    confidence: wavaxDexAccuracy.uniswap.secondLeg.confidence,
                    sampleSize: wavaxDexAccuracy.uniswap.secondLeg.count
                }
            },
            traderjoe: {
                firstLeg: {
                    factor: wavaxDexAccuracy.traderjoe.firstLeg.adjustmentFactor,
                    confidence: wavaxDexAccuracy.traderjoe.firstLeg.confidence,
                    sampleSize: wavaxDexAccuracy.traderjoe.firstLeg.count
                },
                secondLeg: {
                    factor: wavaxDexAccuracy.traderjoe.secondLeg.adjustmentFactor,
                    confidence: wavaxDexAccuracy.traderjoe.secondLeg.confidence,
                    sampleSize: wavaxDexAccuracy.traderjoe.secondLeg.count
                }
            }
        },
        wbtc: {
            uniswap: {
                firstLeg: {
                    factor: wbtcDexAccuracy.uniswap.firstLeg.adjustmentFactor,
                    confidence: wbtcDexAccuracy.uniswap.firstLeg.confidence,
                    sampleSize: wbtcDexAccuracy.uniswap.firstLeg.count
                },
                secondLeg: {
                    factor: wbtcDexAccuracy.uniswap.secondLeg.adjustmentFactor,
                    confidence: wbtcDexAccuracy.uniswap.secondLeg.confidence,
                    sampleSize: wbtcDexAccuracy.uniswap.secondLeg.count
                }
            },
            traderjoe: {
                firstLeg: {
                    factor: wbtcDexAccuracy.traderjoe.firstLeg.adjustmentFactor,
                    confidence: wbtcDexAccuracy.traderjoe.firstLeg.confidence,
                    sampleSize: wbtcDexAccuracy.traderjoe.firstLeg.count
                },
                secondLeg: {
                    factor: wbtcDexAccuracy.traderjoe.secondLeg.adjustmentFactor,
                    confidence: wbtcDexAccuracy.traderjoe.secondLeg.confidence,
                    sampleSize: wbtcDexAccuracy.traderjoe.secondLeg.count
                }
            }
        }
    };

    return {
        totalTransactions: metrics.length,
        successCount,
        failureCount,
        successRate,
        testModeCount,
        routeDistribution,
        tokenPairDistribution,
        dexAccuracy,
        wavaxDexAccuracy,
        wbtcDexAccuracy,
        profitMetrics,
        suggestedAdjustmentFactors,
        tokenPairAdjustmentFactors,
        scenarioAnalysis: {
            byTradeSize: scenarioByTradeSize,
            byTokenPair: scenarioByTokenPair,
            byProfitability: scenarioByProfitability
        },
        temporalAnalysis: {
            accuracyTrend,
            adjustmentFactorTrend
        },
        timeRange: { first, last },
        flashLoanMetrics: flashLoanMetrics,
        executionTypes: {
            flashLoan: flashLoanCount,
            regular: regularCount
        }
    };
}

interface AccuracySummary {
    totalTransactions: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    testModeCount: number;

    // Route distribution
    routeDistribution: {
        'uniswap-to-traderjoe': number;
        'traderjoe-to-uniswap': number;
        'unknown': number;
    };

    // Token pair distribution (new)
    tokenPairDistribution: {
        'USDC-WAVAX': number;
        'USDC-WBTC': number;
        'unknown': number;
    };

    // Flash loan specific metrics
    flashLoanMetrics: {
        count: number;
        successCount: number;
        failureCount: number;
        successRate: number;
        totalGrossProfit: string;
        totalFees: string;
        totalNetProfit: string;
        averageNetProfit: string;
        feeBps: number;
    };

    executionTypes: {
        flashLoan: number;
        regular: number;
    };

    // Accuracy metrics by DEX and direction (combined WAVAX and WBTC)
    dexAccuracy: {
        uniswap: {
            // For first leg (USDC->WAVAX/WBTC)
            firstLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
            // For second leg (WAVAX/WBTC->USDC)
            secondLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
        };
        traderjoe: {
            // For first leg (USDC->WAVAX/WBTC)
            firstLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
            // For second leg (WAVAX/WBTC->USDC)
            secondLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
        };
    };

    // Accuracy metrics specific to WAVAX (new)
    wavaxDexAccuracy: {
        uniswap: {
            firstLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
            secondLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
        };
        traderjoe: {
            firstLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
            secondLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
        };
    };

    // Accuracy metrics specific to WBTC (new)
    wbtcDexAccuracy: {
        uniswap: {
            firstLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
            secondLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
        };
        traderjoe: {
            firstLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
            secondLeg: {
                count: number;
                average: number;
                median: number;
                stdDev: number;
                min: number;
                max: number;
                data: number[];
                adjustmentFactor: number;
                confidence: 'high' | 'medium' | 'low';
            };
        };
    };

    // Profit metrics by token
    profitMetrics: Record<string, {
        totalProfit: string;
        averageProfit: string;
        medianProfit: string;
        profitPredictionAccuracy: number;
        profitableTradeCount: number;
        unprofitableTradeCount: number;
    }>;

    // Suggested adjustment factors with confidence levels (combined WAVAX/WBTC)
    suggestedAdjustmentFactors: {
        uniswap: {
            firstLeg: {
                factor: number;
                confidence: 'high' | 'medium' | 'low';
                sampleSize: number;
            };
            secondLeg: {
                factor: number;
                confidence: 'high' | 'medium' | 'low';
                sampleSize: number;
            };
        };
        traderjoe: {
            firstLeg: {
                factor: number;
                confidence: 'high' | 'medium' | 'low';
                sampleSize: number;
            };
            secondLeg: {
                factor: number;
                confidence: 'high' | 'medium' | 'low';
                sampleSize: number;
            };
        };
    };

    // Token-specific adjustment factors (new)
    tokenPairAdjustmentFactors: {
        wavax: {
            uniswap: {
                firstLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
                secondLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
            };
            traderjoe: {
                firstLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
                secondLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
            };
        };
        wbtc: {
            uniswap: {
                firstLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
                secondLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
            };
            traderjoe: {
                firstLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
                secondLeg: {
                    factor: number;
                    confidence: 'high' | 'medium' | 'low';
                    sampleSize: number;
                };
            };
        };
    };

    // Additional metrics for different scenarios
    scenarioAnalysis: {
        byTradeSize: Record<string, {
            count: number;
            accuracyUniFirst: number;
            accuracyJoeFirst: number;
            accuracyUniSecond: number;
            accuracyJoeSecond: number;
        }>;
        // New analysis by token pair
        byTokenPair: Record<string, {
            count: number;
            accuracyUniFirst: number;
            accuracyJoeFirst: number;
            accuracyUniSecond: number;
            accuracyJoeSecond: number;
        }>;
        byProfitability: {
            profitable: {
                count: number;
                avgAccuracy: number;
                adjustmentFactors: {
                    uniswapFirst: number;
                    uniswapSecond: number;
                    traderjoeFirst: number;
                    traderjoeSecond: number;
                };
            };
            unprofitable: {
                count: number;
                avgAccuracy: number;
                adjustmentFactors: {
                    uniswapFirst: number;
                    uniswapSecond: number;
                    traderjoeFirst: number;
                    traderjoeSecond: number;
                };
            };
        };
    };

    // Time-based analysis
    temporalAnalysis: {
        accuracyTrend: Array<{
            timeRange: string;
            count: number;
            averageAccuracy: number;
        }>;
        adjustmentFactorTrend: Array<{
            timeRange: string;
            uniswapFirstLeg: number;
            uniswapSecondLeg: number;
            traderjoeFirstLeg: number;
            traderjoeSecondLeg: number;
        }>;
    };

    // Time range of data
    timeRange: {
        first: Date;
        last: Date;
    };
}
/**
 * Generate CSV file with detailed transaction data
 */
/**
 * Generate CSV file with detailed transaction data
 * Updated to include token pair information and flash loan details
 */
function generateCSV(metrics: AccuracyMetrics[], outputPath: string): void {
    if (metrics.length === 0) return;

    // Define CSV headers - updated to include new fields
    const headers = [
        'hash',
        'timestamp',
        'blockNumber',
        'status',
        'route',
        'testMode',
        'sourceToken',
        'targetToken',
        'tokenPair',        // Added
        'isFlashLoan',      // Added
        'amountIn',
        'amountInFormatted',
        'finalBalance',
        'finalBalanceFormatted',
        'profit',
        'profitFormatted',
        'flashLoanFee',     // Added
        'netProfit',        // Added
        'profitPercent',
        'firstLeg_dex',
        'firstLeg_router',
        'firstLeg_expectedOutput',
        'firstLeg_actualOutput',
        'firstLeg_actualOutputFormatted', // Added
        'firstLeg_outputDelta',
        'firstLeg_accuracyPercent',
        'secondLeg_dex',
        'secondLeg_router',
        'secondLeg_expectedOutput',
        'secondLeg_actualOutput',
        'secondLeg_actualOutputFormatted', // Added
        'secondLeg_outputDelta',
        'secondLeg_accuracyPercent',
        'overallAccuracy',
        'profitPredictionAccuracy',
        'profitImpact',
        'gasUsed',
        'gasPrice',
        'gasCost',
        'gasCostInUSD',
        'executionTime',
        'quoteAge',
        'tradeInputAmount',  // Added
        'tradeFinalBalance', // Added
        'accountBalance'     // Added
    ].join(',');

    // Generate CSV rows
    const rows = metrics.map(m => [
        m.hash,
        m.timestamp.toISOString(),
        m.blockNumber.toString(),
        m.status,
        m.route,
        m.testMode,
        m.sourceToken,
        m.targetToken,
        m.tokenPair || 'unknown',            // Added
        m.isFlashLoan ? 'true' : 'false',    // Added
        m.amountIn,
        m.amountInFormatted,
        m.finalBalance,
        m.finalBalanceFormatted,
        m.profit,
        m.profitFormatted,
        m.flashLoanFee || 'N/A',             // Added
        m.netProfit || m.profitFormatted,    // Added
        m.profitPercent.toFixed(2),
        m.firstLeg.dex,
        m.firstLeg.router,
        m.firstLeg.expectedOutput,
        m.firstLeg.actualOutput,
        m.firstLeg.actualOutputFormatted || 'N/A', // Added
        m.firstLeg.outputDelta,
        m.firstLeg.accuracyPercent.toFixed(2),
        m.secondLeg.dex,
        m.secondLeg.router,
        m.secondLeg.expectedOutput,
        m.secondLeg.actualOutput,
        m.secondLeg.actualOutputFormatted || 'N/A', // Added
        m.secondLeg.outputDelta,
        m.secondLeg.accuracyPercent.toFixed(2),
        m.overallAccuracy.toFixed(2),
        m.profitPredictionAccuracy.toFixed(2),
        m.profitImpact.toFixed(2),
        m.gasUsed.toString(),
        m.gasPrice.toString(),
        m.gasCost,
        m.gasCostInUSD,
        m.executionTime?.toString() || 'N/A',
        m.quoteAge?.toString() || 'N/A',
        m.tradeInputAmount || m.amountIn,    // Added
        m.tradeFinalBalance || m.finalBalance, // Added
        m.accountBalance || m.finalBalance   // Added
    ].join(','));

    // Combine headers and rows
    const csv = [headers, ...rows].join('\n');

    // Write to file
    fs.writeFileSync(outputPath, csv);
    console.log(`CSV file generated: ${outputPath}`);
}

/**
 * Print a detailed report of the quote accuracy analysis
 * Updated to include token pair-specific information and flash loan details
 */
function printAccuracyReport(metrics: AccuracyMetrics[], summary: AccuracySummary): void {
    console.log('\n=======================================================================================');
    console.log('QUOTE ACCURACY ANALYSIS REPORT');
    console.log('=======================================================================================');

    // Summary stats
    console.log(`Analyzed ${metrics.length} transactions`);
    console.log(`Success Rate: ${summary.successCount}/${summary.totalTransactions} (${(summary.successRate * 100).toFixed(1)}%)`);
    console.log(`Test Mode Transactions: ${summary.testModeCount}`);
    console.log(`Time Range: ${summary.timeRange.first.toISOString()} to ${summary.timeRange.last.toISOString()}`);

    // Route distribution
    console.log('\nRoute Distribution:');
    Object.entries(summary.routeDistribution).forEach(([route, count]) => {
        console.log(`  ${route}: ${count} (${(count / summary.totalTransactions * 100).toFixed(1)}%)`);
    });

    // Token pair distribution (new)
    console.log('\nToken Pair Distribution:');
    Object.entries(summary.tokenPairDistribution).forEach(([pair, count]) => {
        console.log(`  ${pair}: ${count} (${(count / summary.totalTransactions * 100).toFixed(1)}%)`);
    });

    // Flash loan vs regular trades (new)
    console.log('\nExecution Types:');
    console.log(`  Flash Loan Trades: ${summary.executionTypes.flashLoan} (${(summary.executionTypes.flashLoan / summary.totalTransactions * 100).toFixed(1)}%)`);
    console.log(`  Regular Trades: ${summary.executionTypes.regular} (${(summary.executionTypes.regular / summary.totalTransactions * 100).toFixed(1)}%)`);

    // DEX accuracy - WAVAX specific (new)
    console.log('\nDEX Quote Accuracy for USDC-WAVAX:');

    // Check if we have WAVAX data
    if (summary.wavaxDexAccuracy.uniswap.firstLeg.count > 0 || summary.wavaxDexAccuracy.traderjoe.firstLeg.count > 0) {
        // Uniswap WAVAX accuracy
        console.log(`  Uniswap First Leg (USDC->WAVAX):`);
        console.log(`    Count: ${summary.wavaxDexAccuracy.uniswap.firstLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wavaxDexAccuracy.uniswap.firstLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wavaxDexAccuracy.uniswap.firstLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wavaxDexAccuracy.uniswap.firstLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wavaxDexAccuracy.uniswap.firstLeg.min.toFixed(2)}% to ${summary.wavaxDexAccuracy.uniswap.firstLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.confidence} confidence)`);

        console.log(`  Uniswap Second Leg (WAVAX->USDC):`);
        console.log(`    Count: ${summary.wavaxDexAccuracy.uniswap.secondLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wavaxDexAccuracy.uniswap.secondLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wavaxDexAccuracy.uniswap.secondLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wavaxDexAccuracy.uniswap.secondLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wavaxDexAccuracy.uniswap.secondLeg.min.toFixed(2)}% to ${summary.wavaxDexAccuracy.uniswap.secondLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.confidence} confidence)`);

        // TraderJoe WAVAX accuracy
        console.log(`  TraderJoe First Leg (USDC->WAVAX):`);
        console.log(`    Count: ${summary.wavaxDexAccuracy.traderjoe.firstLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wavaxDexAccuracy.traderjoe.firstLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wavaxDexAccuracy.traderjoe.firstLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wavaxDexAccuracy.traderjoe.firstLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wavaxDexAccuracy.traderjoe.firstLeg.min.toFixed(2)}% to ${summary.wavaxDexAccuracy.traderjoe.firstLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.confidence} confidence)`);

        console.log(`  TraderJoe Second Leg (WAVAX->USDC):`);
        console.log(`    Count: ${summary.wavaxDexAccuracy.traderjoe.secondLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wavaxDexAccuracy.traderjoe.secondLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wavaxDexAccuracy.traderjoe.secondLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wavaxDexAccuracy.traderjoe.secondLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wavaxDexAccuracy.traderjoe.secondLeg.min.toFixed(2)}% to ${summary.wavaxDexAccuracy.traderjoe.secondLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.confidence} confidence)`);
    } else {
        console.log('  No WAVAX trading data available');
    }

    // DEX accuracy - WBTC specific (new)
    console.log('\nDEX Quote Accuracy for USDC-WBTC:');

    // Check if we have WBTC data
    if (summary.wbtcDexAccuracy.uniswap.firstLeg.count > 0 || summary.wbtcDexAccuracy.traderjoe.firstLeg.count > 0) {
        // Uniswap WBTC accuracy
        console.log(`  Uniswap First Leg (USDC->WBTC):`);
        console.log(`    Count: ${summary.wbtcDexAccuracy.uniswap.firstLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wbtcDexAccuracy.uniswap.firstLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wbtcDexAccuracy.uniswap.firstLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wbtcDexAccuracy.uniswap.firstLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wbtcDexAccuracy.uniswap.firstLeg.min.toFixed(2)}% to ${summary.wbtcDexAccuracy.uniswap.firstLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.confidence} confidence)`);

        console.log(`  Uniswap Second Leg (WBTC->USDC):`);
        console.log(`    Count: ${summary.wbtcDexAccuracy.uniswap.secondLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wbtcDexAccuracy.uniswap.secondLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wbtcDexAccuracy.uniswap.secondLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wbtcDexAccuracy.uniswap.secondLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wbtcDexAccuracy.uniswap.secondLeg.min.toFixed(2)}% to ${summary.wbtcDexAccuracy.uniswap.secondLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.confidence} confidence)`);

        // TraderJoe WBTC accuracy
        console.log(`  TraderJoe First Leg (USDC->WBTC):`);
        console.log(`    Count: ${summary.wbtcDexAccuracy.traderjoe.firstLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wbtcDexAccuracy.traderjoe.firstLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wbtcDexAccuracy.traderjoe.firstLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wbtcDexAccuracy.traderjoe.firstLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wbtcDexAccuracy.traderjoe.firstLeg.min.toFixed(2)}% to ${summary.wbtcDexAccuracy.traderjoe.firstLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.confidence} confidence)`);

        console.log(`  TraderJoe Second Leg (WBTC->USDC):`);
        console.log(`    Count: ${summary.wbtcDexAccuracy.traderjoe.secondLeg.count}`);
        console.log(`    Average Accuracy: ${summary.wbtcDexAccuracy.traderjoe.secondLeg.average.toFixed(2)}%`);
        console.log(`    Median Accuracy: ${summary.wbtcDexAccuracy.traderjoe.secondLeg.median.toFixed(2)}%`);
        console.log(`    Standard Deviation: ${summary.wbtcDexAccuracy.traderjoe.secondLeg.stdDev.toFixed(2)}`);
        console.log(`    Range: ${summary.wbtcDexAccuracy.traderjoe.secondLeg.min.toFixed(2)}% to ${summary.wbtcDexAccuracy.traderjoe.secondLeg.max.toFixed(2)}%`);
        console.log(`    Adjustment Factor: ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.confidence} confidence)`);
    } else {
        console.log('  No WBTC trading data available');
    }

    // Combined DEX accuracy (for backward compatibility)
    console.log('\nCombined DEX Quote Accuracy (WAVAX + WBTC):');

    // Uniswap combined accuracy
    console.log(`  Uniswap First Leg (USDC->WAVAX/WBTC):`);
    console.log(`    Count: ${summary.dexAccuracy.uniswap.firstLeg.count}`);
    console.log(`    Average Accuracy: ${summary.dexAccuracy.uniswap.firstLeg.average.toFixed(2)}%`);
    console.log(`    Median Accuracy: ${summary.dexAccuracy.uniswap.firstLeg.median.toFixed(2)}%`);
    console.log(`    Standard Deviation: ${summary.dexAccuracy.uniswap.firstLeg.stdDev.toFixed(2)}`);
    console.log(`    Range: ${summary.dexAccuracy.uniswap.firstLeg.min.toFixed(2)}% to ${summary.dexAccuracy.uniswap.firstLeg.max.toFixed(2)}%`);

    console.log(`  Uniswap Second Leg (WAVAX/WBTC->USDC):`);
    console.log(`    Count: ${summary.dexAccuracy.uniswap.secondLeg.count}`);
    console.log(`    Average Accuracy: ${summary.dexAccuracy.uniswap.secondLeg.average.toFixed(2)}%`);
    console.log(`    Median Accuracy: ${summary.dexAccuracy.uniswap.secondLeg.median.toFixed(2)}%`);
    console.log(`    Standard Deviation: ${summary.dexAccuracy.uniswap.secondLeg.stdDev.toFixed(2)}`);
    console.log(`    Range: ${summary.dexAccuracy.uniswap.secondLeg.min.toFixed(2)}% to ${summary.dexAccuracy.uniswap.secondLeg.max.toFixed(2)}%`);

    // TraderJoe combined accuracy
    console.log(`  TraderJoe First Leg (USDC->WAVAX/WBTC):`);
    console.log(`    Count: ${summary.dexAccuracy.traderjoe.firstLeg.count}`);
    console.log(`    Average Accuracy: ${summary.dexAccuracy.traderjoe.firstLeg.average.toFixed(2)}%`);
    console.log(`    Median Accuracy: ${summary.dexAccuracy.traderjoe.firstLeg.median.toFixed(2)}%`);
    console.log(`    Standard Deviation: ${summary.dexAccuracy.traderjoe.firstLeg.stdDev.toFixed(2)}`);
    console.log(`    Range: ${summary.dexAccuracy.traderjoe.firstLeg.min.toFixed(2)}% to ${summary.dexAccuracy.traderjoe.firstLeg.max.toFixed(2)}%`);

    console.log(`  TraderJoe Second Leg (WAVAX/WBTC->USDC):`);
    console.log(`    Count: ${summary.dexAccuracy.traderjoe.secondLeg.count}`);
    console.log(`    Average Accuracy: ${summary.dexAccuracy.traderjoe.secondLeg.average.toFixed(2)}%`);
    console.log(`    Median Accuracy: ${summary.dexAccuracy.traderjoe.secondLeg.median.toFixed(2)}%`);
    console.log(`    Standard Deviation: ${summary.dexAccuracy.traderjoe.secondLeg.stdDev.toFixed(2)}`);
    console.log(`    Range: ${summary.dexAccuracy.traderjoe.secondLeg.min.toFixed(2)}% to ${summary.dexAccuracy.traderjoe.secondLeg.max.toFixed(2)}%`);

    // Profit metrics
    console.log('\nProfit Analysis:');
    Object.entries(summary.profitMetrics).forEach(([token, metrics]) => {
        console.log(`  ${token} Metrics:`);
        console.log(`    Total Profit: ${metrics.totalProfit} ${token}`);
        console.log(`    Average Profit per Trade: ${metrics.averageProfit} ${token}`);
        console.log(`    Median Profit: ${metrics.medianProfit} ${token}`);
        console.log(`    Profit Prediction Accuracy: ${metrics.profitPredictionAccuracy.toFixed(2)}%`);
        console.log(`    Profitable/Unprofitable: ${metrics.profitableTradeCount}/${metrics.unprofitableTradeCount}`);
    });

    // Flash loan analysis (new)
    console.log('\nFlash Loan Analysis:');
    console.log(`  Flash Loan Transactions: ${summary.flashLoanMetrics.count} (${(summary.flashLoanMetrics.count / summary.totalTransactions * 100).toFixed(1)}%)`);
    console.log(`  Success Rate: ${summary.flashLoanMetrics.successCount}/${summary.flashLoanMetrics.count} (${(summary.flashLoanMetrics.successRate * 100).toFixed(1)}%)`);
    console.log(`  Total Gross Profit: ${summary.flashLoanMetrics.totalGrossProfit} USDC`);
    console.log(`  Total Fees Paid: ${summary.flashLoanMetrics.totalFees} USDC (${summary.flashLoanMetrics.feeBps/100}%)`);
    console.log(`  Total Net Profit: ${summary.flashLoanMetrics.totalNetProfit} USDC`);
    console.log(`  Average Net Profit per Trade: ${summary.flashLoanMetrics.averageNetProfit} USDC`);

    // Suggested adjustment factors - separate by token pair
    console.log('\nSuggested Adjustment Factors for USDC-WAVAX:');
    if (summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.sampleSize > 0) {
        console.log(`  Uniswap First Leg (USDC->WAVAX): ${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.sampleSize} samples)`);
        console.log(`  Uniswap Second Leg (WAVAX->USDC): ${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.sampleSize} samples)`);
        console.log(`  TraderJoe First Leg (USDC->WAVAX): ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.sampleSize} samples)`);
        console.log(`  TraderJoe Second Leg (WAVAX->USDC): ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.sampleSize} samples)`);
    } else {
        console.log('  No WAVAX adjustment factors available');
    }

    console.log('\nSuggested Adjustment Factors for USDC-WBTC:');
    if (summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.sampleSize > 0) {
        console.log(`  Uniswap First Leg (USDC->WBTC): ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.sampleSize} samples)`);
        console.log(`  Uniswap Second Leg (WBTC->USDC): ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.sampleSize} samples)`);
        console.log(`  TraderJoe First Leg (USDC->WBTC): ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.sampleSize} samples)`);
        console.log(`  TraderJoe Second Leg (WBTC->USDC): ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.factor.toFixed(4)} (${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.confidence} confidence, ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.sampleSize} samples)`);
    } else {
        console.log('  No WBTC adjustment factors available');
    }

    // Combined adjustment factors (for backward compatibility)
    console.log('\nCombined Adjustment Factors (WAVAX + WBTC):');
    console.log(`  Uniswap First Leg (USDC->Any): ${summary.suggestedAdjustmentFactors.uniswap.firstLeg.factor.toFixed(4)} (${summary.suggestedAdjustmentFactors.uniswap.firstLeg.confidence} confidence, ${summary.suggestedAdjustmentFactors.uniswap.firstLeg.sampleSize} samples)`);
    console.log(`  Uniswap Second Leg (Any->USDC): ${summary.suggestedAdjustmentFactors.uniswap.secondLeg.factor.toFixed(4)} (${summary.suggestedAdjustmentFactors.uniswap.secondLeg.confidence} confidence, ${summary.suggestedAdjustmentFactors.uniswap.secondLeg.sampleSize} samples)`);
    console.log(`  TraderJoe First Leg (USDC->Any): ${summary.suggestedAdjustmentFactors.traderjoe.firstLeg.factor.toFixed(4)} (${summary.suggestedAdjustmentFactors.traderjoe.firstLeg.confidence} confidence, ${summary.suggestedAdjustmentFactors.traderjoe.firstLeg.sampleSize} samples)`);
    console.log(`  TraderJoe Second Leg (Any->USDC): ${summary.suggestedAdjustmentFactors.traderjoe.secondLeg.factor.toFixed(4)} (${summary.suggestedAdjustmentFactors.traderjoe.secondLeg.confidence} confidence, ${summary.suggestedAdjustmentFactors.traderjoe.secondLeg.sampleSize} samples)`);

    // Analysis by token pair (new)
    console.log('\nAnalysis by Token Pair:');
    Object.entries(summary.scenarioAnalysis.byTokenPair).forEach(([pair, data]) => {
        console.log(`  ${pair} (count: ${data.count}):`);
        if (data.count > 0) {
            console.log(`    Uniswap First Leg Accuracy: ${data.accuracyUniFirst.toFixed(2)}%`);
            console.log(`    TraderJoe First Leg Accuracy: ${data.accuracyJoeFirst.toFixed(2)}%`);
            console.log(`    Uniswap Second Leg Accuracy: ${data.accuracyUniSecond.toFixed(2)}%`);
            console.log(`    TraderJoe Second Leg Accuracy: ${data.accuracyJoeSecond.toFixed(2)}%`);
        } else {
            console.log('    No data available');
        }
    });

    // Trade size analysis
    console.log('\nAnalysis by Trade Size:');
    Object.entries(summary.scenarioAnalysis.byTradeSize).forEach(([size, data]) => {
        console.log(`  ${size} trades (count: ${data.count}):`);
        if (data.count > 0) {
            console.log(`    Uniswap First Leg Accuracy: ${data.accuracyUniFirst.toFixed(2)}%`);
            console.log(`    TraderJoe First Leg Accuracy: ${data.accuracyJoeFirst.toFixed(2)}%`);
            console.log(`    Uniswap Second Leg Accuracy: ${data.accuracyUniSecond.toFixed(2)}%`);
            console.log(`    TraderJoe Second Leg Accuracy: ${data.accuracyJoeSecond.toFixed(2)}%`);
        } else {
            console.log('    No data available');
        }
    });

    // Profitability analysis
    console.log('\nAnalysis by Profitability:');

    console.log(`  Profitable trades (count: ${summary.scenarioAnalysis.byProfitability.profitable.count}):`);
    if (summary.scenarioAnalysis.byProfitability.profitable.count > 0) {
        console.log(`    Average Accuracy: ${summary.scenarioAnalysis.byProfitability.profitable.avgAccuracy.toFixed(2)}%`);
        console.log(`    Uniswap First Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.profitable.adjustmentFactors.uniswapFirst.toFixed(4)}`);
        console.log(`    Uniswap Second Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.profitable.adjustmentFactors.uniswapSecond.toFixed(4)}`);
        console.log(`    TraderJoe First Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.profitable.adjustmentFactors.traderjoeFirst.toFixed(4)}`);
        console.log(`    TraderJoe Second Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.profitable.adjustmentFactors.traderjoeSecond.toFixed(4)}`);
    } else {
        console.log('    No profitable trades data available');
    }

    console.log(`  Unprofitable trades (count: ${summary.scenarioAnalysis.byProfitability.unprofitable.count}):`);
    if (summary.scenarioAnalysis.byProfitability.unprofitable.count > 0) {
        console.log(`    Average Accuracy: ${summary.scenarioAnalysis.byProfitability.unprofitable.avgAccuracy.toFixed(2)}%`);
        console.log(`    Uniswap First Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.unprofitable.adjustmentFactors.uniswapFirst.toFixed(4)}`);
        console.log(`    Uniswap Second Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.unprofitable.adjustmentFactors.uniswapSecond.toFixed(4)}`);
        console.log(`    TraderJoe First Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.unprofitable.adjustmentFactors.traderjoeFirst.toFixed(4)}`);
        console.log(`    TraderJoe Second Leg Adjustment: ${summary.scenarioAnalysis.byProfitability.unprofitable.adjustmentFactors.traderjoeSecond.toFixed(4)}`);
    } else {
        console.log('    No unprofitable trades data available');
    }

    // Interpretation guide
    console.log('\nInterpretation Guide:');
    console.log(`  Accuracy % > 0: Actual output was higher than expected (quotes were conservative)`);
    console.log(`  Accuracy % < 0: Actual output was lower than expected (quotes were optimistic)`);
    console.log(`  Adjustment Factor < 1: Reduce your estimates to be more accurate`);
    console.log(`  Adjustment Factor > 1: Increase your estimates to be more accurate`);
    console.log(`  For flash loan trades, profit includes fee adjustment`);

    console.log('=======================================================================================');
}

/**
 * Generate suggested code for quoter files with token pair specific adjustments
 */
function generateSuggestedCode(summary: AccuracySummary, outputPath: string): void {
    // Extract the token pair-specific adjustment factors
    const wavaxAdjustmentFactors = summary.tokenPairAdjustmentFactors.wavax;
    const wbtcAdjustmentFactors = summary.tokenPairAdjustmentFactors.wbtc;
    const uniswapFirstFactor = summary.suggestedAdjustmentFactors.uniswap.firstLeg;
    const uniswapSecondFactor = summary.suggestedAdjustmentFactors.uniswap.secondLeg;
    const traderjoeFirstFactor = summary.suggestedAdjustmentFactors.traderjoe.firstLeg;
    const traderjoeSecondFactor = summary.suggestedAdjustmentFactors.traderjoe.secondLeg;

    // Generate code for quoterUniswap.ts
    let uniswapCode = `// ========================================================
// QUOTE ADJUSTMENT FACTORS FOR UNISWAP
// ========================================================
// Generated based on statistical analysis of ${summary.totalTransactions} transactions
// Date: ${new Date().toISOString()}
// 
// WAVAX Adjustment Factors:
// ------------------------
// First Leg (USDC->WAVAX): ${wavaxAdjustmentFactors.uniswap.firstLeg.factor.toFixed(4)} 
//    - Confidence: ${wavaxAdjustmentFactors.uniswap.firstLeg.confidence}
//    - Sample size: ${wavaxAdjustmentFactors.uniswap.firstLeg.sampleSize}
//
// Second Leg (WAVAX->USDC): ${wavaxAdjustmentFactors.uniswap.secondLeg.factor.toFixed(4)}
//    - Confidence: ${wavaxAdjustmentFactors.uniswap.secondLeg.confidence}
//    - Sample size: ${wavaxAdjustmentFactors.uniswap.secondLeg.sampleSize}
//
// WBTC Adjustment Factors:
// -----------------------
// First Leg (USDC->WBTC): ${wbtcAdjustmentFactors.uniswap.firstLeg.factor.toFixed(4)} 
//    - Confidence: ${wbtcAdjustmentFactors.uniswap.firstLeg.confidence}
//    - Sample size: ${wbtcAdjustmentFactors.uniswap.firstLeg.sampleSize}
//
// Second Leg (WBTC->USDC): ${wbtcAdjustmentFactors.uniswap.secondLeg.factor.toFixed(4)}
//    - Confidence: ${wbtcAdjustmentFactors.uniswap.secondLeg.confidence}
//    - Sample size: ${wbtcAdjustmentFactors.uniswap.secondLeg.sampleSize}
// ========================================================

/**
 * Adjustment factors for Uniswap quotes based on empirical data
 */
export const UNISWAP_QUOTE_ADJUSTMENT_FACTORS = {
    // WAVAX adjustment factors
    WAVAX: {
        // For USDC->WAVAX direction
        USDC_TO_WAVAX: ${wavaxAdjustmentFactors.uniswap.firstLeg.factor.toFixed(4)},
        
        // For WAVAX->USDC direction
        WAVAX_TO_USDC: ${wavaxAdjustmentFactors.uniswap.secondLeg.factor.toFixed(4)}
    },
    
    // WBTC adjustment factors
    WBTC: {
        // For USDC->WBTC direction
        USDC_TO_WBTC: ${wbtcAdjustmentFactors.uniswap.firstLeg.factor.toFixed(4)},
        
        // For WBTC->USDC direction
        WBTC_TO_USDC: ${wbtcAdjustmentFactors.uniswap.secondLeg.factor.toFixed(4)}
    }
};

/**
 * Apply the empirical adjustment factor to expected output
 * @param expectedOutput The original expected output
 * @param direction The swap direction ('USDC->WAVAX' or 'WAVAX->USDC')
 * @returns The adjusted expected output
 */
export function applyQuoteAdjustment(
    expectedOutput: string, 
    direction: 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC'
): string {
    // Get token from direction
    const isWbtc = direction.includes('WBTC');
    const tokenKey = isWbtc ? 'WBTC' : 'WAVAX';
    
    // Get direction type (first leg or second leg)
    const isFirstLeg = direction.startsWith('USDC->');
    
    // Get the appropriate factor based on token and direction
    let factor: number;
    if (isWbtc) {
        factor = isFirstLeg 
            ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WBTC.USDC_TO_WBTC 
            : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WBTC.WBTC_TO_USDC;
    } else {
        factor = isFirstLeg 
            ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX.USDC_TO_WAVAX 
            : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX.WAVAX_TO_USDC;
    }
    
    // Apply the adjustment factor
    const adjustedOutput = (parseFloat(expectedOutput) * factor).toString();
    return adjustedOutput;
}

// Implementation example for your getQuote function:
/*
export async function getQuote(
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    amount?: string,
    recipientOverride?: string
): Promise<SimulatedQuoteResult | null> {
    // ... existing code ...
    
    // Once we have the expected output, apply the adjustment factor
    const rawExpectedOutput = trade.outputAmount.toExact();
    const adjustedExpectedOutput = applyQuoteAdjustment(rawExpectedOutput, direction);
    
    // Use the adjusted value in the returned results
    const result: SimulatedQuoteResult = {
        // ... other fields ...
        expectedOutput: adjustedExpectedOutput,
        // ... other fields ...
    };
    
    // ... existing code ...
}
*/`;

    // Generate code for quoterTraderJoe.ts
    let traderjoeCode = `// ========================================================
// QUOTE ADJUSTMENT FACTORS FOR TRADER JOE
// ========================================================
// Generated based on statistical analysis of ${summary.totalTransactions} transactions
// Date: ${new Date().toISOString()}
// 
// WAVAX Adjustment Factors:
// ------------------------
// First Leg (USDC->WAVAX): ${wavaxAdjustmentFactors.traderjoe.firstLeg.factor.toFixed(4)} 
//    - Confidence: ${wavaxAdjustmentFactors.traderjoe.firstLeg.confidence}
//    - Sample size: ${wavaxAdjustmentFactors.traderjoe.firstLeg.sampleSize}
//
// Second Leg (WAVAX->USDC): ${wavaxAdjustmentFactors.traderjoe.secondLeg.factor.toFixed(4)}
//    - Confidence: ${wavaxAdjustmentFactors.traderjoe.secondLeg.confidence}
//    - Sample size: ${wavaxAdjustmentFactors.traderjoe.secondLeg.sampleSize}
//
// WBTC Adjustment Factors:
// -----------------------
// First Leg (USDC->WBTC): ${wbtcAdjustmentFactors.traderjoe.firstLeg.factor.toFixed(4)} 
//    - Confidence: ${wbtcAdjustmentFactors.traderjoe.firstLeg.confidence}
//    - Sample size: ${wbtcAdjustmentFactors.traderjoe.firstLeg.sampleSize}
//
// Second Leg (WBTC->USDC): ${wbtcAdjustmentFactors.traderjoe.secondLeg.factor.toFixed(4)}
//    - Confidence: ${wbtcAdjustmentFactors.traderjoe.secondLeg.confidence}
//    - Sample size: ${wbtcAdjustmentFactors.traderjoe.secondLeg.sampleSize}
//
// Combined Factors (for backward compatibility):
// --------------------------------------------
// First Leg (USDC->Any): ${traderjoeFirstFactor.factor.toFixed(4)}
// Second Leg (Any->USDC): ${traderjoeSecondFactor.factor.toFixed(4)}
// ========================================================

/**
 * Adjustment factors for Trader Joe quotes based on empirical data
 */
export const TRADERJOE_QUOTE_ADJUSTMENT_FACTORS = {
    // WAVAX adjustment factors
    WAVAX: {
        // For USDC->WAVAX direction
        USDC_TO_WAVAX: ${wavaxAdjustmentFactors.traderjoe.firstLeg.factor.toFixed(4)},
        
        // For WAVAX->USDC direction
        WAVAX_TO_USDC: ${wavaxAdjustmentFactors.traderjoe.secondLeg.factor.toFixed(4)}
    },
    
    // WBTC adjustment factors
    WBTC: {
        // For USDC->WBTC direction
        USDC_TO_WBTC: ${wbtcAdjustmentFactors.traderjoe.firstLeg.factor.toFixed(4)},
        
        // For WBTC->USDC direction
        WBTC_TO_USDC: ${wbtcAdjustmentFactors.traderjoe.secondLeg.factor.toFixed(4)}
    },
    
    // Legacy factors (combined across all token pairs)
    LEGACY: {
        USDC_TO_ANY: ${traderjoeFirstFactor.factor.toFixed(4)},
        ANY_TO_USDC: ${traderjoeSecondFactor.factor.toFixed(4)}
    }
};

/**
 * Apply the empirical adjustment factor to expected output
 * @param expectedOutput The original expected output
 * @param direction The swap direction ('USDC->WAVAX' or 'WAVAX->USDC')
 * @returns The adjusted expected output
 */
export function applyQuoteAdjustment(
    expectedOutput: string, 
    direction: 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC'
): string {
    // Get token from direction
    const isWbtc = direction.includes('WBTC');
    const tokenKey = isWbtc ? 'WBTC' : 'WAVAX';
    
    // Get direction type (first leg or second leg)
    const isFirstLeg = direction.startsWith('USDC->');
    
    // Get the appropriate factor based on token and direction
    let factor: number;
    if (isWbtc) {
        factor = isFirstLeg 
            ? TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WBTC.USDC_TO_WBTC 
            : TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WBTC.WBTC_TO_USDC;
    } else {
        factor = isFirstLeg 
            ? TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WAVAX.USDC_TO_WAVAX 
            : TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WAVAX.WAVAX_TO_USDC;
    }
    
    // Apply the adjustment factor
    const adjustedOutput = (parseFloat(expectedOutput) * factor).toString();
    return adjustedOutput;
}

// Implementation example for your getQuote function:
/*
export async function getQuote(
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    amount?: string,
    recipientOverride?: string
): Promise<SimulatedQuoteResult | null> {
    // ... existing code ...
    
    // Once we have the expected output, apply the adjustment factor
    const rawExpectedOutput = bestTrade.outputAmount.toExact();
    const adjustedExpectedOutput = applyQuoteAdjustment(rawExpectedOutput, direction);
    
    // Use the adjusted value in the returned results
    const result: SimulatedQuoteResult = {
        // ... other fields ...
        expectedOutput: adjustedExpectedOutput,
        // ... other fields ...
    };
    
    // ... existing code ...
}
*/`;

    // Write the code to files
    fs.mkdirSync(path.join(outputPath, 'suggested_code'), { recursive: true });
    fs.writeFileSync(path.join(outputPath, 'suggested_code', 'uniswap_adjustments.ts'), uniswapCode);
    fs.writeFileSync(path.join(outputPath, 'suggested_code', 'traderjoe_adjustments.ts'), traderjoeCode);

    console.log(`\nSuggested code files generated in: ${path.join(outputPath, 'suggested_code')}`);
}

/**
 * Process a batch of transactions and extract metrics
 * Updated to properly handle both WAVAX and WBTC pairs
 */
async function processTransactions(
    hashes: Hash[],
    options: OutputOptions
): Promise<AccuracyMetrics[]> {
    console.log(`Processing ${hashes.length} transactions with AVAX price: $${options.avaxPrice} USD`);
    const results: AccuracyMetrics[] = [];

    // Process in batches to avoid rate limiting
    for (let i = 0; i < hashes.length; i += options.batchSize) {
        const batch = hashes.slice(i, i + options.batchSize);
        console.log(`Processing batch ${Math.floor(i/options.batchSize) + 1}/${Math.ceil(hashes.length/options.batchSize)}`);

        // Process batch in parallel - pass the avaxPrice from options
        const batchResults = await Promise.all(
            batch.map(async (hash) => {
                try {
                    // Get metrics from blockchain data
                    const metrics = await analyzeQuoteAccuracy(hash, options.avaxPrice);

                    // If metrics exist, post-process them to ensure consistent calculations
                    if (metrics) {
                        // Determine token pair if not already set
                        if (!metrics.tokenPair) {
                            metrics.tokenPair =
                                metrics.targetToken === 'WAVAX' ? 'USDC-WAVAX' :
                                    metrics.targetToken === 'BTC.b' ? 'USDC-WBTC' :
                                        'unknown';
                        }

                        // Fix second leg calculations for consistency
                        fixSecondLegCalculations(metrics, options);
                    }

                    return metrics;
                } catch (error) {
                    console.error(`Error processing ${hash}:`, error);
                    return null;
                }
            })
        );

        // Filter out errors and add valid results
        const validResults = batchResults.filter((tx): tx is AccuracyMetrics => tx !== null);
        results.push(...validResults);

        // Wait between batches to avoid rate limiting
        if (i + options.batchSize < hashes.length) {
            console.log('Waiting between batches...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // One final post-processing pass to ensure consistency across all metrics
    for (const metric of results) {
        // Make sure token pair is properly set
        if (!metric.tokenPair || metric.tokenPair === 'unknown') {
            if (metric.targetToken === 'WAVAX') {
                metric.tokenPair = 'USDC-WAVAX';
            } else if (metric.targetToken === 'BTC.b') {
                metric.tokenPair = 'USDC-WBTC';
            }
        }

        // For flash loan transactions, ensure flash loan specific fields are properly set
        if (metric.isFlashLoan) {
            // Make sure flash loan fee is properly calculated
            if (!metric.flashLoanFee && metric.amountIn) {
                const inputAmount = parseFloat(metric.amountInFormatted);
                // Balancer has 0% fee (FLASH_LOAN_BPS = 0)
                metric.flashLoanFee = "0";
            }

            // Ensure net profit is calculated
            if (!metric.netProfit && metric.profit) {
                // For Balancer, net profit equals gross profit (no fees)
                metric.netProfit = metric.profit;
            }
        }
    }

    return results;
}

/**
 * Process JSON files with trade data
 * Updated to support WBTC trading pairs and the latest format from runDataCollection.ts
 */
async function processTradeDataFiles(
    filePaths: string[],
    options: OutputOptions
): Promise<AccuracyMetrics[]> {
    console.log(`Processing ${filePaths.length} trade data files with AVAX price: $${options.avaxPrice} USD`);
    const results: AccuracyMetrics[] = [];

    // Process in batches
    for (let i = 0; i < filePaths.length; i += options.batchSize) {
        const batch = filePaths.slice(i, i + options.batchSize);
        console.log(`Processing file batch ${Math.floor(i / options.batchSize) + 1}/${Math.ceil(filePaths.length / options.batchSize)}`);

        // Process batch in parallel
        const batchResults = await Promise.all(
            batch.map(async (filePath) => {
                try {
                    // First preprocess the raw data to normalize it
                    const rawData = fs.readFileSync(filePath, 'utf-8');
                    const parsedData = JSON.parse(rawData);

                    // Extract token pair information directly from file data
                    // New runDataCollection.ts explicitly includes tokenPair field
                    const tokenPair = parsedData.tokenPair ||
                        (parsedData.config?.firstLeg?.dex && parsedData.config?.secondLeg?.dex ?
                            (filePath.toLowerCase().includes('wbtc') ? 'USDC-WBTC' : 'USDC-WAVAX') :
                            'unknown');

                    if (options.verbose) {
                        console.log(`Processing file: ${filePath}`);
                        console.log(`  Detected token pair: ${tokenPair}`);
                        console.log(`  Direction: ${parsedData.direction}`);
                    }

                    // Preprocess the data to standardize format
                    const processedData = preprocessTransactionData(parsedData);

                    // Add token pair information if not already present
                    if (!processedData.tokenPair) {
                        processedData.tokenPair = tokenPair;
                    }

                    // Write back processed data for debugging if verbose is enabled
                    if (options.verbose) {
                        const debugDir = path.join(options.outputDir, 'debug');
                        if (!fs.existsSync(debugDir)) {
                            fs.mkdirSync(debugDir, { recursive: true });
                        }
                        const debugPath = path.join(debugDir, path.basename(filePath));
                        fs.writeFileSync(debugPath, JSON.stringify(processedData, null, 2));
                        console.log(`Preprocessed data written to ${debugPath}`);
                    }

                    // Now analyze the trade data
                    const metrics = await analyzeStoredTradeData(filePath, options.avaxPrice);

                    // Ensure token pair is correctly set
                    if (metrics) {
                        // If token pair is not set or unknown, use the one from the file
                        if (!metrics.tokenPair || metrics.tokenPair === 'unknown') {
                            metrics.tokenPair = tokenPair;

                            // Also update sourceToken and targetToken based on tokenPair if needed
                            if (metrics.tokenPair === 'USDC-WBTC' && metrics.targetToken !== 'BTC.b') {
                                metrics.targetToken = 'BTC.b';
                            } else if (metrics.tokenPair === 'USDC-WAVAX' && metrics.targetToken !== 'WAVAX') {
                                metrics.targetToken = 'WAVAX';
                            }

                            // Source token is always USDC
                            if (metrics.sourceToken !== 'USDC') {
                                metrics.sourceToken = 'USDC';
                            }
                        }
                    }

                    return metrics;
                } catch (error) {
                    console.error(`Error processing file ${filePath}:`, error);
                    return null;
                }
            })
        );

        // Filter out errors and add valid results
        const validResults = batchResults.filter((tx): tx is AccuracyMetrics => tx !== null);

        // Post-process to fix second leg calculations and other edge cases
        for (const metric of validResults) {
            // Apply consistent fixes
            fixSecondLegCalculations(metric, options);

            // For Balancer flash loans, ensure the fee is set to 0
            if (metric.isFlashLoan) {
                // Balancer flash loans have 0% fee
                metric.flashLoanFee = "0";

                // Net profit equals gross profit for Balancer flash loans
                metric.netProfit = metric.profit;

                if (options.verbose) {
                    console.log(`Flash loan transaction detected: ${metric.hash}`);
                    console.log(`  Flash loan fee: ${metric.flashLoanFee}`);
                    console.log(`  Gross profit: ${metric.profit}`);
                    console.log(`  Net profit: ${metric.netProfit}`);
                }
            }
        }

        results.push(...validResults);

        // Wait between batches
        if (i + options.batchSize < filePaths.length) {
            console.log('Waiting between batches...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    return results;
}
/**
 * Fix second leg calculations to ensure consistent and accurate metrics
 * Updated to support both WAVAX and WBTC pairs and the latest data format from runDataCollection.ts
 * @param metric The metrics object to fix
 * @param options Output options for debugging
 */
function fixSecondLegCalculations(metric: AccuracyMetrics, options: OutputOptions): void {
    if (options.verbose) {
        console.log(`Post-processing metrics for ${metric.hash}`);
        console.log(`  Token pair: ${metric.tokenPair || 'unknown'}`);
        console.log(`  Original second leg: actualOutput=${metric.secondLeg.actualOutput}, expectedOutput=${metric.secondLeg.expectedOutput}`);
    }

    // Ensure token pair is set correctly
    if (!metric.tokenPair || metric.tokenPair === 'unknown') {
        metric.tokenPair = metric.targetToken === 'BTC.b' ? 'USDC-WBTC' : 'USDC-WAVAX';

        if (options.verbose) {
            console.log(`  Updated token pair to: ${metric.tokenPair}`);
        }
    }

    // Use trade context data if available
    if (metric.tradeContext) {
        // First leg actual output should come from tradeContext.actualFirstOutput
        if (metric.firstLeg && metric.tradeContext.actualFirstOutput && metric.tradeContext.actualFirstOutput !== "0") {
            metric.firstLeg.actualOutput = metric.tradeContext.actualFirstOutput;
            metric.firstLeg.actualOutputFormatted = convertRawToDecimal(
                metric.tradeContext.actualFirstOutput,
                metric.targetToken
            );

            // Recalculate accuracy
            if (metric.tradeContext.expectedFirstOutput && metric.tradeContext.expectedFirstOutput !== "0") {
                const expected = parseFloat(convertRawToDecimal(
                    metric.tradeContext.expectedFirstOutput,
                    metric.targetToken
                ));
                const actual = parseFloat(metric.firstLeg.actualOutputFormatted);

                if (!isNaN(expected) && !isNaN(actual) && expected > 0) {
                    metric.firstLeg.accuracyPercent = ((actual - expected) / expected) * 100;
                    metric.firstLeg.outputDelta = (actual - expected).toString();
                }
            }
        }

        // Key fix for second leg calculations
        // For flash loans, the actual second leg output should be calculated differently
        if (metric.isFlashLoan) {
            // For flash loans, the final balance should be the amount after accounting for profit/loss
            // For Balancer flash loans, fee is 0
            const inputAmount = parseFloat(metric.amountInFormatted);
            const outputAmount = inputAmount + parseFloat(metric.profitFormatted);

            // Update second leg actual output
            metric.secondLeg.actualOutput = safeBigInt(Math.floor(outputAmount * 1000000)).toString();
            metric.secondLeg.actualOutputFormatted = outputAmount.toFixed(6);

            // Store original value for reference
            if (!metric.secondLeg._originalActualOutput && metric.tradeContext.actualSecondOutput) {
                metric.secondLeg._originalActualOutput = metric.tradeContext.actualSecondOutput;
            }

            // Recalculate accuracy
            if (metric.secondLeg.expectedOutput && metric.secondLeg.expectedOutput !== "0") {
                const expected = parseFloat(convertRawToDecimal(
                    metric.secondLeg.expectedOutput,
                    metric.sourceToken
                ));

                if (!isNaN(expected) && expected > 0) {
                    metric.secondLeg.accuracyPercent = ((outputAmount - expected) / expected) * 100;
                    metric.secondLeg.outputDelta = (outputAmount - expected).toString();

                    // Calculate original output delta if available
                    if (metric.tradeContext.actualSecondOutput) {
                        const origActualOutput = parseFloat(convertRawToDecimal(
                            metric.tradeContext.actualSecondOutput,
                            metric.sourceToken
                        ));
                        metric.secondLeg._originalOutputDelta = (origActualOutput - expected).toString();
                        metric.secondLeg._originalAccuracyPercent = ((origActualOutput - expected) / expected) * 100;
                    }
                }
            }
        } else {
            // For non-flash loan trades, we need to properly handle trade balances
            if (metric.tradeFinalBalance && metric.tradeFinalBalance !== "0") {
                // The correct actual output is the final trade balance from the round trip
                metric.secondLeg.actualOutput = metric.tradeFinalBalance;
                metric.secondLeg.actualOutputFormatted = convertRawToDecimal(
                    metric.tradeFinalBalance,
                    metric.sourceToken
                );

                // Recalculate accuracy
                if (metric.secondLeg.expectedOutput && metric.secondLeg.expectedOutput !== "0") {
                    const expected = parseFloat(convertRawToDecimal(
                        metric.secondLeg.expectedOutput,
                        metric.sourceToken
                    ));
                    const actual = parseFloat(metric.secondLeg.actualOutputFormatted);

                    if (!isNaN(expected) && !isNaN(actual) && expected > 0) {
                        metric.secondLeg.accuracyPercent = ((actual - expected) / expected) * 100;
                        metric.secondLeg.outputDelta = (actual - expected).toString();
                    }
                }
            } else if (metric.tradeContext.actualSecondOutput && metric.tradeContext.actualSecondOutput !== "0") {
                // If tradeFinalBalance isn't available, use actualSecondOutput
                const actualOutput = metric.tradeContext.actualSecondOutput;

                // Store the original for reference
                metric.secondLeg._originalActualOutput = actualOutput;

                // Calculate the proper actual output based on input and profit
                const inputAmount = parseFloat(metric.amountInFormatted);
                const profitAmount = parseFloat(metric.profitFormatted);
                const calculatedOutput = inputAmount + profitAmount;

                metric.secondLeg.actualOutput = safeBigInt(Math.floor(calculatedOutput * 1000000)).toString();
                metric.secondLeg.actualOutputFormatted = calculatedOutput.toFixed(6);

                // Recalculate accuracy
                if (metric.secondLeg.expectedOutput && metric.secondLeg.expectedOutput !== "0") {
                    const expected = parseFloat(convertRawToDecimal(
                        metric.secondLeg.expectedOutput,
                        metric.sourceToken
                    ));

                    if (!isNaN(expected) && expected > 0) {
                        metric.secondLeg.accuracyPercent = ((calculatedOutput - expected) / expected) * 100;
                        metric.secondLeg.outputDelta = (calculatedOutput - expected).toString();

                        // Calculate original accuracy
                        const origActualOutput = parseFloat(convertRawToDecimal(
                            actualOutput,
                            metric.sourceToken
                        ));
                        metric.secondLeg._originalOutputDelta = (origActualOutput - expected).toString();
                        metric.secondLeg._originalAccuracyPercent = ((origActualOutput - expected) / expected) * 100;
                    }
                }
            }
        }
    }

    // Special handling for test mode transactions with negative profit
    if (metric.testMode && parseFloat(metric.profitFormatted) < 0) {
        // In test mode, negative profit is expected and should be properly reflected
        if (options.verbose) {
            console.log(`  Test mode transaction with negative profit: ${metric.profitFormatted}`);
        }

        // For test mode, adjust profit prediction accuracy to avoid extreme values
        if (Math.abs(metric.profitPredictionAccuracy) > 100) {
            const oldValue = metric.profitPredictionAccuracy;
            metric.profitPredictionAccuracy = Math.sign(metric.profitPredictionAccuracy) * 100;

            if (options.verbose) {
                console.log(`  Capped extreme profit prediction accuracy: ${oldValue} -> ${metric.profitPredictionAccuracy}`);
            }
        }
    }

    // Recalculate overall accuracy based on the updated leg values
    metric.overallAccuracy = (metric.firstLeg.accuracyPercent + metric.secondLeg.accuracyPercent * 2) / 3;

    // Recalculate profit prediction accuracy
    if (metric.secondLeg.expectedOutput && metric.amountInFormatted) {
        const expectedOutput = parseFloat(convertRawToDecimal(
            metric.secondLeg.expectedOutput,
            metric.sourceToken
        ));
        const inputAmount = parseFloat(metric.amountInFormatted);
        const actualProfit = parseFloat(metric.profitFormatted);

        // Calculate expected profit
        const expectedProfit = expectedOutput - inputAmount;

        if (expectedProfit !== 0) {
            // Only update if this calculation provides a valid result
            const newAccuracy = (actualProfit / expectedProfit) * 100;
            if (isFinite(newAccuracy)) {
                metric.profitPredictionAccuracy = newAccuracy;

                // Cap extreme values
                if (Math.abs(metric.profitPredictionAccuracy) > 200) {
                    metric.profitPredictionAccuracy = Math.sign(metric.profitPredictionAccuracy) *
                        Math.min(Math.abs(metric.profitPredictionAccuracy), 200);
                }
            }
        }

        // Calculate profit impact
        if (inputAmount > 0) {
            metric.profitImpact = ((actualProfit - expectedProfit) / inputAmount) * 100;
        }
    }

    // Handle flash loan specific fields
    if (metric.isFlashLoan) {
        // Balancer flash loans have 0% fee
        if (!metric.flashLoanFee) {
            metric.flashLoanFee = "0";
        }

        // Net profit equals gross profit for Balancer (no fee)
        if (!metric.netProfit) {
            metric.netProfit = metric.profit;
        }
    }

    if (options.verbose) {
        console.log(`  Updated second leg: actualOutput=${metric.secondLeg.actualOutput}, actualOutputFormatted=${metric.secondLeg.actualOutputFormatted}`);
        console.log(`  Updated accuracy: firstLeg=${metric.firstLeg.accuracyPercent.toFixed(2)}%, secondLeg=${metric.secondLeg.accuracyPercent.toFixed(2)}%, overall=${metric.overallAccuracy.toFixed(2)}%`);
        if (metric.isFlashLoan) {
            console.log(`  Flash loan details: fee=${metric.flashLoanFee}, profit=${metric.profit}, netProfit=${metric.netProfit}`);
        }
    }
}
/**
 * Converts raw token amount to formatted decimal string based on token decimals
 * Updated to properly handle both WAVAX and WBTC token decimals
 *
 * @param rawAmount The raw amount as a string (in wei/base units)
 * @param tokenSymbol The token symbol to determine decimals
 * @returns Formatted decimal string
 */
function convertRawToDecimal(rawAmount: string, tokenSymbol: string): string {
    // If already in decimal format, return as is
    if (rawAmount.includes('.')) {
        return rawAmount;  // Already in decimal format
    }

    // Get token decimals based on token symbol
    let decimals: number;
    switch (tokenSymbol) {
        case 'USDC':
            decimals = 6;  // USDC has 6 decimals
            break;
        case 'BTC.b':
        case 'WBTC':
            decimals = 8;  // Bitcoin tokens typically have 8 decimals
            break;
        case 'WAVAX':
        default:
            decimals = 18; // WAVAX and most ERC20 tokens have 18 decimals
            break;
    }

    // Handle empty or invalid input
    if (!rawAmount || rawAmount === '0' || rawAmount === 'NULL' || rawAmount === 'N/A') {
        return '0';
    }

    try {
        // Handle negative values correctly
        const isNegative = rawAmount.startsWith('-');
        const absRawAmount = isNegative ? rawAmount.substring(1) : rawAmount;

        // Convert to BigInt to handle large numbers safely
        let amount = safeBigInt(absRawAmount);

        // Calculate divisor (10^decimals)
        const divisor = safeBigInt(10) ** safeBigInt(decimals);

        // Integer part
        const integerPart = (amount / divisor).toString();

        // Fractional part (padded with leading zeros)
        let fractionalPart = (amount % divisor).toString().padStart(decimals, '0');

        // Trim trailing zeros for cleaner output
        fractionalPart = fractionalPart.replace(/0+$/, '');

        // If all zeros, just return the integer part
        if (fractionalPart === '') {
            return isNegative ? `-${integerPart}` : integerPart;
        }

        // Combine integer and fractional parts
        const result = `${integerPart}.${fractionalPart}`;
        return isNegative ? `-${result}` : result;
    } catch (error) {
        console.error(`Error converting raw amount: ${rawAmount} for token ${tokenSymbol}`, error);

        // If conversion fails, try a simpler approach for small numbers
        if (typeof rawAmount === 'string' && !isNaN(Number(rawAmount))) {
            try {
                const numericValue = Number(rawAmount);
                const divisor = Math.pow(10, decimals);
                const formattedValue = (numericValue / divisor).toString();
                return formattedValue;
            } catch (fallbackError) {
                console.error(`Fallback conversion also failed for ${rawAmount}`, fallbackError);
            }
        }

        // Return the original if all conversions fail
        return rawAmount;
    }
}

/**
 * Preprocess transaction data to standardize format and ensure consistency
 * Updated to support both WAVAX and WBTC trading pairs and the latest runDataCollection.ts format
 *
 * @param rawData Raw transaction data from file
 * @returns Standardized transaction data
 */
function preprocessTransactionData(rawData: any): any {
    // Create a deep copy of the data to avoid mutating the original
    const processedData = JSON.parse(JSON.stringify(rawData));

    try {
        // Extract and validate token pair information
        if (!processedData.tokenPair) {
            // Try to determine token pair from context if not explicitly provided
            if (processedData.config && processedData.config.firstLeg) {
                // Check if any paths include WBTC
                const isWbtcPath =
                    // Check first leg expected output path
                    (processedData.config.firstLeg.trade &&
                        JSON.stringify(processedData.config.firstLeg.trade).toLowerCase().includes('btc')) ||
                    // Check directly in expectedWAVAX field, which might contain WBTC despite the name
                    (processedData.expectedWAVAX &&
                        processedData.config.firstLeg.expectedOutput &&
                        processedData.config.firstLeg.expectedOutput.toString().length === 16); // WBTC typically has 8 decimals

                processedData.tokenPair = isWbtcPath ? 'USDC-WBTC' : 'USDC-WAVAX';
            } else {
                processedData.tokenPair = 'USDC-WAVAX'; // Default to WAVAX if cannot determine
            }
        }

        // Check if flash loan details exist and format them properly
        if (processedData.useFlashLoan === true ||
            (processedData.result && processedData.result.flashLoanFee !== undefined) ||
            processedData.flashLoanDetails) {

            // Flag as flash loan
            processedData.isFlashLoan = true;

            // For Balancer flash loans, fee is always 0 (FLASH_LOAN_BPS = 0)
            if (processedData.result && processedData.result.flashLoanFee === undefined) {
                processedData.result.flashLoanFee = "0";
            }

            // Calculate net profit if missing but gross profit is available
            if (processedData.result && processedData.result.profit &&
                processedData.result.flashLoanFee !== undefined &&
                processedData.result.netProfit === undefined) {

                // For Balancer flash loans, net profit equals gross profit (no fee)
                processedData.result.netProfit = processedData.result.profit;
            }
        }

        // Ensure flash loan details structure is consistent
        if (processedData.flashLoanDetails) {
            // Convert to string format if numbers
            if (typeof processedData.flashLoanDetails.flashLoanFee === 'number') {
                processedData.flashLoanDetails.flashLoanFee =
                    processedData.flashLoanDetails.flashLoanFee.toString();
            }

            if (typeof processedData.flashLoanDetails.netProfit === 'number') {
                processedData.flashLoanDetails.netProfit =
                    processedData.flashLoanDetails.netProfit.toString();
            }

            // Ensure Balancer's 0% fee is applied
            if (processedData.flashLoanDetails.flashLoanFee === undefined) {
                processedData.flashLoanDetails.flashLoanFee = "0";
            }

            // Copy to result section if missing
            if (processedData.result) {
                if (processedData.result.flashLoanFee === undefined) {
                    processedData.result.flashLoanFee = processedData.flashLoanDetails.flashLoanFee;
                }

                if (processedData.result.netProfit === undefined &&
                    processedData.flashLoanDetails.netProfit !== undefined) {
                    processedData.result.netProfit = processedData.flashLoanDetails.netProfit;
                }
            }
        }

        // Check if trade context is available and use it
        if (processedData.result && processedData.result.tradeContext) {
            const tradeContext = processedData.result.tradeContext;

            // Ensure numeric values are properly formatted
            if (tradeContext.tradeInputAmount) {
                tradeContext.tradeInputAmount = tradeContext.tradeInputAmount.toString();
            }
            if (tradeContext.tradeFinalBalance) {
                tradeContext.tradeFinalBalance = tradeContext.tradeFinalBalance.toString();
            }
            if (tradeContext.expectedFirstOutput) {
                tradeContext.expectedFirstOutput = tradeContext.expectedFirstOutput.toString();
            }
            if (tradeContext.actualFirstOutput) {
                tradeContext.actualFirstOutput = tradeContext.actualFirstOutput.toString();
            }
            if (tradeContext.expectedSecondOutput) {
                tradeContext.expectedSecondOutput = tradeContext.expectedSecondOutput.toString();
            }
            if (tradeContext.actualSecondOutput) {
                tradeContext.actualSecondOutput = tradeContext.actualSecondOutput.toString();
            }
        }

        // Check swap checkpoints for essential information
        if (processedData.result && processedData.result.swapCheckpoints) {
            // Ensure consistency of field types and names
            processedData.result.swapCheckpoints = processedData.result.swapCheckpoints.map((cp: any) => {
                // Create a standardized checkpoint object
                return {
                    stage: cp.stage || '',
                    token: cp.token || '',
                    actualBalance: cp.actualBalance ? cp.actualBalance.toString() : '0',
                    expectedBalance: cp.expectedBalance ? cp.expectedBalance.toString() : '0',
                    timestamp: cp.timestamp ? cp.timestamp.toString() : Date.now().toString(),
                    difference: cp.difference || '0',
                    // Include account total balance if present
                    ...(cp.accountTotalBalance ? { accountTotalBalance: cp.accountTotalBalance.toString() } : {})
                };
            });

            // Look for first leg checkpoint
            const firstLegCheckpoint = processedData.result.swapCheckpoints.find(
                (cp: any) => cp.stage === 'AfterFirstSwap'
            );

            // Look for second leg checkpoint
            const secondLegCheckpoint = processedData.result.swapCheckpoints.find(
                (cp: any) => cp.stage === 'AfterSecondSwap'
            );

            // If we have trade context and checkpoints, ensure the data is consistent
            if (processedData.result.tradeContext) {
                if (firstLegCheckpoint && !processedData.result.tradeContext.actualFirstOutput) {
                    processedData.result.tradeContext.actualFirstOutput = firstLegCheckpoint.actualBalance;
                }
                if (firstLegCheckpoint && !processedData.result.tradeContext.expectedFirstOutput) {
                    processedData.result.tradeContext.expectedFirstOutput = firstLegCheckpoint.expectedBalance;
                }
                if (secondLegCheckpoint && !processedData.result.tradeContext.actualSecondOutput) {
                    processedData.result.tradeContext.actualSecondOutput = secondLegCheckpoint.actualBalance;
                }
                if (secondLegCheckpoint && !processedData.result.tradeContext.expectedSecondOutput) {
                    processedData.result.tradeContext.expectedSecondOutput = secondLegCheckpoint.expectedBalance;
                }
            }
            // If we don't have trade context but have checkpoints, create trade context
            else if ((firstLegCheckpoint || secondLegCheckpoint) && !processedData.result.tradeContext) {
                processedData.result.tradeContext = {
                    tradeInputAmount: processedData.config?.inputAmount || "0",
                    tradeFinalBalance: processedData.result?.finalBalance || "0",
                    expectedFirstOutput: firstLegCheckpoint?.expectedBalance || "0",
                    actualFirstOutput: firstLegCheckpoint?.actualBalance || "0",
                    expectedSecondOutput: secondLegCheckpoint?.expectedBalance || "0",
                    actualSecondOutput: secondLegCheckpoint?.actualBalance || "0"
                };
            }
        }

        // Make sure all expected output values are strings
        if (processedData.config?.firstLeg?.expectedOutput &&
            typeof processedData.config.firstLeg.expectedOutput !== 'string') {
            processedData.config.firstLeg.expectedOutput =
                processedData.config.firstLeg.expectedOutput.toString();
        }

        if (processedData.config?.secondLeg?.expectedOutput &&
            typeof processedData.config.secondLeg.expectedOutput !== 'string') {
            processedData.config.secondLeg.expectedOutput =
                processedData.config.secondLeg.expectedOutput.toString();
        }

        // Ensure profit is a string value
        if (processedData.result && processedData.result.profit &&
            typeof processedData.result.profit !== 'string') {
            processedData.result.profit = processedData.result.profit.toString();
        }

        // Ensure finalBalance and accountBalance are consistent
        if (processedData.result) {
            // Convert to string if needed
            if (processedData.result.finalBalance &&
                typeof processedData.result.finalBalance !== 'string') {
                processedData.result.finalBalance = processedData.result.finalBalance.toString();
            }

            if (processedData.result.accountBalance &&
                typeof processedData.result.accountBalance !== 'string') {
                processedData.result.accountBalance = processedData.result.accountBalance.toString();
            }

            // If accountBalance is missing but finalBalance is available, use that
            if (!processedData.result.accountBalance && processedData.result.finalBalance) {
                processedData.result.accountBalance = processedData.result.finalBalance;
            }

            // If finalBalance is missing but accountBalance is available, use that
            if (!processedData.result.finalBalance && processedData.result.accountBalance) {
                processedData.result.finalBalance = processedData.result.accountBalance;
            }
        }

        // Fix trade balance information
        if (processedData.result && processedData.result.tradeContext) {
            // Ensure trade input amount is consistent
            if (!processedData.result.tradeContext.tradeInputAmount && processedData.config?.inputAmount) {
                processedData.result.tradeContext.tradeInputAmount = processedData.config.inputAmount;
            }

            // Ensure trade final balance is consistent
            if (!processedData.result.tradeContext.tradeFinalBalance && processedData.result.finalBalance) {
                processedData.result.tradeContext.tradeFinalBalance = processedData.result.finalBalance;
            }
        }

        // For WBTC trades, ensure token symbols are properly set
        if (processedData.tokenPair === 'USDC-WBTC') {
            // Create sourceToken and targetToken properties if not present
            if (!processedData.sourceToken) {
                processedData.sourceToken = 'USDC';
            }

            if (!processedData.targetToken) {
                processedData.targetToken = 'BTC.b';
            }

            // If tokens array is present, ensure the WBTC entry has correct symbol
            if (processedData.result && processedData.result.tokensTraded) {
                const tokens = processedData.result.tokensTraded;
                if (tokens.firstLeg && tokens.firstLeg.output) {
                    tokens.firstLeg.output.symbol = 'BTC.b';
                }

                if (tokens.secondLeg && tokens.secondLeg.input) {
                    tokens.secondLeg.input.symbol = 'BTC.b';
                }
            }
        }

    } catch (error) {
        console.error('Error preprocessing transaction data:', error);
    }

    return processedData;
}
/**
 * Calculate profit based on input amount and final balance
 * Updated to handle both WAVAX and WBTC token pairs
 *
 * @param amountIn The input amount as a string
 * @param finalBalance The final balance as a string
 * @param tokenSymbol Optional token symbol for decimal precision (defaults to USDC)
 * @returns Profit amount as a string
 */
function calculateProfit(amountIn: string, finalBalance: string, tokenSymbol: string = 'USDC'): string {
    try {
        // Handle empty or invalid inputs
        if (!amountIn || !finalBalance ||
            amountIn === 'NULL' || finalBalance === 'NULL' ||
            amountIn === 'N/A' || finalBalance === 'N/A') {
            return "0";
        }

        // Determine token decimals for proper BigInt handling
        let decimals: number;
        switch (tokenSymbol) {
            case 'USDC':
                decimals = 6; // USDC has 6 decimals
                break;
            case 'BTC.b':
            case 'WBTC':
                decimals = 8; // Bitcoin tokens have 8 decimals
                break;
            case 'WAVAX':
            default:
                decimals = 18; // WAVAX and most ERC20 tokens have 18 decimals
                break;
        }

        // Check if inputs are already in decimal format
        if (amountIn.includes('.') || finalBalance.includes('.')) {
            // Handle decimal values by converting to fixed point first
            const inputDecimal = parseFloat(amountIn);
            const finalDecimal = parseFloat(finalBalance);

            // Calculate profit as floating point
            const profitDecimal = finalDecimal - inputDecimal;

            // Convert to string with appropriate decimal precision
            return profitDecimal.toFixed(tokenSymbol === 'USDC' ? 6 :
                (tokenSymbol === 'BTC.b' || tokenSymbol === 'WBTC') ? 8 : 18);
        }

        // If inputs are in raw format (integer with implied decimal)
        // Convert to BigInt for exact arithmetic
        let inputAmount: bigint;
        let finalBalanceAmount: bigint;

        try {
            // Normal case - positive values
            inputAmount = safeBigInt(amountIn);
            finalBalanceAmount = safeBigInt(finalBalance);
        } catch (error) {
            // Fallback to float calculation if BigInt conversion fails
            console.warn(`BigInt conversion failed, falling back to float calculation: ${error}`);

            // Parse as float and convert to implied decimal format based on token
            const inputFloat = parseFloat(amountIn);
            const finalFloat = parseFloat(finalBalance);

            // Calculate profit
            const profitFloat = finalFloat - inputFloat;

            // Return as string
            return profitFloat.toString();
        }

        // Calculate profit using BigInt arithmetic
        const profit = finalBalanceAmount - inputAmount;

        // If token is known, properly format the result
        if (tokenSymbol) {
            return profit.toString();
        }

        // Default return the raw BigInt difference
        return profit.toString();
    } catch (error) {
        console.warn(`Error calculating profit: ${error}`, {
            amountIn,
            finalBalance,
            tokenSymbol
        });
        return "0";
    }
}

/**
 * Calculate profit percentage based on input amount and final balance
 * Updated to handle both WAVAX and WBTC token pairs
 *
 * @param amountIn The input amount as a string
 * @param finalBalance The final balance as a string
 * @param tokenSymbol Optional token symbol for decimal precision (defaults to USDC)
 * @returns Profit percentage as a number
 */
function calculateProfitPercent(amountIn: string, finalBalance: string, tokenSymbol: string = 'USDC'): number {
    try {
        // Handle empty or invalid inputs
        if (!amountIn || !finalBalance ||
            amountIn === 'NULL' || finalBalance === 'NULL' ||
            amountIn === 'N/A' || finalBalance === 'N/A') {
            return 0;
        }

        // Check if inputs are in decimal format
        if (amountIn.includes('.') || finalBalance.includes('.')) {
            // Handle decimal inputs
            const inputDecimal = parseFloat(amountIn);
            const finalDecimal = parseFloat(finalBalance);

            if (inputDecimal === 0) return 0; // Avoid division by zero

            // Calculate profit percentage
            return ((finalDecimal - inputDecimal) / inputDecimal) * 100;
        }

        // Determine token decimals
        let decimals: number;
        switch (tokenSymbol) {
            case 'USDC':
                decimals = 6;
                break;
            case 'BTC.b':
            case 'WBTC':
                decimals = 8;
                break;
            case 'WAVAX':
            default:
                decimals = 18;
                break;
        }

        // Convert to BigInt for exact arithmetic
        const inputAmount = safeBigInt(amountIn);
        const finalBalanceAmount = safeBigInt(finalBalance);

        // Calculate profit
        const profit = finalBalanceAmount - inputAmount;

        // Calculate percentage (multiply by 10000 for 2 decimal places of precision)
        if (inputAmount === 0n) return 0; // Avoid division by zero

        // Use this approach to get a percentage with 2 decimal places of precision
        const profitPercent = Number((profit * 10000n) / inputAmount) / 100;

        // Cap at reasonable values (in case of extreme values causing issues)
        if (!isFinite(profitPercent) || Math.abs(profitPercent) > 10000) {
            console.warn(`Extreme profit percentage calculated: ${profitPercent}%`, {
                amountIn,
                finalBalance,
                profit: profit.toString()
            });
            return Math.sign(profitPercent) * 100; // Cap at ±100%
        }

        return profitPercent;
    } catch (error) {
        console.warn(`Error calculating profit percentage: ${error}`, {
            amountIn,
            finalBalance,
            tokenSymbol
        });
        return 0;
    }
}
/**
 * Main function - updated to handle both WAVAX and WBTC token pairs
 */
async function main() {
    const { hashes, options, dataFiles } = parseOptions();

    if (hashes.length === 0 && (!dataFiles || dataFiles.length === 0)) {
        console.error('Please provide at least one transaction hash or data file');
        console.error('Usage: ts-node analyzeQuoteAccuracy.ts <tx_hash1> <tx_hash2> ... <tx_hash_n> [options]');
        console.error('Options:');
        console.error('  --json                   Generate JSON output');
        console.error('  --csv                    Generate CSV output');
        console.error('  --summary                Show only summary, not transaction details');
        console.error('  --detailed               Show transaction details');
        console.error('  --verbose                Show additional debug information');
        console.error('  --no-suggested-code      Don\'t generate suggested code files');
        console.error('  --no-smoothing           Don\'t apply smoothing to adjustment factors');
        console.error('  --no-outlier-adjustment  Don\'t filter outliers');
        console.error('  --output=<dir>           Output directory (default: ./quote_accuracy_analysis)');
        console.error('  --avax-price=<number>    AVAX price in USD (default: 17)');
        console.error('  --batch-size=<number>    Process batch size (default: 3)');
        console.error('  --smoothing=<factor>     Smoothing factor (0-1, default: 0.15)');
        console.error('  --confidence=<threshold> Confidence threshold (0-1, default: 0.8)');
        console.error('  --min-samples=<count>    Minimum samples for high confidence (default: 10)');
        console.error('  --index=<file>           Transaction index file to read hashes from');
        console.error('  --data-dir=<dir>         Directory with trade data JSON files');
        process.exit(1);
    }

    try {
        // Get the current AVAX price from the quoter
        let avaxPrice = options.avaxPrice; // Default value from options
        try {
            const dynamicPrice = await wavaxPriceQuoter.getPrice();
            if (dynamicPrice > 0) {
                console.log(`Using current AVAX price: $${dynamicPrice.toFixed(2)} USD`);
                avaxPrice = dynamicPrice;
                // Update the options object for consistent use throughout the code
                options.avaxPrice = avaxPrice;
            } else {
                console.log(`Using default AVAX price: $${avaxPrice} USD (dynamic price unavailable)`);
            }
        } catch (error) {
            console.warn(`Could not get dynamic AVAX price, using default: $${avaxPrice} USD`, error);
        }

        let metrics: AccuracyMetrics[] = [];

        // Process transaction hashes
        if (hashes.length > 0) {
            console.log(`\nAnalyzing ${hashes.length} transactions from hashes...`);
            const txMetrics = await processTransactions(hashes, options);
            metrics = metrics.concat(txMetrics);
        }

        // Process data files
        if (dataFiles && dataFiles.length > 0) {
            console.log(`\nAnalyzing ${dataFiles.length} trade data files...`);
            const fileMetrics = await processTradeDataFiles(dataFiles, options);
            metrics = metrics.concat(fileMetrics);
        }

        console.log(`\nSuccessfully processed ${metrics.length} transactions`);

        if (metrics.length === 0) {
            console.error('No valid transactions to analyze');
            process.exit(1);
        }

        // Calculate summary
        const summary = calculateSummary(metrics, options);

        // Group metrics by token pair for separate analysis
        const wavaxMetrics = metrics.filter(m => m.tokenPair === 'USDC-WAVAX');
        const wbtcMetrics = metrics.filter(m => m.tokenPair === 'USDC-WBTC');
        const unknownPairMetrics = metrics.filter(m => m.tokenPair === 'unknown' || !m.tokenPair);

        // Print summary report
        printAccuracyReport(metrics, summary);

        // Log token pair distribution
        console.log('\nToken Pair Distribution:');
        console.log(`  USDC-WAVAX: ${wavaxMetrics.length} transactions`);
        console.log(`  USDC-WBTC: ${wbtcMetrics.length} transactions`);
        console.log(`  Unknown: ${unknownPairMetrics.length} transactions`);

        // Generate output files
        const outputDir = options.outputDir;

        // Generate JSON output
        if (options.json) {
            const metricsJson = JSON.stringify(metrics, (key, value) => {
                // Handle bigint serialization
                if (typeof value === 'bigint') return value.toString();
                return value;
            }, 2);

            fs.writeFileSync(path.join(outputDir, 'metrics.json'), metricsJson);

            const summaryJson = JSON.stringify(summary, (key, value) => {
                if (typeof value === 'bigint') return value.toString();
                return value;
            }, 2);

            fs.writeFileSync(path.join(outputDir, 'summary.json'), summaryJson);

            // Generate token pair specific metrics files if they exist
            if (wavaxMetrics.length > 0) {
                const wavaxJson = JSON.stringify(wavaxMetrics, (key, value) => {
                    if (typeof value === 'bigint') return value.toString();
                    return value;
                }, 2);
                fs.writeFileSync(path.join(outputDir, 'wavax_metrics.json'), wavaxJson);
            }

            if (wbtcMetrics.length > 0) {
                const wbtcJson = JSON.stringify(wbtcMetrics, (key, value) => {
                    if (typeof value === 'bigint') return value.toString();
                    return value;
                }, 2);
                fs.writeFileSync(path.join(outputDir, 'wbtc_metrics.json'), wbtcJson);
            }

            console.log(`\nJSON files generated in: ${outputDir}`);
        }

        // Generate CSV output
        if (options.csv) {
            generateCSV(metrics, path.join(outputDir, 'metrics.csv'));

            // Generate token pair specific CSV files if they exist
            if (wavaxMetrics.length > 0) {
                generateCSV(wavaxMetrics, path.join(outputDir, 'wavax_metrics.csv'));
            }

            if (wbtcMetrics.length > 0) {
                generateCSV(wbtcMetrics, path.join(outputDir, 'wbtc_metrics.csv'));
            }
        }

        // Generate suggested code if requested
        if (options.writeSuggestedCode) {
            generateSuggestedCode(summary, outputDir);
        }

        // Print next steps
        console.log('\nNext Steps:');
        console.log('1. Review the adjustment factors and determine which to implement');
        console.log('2. Copy the suggested code to your project');
        console.log('3. Modify your quoter files to use the adjustment factors');
        console.log('4. Run more tests to validate the improvement');

        console.log('\nSuggested Implementation:');

        // WAVAX specific adjustment factors
        console.log('\nFor USDC-WAVAX:');
        console.log('In quoterUniswap.ts:');
        console.log(`const ADJUSTMENT_FACTOR_USDC_TO_WAVAX = ${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wavax.uniswap.firstLeg.confidence} confidence`);
        console.log(`const ADJUSTMENT_FACTOR_WAVAX_TO_USDC = ${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wavax.uniswap.secondLeg.confidence} confidence`);

        console.log('\nIn quoterTraderJoe.ts:');
        console.log(`const ADJUSTMENT_FACTOR_USDC_TO_WAVAX = ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.firstLeg.confidence} confidence`);
        console.log(`const ADJUSTMENT_FACTOR_WAVAX_TO_USDC = ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wavax.traderjoe.secondLeg.confidence} confidence`);

        // WBTC specific adjustment factors
        console.log('\nFor USDC-WBTC:');
        console.log('In quoterUniswap.ts:');
        console.log(`const ADJUSTMENT_FACTOR_USDC_TO_WBTC = ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.firstLeg.confidence} confidence`);
        console.log(`const ADJUSTMENT_FACTOR_WBTC_TO_USDC = ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wbtc.uniswap.secondLeg.confidence} confidence`);

        console.log('\nIn quoterTraderJoe.ts:');
        console.log(`const ADJUSTMENT_FACTOR_USDC_TO_WBTC = ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.firstLeg.confidence} confidence`);
        console.log(`const ADJUSTMENT_FACTOR_WBTC_TO_USDC = ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.factor.toFixed(4)}; // ${summary.tokenPairAdjustmentFactors.wbtc.traderjoe.secondLeg.confidence} confidence`);

        console.log('\nThen in your quote function, multiply the expected output based on token pair:');
        console.log('const adjustedExpectedOutput = (parseFloat(expectedOutput) * getAdjustmentFactorForPair(direction)).toString();');

        console.log('\nExample implementation for token-pair specific adjustment:');
        console.log(`
function getAdjustmentFactorForPair(direction: 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC'): number {
    // Determine token pair and direction
    const isWbtcPair = direction.includes('WBTC');
    const isFirstLeg = direction.startsWith('USDC->');
    
    // Return the appropriate adjustment factor
    if (isWbtcPair) {
        return isFirstLeg ? ADJUSTMENT_FACTOR_USDC_TO_WBTC : ADJUSTMENT_FACTOR_WBTC_TO_USDC;
    } else {
        return isFirstLeg ? ADJUSTMENT_FACTOR_USDC_TO_WAVAX : ADJUSTMENT_FACTOR_WAVAX_TO_USDC;
    }
}`);

    } catch (error) {
        console.error('Error processing transactions:', error);
        process.exit(1);
    }
}

// Run the main function
main().catch(console.error);

