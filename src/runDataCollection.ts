// src/runDataCollection.ts
// Updated for Balancer flash loan implementation and WBTC support

import { getQuote as getUniswapQuote } from './quoterUniswap';
import { getQuote as getTraderJoeQuote } from './quoterTraderJoe';
import { SmartContractService } from './services/smartContractService';
import { FlashLoanService } from './services/flashLoanService';
import { getErrorMessage, sleep } from './utils';
import { ADDRESSES, TOKEN_CONFIGS } from './constants';
import logger from './logger';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type {
    DexType,
    SwapCheckpoint as ContractSwapCheckpoint,
    ArbitrageConfig
} from './tradeTypes';

dotenv.config();

// Extend the SwapCheckpoint interface from tradeTypes to ensure compatibility
interface SwapCheckpoint extends Omit<ContractSwapCheckpoint, 'token'> {
    token: string;          // Allow string type for token to be more flexible
    accountTotalBalance?: string; // Add the account total balance property
    stage: string;          // The execution stage (BeforeFirstSwap, AfterFirstSwap, etc.)
    actualBalance: string;  // The actual balance at the checkpoint
    expectedBalance: string; // The expected balance (if available)
    timestamp: string;      // When the checkpoint was recorded
    difference: string;     // The difference between actual and expected
}

// Define supported token pairs
type TokenPair = 'USDC-WAVAX' | 'USDC-WBTC';

// Support multiple trading directions with both token pairs
type TradeDirection =
    'uniswap-to-traderjoe-wavax' |
    'traderjoe-to-uniswap-wavax' |
    'uniswap-to-traderjoe-wbtc' |
    'traderjoe-to-uniswap-wbtc';

// Configuration
const CONFIG = {
    // WAVAX trading configuration
    wavaxTrades: {
        uniToJoeCount: 2,    // Number of uniswap-to-traderjoe WAVAX trades to execute
        joeToUniCount: 2,    // Number of traderjoe-to-uniswap WAVAX trades to execute
    },
    // WBTC trading configuration
    wbtcTrades: {
        uniToJoeCount: 2,    // Number of uniswap-to-traderjoe WBTC trades to execute
        joeToUniCount: 2,    // Number of traderjoe-to-uniswap WBTC trades to execute
    },
    baseAmountUsdc: '1.5',   // Base trade amount in USDC
    amountVariation: true,   // Randomly vary the amount
    variationPercent: 2,     // Variation percentage (e.g., 5 = ±5%)
    delayBetweenTrades: 10000, // 10 seconds between trades
    outputDir: './trade_data', // Output directory
    testMode: true,          // Allow negative profits
    retryAttempts: 3,        // Number of retry attempts per trade
    flashLoanFeeBps: ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS || 0, // Balancer flash loan fee in basis points (0%)
};

// Utility function to get a varied amount
function getVariedAmount(baseAmount: string, variationPercent: number): string {
    if (variationPercent <= 0) return baseAmount;

    const base = parseFloat(baseAmount);
    const variation = base * (variationPercent / 100);
    const randomFactor = (Math.random() * 2 - 1) * variation;
    const finalAmount = base + randomFactor;
    const minAmount = Math.max(finalAmount, 0.5); // Minimum 0.5 USDC trade

    return minAmount.toFixed(6);
}

/**
 * Get quote directions based on token pair
 * @param tokenPair The token pair to trade
 * @returns Quote directions for first and second legs
 */
function getQuoteDirections(tokenPair: TokenPair): {
    firstLeg: 'USDC->WAVAX' | 'USDC->WBTC',
    secondLeg: 'WAVAX->USDC' | 'WBTC->USDC'
} {
    if (tokenPair === 'USDC-WAVAX') {
        return {
            firstLeg: 'USDC->WAVAX',
            secondLeg: 'WAVAX->USDC'
        };
    } else { // USDC-WBTC
        return {
            firstLeg: 'USDC->WBTC',
            secondLeg: 'WBTC->USDC'
        };
    }
}

/**
 * Determine token pair from trade direction
 * @param direction The trade direction
 * @returns The token pair involved in the trade
 */
function getTokenPairFromDirection(direction: TradeDirection): TokenPair {
    if (direction.endsWith('wavax')) {
        return 'USDC-WAVAX';
    } else {
        return 'USDC-WBTC';
    }
}

/**
 * Get DEX direction from trade direction
 * @param direction The full trade direction including token info
 * @returns The basic DEX direction without token info
 */
function getDexDirection(direction: TradeDirection): 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap' {
    if (direction.startsWith('uniswap-to-traderjoe')) {
        return 'uniswap-to-traderjoe';
    } else {
        return 'traderjoe-to-uniswap';
    }
}

/**
 * Get target token config based on token pair
 * @param tokenPair The token pair
 * @returns Target token config (WAVAX or WBTC)
 */
function getTargetToken(tokenPair: TokenPair) {
    return tokenPair === 'USDC-WAVAX' ? TOKEN_CONFIGS.WAVAX : TOKEN_CONFIGS.WBTC;
}

// Execute a single trade and collect data
async function executeTradeAndCollectData(
    direction: TradeDirection,
    amount: string,
    smartContractService: SmartContractService,
    flashLoanService: FlashLoanService,
): Promise<boolean> {
    // Extract basic DEX direction and token pair from trade direction
    const dexDirection = getDexDirection(direction);
    const tokenPair = getTokenPairFromDirection(direction);
    const quoteDirections = getQuoteDirections(tokenPair);
    const targetToken = getTargetToken(tokenPair);

    const tradeId = `${dexDirection}_${tokenPair.replace('-', '_').toLowerCase()}_${Date.now()}`;
    // Always use flash loans as it's the only supported method now
    const useFlashLoan = true;

    logger.info(`Starting data collection trade: ${tradeId}`, {
        direction: dexDirection,
        tokenPair,
        amount,
        testMode: CONFIG.testMode
    });

    try {
        // Get contract address
        const contractAddress = smartContractService.getContractAddress();

        // Determine quote functions based on direction
        const getFirstLegQuote = dexDirection === 'uniswap-to-traderjoe' ? getUniswapQuote : getTraderJoeQuote;
        const getSecondLegQuote = dexDirection === 'uniswap-to-traderjoe' ? getTraderJoeQuote : getUniswapQuote;

        // Get quotes with the correct token directions
        const firstLegQuote = await getFirstLegQuote(quoteDirections.firstLeg, amount, contractAddress);
        if (!firstLegQuote) {
            logger.error(`Failed to get first leg quote for ${dexDirection} with ${tokenPair}`, { amount });
            return false;
        }

        // Get second leg quote
        const secondLegQuote = await getSecondLegQuote(quoteDirections.secondLeg, firstLegQuote.expectedOutput, contractAddress);
        if (!secondLegQuote) {
            logger.error(`Failed to get second leg quote for ${dexDirection} with ${tokenPair}`, { amount });
            return false;
        }

        // Calculate expected profit and flash loan fee
        const inputAmount = parseFloat(amount);
        const expectedOutput = parseFloat(secondLegQuote.expectedOutput);
        const expectedProfit = expectedOutput - inputAmount;
        const flashLoanFee = useFlashLoan ? (inputAmount * CONFIG.flashLoanFeeBps / 10000) : 0;
        const netProfit = expectedProfit - flashLoanFee;

        // Log expected outputs for debugging
        logger.info('Quote details', {
            direction: dexDirection,
            tokenPair,
            inputAmount: amount,
            firstLegExpectedOutput: firstLegQuote.expectedOutput,
            secondLegExpectedOutput: secondLegQuote.expectedOutput,
            expectedProfit: expectedProfit.toFixed(6),
            useFlashLoan,
            flashLoanFee: flashLoanFee.toFixed(6),
            netProfit: netProfit.toFixed(6)
        });

        // Build the arbitrage configuration with expected outputs included
        const config: ArbitrageConfig = {
            startDex: dexDirection === 'uniswap-to-traderjoe' ? 'uniswap' as DexType : 'traderjoe' as DexType,
            endDex: dexDirection === 'uniswap-to-traderjoe' ? 'traderjoe' as DexType : 'uniswap' as DexType,
            inputAmount: amount,
            quoteTimestamp: Math.floor(Date.now() / 1000),
            simulatedTradeData: {
                firstLeg: firstLegQuote,
                secondLeg: secondLegQuote
            },
            testMode: CONFIG.testMode
        };

        // Always use flash loan arbitrage as this is now the only supported method
        console.log(`Executing flash loan arbitrage (${dexDirection} with ${tokenPair})...`);
        const result = await flashLoanService.executeFlashLoanArbitrage(config);

        const timestamp = Math.floor(Date.now() / 1000);

        // Log result details - enhanced to include both account and trade-specific balances
        if (result.success) {
            const profitValue = result.profit || '0';
            const flashLoanFeeValue = result.flashLoanFee || '0';
            const netProfitValue = result.netProfit || (useFlashLoan ?
                (parseFloat(profitValue) - parseFloat(flashLoanFeeValue)).toFixed(6) :
                profitValue);

            logger.info(`Trade ${tradeId} executed successfully`, {
                transactionHash: result.firstLegHash,
                profit: profitValue,
                flashLoanFee: useFlashLoan ? flashLoanFeeValue : 'N/A',
                netProfit: useFlashLoan ? netProfitValue : 'N/A',
                finalBalance: result.finalBalance,
                accountBalance: result.accountBalance, // Log account-wide balance
                tradeInputAmount: result.tradeContext?.tradeInputAmount.toString() || 'N/A',
                tradeFinalBalance: result.tradeContext?.tradeFinalBalance.toString() || 'N/A',
                checkpoints: result.swapCheckpoints?.length || 0
            });

            // Extract and log swap checkpoint data for analysis
            if (result.swapCheckpoints && result.swapCheckpoints.length > 0) {
                for (const checkpoint of result.swapCheckpoints) {
                    // Create a safe version of the checkpoint data, handling optional accountTotalBalance
                    const checkpointData = {
                        tradeId,
                        stage: checkpoint.stage,
                        token: checkpoint.token,
                        actualBalance: checkpoint.actualBalance,
                        expectedBalance: checkpoint.expectedBalance,
                        difference: checkpoint.difference,
                        // Only include accountTotalBalance if it exists
                        ...(('accountTotalBalance' in checkpoint) ?
                            { accountTotalBalance: checkpoint.accountTotalBalance } : {})
                    };

                    logger.debug('Swap checkpoint data', checkpointData);
                }
            }

            // Extract and log trade context data if available
            if (result.tradeContext) {
                logger.debug('Trade context data', {
                    tradeId,
                    tradeInputAmount: result.tradeContext.tradeInputAmount.toString(),
                    tradeFinalBalance: result.tradeContext.tradeFinalBalance.toString(),
                    expectedFirstOutput: result.tradeContext.expectedFirstOutput.toString(),
                    actualFirstOutput: result.tradeContext.actualFirstOutput.toString(),
                    expectedSecondOutput: result.tradeContext.expectedSecondOutput.toString(),
                    actualSecondOutput: result.tradeContext.actualSecondOutput.toString()
                });
            }

            // Create directories if they don't exist
            const dirPath = path.join(CONFIG.outputDir, 'raw_trades');
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            // Prepare enhanced data object with trade-specific balances and flash loan data
            const enhancedTradeData = {
                id: tradeId,
                timestamp,
                direction: dexDirection,
                tokenPair,
                useFlashLoan,
                config: {
                    startDex: config.startDex,
                    endDex: config.endDex,
                    inputAmount: amount,
                    testMode: CONFIG.testMode,
                    firstLeg: {
                        dex: config.startDex,
                        expectedOutput: firstLegQuote.expectedOutput,
                        priceImpact: firstLegQuote.priceImpact,
                        formattedPrice: firstLegQuote.formattedPrice,
                        routerAddress: firstLegQuote.routerAddress,
                        poolAddress: firstLegQuote.poolAddress,
                        fee: firstLegQuote.fee
                    },
                    secondLeg: {
                        dex: config.endDex,
                        expectedOutput: secondLegQuote.expectedOutput,
                        priceImpact: secondLegQuote.priceImpact,
                        formattedPrice: secondLegQuote.formattedPrice,
                        routerAddress: secondLegQuote.routerAddress,
                        poolAddress: secondLegQuote.poolAddress,
                        fee: secondLegQuote.fee
                    }
                },
                expectedProfit: expectedProfit.toFixed(6),
                flashLoanDetails: useFlashLoan ? {
                    flashLoanFee: flashLoanFee.toFixed(6),
                    netProfit: netProfit.toFixed(6),
                    feeBps: CONFIG.flashLoanFeeBps
                } : null,
                result: {
                    success: result.success,
                    transactionHash: result.firstLegHash,
                    profit: profitValue,
                    finalBalance: result.finalBalance,
                    accountBalance: result.accountBalance, // Include account-wide balance
                    flashLoanFee: useFlashLoan ? flashLoanFeeValue : null,
                    netProfit: useFlashLoan ? netProfitValue : null,
                    swapCheckpoints: result.swapCheckpoints as SwapCheckpoint[], // Cast to our defined type
                    validationCheckpoints: result.validationCheckpoints,
                    gasUsed: result.gasUsed,
                    effectiveGasPrice: result.effectiveGasPrice,
                    tradeContext: result.tradeContext ? {
                        tradeInputAmount: result.tradeContext.tradeInputAmount.toString(),
                        tradeFinalBalance: result.tradeContext.tradeFinalBalance.toString(),
                        expectedFirstOutput: result.tradeContext.expectedFirstOutput.toString(),
                        actualFirstOutput: result.tradeContext.actualFirstOutput.toString(),
                        expectedSecondOutput: result.tradeContext.expectedSecondOutput.toString(),
                        actualSecondOutput: result.tradeContext.actualSecondOutput.toString()
                    } : null,
                    firstLegOutput: result.firstLegOutput,
                    secondLegOutput: result.secondLegOutput
                }
            };

            // Write detailed data to JSON file
            const dataPath = path.join(dirPath, `${tradeId}.json`);
            fs.writeFileSync(dataPath, JSON.stringify(enhancedTradeData, null, 2));

            // Add transaction to index file with enhanced data
            const indexPath = path.join(CONFIG.outputDir, 'transaction_index.csv');
            const indexExists = fs.existsSync(indexPath);

            // Include account balance vs trade balance in the index
            const tradeBalance = result.tradeContext?.tradeFinalBalance.toString() || 'N/A';
            const accountBalance = result.accountBalance || 'N/A';
            // Include flash loan specific metrics in the index
            const flashLoanFeeColumn = useFlashLoan ? flashLoanFeeValue : 'N/A';
            const netProfitColumn = useFlashLoan ? netProfitValue : 'N/A';

            const indexLine = `${tradeId},${dexDirection},${tokenPair},${timestamp},${result.firstLegHash || 'NULL'},${result.success ? 'success' : 'failed'},${useFlashLoan ? 'flash_loan' : 'regular'},${profitValue},${tradeBalance},${accountBalance},${flashLoanFeeColumn},${netProfitColumn},${dataPath}\n`;

            if (!indexExists) {
                // Create the index file with headers - ensure columns match the data in indexLine
                fs.writeFileSync(indexPath, 'trade_id,direction,token_pair,timestamp,tx_hash,status,execution_type,profit,trade_balance,account_balance,flash_loan_fee,net_profit,data_file\n' + indexLine);
            } else {
                // Append to the existing index
                fs.appendFileSync(indexPath, indexLine);
            }

            logger.info(`Trade data stored to ${dataPath}`);
            console.log(`Successfully executed ${dexDirection} trade with ${tokenPair}: ${result.firstLegHash}`);
            return true;
        } else {
            logger.warn(`Trade ${tradeId} failed`, {
                direction: dexDirection,
                tokenPair,
                error: result.error,
                errorType: result.errorType,
                useFlashLoan
            });
            return false;
        }
    } catch (error) {
        logger.error(`Error executing trade`, {
            direction: dexDirection,
            tokenPair,
            amount,
            error: getErrorMessage(error)
        });
        return false;
    }
}

// Main function - updated to initialize the flash loan service
async function main() {
    console.log(`
=========================================
ENHANCED ARBITRAGE DATA COLLECTION
=========================================
Collecting data to improve quote accuracy
----------------------------------------
WAVAX Trading:
  Uniswap->TraderJoe Trades: ${CONFIG.wavaxTrades.uniToJoeCount}
  TraderJoe->Uniswap Trades: ${CONFIG.wavaxTrades.joeToUniCount}

WBTC Trading:
  Uniswap->TraderJoe Trades: ${CONFIG.wbtcTrades.uniToJoeCount}
  TraderJoe->Uniswap Trades: ${CONFIG.wbtcTrades.joeToUniCount}

Base Amount: ${CONFIG.baseAmountUsdc} USDC
Test Mode: ${CONFIG.testMode ? 'ENABLED' : 'DISABLED'}
Flash Loans: ENABLED (Only Method)
Flash Loan Fee: ${CONFIG.flashLoanFeeBps/100}%
Output Directory: ${CONFIG.outputDir}
=========================================
`);

    try {
        // Initialize the smart contract service
        if (!process.env.PRIVATE_KEY || !process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables');
        }

        const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
            ? (process.env.PRIVATE_KEY as `0x${string}`)
            : (`0x${process.env.PRIVATE_KEY}` as `0x${string}`);

        const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as `0x${string}`;

        // Initialize services
        const smartContractService = new SmartContractService(privateKey, contractAddress);
        const flashLoanService = new FlashLoanService(
            smartContractService,
            ADDRESSES.BALANCER_V2.POOL as `0x${string}`
        );

        // Create output directory if it doesn't exist
        if (!fs.existsSync(CONFIG.outputDir)) {
            fs.mkdirSync(CONFIG.outputDir, { recursive: true });
        }

        // Initialize counters
        let wavaxStats = {
            uniToJoeCompleted: 0,
            joeToUniCompleted: 0
        };

        let wbtcStats = {
            uniToJoeCompleted: 0,
            joeToUniCompleted: 0
        };

        let successCount = 0;
        let failureCount = 0;
        let flashLoanCount = 0;

        // Execute trades until we reach the desired counts for both token pairs
        while (
            wavaxStats.uniToJoeCompleted < CONFIG.wavaxTrades.uniToJoeCount ||
            wavaxStats.joeToUniCompleted < CONFIG.wavaxTrades.joeToUniCount ||
            wbtcStats.uniToJoeCompleted < CONFIG.wbtcTrades.uniToJoeCount ||
            wbtcStats.joeToUniCompleted < CONFIG.wbtcTrades.joeToUniCount
            ) {
            // Determine which token pair and direction to trade next
            let tradeDirection: TradeDirection;

            // Check if WAVAX trades are complete
            const wavaxComplete =
                wavaxStats.uniToJoeCompleted >= CONFIG.wavaxTrades.uniToJoeCount &&
                wavaxStats.joeToUniCompleted >= CONFIG.wavaxTrades.joeToUniCount;

            // Check if WBTC trades are complete
            const wbtcComplete =
                wbtcStats.uniToJoeCompleted >= CONFIG.wbtcTrades.uniToJoeCount &&
                wbtcStats.joeToUniCompleted >= CONFIG.wbtcTrades.joeToUniCount;

            if (wavaxComplete && !wbtcComplete) {
                // Only WBTC trades left
                if (wbtcStats.uniToJoeCompleted < CONFIG.wbtcTrades.uniToJoeCount) {
                    tradeDirection = 'uniswap-to-traderjoe-wbtc';
                } else {
                    tradeDirection = 'traderjoe-to-uniswap-wbtc';
                }
            } else if (!wavaxComplete && wbtcComplete) {
                // Only WAVAX trades left
                if (wavaxStats.uniToJoeCompleted < CONFIG.wavaxTrades.uniToJoeCount) {
                    tradeDirection = 'uniswap-to-traderjoe-wavax';
                } else {
                    tradeDirection = 'traderjoe-to-uniswap-wavax';
                }
            } else {
                // Both token pairs need trades - alternate between them
                const useWavax = Math.random() > 0.5;

                if (useWavax) {
                    if (wavaxStats.uniToJoeCompleted < CONFIG.wavaxTrades.uniToJoeCount) {
                        tradeDirection = 'uniswap-to-traderjoe-wavax';
                    } else {
                        tradeDirection = 'traderjoe-to-uniswap-wavax';
                    }
                } else {
                    if (wbtcStats.uniToJoeCompleted < CONFIG.wbtcTrades.uniToJoeCount) {
                        tradeDirection = 'uniswap-to-traderjoe-wbtc';
                    } else {
                        tradeDirection = 'traderjoe-to-uniswap-wbtc';
                    }
                }
            }

            // Get amount with variation if enabled
            const amount = CONFIG.amountVariation
                ? getVariedAmount(CONFIG.baseAmountUsdc, CONFIG.variationPercent)
                : CONFIG.baseAmountUsdc;

            // All trades now use flash loans
            const willUseFlashLoan = true;

            // Extract token pair for logging
            const tokenPair = getTokenPairFromDirection(tradeDirection);
            const dexDirection = getDexDirection(tradeDirection);

            // Execute trade with retries
            let success = false;
            for (let attempt = 1; attempt <= CONFIG.retryAttempts; attempt++) {
                if (attempt > 1) {
                    console.log(`Retry attempt ${attempt} for ${dexDirection} with ${tokenPair} (${willUseFlashLoan ? 'flash loan' : 'regular'})...`);
                    await sleep(CONFIG.delayBetweenTrades / 2); // Shorter delay for retries
                }

                success = await executeTradeAndCollectData(tradeDirection, amount, smartContractService, flashLoanService);
                if (success) break;
            }

            // Update counters based on token pair and direction
            if (tokenPair === 'USDC-WAVAX') {
                if (dexDirection === 'uniswap-to-traderjoe') {
                    wavaxStats.uniToJoeCompleted++;
                } else {
                    wavaxStats.joeToUniCompleted++;
                }
            } else { // USDC-WBTC
                if (dexDirection === 'uniswap-to-traderjoe') {
                    wbtcStats.uniToJoeCompleted++;
                } else {
                    wbtcStats.joeToUniCompleted++;
                }
            }

            if (success) {
                successCount++;
                if (willUseFlashLoan) {
                    flashLoanCount++;
                }
            } else {
                failureCount++;
            }

            // Log progress
            console.log(`
Progress Report:
--------------------------
WAVAX Trading Progress:
  Uniswap->TraderJoe: ${wavaxStats.uniToJoeCompleted}/${CONFIG.wavaxTrades.uniToJoeCount}
  TraderJoe->Uniswap: ${wavaxStats.joeToUniCompleted}/${CONFIG.wavaxTrades.joeToUniCount}

WBTC Trading Progress:
  Uniswap->TraderJoe: ${wbtcStats.uniToJoeCompleted}/${CONFIG.wbtcTrades.uniToJoeCount}
  TraderJoe->Uniswap: ${wbtcStats.joeToUniCompleted}/${CONFIG.wbtcTrades.joeToUniCount}

Success: ${successCount}, Failures: ${failureCount}
All trades using Flash Loans: ${flashLoanCount}
--------------------------
`);

            // Wait before next trade
            const tradesRemaining =
                (CONFIG.wavaxTrades.uniToJoeCount - wavaxStats.uniToJoeCompleted) +
                (CONFIG.wavaxTrades.joeToUniCount - wavaxStats.joeToUniCompleted) +
                (CONFIG.wbtcTrades.uniToJoeCount - wbtcStats.uniToJoeCompleted) +
                (CONFIG.wbtcTrades.joeToUniCount - wbtcStats.joeToUniCompleted);

            if (tradesRemaining > 0) {
                console.log(`Waiting ${CONFIG.delayBetweenTrades/1000} seconds before next trade...`);
                await sleep(CONFIG.delayBetweenTrades);
            }
        }

        // Attempt to shut down services gracefully
        if (flashLoanService.shutdown) {
            await flashLoanService.shutdown();
        }

        console.log(`
=========================================
DATA COLLECTION COMPLETE
=========================================
WAVAX Trades:
  Uniswap->TraderJoe: ${wavaxStats.uniToJoeCompleted}/${CONFIG.wavaxTrades.uniToJoeCount}
  TraderJoe->Uniswap: ${wavaxStats.joeToUniCompleted}/${CONFIG.wavaxTrades.joeToUniCount}

WBTC Trades:
  Uniswap->TraderJoe: ${wbtcStats.uniToJoeCompleted}/${CONFIG.wbtcTrades.uniToJoeCount}
  TraderJoe->Uniswap: ${wbtcStats.joeToUniCompleted}/${CONFIG.wbtcTrades.joeToUniCount}

Total Trades: ${successCount + failureCount}
Successful: ${successCount}
Failed: ${failureCount}
Success Rate: ${(successCount / (successCount + failureCount) * 100).toFixed(1)}%
All trades using Flash Loans: ${flashLoanCount}
=========================================

Next Steps:
1. Run analyzeQuoteAccuracy.ts to analyze the data
2. Implement quote adjustments based on findings
3. Pay special attention to differences between WAVAX and WBTC trades
4. Use the TradeContext data for the most accurate analysis
`);

    } catch (error) {
        console.error('Fatal error:', getErrorMessage(error));
        logger.error('Fatal error in main', { error: getErrorMessage(error) });

        // Try to flush logs before exiting
        await logger.flush?.();
        process.exit(1);
    }
}

// Run the script
main().catch(async (error) => {
    console.error('Uncaught error:', getErrorMessage(error));
    await logger.flush?.();
    process.exit(1);
});