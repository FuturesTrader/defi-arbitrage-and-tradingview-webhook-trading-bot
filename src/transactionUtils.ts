// src/transactionUtils.ts
import {
    createPublicClient,
    http,
    decodeEventLog,
    formatEther,
    formatUnits,
    type Hash,
    type Address,
    type Log,
    type TransactionReceipt,
    type Transaction
} from 'viem';
import { avalanche } from 'viem/chains';
import fs from 'fs';
import path from 'path';
import { ARBITRAGE_ABI } from './services/constants/arbitrageAbi';
import { TOKEN_CONFIGS } from './constants';

// Define the interfaces for type checking
interface DecodedEventLog {
    name: string | undefined;  // Allow undefined to fix type error
    args: Record<string, any>;
}

interface DecodedLog {
    address: Address;
    logIndex: number;
    data?: string;
    topics?: readonly string[];
    decoded: DecodedEventLog | null;
}

interface TokenTransfer {
    token: Address;
    from: Address;
    to: Address;
    value: bigint;
    valueFormatted: string;
}

interface GasData {
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    gasLimit: bigint;
    gasCost: bigint;
    gasCostInAVAX: string;
}

interface DetailedTransaction {
    hash: Hash;
    from: Address;
    to: Address | null;
    value: bigint;
    valueFormatted: string;
    nonce: number;
    blockNumber: bigint;
    blockHash: Hash;
    timestamp: bigint;
    status: 'success' | 'reverted';
    logs: DecodedLog[];
    tokenTransfers: TokenTransfer[];
    gasData: GasData;
    rawTransaction: Transaction;
    rawReceipt: TransactionReceipt;
}

interface TransactionFilters {
    status?: 'success' | 'reverted';
    fromBlock?: number;
    toBlock?: number;
    from?: Address;
    to?: Address;
}

/**
 * Gets detailed transaction information including logs and decoded events
 */
async function getTransactionDetails(txHash: Hash): Promise<DetailedTransaction> {
    const publicClient = createPublicClient({
        chain: avalanche,
        transport: http(process.env.AVALANCHE_RPC_URL as string),
    });

    // Fetch transaction and receipt in parallel
    const [transaction, receipt] = await Promise.all([
        publicClient.getTransaction({ hash: txHash }),
        publicClient.getTransactionReceipt({ hash: txHash })
    ]);

    // Get block information
    const block = await publicClient.getBlock({
        blockHash: receipt.blockHash
    });

    // Decode events from logs
    const decodedLogs: DecodedLog[] = await Promise.all(
        receipt.logs.map(async (log) => {
            try {
                // Try to decode with known ABIs
                const decoded = decodeEventLog({
                    abi: ARBITRAGE_ABI, // You can extend this with other ABIs
                    data: log.data,
                    topics: log.topics
                });

                return {
                    address: log.address,
                    logIndex: log.logIndex,
                    decoded: {
                        name: decoded.eventName,
                        args: decoded.args as Record<string, any>
                    }
                };
            } catch (e) {
                // Return undecoded log if not recognized
                return {
                    address: log.address,
                    logIndex: log.logIndex,
                    data: log.data,
                    topics: log.topics,
                    decoded: null
                };
            }
        })
    );

    // Try to fetch token transfers
    const tokenTransfers: TokenTransfer[] = decodedLogs
        .filter(log => log.decoded?.name === 'Transfer')
        .map(log => {
            if (!log.decoded || !log.decoded.args) {
                return null;
            }

            return {
                token: log.address,
                from: log.decoded.args.from as Address,
                to: log.decoded.args.to as Address,
                value: log.decoded.args.value as bigint,
                valueFormatted: formatUnits(
                    log.decoded.args.value as bigint,
                    getTokenDecimals(log.address)
                )
            };
        })
        .filter((transfer): transfer is TokenTransfer => transfer !== null);

    // Get gas data
    const gasData: GasData = {
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        gasLimit: transaction.gas,
        gasCost: receipt.gasUsed * receipt.effectiveGasPrice,
        gasCostInAVAX: formatEther(receipt.gasUsed * receipt.effectiveGasPrice)
    };

    return {
        hash: txHash,
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        valueFormatted: formatEther(transaction.value),
        nonce: transaction.nonce,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        timestamp: block.timestamp,
        status: receipt.status,
        logs: decodedLogs,
        tokenTransfers,
        gasData,
        rawTransaction: transaction,
        rawReceipt: receipt
    };
}

// Helper to get token decimals
function getTokenDecimals(tokenAddress: Address): number {
    const lowerCaseAddress = tokenAddress.toLowerCase() as Address;

    // Check against known token addresses
    if (lowerCaseAddress === TOKEN_CONFIGS.USDC.address.toLowerCase() as Address) {
        return TOKEN_CONFIGS.USDC.decimals;
    } else if (lowerCaseAddress === TOKEN_CONFIGS.WAVAX.address.toLowerCase() as Address) {
        return TOKEN_CONFIGS.WAVAX.decimals;
    }

    // Default fallback
    return 18;
}

// Trace transaction execution path (optional, requires archive node)
async function getTransactionTrace(txHash: Hash): Promise<any> {
    // Note: This requires an archive node or debug API support
    const response = await fetch(process.env.AVALANCHE_DEBUG_RPC_URL as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'debug_traceTransaction',
            params: [txHash, { tracer: 'callTracer' }]
        })
    });

    const result = await response.json();
    return result.result;
}

// Helper function to apply filters
function applyFilters(tx: DetailedTransaction, filters: TransactionFilters): boolean {
    if (filters.status && tx.status !== filters.status) return false;
    if (filters.fromBlock && Number(tx.blockNumber) < filters.fromBlock) return false;
    if (filters.toBlock && Number(tx.blockNumber) > filters.toBlock) return false;
    if (filters.from && tx.from.toLowerCase() !== filters.from.toLowerCase()) return false;
    if (filters.to && (!tx.to || tx.to.toLowerCase() !== filters.to.toLowerCase())) return false;

    return true;
}

// File-based storage implementation
class FileTransactionStorage {
    private readonly directory: string;

    constructor(directory = './transaction_data') {
        this.directory = directory;
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    }

    async storeTransaction(tx: DetailedTransaction): Promise<void> {
        const filePath = path.join(this.directory, `${tx.hash}.json`);
        await fs.promises.writeFile(
            filePath,
            JSON.stringify(tx, null, 2)
        );
    }

    async getTransaction(hash: Hash): Promise<DetailedTransaction> {
        const filePath = path.join(this.directory, `${hash}.json`);
        const data = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(data);
    }

    async getTransactions(filters: TransactionFilters = {}): Promise<DetailedTransaction[]> {
        const files = await fs.promises.readdir(this.directory);
        const txs: DetailedTransaction[] = [];

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            try {
                const tx = await this.getTransaction(file.replace('.json', '') as Hash);

                // Apply filters
                if (applyFilters(tx, filters)) {
                    txs.push(tx);
                }
            } catch (error) {
                console.error(`Error reading transaction ${file}:`, error);
            }
        }

        return txs;
    }
}

// Helper to determine route based on transaction logs
function determineRoute(logs: DecodedLog[]): 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap' | 'unknown' {
    // This is a simplified example - you'll need to adapt to your specific transaction flow
    const firstSwap = logs.find(log => log.decoded?.name === 'SwapInitiated');
    const secondSwap = logs.find(log =>
        log.decoded?.name === 'SwapInitiated' &&
        log !== firstSwap
    );

    if (!firstSwap?.decoded?.args || !secondSwap?.decoded?.args) {
        return 'unknown';
    }

    const firstRouter = firstSwap.decoded.args.router as Address;
    const secondRouter = secondSwap.decoded.args.router as Address;

    // Check router addresses to determine direction
    // Replace with your actual router addresses
    const UNISWAP_ROUTER = '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE'.toLowerCase();
    const TRADERJOE_ROUTER = '0x18556DA13313f3532c54711497A8FedAC273220E'.toLowerCase();

    if (
        firstRouter.toLowerCase() === UNISWAP_ROUTER &&
        secondRouter.toLowerCase() === TRADERJOE_ROUTER
    ) {
        return 'uniswap-to-traderjoe';
    } else if (
        firstRouter.toLowerCase() === TRADERJOE_ROUTER &&
        secondRouter.toLowerCase() === UNISWAP_ROUTER
    ) {
        return 'traderjoe-to-uniswap';
    }

    return 'unknown';
}

// Extract specific leg data for analysis
function extractFirstLegData(tx: DetailedTransaction): any {
    const firstSwapEvent = tx.logs.find(log =>
        log.decoded?.name === 'SwapInitiated' &&
        log.decoded?.args?.swapType === 'first'
    );

    if (!firstSwapEvent?.decoded?.args) {
        return {};
    }

    return {
        router: firstSwapEvent.decoded.args.router,
        startBalance: firstSwapEvent.decoded.args.startBalance.toString(),
        expectedOutput: firstSwapEvent.decoded.args.expectedOutput.toString()
    };
}

function extractSecondLegData(tx: DetailedTransaction): any {
    const secondSwapEvent = tx.logs.find(log =>
        log.decoded?.name === 'SwapInitiated' &&
        log.decoded?.args?.swapType === 'second'
    );

    if (!secondSwapEvent?.decoded?.args) {
        return {};
    }

    return {
        router: secondSwapEvent.decoded.args.router,
        startBalance: secondSwapEvent.decoded.args.startBalance.toString(),
        expectedOutput: secondSwapEvent.decoded.args.expectedOutput.toString()
    };
}

// Function to find ArbitrageExecuted event data
function extractArbitrageExecutedData(tx: DetailedTransaction): any {
    const event = tx.logs.find(log => log.decoded?.name === 'ArbitrageExecuted');

    if (!event?.decoded?.args) {
        return null;
    }

    const args = event.decoded.args;

    // Helper function to safely convert to BigInt
    const safeBigInt = (value: any): bigint | null => {
        if (value === undefined || value === null || value === 'N/A') {
            return null;
        }
        try {
            return BigInt(value.toString());
        } catch {
            return null;
        }
    };

    return {
        sourceToken: args.sourceToken,
        targetToken: args.targetToken,
        amountIn: safeBigInt(args.amountIn) || 0n,
        finalBalance: safeBigInt(args.finalBalance) || 0n,
        profit: safeBigInt(args.profit) || 0n,
        testMode: args.testMode || false
    };
}
function safeBigInt(value: any, defaultValue: bigint = 0n): bigint {
    // Handle null, undefined, or 'N/A' cases
    if (value === null || value === undefined || value === 'N/A') {
        return defaultValue;
    }

    // If it's already a bigint, return it
    if (typeof value === 'bigint') {
        return value;
    }

    // If it's a number, convert to bigint
    if (typeof value === 'number') {
        try {
            return BigInt(Math.floor(value));
        } catch {
            return defaultValue;
        }
    }

    // If it's a string, try parsing
    if (typeof value === 'string') {
        // Remove any non-numeric characters except for decimal point and negative sign
        const cleanedValue = value.replace(/[^0-9.-]/g, '');

        // Handle empty string
        if (cleanedValue === '') {
            return defaultValue;
        }

        try {
            // If the string contains a decimal, parse the integer part
            if (cleanedValue.includes('.')) {
                return BigInt(Math.floor(parseFloat(cleanedValue)));
            }

            // Otherwise, parse directly
            return BigInt(cleanedValue);
        } catch {
            return defaultValue;
        }
    }

    // For objects or arrays, try converting to string first
    try {
        return BigInt(String(value));
    } catch {
        return defaultValue;
    }
}
// Function to process a batch of transactions
async function processHistoricalTransactions(txHashes: Hash[]): Promise<void> {
    const storage = new FileTransactionStorage();

    // Process in batches to avoid overloading the RPC
    const batchSize = 5;

    for (let i = 0; i < txHashes.length; i += batchSize) {
        const batch = txHashes.slice(i, i + batchSize);

        console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(txHashes.length/batchSize)}`);

        // Process batch in parallel
        const results = await Promise.all(
            batch.map(async hash => {
                try {
                    return await getTransactionDetails(hash);
                } catch (err) {
                    console.error(`Error processing ${hash}:`, err);
                    return null;
                }
            })
        );

        // Filter out errors and store results
        const validResults = results.filter((result): result is DetailedTransaction => result !== null);

        for (const tx of validResults) {
            await storage.storeTransaction(tx);
            console.log(`Stored transaction ${tx.hash}`);
        }

        // Wait a bit between batches to avoid rate limiting
        if (i + batchSize < txHashes.length) {
            console.log('Waiting between batches...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    console.log(`Processed ${txHashes.length} transactions`);
}
// Helper function to get token symbol
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
// Helper function to get token address from symbol
function getTokenAddress(symbol: string): Address {
    if (symbol === TOKEN_CONFIGS.USDC.symbol) {
        return TOKEN_CONFIGS.USDC.address;
    } else if (symbol === TOKEN_CONFIGS.WAVAX.symbol) {
        return TOKEN_CONFIGS.WAVAX.address;
    }

    // Return zero address if symbol not found
    return '0x0000000000000000000000000000000000000000' as Address;
}
// Export the functions you'll need
export {
    getTransactionDetails,
    getTransactionTrace,
    getTokenDecimals,
    FileTransactionStorage,
    processHistoricalTransactions,
    determineRoute,
    extractFirstLegData,
    extractSecondLegData,
    extractArbitrageExecutedData,
    getTokenSymbol,
    getTokenAddress,
    safeBigInt,
    type DetailedTransaction,
    type DecodedLog,
    type DecodedEventLog,
    type TokenTransfer,
    type GasData,
    type TransactionFilters
};