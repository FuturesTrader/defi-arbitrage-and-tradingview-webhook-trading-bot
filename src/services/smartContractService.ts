// src/services/smartContractService.ts
import {
    createPublicClient,
    createWalletClient,
    http,
    decodeEventLog,
    formatUnits,
    decodeErrorResult,
    type Address,
    type TransactionReceipt,
    Hash,
    parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche } from 'viem/chains';
import { TOKEN_CONFIGS, ARBITRAGE_SETTINGS } from '../constants';
import { ARBITRAGE_ABI } from './constants/arbitrageAbi';
import { getErrorMessage, GasTransactionUtility, getBlockchainTime, sleep } from '../utils';
import logger from '../logger';
import type {
    TradeResult,
    ArbitrageExecutedEvent,
    SwapCheckpoint,
    TradeContext
} from '../tradeTypes';

/**
 * Safely parses a string to a bigint, handling negative values properly
 * @param valueStr String value to parse
 * @param decimals Number of decimals
 * @returns Parsed bigint value
 */
function safeParseUnits(valueStr: string, decimals: number): bigint {
    if (!valueStr) return 0n;

    // Parse the value to a float first to handle scientific notation
    const floatValue = parseFloat(valueStr);

    // Check if the value is negative
    if (floatValue < 0) {
        // Convert the absolute value to bigint with decimals and then negate it
        const absValue = Math.abs(floatValue);
        try {
            return -parseUnits(absValue.toString(), decimals);
        } catch (error) {
            logger.error('Error parsing negative value', {
                value: valueStr,
                absValue: absValue.toString(),
                error: getErrorMessage(error)
            });
            // Default to a small negative number to avoid crashing
            return -1n;
        }
    } else {
        // Normal positive or zero case
        try {
            return parseUnits(valueStr, decimals);
        } catch (error) {
            logger.error('Error parsing positive value', {
                value: valueStr,
                error: getErrorMessage(error)
            });
            // Default to zero to avoid crashing
            return 0n;
        }
    }
}

/**
 * Safely formats a bigint to a string, handling negative values properly
 * @param value Bigint value to format
 * @param decimals Number of decimals
 * @returns Formatted string value
 */
function safeFormatUnits(value: bigint, decimals: number): string {
    if (value < 0n) {
        // Handle negative values
        const absValue = -value;
        return '-' + formatUnits(absValue, decimals);
    } else {
        return formatUnits(value, decimals);
    }
}

export class SmartContractService {
    private readonly publicClient;
    private readonly walletClient;
    private readonly account;
    private readonly contractAddress: Address;
    private readonly gasUtility: GasTransactionUtility;
    private readonly MAX_RETRY_ATTEMPTS = ARBITRAGE_SETTINGS.MAX_RETRY_ATTEMPTS;
    private readonly RETRY_DELAY = ARBITRAGE_SETTINGS.RETRY_DELAY;

    constructor(privateKey: string, contractAddress: Address) {
        const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        this.account = privateKeyToAccount(formattedKey as `0x${string}`);

        const transport = http(process.env.AVALANCHE_RPC_URL!);
        this.publicClient = createPublicClient({
            chain: avalanche,
            transport
        });

        this.walletClient = createWalletClient({
            account: this.account,
            chain: avalanche,
            transport
        });

        this.contractAddress = contractAddress;
        this.gasUtility = GasTransactionUtility.getInstance(this.publicClient);

        logger.info('SmartContractService initialized', {
            contractAddress: this.contractAddress,
            walletAddress: this.account.address
        });
    }

    public getWalletAddress(): Address {
        return this.account.address;
    }

    public getContractAddress(): Address {
        return this.contractAddress;
    }

    /**
     * Check if local system time and chain time differ significantly
     */
    public async checkTimeSync(): Promise<{
        systemTime: number;
        blockchainTime: number;
        difference: number;
        isSynchronized: boolean;
    }> {
        try {
            const systemTime = Math.floor(Date.now() / 1000);
            const blockchainTime = await getBlockchainTime(this.publicClient);
            const difference = Math.abs(systemTime - blockchainTime);
            const isSynchronized = difference <= 10;

            if (!isSynchronized) {
                logger.warn('System and blockchain time are not synchronized', {
                    systemTime,
                    blockchainTime,
                    difference,
                    systemTimeISO: new Date(systemTime * 1000).toISOString(),
                    blockchainTimeISO: new Date(blockchainTime * 1000).toISOString()
                });
            }

            return {
                systemTime,
                blockchainTime,
                difference,
                isSynchronized
            };
        } catch (error) {
            logger.error('Error checking time synchronization', {
                error: getErrorMessage(error)
            });
            throw error;
        }
    }

    /**
     * Parse ArbitrageExecuted event from transaction receipt
     * Updated to handle the flash loan event format
     */
    public parseArbitrageEvent(receipt: TransactionReceipt): ArbitrageExecutedEvent | null {
        // Filter logs from our contract
        const contractLogs = receipt.logs.filter(log =>
            log.address.toLowerCase() === this.contractAddress.toLowerCase()
        );
        logger.debug('Parsing receipt for arbitrage event', {
            totalLogs: receipt.logs.length,
            contractLogs: contractLogs.length,
            transactionHash: receipt.transactionHash
        });

        const eventNames: string[] = [];
        let eventData: any = null;

        // 1. Look for "ArbitrageExecuted" events
        for (const log of contractLogs) {
            try {
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: log.data,
                    topics: log.topics
                });
                eventNames.push(decoded.eventName || 'Unknown');
                if (decoded.eventName === 'ArbitrageExecuted') {
                    eventData = decoded.args;
                    break;
                }
            } catch (error) {
                // Skip decoding errors for this log
            }
        }

        // 2. Try parsing FlashLoanEvent events
        if (!eventData) {
            const flashLoanData = this.parseFlashLoanEvents(receipt);
            if (flashLoanData.flashLoanData) {
                // Determine token types based on token address
                const isWbtcToken =
                    flashLoanData.flashLoanData.token.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase();

                // Default to WAVAX if not WBTC
                const intermediateToken = isWbtcToken ?
                    TOKEN_CONFIGS.WBTC.address :
                    TOKEN_CONFIGS.WAVAX.address;

                eventData = {
                    sourceToken: flashLoanData.flashLoanData.token,
                    targetToken: intermediateToken, // Set to appropriate intermediate token
                    tradeInputAmount: flashLoanData.flashLoanData.amount,
                    tradeFinalBalance: flashLoanData.flashLoanData.amount, // Assume break-even for failed loans
                    finalAccountBalance: flashLoanData.flashLoanData.amount,
                    tradeProfit: flashLoanData.flashLoanData.profit || 0n,
                    expectedProfit: 0n, // Not available in failed flash loans
                    testMode: true // Assume testMode for flash loans
                };
                logger.debug('Created synthetic event data from flash loan logs', {
                    token: flashLoanData.flashLoanData.token,
                    intermediateToken,
                    isWbtcToken,
                    amount: flashLoanData.flashLoanData.amount.toString(),
                    profit: (flashLoanData.flashLoanData.profit || 0n).toString()
                });
            }
        }

        // 3. Fallback: use swap checkpoints to compute trade profit
        if (!eventData) {
            logger.warn('No arbitrage event found; attempting fallback from swap checkpoints', {
                transactionHash: receipt.transactionHash,
                foundEvents: eventNames
            });
            const checkpoints = this.parseSwapCheckpoints(receipt);

            // Look for checkpoints to determine input and output
            const beforeFirstSwap = checkpoints.find(cp => cp.stage === 'BeforeFirstSwap');
            const afterSecondSwap = checkpoints.find(cp => cp.stage === 'AfterSecondSwap');

            if (beforeFirstSwap && afterSecondSwap) {
                try {
                    // Get values from checkpoints - SAFELY for potential negative values
                    const inputAmount = BigInt(beforeFirstSwap.actualBalance || '0');
                    const finalBalance = BigInt(afterSecondSwap.actualBalance || '0');

                    // Determine token type based on token address
                    const isWbtcToken = beforeFirstSwap.token.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase();

                    // Default to WAVAX if not WBTC
                    const intermediateToken = isWbtcToken ?
                        TOKEN_CONFIGS.WBTC.address :
                        TOKEN_CONFIGS.WAVAX.address;

                    // Calculate profit - handling potential negative values
                    let profit: bigint;
                    if (finalBalance >= inputAmount) {
                        profit = finalBalance - inputAmount;
                    } else {
                        profit = -(inputAmount - finalBalance);
                    }

                    eventData = {
                        sourceToken: TOKEN_CONFIGS.USDC.address, // Default to USDC for source
                        targetToken: intermediateToken, // Use appropriate intermediate token
                        tradeInputAmount: inputAmount,
                        tradeFinalBalance: finalBalance,
                        finalAccountBalance: finalBalance,
                        tradeProfit: profit,
                        expectedProfit: 0n, // Fallback
                        testMode: false
                    };

                    logger.info('Fallback arbitrage event computed from swap checkpoints', {
                        tradeInputAmount: eventData.tradeInputAmount.toString(),
                        tradeFinalBalance: eventData.tradeFinalBalance.toString(),
                        tradeProfit: eventData.tradeProfit.toString(),
                        intermediateToken,
                        isWbtcToken
                    });
                } catch (error) {
                    logger.error('Error computing fallback arbitrage event from checkpoints', {
                        error: getErrorMessage(error)
                    });
                }
            }
        }

        // 4. Try decoding StateLog events for failures
        if (!eventData) {
            const stateLogs = this.parseStateLogs(receipt);
            if (stateLogs.length > 0) {
                // Check for FlashLoanError events
                const flashLoanError = stateLogs.find(log => log.stage === 'FlashLoanError');
                if (flashLoanError) {
                    logger.info('Found FlashLoanError in StateLog', {
                        errorDetail: flashLoanError.data
                    });

                    eventData = {
                        sourceToken: TOKEN_CONFIGS.USDC.address, // Default to USDC as source
                        targetToken: TOKEN_CONFIGS.WAVAX.address, // Default to WAVAX as target
                        tradeInputAmount: 0n, // Not available
                        tradeFinalBalance: 0n, // Failed, so zero
                        finalAccountBalance: 0n,
                        tradeProfit: 0n, // Failed, so zero
                        expectedProfit: 0n,
                        testMode: true // Assume test mode
                    };
                }
            }
        }

        if (!eventData) {
            logger.warn('No valid arbitrage event found', {
                transactionHash: receipt.transactionHash,
                foundEvents: eventNames
            });
            return null;
        }

        // Map the eventData into the ArbitrageExecutedEvent structure.
        return {
            sourceToken: eventData.sourceToken || '0x0000000000000000000000000000000000000000',
            targetToken: eventData.targetToken || '0x0000000000000000000000000000000000000000',
            amountIn: eventData.tradeInputAmount || 0n,
            finalBalance: eventData.tradeFinalBalance || 0n,
            accountBalance: eventData.finalAccountBalance || 0n,
            profit: eventData.tradeProfit || 0n,
            expectedProfit: eventData.expectedProfit || 0n,
            testMode: eventData.testMode || false,
            tradeProfit: eventData.tradeProfit || 0n,
            tradeFinalBalance: eventData.tradeFinalBalance || 0n,
            finalAccountBalance: eventData.finalAccountBalance || 0n
        };
    }

    /**
     * Get trade context data from transaction receipt
     * @param receipt Transaction receipt
     * @returns Trade context data if available
     */
    public async getTradeContextFromReceipt(receipt: TransactionReceipt): Promise<TradeContext | undefined> {
        try {
            // Try to find executionId from various sources
            let executionId: Hash | undefined;

            // Check for StateLog events first
            const stateLogs = this.parseStateLogs(receipt);
            if (stateLogs.length > 0) {
                // Get the first non-zero executionId
                for (const log of stateLogs) {
                    if (log.executionId && log.executionId !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                        executionId = log.executionId;
                        break;
                    }
                }
            }

            // Check for FlashLoanEvent if no executionId found yet
            if (!executionId) {
                const flashLoanEvents = this.parseFlashLoanEvents(receipt);
                if (flashLoanEvents.flashLoanData?.executionId) {
                    executionId = flashLoanEvents.flashLoanData.executionId;
                }
            }

            // If we found an executionId, proceed with getting trade context
            if (executionId) {
                logger.debug('Found executionId, retrieving trade context', {
                    executionId,
                    transactionHash: receipt.transactionHash
                });

                // Call contract to get trade context
                const context = await this.publicClient.readContract({
                    address: this.contractAddress,
                    abi: ARBITRAGE_ABI,
                    functionName: 'getTradeContext',
                    args: [executionId]
                });

                if (!context) {
                    logger.warn('No trade context returned from contract', {
                        executionId,
                        transactionHash: receipt.transactionHash
                    });
                    return undefined;
                }

                // Convert the returned tuple to a TradeContext object
                return {
                    tradeInputAmount: (context as any)[0] || 0n,
                    tradeFinalBalance: (context as any)[1] || 0n,
                    expectedFirstOutput: (context as any)[2] || 0n,
                    actualFirstOutput: (context as any)[3] || 0n,
                    expectedSecondOutput: (context as any)[4] || 0n,
                    actualSecondOutput: (context as any)[5] || 0n,
                    executed: (context as any)[6] || false
                };
            }

            // For flash loan transactions that don't have context, create synthetic values
            // from flash loan events if they exist
            const flashLoanData = this.parseFlashLoanEvents(receipt);
            if (flashLoanData.flashLoanData) {
                const amount = flashLoanData.flashLoanData.amount;

                // Create a synthetic trade context
                logger.debug('Creating synthetic trade context from flash loan data');

                // Safely handle profit data from flash loan
                let secondLegOutput = 0n;
                if (flashLoanData.flashLoanData.profit) {
                    // Profit can be negative in test mode
                    secondLegOutput = flashLoanData.flashLoanData.profit;
                }

                return {
                    tradeInputAmount: amount,
                    tradeFinalBalance: amount + secondLegOutput, // Add profit (which can be negative)
                    expectedFirstOutput: 0n,   // Not available from flash loan events
                    actualFirstOutput: 0n,     // Not available from flash loan events
                    expectedSecondOutput: 0n,  // Not available from flash loan events
                    actualSecondOutput: secondLegOutput, // Use profit as second leg output
                    executed: true             // Transaction succeeded
                };
            }

            logger.warn('Could not extract executionId or flash loan data for trade context', {
                transactionHash: receipt.transactionHash
            });
            return undefined;
        } catch (error) {
            logger.error('Error getting trade context', {
                error: getErrorMessage(error),
                transactionHash: receipt.transactionHash
            });
            return undefined;
        }
    }

    /**
     * Parse SwapCheckpoint events from transaction receipt
     * Updated to handle the consolidated SwapEvent format for Balancer implementation
     */
    public parseSwapCheckpoints(receipt: TransactionReceipt): SwapCheckpoint[] {
        const checkpoints: SwapCheckpoint[] = [];

        // Filter logs to only include those from our contract
        const contractLogs = receipt.logs.filter(log =>
            log.address.toLowerCase() === this.contractAddress.toLowerCase()
        );

        // First try to parse the new consolidated SwapEvent events (primary in Balancer implementation)
        for (const log of contractLogs) {
            try {
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: log.data,
                    topics: log.topics
                });

                if (decoded.eventName === 'SwapEvent' && decoded.args) {
                    // Type assertion to access properties safely
                    const args = decoded.args as unknown as {
                        executionId: Hash;
                        eventType: number; // 1=initiated, 2=completed, 3=checkpoint
                        stage: string;
                        token: Address;
                        actualBalance: bigint;
                        expectedBalance: bigint;
                    };

                    // We're primarily interested in checkpoint events (type 3)
                    // but we can also extract useful info from other types
                    const stage = args.stage || '';
                    const token = args.token || '0x0000000000000000000000000000000000000000' as Address;
                    const actualBalance = args.actualBalance ? args.actualBalance.toString() : '0';
                    const expectedBalance = args.expectedBalance ? args.expectedBalance.toString() : '0';

                    // Calculate difference between actual and expected - safely for potentially negative values
                    let differenceValue: string;
                    const actualBigInt = BigInt(actualBalance);
                    const expectedBigInt = BigInt(expectedBalance);

                    if (actualBigInt >= expectedBigInt) {
                        differenceValue = "+" + (actualBigInt - expectedBigInt).toString();
                    } else {
                        differenceValue = "-" + (expectedBigInt - actualBigInt).toString();
                    }

                    // Create the checkpoint
                    const checkpoint: SwapCheckpoint = {
                        stage,
                        token,
                        actualBalance,
                        expectedBalance,
                        timestamp: Date.now().toString(), // Use current time as timestamp
                        difference: differenceValue
                    };

                    checkpoints.push(checkpoint);

                    logger.debug('Parsed SwapEvent', {
                        executionId: args.executionId,
                        eventType: args.eventType,
                        stage,
                        token,
                        actualBalance,
                        expectedBalance,
                        difference: differenceValue
                    });
                }
            } catch (error) {
                // Skip logs that cannot be decoded - normal for non-event logs
                continue;
            }
        }

        return checkpoints;
    }

    /**
     * Parse ValidationCheckpoint events from transaction receipt
     * Updated to handle the consolidated StateLog events for Balancer implementation
     */
    public parseValidationCheckpoints(receipt: TransactionReceipt): { stage: string; detail: string }[] {
        const checkpoints: { stage: string; detail: string }[] = [];

        // Get all logs from our contract
        const contractLogs = receipt.logs.filter(log =>
            log.address.toLowerCase() === this.contractAddress.toLowerCase()
        );

        // First check for StateLog events which are now the primary event type
        // in the updated Balancer implementation
        for (const log of contractLogs) {
            try {
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: log.data,
                    topics: log.topics
                });

                if (decoded.eventName === 'StateLog' && decoded.args) {
                    // Type assertion to access properties safely
                    const args = decoded.args as unknown as {
                        executionId: Hash;
                        stage: string;
                        data: string;
                    };

                    checkpoints.push({
                        stage: args.stage || '',
                        detail: args.data || ''
                    });

                    logger.debug('Parsed StateLog event', {
                        executionId: args.executionId,
                        stage: args.stage,
                        data: args.data
                    });
                }
            } catch (error) {
                // Skip logs that cannot be decoded - normal for non-event logs
                continue;
            }
        }

        return checkpoints;
    }

    /**
     * Attempt to decode a revert reason from transaction logs, debug calls, etc.
     * Return null if none found.
     */
    private async decodeRevertReason(hash: Hash): Promise<string | null> {
        try {
            // Try to get transaction details
            const tx = await this.publicClient.getTransaction({
                hash
            });

            // Try to simulate the transaction to get the revert reason
            try {
                await this.publicClient.call({
                    to: tx.to as Address,
                    data: tx.input,
                    value: tx.value,
                    account: tx.from
                });
                // If simulation succeeds but actual tx failed, something strange happened
                return "Transaction simulation succeeded but actual transaction failed";
            } catch (callError: any) {
                // Extract revert reason from error
                if (callError.message) {
                    // Look for common revert reason patterns
                    const revertMatch = callError.message.match(/reverted with reason string '([^']+)'/);
                    if (revertMatch) {
                        return revertMatch[1];
                    }

                    // Look for custom error selectors
                    const customErrorMatch = callError.message.match(/reverted with custom error '([^']+)'/);
                    if (customErrorMatch) {
                        return customErrorMatch[1];
                    }

                    // Check for arithmetic overflow/underflow errors
                    if (callError.message.includes('arithmetic underflow or overflow')) {
                        return 'Arithmetic underflow or overflow. This might be due to negative values in test mode.';
                    }

                    // Return the full error message as a fallback
                    return callError.message;
                }
            }
        } catch (error) {
            logger.error('Error decoding revert reason', {
                error: getErrorMessage(error),
                hash
            });
        }

        return null;
    }

    /**
     * Classify known error messages into error types
     */
    private classifyError(errorMessage: string): string {
        if (!errorMessage) return 'UNKNOWN_ERROR';

        // Arithmetic errors - handle explicitly for flash loan test mode
        if (errorMessage.includes('arithmetic underflow or overflow')) {
            return 'ARITHMETIC_ERROR';
        }

        // Balancer Vault specific errors
        if (errorMessage.includes('BALANCER_VAULT_LOCKED')) return 'BALANCER_VAULT_LOCKED';
        if (errorMessage.includes('NOT_BALANCER_VAULT')) return 'INVALID_FLASH_LOAN_PROVIDER';
        if (errorMessage.includes('SETTLEMENT_FAILURE')) return 'FLASH_LOAN_REPAYMENT_FAILED';
        if (errorMessage.includes('INVALID_TRANSACTION_DATA')) return 'INVALID_FLASH_LOAN_DATA';
        if (errorMessage.includes('Vault: function can only be called from an unlocked vault')) return 'INVALID_FLASH_LOAN_CALL';

        // Custom error types from the contract
        // FlashLoanErrors custom error type handling - numeric codes
        if (errorMessage.includes('FlashLoanErrors')) {
            // Try to extract error code
            const codeMatch = errorMessage.match(/FlashLoanErrors\((\d+)\)/);
            if (codeMatch && codeMatch[1]) {
                const code = parseInt(codeMatch[1]);
                switch (code) {
                    case 1:
                        return 'INVALID_FLASH_LOAN_AMOUNT';
                    case 2:
                        return 'INVALID_FLASH_LOAN_PROVIDER';
                    case 3:
                        return 'FLASH_LOAN_APPROVAL_FAILED';
                    case 4:
                        return 'INSUFFICIENT_REPAYMENT_BALANCE';
                    case 5:
                        return 'OWNER_WALLET_INSUFFICIENT_COVERAGE';
                    default:
                        return 'FLASH_LOAN_ERROR';
                }
            }
            return 'FLASH_LOAN_ERROR';
        }

        // Trade errors - numeric codes
        if (errorMessage.includes('TradeErrors')) {
            const codeMatch = errorMessage.match(/TradeErrors\((\d+)/);
            if (codeMatch && codeMatch[1]) {
                const code = parseInt(codeMatch[1]);
                switch (code) {
                    case 1:
                        return 'SOURCE_TARGET_TOKENS_SAME';
                    case 2:
                        return 'TOKEN_NOT_ENABLED';
                    case 3:
                        return 'TRADE_ALREADY_EXECUTED';
                    case 4:
                        return 'FIRST_SWAP_FAILED';
                    case 5:
                        return 'NO_INTERMEDIATE_TOKENS';
                    case 6:
                        return 'SECOND_SWAP_FAILED';
                    case 7:
                        return 'NO_PROFIT';
                    default:
                        return 'TRADE_ERROR';
                }
            }
            return 'TRADE_ERROR';
        }

        // InvalidSetup errors - numeric codes
        if (errorMessage.includes('InvalidSetup')) {
            const codeMatch = errorMessage.match(/InvalidSetup\((\d+)\)/);
            if (codeMatch && codeMatch[1]) {
                const code = parseInt(codeMatch[1]);
                switch (code) {
                    case 1:
                        return 'INVALID_VAULT_ADDRESS';
                    case 2:
                        return 'INVALID_DEX_CONFIG';
                    case 3:
                        return 'INVALID_FEE_TIER';
                    case 4:
                        return 'INVALID_POOL_ADDRESS';
                    case 5:
                        return 'DEX_NOT_CONFIGURED';
                    case 6:
                        return 'DEX_ROUTER_NOT_CONFIGURED';
                    case 7:
                        return 'INVALID_TOKEN_ADDRESS';
                    case 8:
                        return 'INVALID_TOKEN_AMOUNT';
                    case 9:
                        return 'INVALID_TOKEN_DECIMALS';
                    default:
                        return 'INVALID_SETUP';
                }
            }
            return 'INVALID_SETUP';
        }

        // Balancer flash loan named error patterns
        if (errorMessage.includes('Unauthorized callback')) return 'INVALID_FLASH_LOAN_PROVIDER';
        if (errorMessage.includes('Callback failed')) return 'FLASH_LOAN_CALLBACK_FAILED';
        if (errorMessage.includes('settle')) return 'FLASH_LOAN_REPAYMENT_FAILED';
        if (errorMessage.includes('unlock')) return 'FLASH_LOAN_UNLOCK_FAILED';
        if (errorMessage.includes('sendTo')) return 'FLASH_LOAN_SEND_FAILED';

        // General contract-level errors
        if (errorMessage.includes('NoProfitGenerated')) return 'NO_PROFIT';
        if (errorMessage.includes('FirstSwapFailed')) return 'FIRST_SWAP_FAILED';
        if (errorMessage.includes('SecondSwapFailed')) return 'SECOND_SWAP_FAILED';
        if (errorMessage.includes('NoIntermediateTokenReceived')) return 'NO_INTERMEDIATE_TOKENS';
        if (errorMessage.includes('InsufficientProfit')) return 'INSUFFICIENT_PROFIT';
        if (errorMessage.includes('TokenNotEnabled')) return 'TOKEN_NOT_ENABLED';
        if (errorMessage.includes('AmountTooLow')) return 'AMOUNT_TOO_LOW';
        if (errorMessage.includes('AmountTooHigh')) return 'AMOUNT_TOO_HIGH';
        if (errorMessage.includes('SameRouterNotAllowed')) return 'SAME_ROUTER_NOT_ALLOWED';

        // Network/gas errors
        if (errorMessage.includes('transaction underpriced')) return 'TRANSACTION_UNDERPRICED';
        if (errorMessage.includes('insufficient funds')) return 'INSUFFICIENT_FUNDS';
        if (errorMessage.includes('nonce too low')) return 'NONCE_TOO_LOW';
        if (errorMessage.includes('gas limit reached')) return 'GAS_LIMIT_REACHED';
        if (errorMessage.includes('exceeds block gas limit')) return 'EXCEEDS_BLOCK_GAS_LIMIT';
        if (errorMessage.includes('intrinsic gas too low')) return 'INTRINSIC_GAS_TOO_LOW';
        if (errorMessage.includes('replacement transaction underpriced')) return 'REPLACEMENT_UNDERPRICED';

        // Generic error types
        if (errorMessage.includes('reverted')) return 'TRANSACTION_REVERTED';
        if (errorMessage.includes('timeout')) return 'TRANSACTION_TIMEOUT';

        // Router and token errors
        if (errorMessage.includes('InsufficientAllowance') || errorMessage.includes('transfer amount exceeds allowance')) return 'INSUFFICIENT_ALLOWANCE';
        if (errorMessage.includes('InsufficientBalance') || errorMessage.includes('transfer amount exceeds balance')) return 'INSUFFICIENT_BALANCE';
        if (errorMessage.includes('InvalidRouterAddress')) return 'INVALID_ROUTER_ADDRESS';

        return 'UNKNOWN_ERROR';
    }

    /**
     * Attempts to decode contract error data into a structured error object
     * Enhanced to handle flash loan errors and provide better categorization
     * @param data The error data from the contract call
     * @returns Decoded error information or null if decoding fails
     */
    private decodeContractError(data: string): {
        name: string;
        args: any;
        category: string;
        recoveryHint: string;
    } | null {
        try {
            // Use Viem's decodeErrorResult function to decode the error
            const decoded = decodeErrorResult({
                abi: ARBITRAGE_ABI,
                data: data as `0x${string}`
            });

            // Determine error category
            let category = 'GENERAL';
            let recoveryHint = '';

            // Use the errorName as a string for safer comparisons
            const errorNameStr = decoded.errorName as string;

            // Flash loan related errors
            if (errorNameStr === 'FlashLoanErrors') {
                category = 'FLASH_LOAN';

                // Parse the error code if available
                const decodedArgs = decoded.args as any;
                const errorCode = decodedArgs && typeof decodedArgs === 'object' ?
                    (decodedArgs[0] !== undefined ? Number(decodedArgs[0]) : 0) : 0;

                switch (errorCode) {
                    case 1:
                        recoveryHint = 'Invalid flash loan amount. Amount must be greater than zero.';
                        break;
                    case 2:
                        recoveryHint = 'Invalid flash loan provider. Callback not received from Balancer Vault.';
                        break;
                    case 3:
                        recoveryHint = 'Flash loan approval failed. Check token allowances for the Balancer Vault.';
                        break;
                    case 4:
                        recoveryHint = 'Insufficient balance to repay flash loan. In test mode, ensure owner wallet has sufficient balance.';
                        break;
                    case 5:
                        recoveryHint = 'Owner wallet has insufficient balance or allowance to cover shortfall in test mode.';
                        break;
                    default:
                        recoveryHint = 'Unknown flash loan error. Check contract events for more details.';
                }
            }
            // Trade execution errors
            else if (errorNameStr === 'TradeErrors') {
                category = 'SWAP';

                // Parse the error code and reason if available
                const decodedArgs = decoded.args as any;
                const errorCode = decodedArgs && typeof decodedArgs === 'object' ?
                    (decodedArgs[0] !== undefined ? Number(decodedArgs[0]) : 0) : 0;
                const reason = decodedArgs && typeof decodedArgs === 'object' ?
                    (decodedArgs[1] !== undefined ? String(decodedArgs[1]) : '') : '';

                switch (errorCode) {
                    case 1:
                        recoveryHint = 'Source and target tokens must be different.';
                        break;
                    case 2:
                        recoveryHint = 'Token is not enabled for trading. Configure the token first.';
                        break;
                    case 3:
                        recoveryHint = 'Trade has already been executed with this ID.';
                        break;
                    case 4:
                        recoveryHint = `First swap failed: ${reason}`;
                        break;
                    case 5:
                        recoveryHint = 'No intermediate tokens received. Check first swap parameters.';
                        break;
                    case 6:
                        recoveryHint = `Second swap failed: ${reason}`;
                        break;
                    case 7:
                        recoveryHint = 'Trade did not generate any profit.';
                        break;
                    default:
                        recoveryHint = 'Unknown trade error. Check contract events for more details.';
                }
            }
            // Setup and configuration errors
            else if (errorNameStr === 'InvalidSetup') {
                category = 'CONFIGURATION';

                // Parse the error code if available
                const decodedArgs = decoded.args as any;
                const errorCode = decodedArgs && typeof decodedArgs === 'object' ?
                    (decodedArgs[0] !== undefined ? Number(decodedArgs[0]) : 0) : 0;

                switch (errorCode) {
                    case 1:
                        recoveryHint = 'Invalid Balancer Vault address. Cannot be zero address.';
                        break;
                    case 2:
                        recoveryHint = 'Invalid DEX router or name. Router address cannot be zero and name cannot be empty.';
                        break;
                    case 3:
                        recoveryHint = 'Invalid fee value. Fees must be less than MAX_BPS (10000).';
                        break;
                    case 4:
                        recoveryHint = 'Invalid pool address. Cannot be zero address.';
                        break;
                    case 5:
                        recoveryHint = 'DEX not configured. Configure the DEX before adding pools.';
                        break;
                    case 6:
                        recoveryHint = 'DEX router not configured. Configure the DEX router first.';
                        break;
                    case 7:
                        recoveryHint = 'Invalid token address. Cannot be zero address.';
                        break;
                    case 8:
                        recoveryHint = 'Invalid token amounts. Max amount must be greater than min amount.';
                        break;
                    case 9:
                        recoveryHint = 'Invalid token decimals. Must be 18 or less.';
                        break;
                    default:
                        recoveryHint = 'Invalid contract setup. Check configuration parameters.';
                }
            }
            // Balance and token errors
            else if (['InsufficientAllowance', 'InsufficientBalance', 'TokenNotEnabled'].includes(errorNameStr)) {
                category = 'BALANCE';

                if (errorNameStr === 'InsufficientAllowance') {
                    recoveryHint = 'Contract does not have sufficient allowance to spend tokens. Update token approvals.';
                } else if (errorNameStr === 'InsufficientBalance') {
                    recoveryHint = 'Contract does not have sufficient token balance for the operation.';
                } else if (errorNameStr === 'TokenNotEnabled') {
                    recoveryHint = 'The token is not enabled for trading in the contract. Configure the token first.';
                }
            }
            // Profit and execution errors
            else if (['NoProfitGenerated', 'AmountTooLow', 'AmountTooHigh', 'SameRouterNotAllowed'].includes(errorNameStr)) {
                category = 'EXECUTION';

                if (errorNameStr === 'NoProfitGenerated') {
                    recoveryHint = 'The trade did not generate a profit. Try increasing input amount or using test mode for testing.';
                } else if (errorNameStr === 'SameRouterNotAllowed') {
                    recoveryHint = 'Cannot use the same router for both swaps. Use different DEXes for arbitrage.';
                } else if (errorNameStr === 'AmountTooLow' || errorNameStr === 'AmountTooHigh') {
                    recoveryHint = 'Trade amount is outside the configured limits for this token.';
                }
            }
            // Balancer-specific errors
            else if (errorNameStr.includes('BALANCER_')) {
                category = 'BALANCER';

                if (errorNameStr === 'BALANCER_VAULT_LOCKED') {
                    recoveryHint = 'Balancer Vault is locked. This could be due to an unlock state issue or reentrancy protection.';
                } else if (errorNameStr === 'NOT_BALANCER_VAULT') {
                    recoveryHint = 'The callback was not received from the Balancer Vault.';
                } else if (errorNameStr === 'SETTLEMENT_FAILURE') {
                    recoveryHint = 'Failed to settle a flash loan with the Balancer Vault. Make sure there are sufficient funds to repay.';
                } else {
                    recoveryHint = 'Error in Balancer Vault interaction. Check contract configuration and call parameters.';
                }
            }
            // Value type errors
            else if (['NegativeAmountNotAllowed', 'NegativeValueConversionError', 'SourceAndTargetTokensMustDiffer'].includes(errorNameStr)) {
                category = 'VALIDATION';

                if (errorNameStr === 'SourceAndTargetTokensMustDiffer') {
                    recoveryHint = 'Source and target tokens must be different for an arbitrage operation.';
                } else {
                    recoveryHint = 'Invalid numerical value. Ensure all amounts are positive.';
                }
            }
            // State errors
            else if (['TradeAlreadyExecuted'].includes(errorNameStr)) {
                category = 'STATE';
                recoveryHint = 'This trade has already been executed. Generate a new trade ID.';
            }
            // Arithmetic errors
            else if (errorNameStr.includes('overflow') || errorNameStr.includes('underflow')) {
                category = 'ARITHMETIC';
                recoveryHint = 'Arithmetic overflow or underflow error. This may occur with negative values in test mode.';
            }

            logger.debug('Decoded contract error', {
                name: decoded.errorName,
                category,
                args: decoded.args,
                recoveryHint
            });

            return {
                name: decoded.errorName,
                args: decoded.args,
                category,
                recoveryHint
            };
        } catch (error) {
            // If we can't decode using the contract's ABI, try to check for some known error patterns
            if (typeof data === 'string') {
                // Common Balancer error signatures
                const balancerErrors: Record<string, { name: string, hint: string }> = {
                    '0x33a0a577': {
                        name: 'BALANCER_VAULT_LOCKED',
                        hint: 'Balancer Vault is locked. Check for reentrancy issues.'
                    },
                    '0xa965587f': {
                        name: 'UNAUTHORIZED_CALLER',
                        hint: 'Caller is not authorized to call this function. Verify caller address.'
                    },
                    '0xd3c15364': {
                        name: 'FLASH_LOAN_INVALID_BALANCE',
                        hint: 'Balancer Vault has insufficient balance for the requested flash loan.'
                    },
                    '0xc2e25e9e': {
                        name: 'UNSETTLED_BALANCE',
                        hint: 'Flash loan was not fully settled. Ensure all borrowed amounts are returned.'
                    }
                };

                // Check if the error selector (first 10 chars including 0x) matches any known Balancer errors
                const errorSelector = data.slice(0, 10);

                if (Object.prototype.hasOwnProperty.call(balancerErrors, errorSelector)) {
                    const error = balancerErrors[errorSelector];
                    logger.debug('Recognized Balancer error selector', {
                        selector: errorSelector,
                        name: error.name
                    });

                    return {
                        name: error.name,
                        args: {},
                        category: 'BALANCER',
                        recoveryHint: error.hint
                    };
                }

                // Check for arithmetic errors that might not be properly decoded
                if (data.includes('arithmetic')) {
                    return {
                        name: 'ArithmeticError',
                        args: {},
                        category: 'ARITHMETIC',
                        recoveryHint: 'Arithmetic overflow or underflow - likely due to negative values in test mode.'
                    };
                }
            }

            logger.debug('Error decoding contract error', {
                error: getErrorMessage(error),
                data: data
            });
            return null;
        }
    }

    /**
     * Parse StateLog events - consolidated event format
     */
    public parseStateLogs(receipt: TransactionReceipt): { executionId: Hash; stage: string; data: string }[] {
        const results: { executionId: Hash; stage: string; data: string }[] = [];

        for (const log of receipt.logs) {
            try {
                if (log.address.toLowerCase() !== this.contractAddress.toLowerCase()) {
                    continue;
                }

                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: log.data,
                    topics: log.topics
                });

                if (decoded.eventName === 'StateLog' && decoded.args) {
                    const args = decoded.args as unknown as {
                        executionId: Hash;
                        stage: string;
                        data: string;
                    };

                    results.push({
                        executionId: args.executionId,
                        stage: args.stage || '',
                        data: args.data || ''
                    });

                    logger.debug('Parsed StateLog event', {
                        executionId: args.executionId,
                        stage: args.stage,
                        data: args.data
                    });
                }
            } catch (error) {
                // Skip logs that cannot be decoded
                continue;
            }
        }

        return results;
    }

    /**
     * Executes a flash loan-based arbitrage using Balancer's flash loan
     * Enhanced to support multiple token pairs including USDC-WAVAX and USDC-WBTC
     * @param params Flash loan arbitrage parameters
     * @returns Trade result with transaction details
     */
    public async executeFlashLoanArbitrage(params: {
        sourceToken: Address;
        targetToken: Address;
        amount: bigint;
        firstSwapData: `0x${string}`;
        secondSwapData: `0x${string}`;
        firstRouter: Address;
        secondRouter: Address;
        testMode: boolean;
        expectedFirstOutput: bigint;
        expectedSecondOutput: bigint;
    }): Promise<TradeResult> {
        try {
            // Detect token pair type - USDC-WAVAX or USDC-WBTC
            const isWbtcPair = params.targetToken.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase();
            const targetTokenConfig = isWbtcPair ? TOKEN_CONFIGS.WBTC : TOKEN_CONFIGS.WAVAX;
            const sourceTokenConfig = TOKEN_CONFIGS.USDC; // Always USDC as source token

            // Enhanced logging for negative values in test mode
            const hasNegativeExpectedValue = params.expectedFirstOutput < 0n || params.expectedSecondOutput < 0n;

            if (hasNegativeExpectedValue) {
                logger.info('Detected negative expected values in test mode', {
                    expectedFirstOutput: params.expectedFirstOutput.toString(),
                    expectedSecondOutput: params.expectedSecondOutput.toString(),
                    isFirstOutputNegative: params.expectedFirstOutput < 0n,
                    isSecondOutputNegative: params.expectedSecondOutput < 0n,
                    testMode: params.testMode,
                    tokenPair: `${sourceTokenConfig.symbol}-${targetTokenConfig.symbol}`,
                    isWbtcPair
                });
            }

            logger.info('Preparing flash loan arbitrage execution', {
                sourceToken: params.sourceToken,
                targetToken: params.targetToken,
                tokenPair: `${sourceTokenConfig.symbol}-${targetTokenConfig.symbol}`,
                amount: params.amount.toString(),
                firstRouter: params.firstRouter,
                secondRouter: params.secondRouter,
                testMode: params.testMode,
                expectedFirstOutput: params.expectedFirstOutput.toString(),
                expectedSecondOutput: params.expectedSecondOutput.toString(),
                isFirstOutputNegative: params.expectedFirstOutput < 0n,
                isSecondOutputNegative: params.expectedSecondOutput < 0n,
                isWbtcPair
            });

            // Get latest gas parameters
            const gasParams = await this.gasUtility.getGasParameters();

            // Balancer has 0% flash loan fee
            const flashLoanFee = 0n;
            logger.info('Flash loan fee estimate', {
                amount: formatUnits(params.amount, sourceTokenConfig.decimals),
                flashLoanFee: formatUnits(flashLoanFee, sourceTokenConfig.decimals),
                feePercentage: `0.00%`
            });

            // Execute the flash loan arbitrage
            const hash = await this.walletClient.writeContract({
                address: this.contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'executeFlashLoanArbitrage',
                args: [
                    params.sourceToken,
                    params.targetToken,
                    params.amount,
                    params.firstSwapData,
                    params.secondSwapData,
                    params.firstRouter,
                    params.secondRouter,
                    params.testMode,
                    params.expectedFirstOutput,
                    params.expectedSecondOutput
                ],
                gas: gasParams.gasLimit,
                ...(gasParams.maxFeePerGas && gasParams.maxPriorityFeePerGas
                    ? {
                        maxFeePerGas: gasParams.maxFeePerGas,
                        maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas
                    }
                    : gasParams.gasPrice
                        ? {gasPrice: gasParams.gasPrice}
                        : {})
            });

            logger.info('Flash loan arbitrage transaction submitted', {
                hash,
                tokenPair: `${sourceTokenConfig.symbol}-${targetTokenConfig.symbol}`,
                isWbtcPair
            });

            // Default result with transaction hash
            let result: TradeResult = {
                success: false,
                firstLegHash: hash,
                error: '',
                errorType: ''
            };

            // Wait for receipt
            let receipt: TransactionReceipt | undefined;
            try {
                receipt = await this.publicClient.waitForTransactionReceipt({
                    hash,
                    timeout: ARBITRAGE_SETTINGS.TRANSACTION_TIMEOUT,
                    retryCount: this.MAX_RETRY_ATTEMPTS,
                    retryDelay: this.RETRY_DELAY
                });
            } catch (waitError) {
                const errorMsg = getErrorMessage(waitError);

                // Handle timeout or not found errors
                if (errorMsg.includes('timed out') ||
                    errorMsg.includes('could not be found') ||
                    errorMsg.includes('not yet been mined')) {

                    logger.warn('Transaction confirmation timed out - checking status manually', {
                        hash,
                        error: errorMsg
                    });

                    // Try manual receipt fetching with multiple attempts
                    receipt = await this.manuallyCheckReceipt(hash);
                } else {
                    throw waitError;
                }
            }

            // If we still don't have a receipt, transaction likely failed
            if (!receipt) {
                result.error = 'Could not retrieve transaction receipt after multiple attempts';
                result.errorType = 'NO_RECEIPT';
                logger.error(result.error, {hash});
                return result;
            }

            // Store receipt in result
            result.receipt = receipt;

            // Check status
            if (receipt.status !== 'success') {
                // Check for arithmetic errors specifically in test mode
                const revertReason = await this.decodeRevertReason(hash);
                let errorType = this.classifyError(revertReason || '');

                // Special handling for arithmetic errors in test mode
                if ((revertReason?.includes('arithmetic underflow or overflow') ||
                        errorType === 'ARITHMETIC_ERROR') &&
                    params.testMode) {

                    logger.warn('Arithmetic underflow/overflow in test mode with negative values', {
                        hash,
                        firstOutput: params.expectedFirstOutput.toString(),
                        secondOutput: params.expectedSecondOutput.toString(),
                        testMode: params.testMode,
                        tokenPair: `${sourceTokenConfig.symbol}-${targetTokenConfig.symbol}`,
                        isWbtcPair
                    });

                    result.error = 'Arithmetic underflow/overflow in test mode with negative expected profit. ' +
                        'This is likely due to calculations with negative values. ' +
                        'Consider updating the smart contract to handle negative values more safely.';
                    result.errorType = 'TEST_MODE_ARITHMETIC_ERROR';
                } else {
                    // Parse flash loan events even for failed transactions
                    const flashLoanEvents = this.parseFlashLoanEvents(receipt);

                    result.success = false;
                    result.error = revertReason || 'Transaction reverted on chain';
                    result.errorType = errorType;

                    // Add flash loan specific data if available
                    if (flashLoanEvents.flashLoanData) {
                        if (flashLoanEvents.flashLoanData.reason) {
                            result.error += `: ${flashLoanEvents.flashLoanData.reason}`;
                        }
                        result.flashLoanFee = "0"; // Balancer has 0% fee
                    }

                    // Parse validation checkpoints for additional error context
                    const validationCheckpoints = this.parseValidationCheckpoints(receipt);
                    result.validationCheckpoints = validationCheckpoints;

                    // Add specific guidance for common flash loan errors
                    if (errorType === 'INSUFFICIENT_ALLOWANCE' ||
                        errorType === 'FLASH_LOAN_APPROVAL_FAILED') {
                        result.error += ' - Make sure to run approveFlashLoan.js before testing flash loans';
                    } else if (errorType === 'INSUFFICIENT_REPAYMENT_BALANCE' && params.testMode) {
                        result.error += ' - In test mode, ensure owner wallet has enough tokens to cover negative profit';
                    } else if (errorType === 'INVALID_FLASH_LOAN_PROVIDER') {
                        result.error += ' - Flash loan provider address may be incorrectly configured';
                    } else if (errorType === 'FLASH_LOAN_CALLBACK_FAILED') {
                        // Look for specific failure details in validation checkpoints
                        const callbackFailure = validationCheckpoints.find(cp =>
                            cp.stage === 'FlashLoanCallback' ||
                            cp.stage === 'OnFlashLoan');

                        if (callbackFailure) {
                            result.error += ` - Flash loan callback error: ${callbackFailure.detail}`;
                        } else {
                            result.error += ' - Flash loan callback failed during execution';
                        }
                    } else if (errorType === 'NO_PROFIT' && params.testMode) {
                        result.error += ' - No profit generated, but this is expected in test mode';
                    }
                }

                return result;
            }

            // Get flash loan events and regular arbitrage events
            const flashLoanResult = this.parseFlashLoanEvents(receipt);

            // Use the event data to populate result
            result.success = true;
            const {gasUsed, effectiveGasPrice} = receipt;
            result.gasUsed = gasUsed.toString();
            result.effectiveGasPrice = formatUnits(effectiveGasPrice || 0n, 9);

            // Add router addresses to result
            result.firstRouter = params.firstRouter;
            result.secondRouter = params.secondRouter;

            // Process flash loan data if available
            if (flashLoanResult.flashLoanData) {
                // Get flash loan fee (for Balancer, it's always 0)
                result.flashLoanFee = "0";

                // Handle profit (with fallback to zero if not available)
                const profitBigInt = flashLoanResult.flashLoanData.profit || 0n;
                // Safely format profit, which can be negative in test mode
                result.profit = safeFormatUnits(profitBigInt, sourceTokenConfig.decimals);

                // Net profit is the same as profit (since flash loan fee is 0)
                result.netProfit = result.profit;

                // Set final balance and account balance
                const loanAmount = flashLoanResult.flashLoanData.amount;
                // Handle potentially negative profit scenarios safely
                if (profitBigInt < 0n) {
                    // For test mode with negative profit
                    if (-profitBigInt >= loanAmount) {
                        // Complete loss (plus some)
                        result.finalBalance = '0';
                    } else {
                        // Partial loss
                        result.finalBalance = safeFormatUnits(loanAmount + profitBigInt, sourceTokenConfig.decimals);
                    }
                } else {
                    // Normal profit case
                    result.finalBalance = safeFormatUnits(loanAmount + profitBigInt, sourceTokenConfig.decimals);
                }
                result.accountBalance = result.finalBalance;
            }

            // Process arbitrage data if available
            if (flashLoanResult.arbitrageData) {
                // Safely format potentially negative profit values
                result.profit = safeFormatUnits(flashLoanResult.arbitrageData.tradeProfit, sourceTokenConfig.decimals);

                // Safely format potentially negative balance values
                result.finalBalance = safeFormatUnits(flashLoanResult.arbitrageData.tradeFinalBalance, sourceTokenConfig.decimals);
                result.accountBalance = safeFormatUnits(flashLoanResult.arbitrageData.finalAccountBalance, sourceTokenConfig.decimals);
                result.testMode = flashLoanResult.arbitrageData.testMode;
            }

            // Handle the case where we still have no profit data
            if (!result.profit) {
                result.profit = "0";  // Default to zero profit for successful transactions
            }
            if (!result.netProfit) {
                result.netProfit = result.profit;  // Default net profit to match profit
            }

            // Fix for null profits
            if (result.profit === "NaN" || !result.profit) {
                result.profit = "0";
            }
            if (result.netProfit === "NaN" || !result.netProfit) {
                result.netProfit = "0";
            }

            // Parse checkpoints
            const swapCheckpoints = this.parseSwapCheckpoints(receipt);
            const validationCheckpoints = this.parseValidationCheckpoints(receipt);
            result.swapCheckpoints = swapCheckpoints;
            result.validationCheckpoints = validationCheckpoints;

            // Get trade context if available
            try {
                const tradeContext = await this.getTradeContextFromReceipt(receipt);
                if (tradeContext) {
                    result.tradeContext = tradeContext;

                    // Add leg outputs if available - handle potentially negative values
                    result.firstLegOutput = safeFormatUnits(tradeContext.actualFirstOutput, targetTokenConfig.decimals);
                    result.secondLegOutput = safeFormatUnits(tradeContext.actualSecondOutput, sourceTokenConfig.decimals);

                    // Add expected outputs - safely handle potentially negative values
                    result.expectedFirstLegOutput = safeFormatUnits(tradeContext.expectedFirstOutput, targetTokenConfig.decimals);
                    result.expectedSecondLegOutput = safeFormatUnits(tradeContext.expectedSecondOutput, sourceTokenConfig.decimals);
                }
            } catch (contextError) {
                logger.warn('Error getting trade context but continuing', {
                    error: getErrorMessage(contextError)
                });
            }

            // Add token info to result for clarity
            result.tokensTraded = {
                firstLeg: {
                    input: {
                        symbol: sourceTokenConfig.symbol,
                        address: sourceTokenConfig.address
                    },
                    output: {
                        symbol: targetTokenConfig.symbol,
                        address: targetTokenConfig.address
                    }
                },
                secondLeg: {
                    input: {
                        symbol: targetTokenConfig.symbol,
                        address: targetTokenConfig.address
                    },
                    output: {
                        symbol: sourceTokenConfig.symbol,
                        address: sourceTokenConfig.address
                    }
                }
            };

            return result;
        } catch (error: unknown) {
            let errorMessage = getErrorMessage(error);
            let errorType = 'UNKNOWN_ERROR';

            // Check if this is a contract error with data
            if (error && typeof error === 'object' && 'data' in error && error.data) {
                const decodedError = this.decodeContractError(error.data as string);
                if (decodedError) {
                    errorMessage = decodedError.name;

                    // If the error has arguments, include them
                    if (decodedError.args) {
                        if (typeof decodedError.args === 'object') {
                            const argValues = Object.values(decodedError.args)
                                .filter(val => val !== undefined)
                                .map(val => {
                                    if (typeof val === 'bigint') return val.toString();
                                    return val;
                                });

                            if (argValues.length > 0) {
                                errorMessage += `: ${argValues.join(', ')}`;
                            }
                        } else if (Array.isArray(decodedError.args) && decodedError.args.length > 0) {
                            const argString = decodedError.args
                                .filter(arg => arg !== undefined)
                                .map(arg => {
                                    if (typeof arg === 'bigint') return arg.toString();
                                    return arg;
                                })
                                .join(', ');

                            errorMessage += `: ${argString}`;
                        }
                    }

                    // Add recovery hint if available
                    if (decodedError.recoveryHint) {
                        errorMessage += ` (${decodedError.recoveryHint})`;
                    }

                    // Set error type based on error name
                    errorType = this.classifyError(decodedError.name);

                    // Special handling for arithmetic errors in test mode
                    if (errorType === 'ARITHMETIC_ERROR' || decodedError.category === 'ARITHMETIC') {
                        errorType = 'TEST_MODE_ARITHMETIC_ERROR';
                        errorMessage = 'Arithmetic underflow/overflow in test mode. This is likely due to calculations with negative values.';
                    }
                }
            } else if (errorMessage.includes('arithmetic') || errorMessage.includes('overflow') || errorMessage.includes('underflow')) {
                // Special handling for arithmetic errors that aren't properly decoded
                errorType = 'TEST_MODE_ARITHMETIC_ERROR';
                errorMessage = 'Arithmetic underflow/overflow in test mode. This is likely due to calculations with negative expected profit values.';
            }

            logger.error('Error executing flash loan arbitrage', {
                error: errorMessage,
                decodedError: error && typeof error === 'object' && 'data' in error && error.data
                    ? 'See decoded error'
                    : 'No error data available'
            });

            return {
                success: false,
                error: errorMessage,
                errorType: errorType
            };
        }
    }

    /**
     * Manually check for transaction receipt with multiple attempts
     * Used when waitForTransactionReceipt times out
     */
    private async manuallyCheckReceipt(hash: Hash): Promise<TransactionReceipt | undefined> {
        const maxAttempts = 10;
        const pollingInterval = 3000; // 3 seconds

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const receipt = await this.publicClient.getTransactionReceipt({
                    hash: hash
                });

                if (receipt) {
                    logger.info('Manually retrieved transaction receipt', {
                        hash,
                        blockNumber: receipt.blockNumber,
                        status: receipt.status,
                        attempt: attempt + 1
                    });
                    return receipt;
                }
            } catch (error) {
                logger.debug(`Manual receipt check attempt ${attempt + 1} failed`, {
                    hash,
                    error: getErrorMessage(error)
                });
            }

            // Wait before next attempt
            await sleep(pollingInterval);
        }

        logger.error('Failed to retrieve receipt after manual attempts', {hash});
        return undefined;
    }

    /**
     * Parse FlashLoanEvents from transaction receipt
     * Updated to handle the consolidated FlashLoanEvent format for Balancer implementation
     * Enhanced to detect token types (USDC-WAVAX or USDC-WBTC)
     */
    private parseFlashLoanEvents(receipt: TransactionReceipt): {
        flashLoanData?: {
            executionId: Hash;
            token: Address;
            amount: bigint;
            fee?: bigint;
            profit?: bigint;
            reason?: string;
        };
        arbitrageData?: {
            tradeProfit: bigint;
            tradeFinalBalance: bigint;
            finalAccountBalance: bigint;
            testMode: boolean;
        };
    } {
        const result = {
            flashLoanData: undefined as {
                executionId: Hash;
                token: Address;
                amount: bigint;
                fee?: bigint;
                profit?: bigint;
                reason?: string;
            } | undefined,
            arbitrageData: undefined as {
                tradeProfit: bigint;
                tradeFinalBalance: bigint;
                finalAccountBalance: bigint;
                testMode: boolean;
            } | undefined
        };

        // Filter logs to only include those from our contract
        const contractLogs = receipt.logs.filter(log =>
            log.address.toLowerCase() === this.contractAddress.toLowerCase()
        );

        // Look for FlashLoanEvent events (primary in Balancer implementation)
        const flashLoanEvents = contractLogs.filter(log => {
            try {
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: log.data,
                    topics: log.topics
                });
                return decoded.eventName === 'FlashLoanEvent';
            } catch {
                return false;
            }
        });

        if (flashLoanEvents.length > 0) {
            logger.debug('Found FlashLoanEvent logs', {count: flashLoanEvents.length});

            // First, find the initiated event (eventType = 1) to get basic info
            const initiatedEvent = flashLoanEvents.find(log => {
                try {
                    const decoded = decodeEventLog({
                        abi: ARBITRAGE_ABI,
                        data: log.data,
                        topics: log.topics
                    });
                    const args = decoded.args as Record<string, any>;
                    return args && args.eventType === 1; // 1 = initiated
                } catch {
                    return false;
                }
            });

            if (initiatedEvent) {
                try {
                    const decoded = decodeEventLog({
                        abi: ARBITRAGE_ABI,
                        data: initiatedEvent.data,
                        topics: initiatedEvent.topics
                    });

                    const args = decoded.args as Record<string, any>;
                    const executionId = args.executionId as Hash;
                    const token = args.token as Address;
                    const amount = args.amount as bigint;

                    // Determine the token type
                    const isWbtc = token.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase();
                    const tokenConfig = isWbtc ? TOKEN_CONFIGS.WBTC : TOKEN_CONFIGS.USDC;

                    // For Balancer, fee is always 0, but we extract feeOrProfit for compatibility
                    const fee = 0n; // Balancer has no fees

                    // Start building flash loan data
                    result.flashLoanData = {
                        executionId,
                        token,
                        amount,
                        fee
                    };

                    logger.debug('FlashLoanEvent (initiated)', {
                        executionId,
                        token,
                        tokenType: isWbtc ? 'WBTC' : 'USDC',
                        amount: amount.toString(),
                        fee: fee.toString()
                    });

                    // Look for completed event (eventType = 2) with the same executionId
                    const completedEvent = flashLoanEvents.find(log => {
                        try {
                            const decoded = decodeEventLog({
                                abi: ARBITRAGE_ABI,
                                data: log.data,
                                topics: log.topics
                            });
                            const args = decoded.args as Record<string, any>;
                            return args &&
                                args.eventType === 2 && // 2 = completed
                                args.executionId === executionId;
                        } catch {
                            return false;
                        }
                    });

                    if (completedEvent) {
                        const completedDecoded = decodeEventLog({
                            abi: ARBITRAGE_ABI,
                            data: completedEvent.data,
                            topics: completedEvent.topics
                        });

                        const completedArgs = completedDecoded.args as Record<string, any>;
                        // For completed events, feeOrProfit represents profit
                        const profit = completedArgs.feeOrProfit as bigint || 0n;

                        logger.info('FlashLoanEvent (completed)', {
                            executionId,
                            token,
                            tokenType: isWbtc ? 'WBTC' : 'USDC',
                            amount: amount.toString(),
                            profit: profit.toString(),
                            isNegative: profit < 0n
                        });

                        if (result.flashLoanData) {
                            result.flashLoanData.profit = profit;
                        }

                        // Create arbitrage data using this info
                        result.arbitrageData = {
                            tradeProfit: profit,
                            tradeFinalBalance: amount + profit,
                            finalAccountBalance: amount + profit,
                            testMode: true // Assume test mode for flash loans
                        };

                        return result;
                    }

                    // If no completed event, check for failed event (eventType = 3)
                    const failedEvent = flashLoanEvents.find(log => {
                        try {
                            const decoded = decodeEventLog({
                                abi: ARBITRAGE_ABI,
                                data: log.data,
                                topics: log.topics
                            });
                            const args = decoded.args as Record<string, any>;
                            return args &&
                                args.eventType === 3 && // 3 = failed
                                args.executionId === executionId;
                        } catch {
                            return false;
                        }
                    });

                    if (failedEvent) {
                        try {
                            const failedDecoded = decodeEventLog({
                                abi: ARBITRAGE_ABI,
                                data: failedEvent.data,
                                topics: failedEvent.topics
                            });

                            const failedArgs = failedDecoded.args as Record<string, any>;
                            // For Balancer implementation, try to extract error reason if available
                            let reason = "Unknown failure";

                            // Extract reason - field name might vary based on your implementation
                            if (failedArgs.reason) {
                                reason = failedArgs.reason as string;
                            } else if (failedArgs.data) {
                                reason = failedArgs.data as string;
                            } else if (failedArgs.feeOrProfit && typeof failedArgs.feeOrProfit === 'string') {
                                reason = failedArgs.feeOrProfit;
                            }

                            logger.warn('FlashLoanEvent (failed)', {
                                executionId,
                                token,
                                tokenType: isWbtc ? 'WBTC' : 'USDC',
                                amount: amount.toString(),
                                reason
                            });

                            if (result.flashLoanData) {
                                result.flashLoanData.reason = reason;
                                result.flashLoanData.profit = 0n;
                            }

                            return result;
                        } catch (error) {
                            logger.warn('Error decoding failed FlashLoanEvent', {
                                error: getErrorMessage(error)
                            });
                        }
                    }

                    // If we only found an initiated event, just return that data
                    logger.debug('Only FlashLoanEvent (initiated) found, no completion/failure events');
                    return result;
                } catch (error) {
                    logger.debug('Error parsing FlashLoanEvent', {
                        error: getErrorMessage(error)
                    });
                }
            }
        }

        // If we couldn't find consolidated FlashLoanEvents, try to get info from ArbitrageExecuted event
        // This is for compatibility with other events in the updated Balancer implementation
        const arbitrageExecutedEvent = contractLogs.find(log => {
            try {
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: log.data,
                    topics: log.topics
                });
                return decoded.eventName === 'ArbitrageExecuted';
            } catch {
                return false;
            }
        });

        if (arbitrageExecutedEvent) {
            try {
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI,
                    data: arbitrageExecutedEvent.data,
                    topics: arbitrageExecutedEvent.topics
                });

                const args = decoded.args as unknown as {
                    sourceToken: Address;
                    targetToken: Address;
                    tradeInputAmount: bigint;
                    finalAccountBalance: bigint;
                    tradeFinalBalance: bigint;
                    tradeProfit: bigint;
                    expectedProfit: bigint;
                    testMode: boolean;
                };

                // Determine the token type
                const isWbtc = args.targetToken.toLowerCase() === TOKEN_CONFIGS.WBTC.address.toLowerCase();
                const intermediateToken = isWbtc ? TOKEN_CONFIGS.WBTC.address : TOKEN_CONFIGS.WAVAX.address;

                // If we have ArbitrageExecuted event, we can infer flash loan details
                result.flashLoanData = {
                    executionId: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash, // Default
                    token: args.sourceToken,
                    amount: args.tradeInputAmount,
                    // In Balancer, fees are always 0
                    fee: 0n,
                    profit: args.tradeProfit
                };

                // Also populate arbitrage data
                result.arbitrageData = {
                    tradeProfit: args.tradeProfit,
                    tradeFinalBalance: args.tradeFinalBalance,
                    finalAccountBalance: args.finalAccountBalance,
                    testMode: args.testMode
                };

                logger.debug('Derived flash loan data from ArbitrageExecuted event', {
                    sourceToken: args.sourceToken,
                    targetToken: args.targetToken,
                    tokenType: isWbtc ? 'WBTC' : 'WAVAX',
                    inputAmount: args.tradeInputAmount.toString(),
                    profit: args.tradeProfit.toString(),
                    isNegative: args.tradeProfit < 0n
                });

                return result;
            } catch (error) {
                logger.debug('Error parsing ArbitrageExecuted event', {
                    error: getErrorMessage(error)
                });
            }
        }

        // As a final fallback, check for StateLog events that might contain flash loan info
        const stateLogs = this.parseStateLogs(receipt);
        const flashLoanStateLog = stateLogs.find(log =>
            log.stage.includes('FlashLoan') ||
            log.stage.includes('flash loan')
        );

        if (flashLoanStateLog) {
            logger.debug('Found flash loan-related StateLog', {
                stage: flashLoanStateLog.stage,
                data: flashLoanStateLog.data
            });

            // Create minimal synthetic data from the StateLog
            result.flashLoanData = {
                executionId: flashLoanStateLog.executionId,
                token: TOKEN_CONFIGS.USDC.address, // Default to USDC
                amount: 0n, // Unknown amount
                fee: 0n,    // Balancer has no fees
                reason: flashLoanStateLog.data
            };
        }
        return result;
    }
}