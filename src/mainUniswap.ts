// src/mainUniswap.ts - Network-Aware Multi-Chain Trading v2.2.0 - PERCENTAGE LOGIC FIXED
// 🔧 MAJOR UPGRADE: Support for Avalanche + Arbitrum with webhook-driven network selection
// 🚀 NONCE FIX: Complete nonce management integration for concurrent webhook handling
// 🛡️ ENHANCED: Proper error handling and transaction safety
// ✅ PERCENTAGE FIX: Added proper --percentage=100 argument parsing and balance calculation
// ✅ TYPESCRIPT: All compilation errors resolved - Fixed network config structure

import type {
    TradeResult,
    TradeExecutionResult,
} from './tradeTypes.ts';
import { TransactionState } from './tradeTypes.ts';
import {
    createUniswapTrade,
    executeUniswapTrade,
    setTradeDirection,
    setTradeAmount,
    verifyNetwork,
    getCurrentConfig,
    switchNetwork,
    initializeNetwork,
    getNetworkInfo,
    getNetworkGasCostEstimate,
    getPoolAddress,
    type TradeDirection,
    type NetworkKey,
} from './uniswapv3Trade.ts';
import {
    getNetworkConfig,
    getCurrentNetworkKey,
    isNetworkSupported,
    SUPPORTED_NETWORKS,
    type ChainId
} from './constants.ts';
import { NonceManager } from './nonceManager.ts';
import logger from './logger.ts';
import {
    getErrorMessage,
    getTransactionError,
    retryOperation,
    getCurrentTimestamp
} from './utils.ts';
import { tradeTracker } from './tradeTracker.ts';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche, arbitrum } from 'viem/chains';

dotenv.config();

// ==================== NETWORK-AWARE WEBHOOK INTERFACE ====================

export interface WebhookTradeData {
    side: 'buy' | 'sell' | 'sellsl' | 'selltp';
    product: string;           // "BTC/USDC", "AVAX/USDC", "ETH/USDC"
    network: string;           // "Avalanche", "Arbitrum"
    exchange: string;          // "Uniswap"
    secret?: string;           // Authentication
}

export interface NetworkTradeContext {
    networkKey: NetworkKey;
    tradeDirection: TradeDirection;
    webhookData: WebhookTradeData;
    webhookId?: string;
    signalType?: string;
    trackTrade?: boolean;
}

// ==================== NONCE MANAGEMENT GLOBALS ====================

// Global nonce manager instances for each network
const nonceManagers = new Map<string, NonceManager>();

/**
 * Get or create nonce manager for specific account/network combination
 */
function getNonceManager(accountAddress: string, networkKey: NetworkKey): NonceManager {
    const key = `${accountAddress}-${networkKey}`;

    if (!nonceManagers.has(key)) {
        const networkConfig = getNetworkConfig(networkKey);

        // ✅ FIX: Create clients manually since they're not in the config
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }

        const account = privateKeyToAccount(
            (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
        );

        const chain = networkKey === 'AVALANCHE' ? avalanche : arbitrum;
        const rpcUrl = networkKey === 'AVALANCHE' ? process.env.AVALANCHE_RPC_URL : process.env.ARBITRUM_RPC_URL;

        const publicClient = createPublicClient({
            chain,
            transport: http(rpcUrl)
        });

        const walletClient = createWalletClient({
            account,
            chain,
            transport: http(rpcUrl)
        });

        const nonceManager = NonceManager.getInstance(
            publicClient,
            walletClient,
            accountAddress as `0x${string}`
        );
        nonceManagers.set(key, nonceManager);

        logger.info('Nonce manager created', {
            account: accountAddress,
            network: networkKey,
            key
        });
    }

    return nonceManagers.get(key)!;
}

// ==================== ARGUMENT PROCESSING FUNCTIONS ====================

/**
 * Parse CLI arguments for percentage and amount - FIXED IMPLEMENTATION
 */
function parseTradeArguments() {
    const args = process.argv.slice(2);
    let amount: number | undefined;
    let percentage: number = 100;
    let useBalance = false;

    // Process additional arguments
    for (let i = 1; i < args.length; i++) {
        const arg = args[i].toLowerCase();

        // Amount and percentage parsing
        if (arg.startsWith('--percentage=') || arg.startsWith('-p=')) {
            const percentStr = arg.split('=')[1];
            const percentValue = parseFloat(percentStr);
            if (!isNaN(percentValue) && percentValue > 0 && percentValue <= 100) {
                percentage = percentValue;
                useBalance = true;  // ✅ KEY: This enables balance-based trading
                logger.info(`Using ${percentage}% of available balance`);
            }
        }
        else if (arg.startsWith('--amount=') || arg.startsWith('-a=')) {
            const amountStr = arg.split('=')[1];
            const amountValue = parseFloat(amountStr);
            if (!isNaN(amountValue) && amountValue > 0) {
                amount = amountValue;
                logger.info(`Using fixed amount: ${amount}`);
            }
        }
        else if (arg === '--balance' || arg === '-b' || arg === '--100%') {
            percentage = 100;
            useBalance = true;
            logger.info('Using 100% of available balance');
        }
    }

    return { amount, percentage, useBalance };
}

/**
 * Parse CLI network argument with support for multiple formats
 * Supports: --network=ARBITRUM, --network ARBITRUM, -n ARBITRUM, and bare ARBITRUM
 */
function parseNetworkFromCLI(): NetworkKey | undefined {
    const args = process.argv.slice(2);

    logger.debug('Parsing CLI arguments for network', {
        args,
        supportedNetworks: Object.keys(SUPPORTED_NETWORKS)
    });

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // Handle --network=VALUE format
        if (arg.startsWith('--network=')) {
            const networkValue = arg.split('=')[1]?.toUpperCase() as NetworkKey;
            if (networkValue && SUPPORTED_NETWORKS[networkValue]) {
                logger.debug('Found network from --network=VALUE format', { networkValue });
                return networkValue;
            }
        }

        // Handle --network VALUE or -n VALUE format
        if ((arg === '--network' || arg === '-n') && i + 1 < args.length) {
            const networkValue = args[i + 1]?.toUpperCase() as NetworkKey;
            if (networkValue && SUPPORTED_NETWORKS[networkValue]) {
                logger.debug('Found network from --network VALUE format', { networkValue });
                return networkValue;
            }
        }

        // Handle bare AVALANCHE or ARBITRUM (legacy support)
        if (arg.toUpperCase() === 'AVALANCHE' || arg.toUpperCase() === 'ARBITRUM') {
            logger.debug('Found network from bare argument', { networkValue: arg.toUpperCase() });
            return arg.toUpperCase() as NetworkKey;
        }
    }

    logger.debug('No network argument found in CLI args');
    return undefined;
}

// ==================== NETWORK-AWARE UTILITIES ====================

/**
 * Parse network from webhook with fallback support
 */
function parseNetworkFromWebhook(webhookData: WebhookTradeData): NetworkKey {
    const networkString = webhookData.network?.toLowerCase();

    // Support multiple variations of network names
    const networkMap: Record<string, NetworkKey> = {
        'avalanche': 'AVALANCHE',
        'arbitrum': 'ARBITRUM',
        'arbitrum one': 'ARBITRUM',
        'arb': 'ARBITRUM',
        // Legacy support
        'avax': 'AVALANCHE',
        'avax-c': 'AVALANCHE',
        'ethereum': 'ARBITRUM', // Some users might send this for L2
    };

    if (networkString && networkMap[networkString]) {
        return networkMap[networkString];
    }

    // Default fallback
    logger.warn('Unknown network in webhook, using default', {
        provided: webhookData.network,
        defaultUsed: 'ARBITRUM'
    });

    return 'ARBITRUM';
}

/**
 * Map webhook data to trade direction with network awareness
 */
function parseTradeDirection(webhookData: WebhookTradeData, networkKey: NetworkKey): TradeDirection {
    const { side, product } = webhookData;

    if (networkKey === 'AVALANCHE') {
        if (product.includes('BTC')) {
            return side === 'buy' ? 'USDC_TO_WBTC' : 'WBTC_TO_USDC';
        } else if (product.includes('AVAX')) {
            return side === 'buy' ? 'USDC_TO_WAVAX' : 'WAVAX_TO_USDC';
        }
    } else if (networkKey === 'ARBITRUM') {
        if (product.includes('BTC')) {
            return side === 'buy' ? 'USDC_TO_WBTC_ARB' : 'WBTC_TO_USDC_ARB';
        } else if (product.includes('ETH')) {
            return side === 'buy' ? 'USDC_TO_WETH' : 'WETH_TO_USDC';
        }
    }

    throw new Error(`Unsupported product/network combination: ${product} on ${networkKey}`);
}

function parseWebhookContext(): NetworkTradeContext | undefined {
    const contextEnv = process.env.WEBHOOK_CONTEXT;
    if (!contextEnv) return undefined;

    try {
        const webhookData: WebhookTradeData = JSON.parse(contextEnv);
        const networkKey = parseNetworkFromWebhook(webhookData);
        const tradeDirection = parseTradeDirection(webhookData, networkKey);

        return {
            networkKey,
            tradeDirection,
            webhookData,
            webhookId: process.env.WEBHOOK_ID,
            signalType: webhookData.side,
            trackTrade: true
        };
    } catch (error) {
        logger.error('Failed to parse webhook context', {
            error: getErrorMessage(error),
            rawContext: contextEnv
        });
        return undefined;
    }
}

function extractNetworkAwareAddressInformation(
    network: NetworkKey,
    tradeDirection: TradeDirection,
    tradeResult: TradeResult
): any {
    try {
        const poolAddress = getPoolAddress(network, tradeDirection);
        const networkConfig = getNetworkConfig(network);
        // ✅ FIX: Get addresses from SUPPORTED_NETWORKS or use fallbacks
        const networkInfo = SUPPORTED_NETWORKS[network];
        if (!networkInfo) {
            throw new Error(`Unsupported network: ${network}`);
        }

        return {
            network,
            poolAddress: poolAddress || 'UNKNOWN',
            // ✅ CORRECTED: Use actual addresses from constants.ts
            routerAddress: networkConfig.addresses.UNISWAP_V3.ROUTER,
            factoryAddress: networkConfig.addresses.UNISWAP_V3.FACTORY,
            quoterAddress: networkConfig.addresses.UNISWAP_V3.QUOTER,
            inputTokenAddress: '', // Extract from trade result
            outputTokenAddress: ''  // Extract from trade result
        };
    } catch (error) {
        logger.warn('Failed to extract complete address information', {
            network,
            tradeDirection,
            error: getErrorMessage(error)
        });

        return {
            network,
            poolAddress: 'UNKNOWN',
            routerAddress: 'UNKNOWN',
            factoryAddress: 'UNKNOWN',
            quoterAddress: 'UNKNOWN'
        };
    }
}

// ==================== ENHANCED ERROR HANDLING ====================

/**
 * Enhanced error logging with proper transaction hash capture and nonce context
 */
function logTradeExecutionError(
    error: unknown,
    context: {
        network: NetworkKey;
        tradeId: string;
        transactionHash?: string;
        webhookId?: string;
        nonce?: number;
        operation?: string;
    }
): void {
    const errorMessage = getErrorMessage(error);
    const transactionError = getTransactionError(error);

    logger.error('🚨 Network-aware trade execution error with nonce context', {
        network: context.network,
        tradeId: context.tradeId,
        operation: context.operation || 'unknown',
        webhookId: context.webhookId,
        nonce: context.nonce,
        error: {
            message: errorMessage,
            transaction: transactionError,
            hash: context.transactionHash || 'unknown',
            timestamp: getCurrentTimestamp()
        },
        nonceManagerStatus: context.nonce ? {
            currentNonce: context.nonce,
            timestamp: new Date().toISOString()
        } : undefined
    });
}

// ==================== MAIN TRADE EXECUTION FUNCTION ====================

/**
 * 🚀 ENHANCED: Main execution function with integrated nonce management and PERCENTAGE LOGIC
 * Handles both CLI and webhook execution with proper nonce coordination
 */
async function main(trackingContext?: NetworkTradeContext): Promise<void> {
    // 🔧 MOVE VARIABLE DECLARATIONS OUTSIDE try block for scope access
    let targetNetwork: NetworkKey = getCurrentNetworkKey(); // Default fallback
    let tradeDirection: TradeDirection;
    let trackTrade = false;

    // Global execution timeout with nonce cleanup
    const EXECUTION_TIMEOUT = 300000; // 5 minutes
    const executionTimer = setTimeout(() => {
        logger.error('Trade execution timeout - cleaning up nonce managers', {
            timeout: `${EXECUTION_TIMEOUT}ms`,
            trackingContext: trackingContext ? {
                network: trackingContext.networkKey,
                webhookId: trackingContext.webhookId
            } : undefined
        });

        // Cleanup nonce managers on timeout
        nonceManagers.forEach((manager, key) => {
            manager.cleanup();
            logger.debug('Nonce manager cleaned up on timeout', { key });
        });

        // 🚀 WEBHOOK FIX: Only exit if not called from webhook
        if (!trackingContext) {
            process.exit(1);
        } else {
            throw new Error('Trade execution timeout');
        }
    }, EXECUTION_TIMEOUT);

    try {
        const startTime = process.hrtime();
        const executionStartTime = performance.now();

        logger.info('Starting Network-Aware Multi-Chain Trade Execution v2.2.0 with Nonce Management', {
            supportedNetworks: Object.keys(SUPPORTED_NETWORKS),
            trackingEnabled: !!trackingContext?.trackTrade,
            webhookContext: trackingContext ? {
                network: trackingContext.networkKey,
                tradeDirection: trackingContext.tradeDirection,
                webhookId: trackingContext.webhookId
            } : 'CLI Mode'
        });

        // Network context resolution with enhanced logging
        // 🔧 VARIABLES NOW DECLARED ABOVE - just assign values here

        if (trackingContext) {
            // Webhook mode - use provided context
            targetNetwork = trackingContext.networkKey;
            tradeDirection = trackingContext.tradeDirection;
            trackTrade = trackingContext.trackTrade || false;

            logger.info('Using webhook-provided network context', {
                network: targetNetwork,
                tradeDirection,
                trackTrade,
                webhookId: trackingContext.webhookId,
                timestamp: Date.now()
            });
        } else {
            // 🔧 CLI mode - determine from arguments, then environment
            const argNetwork = parseNetworkFromCLI();
            targetNetwork = argNetwork || getCurrentNetworkKey();

            if (!isNetworkSupported(SUPPORTED_NETWORKS[targetNetwork]?.chainId)) {
                throw new Error(`Unsupported network: ${targetNetwork}. 
Supported: ${Object.keys(SUPPORTED_NETWORKS).join(', ')}`);
            }

            // For CLI mode, determine trade direction from first argument or environment
            const firstArg = process.argv[2];
            const envDirection = process.env.TRADE_DIRECTION as TradeDirection;

            // Use first argument as trade direction if it looks like one
            if (firstArg && (firstArg.includes('TO') || firstArg.includes('_'))) {
                tradeDirection = firstArg as TradeDirection;
            } else {
                tradeDirection = envDirection || (targetNetwork === 'AVALANCHE' ? 'USDC_TO_WBTC' : 'USDC_TO_WETH');
            }

            trackTrade = process.env.TRACK_TRADES === 'true';

            logger.info('Using CLI network context', {
                network: targetNetwork,
                tradeDirection,
                trackTrade,
                source: argNetwork ? 'command_line' : 'environment',
                cliArgs: process.argv.slice(2),
                firstArg
            });
        }

        // Initialize network with enhanced verification
        logger.info('Initializing network with nonce management support', {
            network: targetNetwork,
            chainId: SUPPORTED_NETWORKS[targetNetwork].chainId
        });

        await initializeNetwork(targetNetwork);
        await verifyNetwork(targetNetwork);

        const networkInfo = getNetworkInfo(targetNetwork);
        logger.info('Network verification successful', {
            network: targetNetwork,
            chainName: networkInfo.name,
            chainId: networkInfo.chainId,
            nativeCurrency: networkInfo.nativeCurrency
        });

        // ==================== FIXED TRADE PARAMETERS SECTION ====================

        // Set trade direction
        await setTradeDirection(tradeDirection);

        // 🚀 AMOUNT DETERMINATION: Handle webhook vs manual trades (from mainUniswapBackup.ts)
        let amount: number | undefined;
        let percentage: number = 100;
        let useBalance = false;

        if (trackingContext) {
            // Webhook context - use configured amounts from environment variables
            const signalType = trackingContext.signalType || trackingContext.webhookData.side;

            if (signalType === 'buy') {
                amount = parseFloat(process.env.BUY_AMOUNT || '15');
                useBalance = false;
                logger.info('Using configured buy amount for webhook', {
                    amount,
                    source: 'BUY_AMOUNT environment variable'
                });
            } else {
                percentage = parseFloat(process.env.SELL_PERCENTAGE || '100');
                useBalance = true;
                logger.info('Using configured sell percentage for webhook', {
                    percentage,
                    source: 'SELL_PERCENTAGE environment variable'
                });
            }
        } else {
            // CLI context - parse arguments for percentage and amount
            const parsedArgs = parseTradeArguments();
            amount = parsedArgs.amount;
            percentage = parsedArgs.percentage;
            useBalance = parsedArgs.useBalance;
        }

        // Set trade amount using the correct setTradeAmount signature
        if (useBalance) {
            // 🚀 PERCENTAGE-BASED: Query actual balance and use percentage
            await setTradeAmount(percentage, true, targetNetwork);
            logger.info('Trade amount set to percentage of balance', {
                percentage,
                network: targetNetwork,
                mode: 'balance_percentage'
            });
        } else if (amount !== undefined) {
            // 💰 FIXED AMOUNT: Use specified amount
            await setTradeAmount(amount, false, targetNetwork);
            logger.info('Trade amount set to fixed value', {
                amount,
                network: targetNetwork,
                mode: 'fixed_amount'
            });
        } else {
            logger.error('No amount or percentage specified for trade');

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error('No amount or percentage specified for trade');
            }
        }

        logger.info('Trade parameters configured', {
            network: targetNetwork,
            direction: tradeDirection
        });

        // Create trade with nonce-aware error handling
        logger.info('Creating network-aware trade with nonce management', {
            network: targetNetwork,
            direction: tradeDirection
        });

        const tradeResult: TradeResult = await Promise.race([
            createUniswapTrade(targetNetwork),
            new Promise<TradeResult>((_, reject) =>
                setTimeout(() => reject(new Error('Trade creation timeout')), 30000)
            )
        ]);

        clearTimeout(executionTimer);

        // Handle trade result with network-aware processing
        if (!tradeResult.success) {
            logger.error('Network-aware trade creation failed', {
                error: tradeResult.error,
                network: targetNetwork,
                tradeId: tradeResult.tradeId
            });

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error(tradeResult.error || 'Trade creation failed');
            }
        }
        logger.info('Network-aware trade created successfully, executing with nonce management...', {
            network: targetNetwork,
            tradeId: tradeResult.tradeId
        });

        // Execute the trade with nonce management
        const executionResult: TradeExecutionResult = await Promise.race([
            executeUniswapTrade(tradeResult, targetNetwork, trackingContext?.webhookId),
            new Promise<TradeExecutionResult>((_, reject) =>
                setTimeout(() => reject(new Error('Trade execution timeout')), 60000)
            )
        ]);

        // Check execution result
        if (executionResult.state === TransactionState.Failed) {
            logger.error('Trade execution failed', {
                error: executionResult.error,
                network: targetNetwork,
                tradeId: tradeResult.tradeId
            });

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error(executionResult.error || 'Trade execution failed');
            }
        }
        clearTimeout(executionTimer);
        // Enhanced trade execution logging with proper property access
        logger.info('🎉 Network-aware trade execution completed successfully with nonce management', {
            network: targetNetwork,
            elapsedTime: `${((performance.now() - executionStartTime) / 1000).toFixed(2)}s`,
            executionTime: `${(performance.now() - executionStartTime).toFixed(2)}ms`,
            state: executionResult?.state || TransactionState.Sent,
            hash: executionResult?.hash || 'undefined',
            blockNumber: executionResult?.blockNumber?.toString() || 'unknown',
            gasUsed: executionResult?.gasUsed || tradeResult.gasUsed || 'unknown',
            trackingEnabled: trackTrade
        });

        // Record trade for tracking if enabled
        if (trackTrade && tradeResult.success) {
            try {
                const addressInfo = extractNetworkAwareAddressInformation(
                    targetNetwork,
                    tradeDirection,
                    tradeResult
                );

                const tokenPair = getTokenPairFromDirection(tradeDirection);
                const productForWebhook = tokenPair.replace('-', '/');
                // Create proper webhook data structure
                const webhookData: WebhookTradeData = {
                    side: tradeDirection.includes('TO_USDC') ? 'sell' : 'buy',
                    product: productForWebhook,
                    network: targetNetwork,
                    exchange: 'Uniswap'
                };

                await tradeTracker.recordTrade({
                    webhookData,
                    tradeDirection,
                    tradeResult,
                    executionResult,
                    webhookId: trackingContext?.webhookId || `cli-${Date.now()}`,
                    signalType: webhookData.side,
                    executionTimestamp: getCurrentTimestamp(),
                    signalTimestamp: getCurrentTimestamp(),
                    addressInfo: {
                        tokenAddresses: {
                            inputToken: {
                                address: tradeResult.tokensTraded?.firstLeg?.input?.address || '',
                                symbol: tradeResult.tokensTraded?.firstLeg?.input?.symbol || 'UNKNOWN',
                                decimals: 18
                            },
                            outputToken: {
                                address: tradeResult.tokensTraded?.firstLeg?.output?.address || '',
                                symbol: tradeResult.tokensTraded?.firstLeg?.output?.symbol || 'UNKNOWN',
                                decimals: 18
                            }
                        },
                        protocolAddresses: {
                            routerAddress: addressInfo.routerAddress,
                            poolAddress: addressInfo.poolAddress,
                            factoryAddress: addressInfo.factoryAddress,
                            quoterAddress: addressInfo.quoterAddress
                        }
                    }
                });

                logger.info('Trade recorded for network-aware tracking', {
                    tradeId: tradeResult.tradeId,
                    network: targetNetwork,
                    tokenPair
                });
            } catch (trackingError) {
                logger.error('Failed to record trade for tracking', {
                    error: getErrorMessage(trackingError),
                    tradeId: tradeResult.tradeId,
                    network: targetNetwork
                });
            }
        }

        // Success cleanup
        logger.info('Network-aware trade execution completed successfully', {
            network: targetNetwork,
            tradeId: tradeResult.tradeId,
            executionTimeMs: (performance.now() - executionStartTime).toFixed(2)
        });

        // 🚀 WEBHOOK FIX: Don't call process.exit() when called from webhook
        if (!trackingContext) {
            process.exit(0);
        } else {
            return; // Just return, don't kill webhook server
        }

    } catch (error) {
        const errorContext = {
            network: targetNetwork,  // ✅ NOW AVAILABLE - declared outside try block
            tradeId: `error-${Date.now()}`,
            webhookId: trackingContext?.webhookId,
            operation: 'main_execution'
        };

        logTradeExecutionError(error, errorContext);

        // Cleanup nonce managers on error
        nonceManagers.forEach((manager, key) => {
            manager.cleanup();
            logger.debug('Nonce manager cleaned up on error', { key });
        });

        clearTimeout(executionTimer);

        // 🚀 WEBHOOK FIX: Only exit if not called from webhook
        if (!trackingContext) {
            process.exit(1);
        } else {
            throw error; // Re-throw for webhook error handling
        }
    }
}

function getTokenPairFromDirection(tradeDirection: TradeDirection): string {
    if (tradeDirection.includes('WBTC')) return 'BTC-USDC';
    if (tradeDirection.includes('WETH')) return 'ETH-USDC';
    if (tradeDirection.includes('WAVAX')) return 'AVAX-USDC';
    return 'UNKNOWN-USDC';
}
function getProductFromDirection(tradeDirection: TradeDirection): string {
    if (tradeDirection.includes('WBTC')) return 'BTC/USDC';
    if (tradeDirection.includes('WETH')) return 'ETH/USDC';
    if (tradeDirection.includes('WAVAX')) return 'AVAX/USDC';
    return 'UNKNOWN/USDC';
}
// ==================== EXPORT FUNCTIONS ====================

/**
 * 🚀 ENHANCED: Network-aware main function for webhook integration with nonce management
 * This function properly delegates to the main() function which contains all the trade execution logic
 */
export async function executeTradeWithTracking(trackingContext: NetworkTradeContext): Promise<void> {
    logger.info('🚀 WEBHOOK: executeTradeWithTracking called with nonce management', {
        network: trackingContext.networkKey,
        tradeDirection: trackingContext.tradeDirection,
        product: trackingContext.webhookData.product,
        side: trackingContext.webhookData.side,
        webhookId: trackingContext.webhookId
    });

    // Simply call the main function with the tracking context
    // This ensures webhook trades use the exact same logic as manual trades
    return main(trackingContext);
}

/**
 * Export nonce manager access for testing and monitoring
 */
export function getNonceManagerStatus(): Array<{
    key: string;
    account: string;
    nextNonce: number;
    pendingCount: number;
    pendingNonces: number[];
}> {
    const status = [];
    for (const [key, manager] of nonceManagers.entries()) {
        const managerStatus = manager.getStatus();
        status.push({
            key,
            ...managerStatus
        });
    }
    return status;
}

/**
 * Force refresh all nonce managers (emergency function)
 */
export async function refreshAllNonces(): Promise<void> {
    logger.info('Force refreshing all nonce managers', {
        count: nonceManagers.size
    });

    for (const [key, manager] of nonceManagers.entries()) {
        try {
            await manager.refreshNonce();
            logger.info('Nonce refreshed', { key });
        } catch (error) {
            logger.error('Failed to refresh nonce', {
                key,
                error: getErrorMessage(error)
            });
        }
    }
}

// ES Module-compatible main execution detection
const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

async function handleDirectExecution() {
    try {
        const webhookContext = parseWebhookContext();

        logger.info('Network-aware script executed directly with nonce management', {
            hasWebhookContext: !!webhookContext,
            network: webhookContext?.networkKey || 'default',
            args: process.argv.slice(2),
            supportedNetworks: Object.keys(SUPPORTED_NETWORKS)
        });

        await main(webhookContext);
    } catch (error) {
        logger.error('Fatal error in network-aware direct execution', {
            error: getErrorMessage(error)
        });
        process.exit(1);
    }
}

if (isMainModule) {
    handleDirectExecution();
}