// src/mainUniswap.ts - Network-Aware Multi-Chain Trading v2.1.0 - WEBHOOK FIXED
// 🔧 MAJOR UPGRADE: Support for Avalanche + Arbitrum with webhook-driven network selection
// 🚀 WEBHOOK FIX: Complete executeTradeWithTracking implementation

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
import logger from './logger.ts';
import { getErrorMessage, getCurrentTimestamp } from './utils.ts';
import { tradeTracker } from './tradeTracker.ts';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

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
function mapWebhookToTradeDirection(webhookData: WebhookTradeData, networkKey: NetworkKey): TradeDirection {
    const isBuySignal = ['buy'].includes(webhookData.side.toLowerCase());
    const normalizedProduct = webhookData.product.toUpperCase();

    // Network-specific product mapping
    const networkMapping = {
        'AVALANCHE': {
            'BTC/USDC': { buy: 'USDC_TO_WBTC', sell: 'WBTC_TO_USDC' },
            'AVAX/USDC': { buy: 'USDC_TO_WAVAX', sell: 'WAVAX_TO_USDC' },
        },
        'ARBITRUM': {
            'BTC/USDC': { buy: 'USDC_TO_WBTC_ARB', sell: 'WBTC_TO_USDC_ARB' },
            'ETH/USDC': { buy: 'USDC_TO_WETH', sell: 'WETH_TO_USDC' },
        }
    };

    const productMapping = networkMapping[networkKey]?.[normalizedProduct as keyof typeof networkMapping[typeof networkKey]];

    if (!productMapping) {
        throw new Error(`Product ${normalizedProduct} not supported on ${networkKey}`);
    }

    return (isBuySignal ? productMapping.buy : productMapping.sell) as TradeDirection;
}

// ==================== ARGUMENT PROCESSING ====================

/**
 * Enhanced argument processing with network awareness
 */
function processArgs() {
    const args = process.argv.slice(2);
    let direction: TradeDirection | undefined;
    let amount: number | undefined;
    let percentage: number = 100;
    let useBalance = false;
    let network: NetworkKey | undefined;
    let trackTrade = false;

    // First argument is always the trade direction (if present)
    if (args.length > 0) {
        const firstArg = args[0].toUpperCase();

        // Validate trade direction
        const validDirections = [
            'USDC_TO_WBTC', 'WBTC_TO_USDC',
            'USDC_TO_WAVAX', 'WAVAX_TO_USDC',
            'USDC_TO_WBTC_ARB', 'WBTC_TO_USDC_ARB',
            'USDC_TO_WETH', 'WETH_TO_USDC'
        ];

        if (validDirections.includes(firstArg as TradeDirection)) {
            direction = firstArg as TradeDirection;
            logger.info('Trade direction set from command line', { direction });
        } else {
            logger.warn('Invalid trade direction provided', {
                provided: firstArg,
                valid: validDirections
            });
            logger.error(`Invalid trade direction: ${firstArg}. Use network-aware directions.`);
        }
    }

    // Process additional arguments
    for (let i = 1; i < args.length; i++) {
        const arg = args[i].toLowerCase();

        // Network selection
        if (arg.startsWith('--network=') || arg.startsWith('-n=')) {
            const networkStr = arg.split('=')[1].toUpperCase();
            if (networkStr === 'AVALANCHE' || networkStr === 'ARBITRUM') {
                network = networkStr as NetworkKey;
                logger.info('Network set from command line', { network });
            } else {
                logger.warn('Invalid network specified', {
                    provided: networkStr,
                    supported: ['AVALANCHE', 'ARBITRUM']
                });
            }
        }

        // Amount and percentage parsing (existing logic)
        else if (arg.startsWith('--percentage=') || arg.startsWith('-p=')) {
            const percentStr = arg.split('=')[1];
            const percentValue = parseFloat(percentStr);
            if (!isNaN(percentValue) && percentValue > 0 && percentValue <= 100) {
                percentage = percentValue;
                useBalance = true;
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
        else if (arg === '--track-trade' || arg === '--track') {
            trackTrade = true;
            logger.info('Trade tracking enabled');
        }
    }

    const webhookContext = parseWebhookContext();

    return {
        direction,
        amount,
        percentage,
        useBalance,
        network,
        trackTrade,
        webhookContext
    };
}

/**
 * Parse webhook context with network awareness
 */
function parseWebhookContext(): NetworkTradeContext | undefined {
    try {
        const webhookContextStr = process.env.WEBHOOK_CONTEXT;
        if (!webhookContextStr) {
            logger.debug('No WEBHOOK_CONTEXT environment variable found');
            return undefined;
        }

        const parsed = JSON.parse(webhookContextStr);

        // Validate webhook data structure
        if (!parsed.webhookData || !parsed.webhookData.network) {
            logger.warn('Invalid webhook context structure', { parsed });
            return undefined;
        }

        const webhookData = parsed.webhookData as WebhookTradeData;

        // Parse network from webhook
        const networkKey = parseNetworkFromWebhook(webhookData);

        // Map to trade direction
        const tradeDirection = mapWebhookToTradeDirection(webhookData, networkKey);

        const context: NetworkTradeContext = {
            networkKey,
            tradeDirection,
            webhookData,
            webhookId: parsed.webhookId,
            signalType: parsed.signalType,
            trackTrade: parsed.trackTrade
        };

        logger.info('Network-aware webhook context parsed successfully', {
            networkKey,
            tradeDirection,
            product: webhookData.product,
            side: webhookData.side,
            webhookId: context.webhookId
        });

        return context;
    } catch (error) {
        logger.error('Failed to parse network-aware webhook context', {
            error: getErrorMessage(error),
            rawValue: process.env.WEBHOOK_CONTEXT?.substring(0, 100)
        });
        return undefined;
    }
}

// ==================== NETWORK-AWARE TRADE RECORDING ====================

/**
 * Extract address information for network-aware trade tracking
 */
function extractNetworkAwareAddressInformation(
    networkKey: NetworkKey,
    tradeDirection: TradeDirection,
    tradeResult: TradeResult,
    poolAddress?: string
) {
    const networkConfig = getNetworkConfig(networkKey);
    const currentConfig = getCurrentConfig();

    if (!currentConfig) {
        logger.warn('No current config available for address extraction', {
            network: networkKey,
            tradeDirection
        });
        return undefined;
    }

    const tokenAddresses = {
        inputToken: {
            address: currentConfig.tokens.in.address,
            symbol: currentConfig.tokens.in.symbol || 'UNKNOWN',
            decimals: currentConfig.tokens.in.decimals
        },
        outputToken: {
            address: currentConfig.tokens.out.address,
            symbol: currentConfig.tokens.out.symbol || 'UNKNOWN',
            decimals: currentConfig.tokens.out.decimals
        }
    };

    const protocolAddresses = {
        routerAddress: networkConfig.addresses.UNISWAP_V3.ROUTER,
        poolAddress: poolAddress || getPoolAddress(networkKey),
        factoryAddress: networkConfig.addresses.UNISWAP_V3.FACTORY,
        quoterAddress: networkConfig.addresses.UNISWAP_V3.QUOTER
    };

    const executionDetails = {
        poolFee: currentConfig.tokens.poolFee,
        slippageTolerance: networkConfig.tradeSettings.DEFAULT_SLIPPAGE_BPS / 10000,
        priceImpact: undefined,
        executionPrice: tradeResult.actualAmountOut && tradeResult.actualAmountIn ?
            (parseFloat(tradeResult.actualAmountOut) / parseFloat(tradeResult.actualAmountIn)).toFixed(6) :
            undefined,
        minimumAmountOut: undefined
    };

    return {
        tokenAddresses,
        protocolAddresses,
        executionDetails
    };
}

/**
 * Record network-aware trade with enhanced context
 */
async function recordNetworkAwareTrade(
    networkKey: NetworkKey,
    tradeDirection: TradeDirection,
    tradeResult: TradeResult,
    executionResult: TradeExecutionResult,
    webhookData: WebhookTradeData,
    addressInfo: any,
    trackingContext?: NetworkTradeContext
) {
    try {
        const executionTimeMs = performance.now() - (trackingContext?.signalType ? 0 : performance.now());
        const webhookId = trackingContext?.webhookId || `manual_${networkKey.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const signalType = trackingContext?.signalType || `Manual ${networkKey} Trade`;

        logger.info('Recording network-aware trade', {
            network: networkKey,
            tradeDirection,
            webhookId,
            signalType,
            transactionHash: executionResult.hash,
            executionTime: `${executionTimeMs.toFixed(2)}ms`
        });

        const networkConfig = getNetworkConfig(networkKey);

        const recordedId = await tradeTracker.recordTrade({
            webhookData,
            tradeDirection,
            tradeResult,
            executionResult,
            webhookId,
            signalType,
            executionTime: executionTimeMs,
            executionTimestamp: getCurrentTimestamp(),
            addressInfo: addressInfo || undefined
        });

        logger.info('Network-aware trade recorded successfully', {
            recordedId,
            network: networkKey,
            tradeDirection,
            signalType,
            executionTime: `${executionTimeMs.toFixed(2)}ms`,
            webhookId
        });

    } catch (trackingError) {
        logger.error('Failed to record network-aware trade', {
            error: getErrorMessage(trackingError),
            network: networkKey,
            tradeId: tradeResult.tradeId
        });
    }
}

/**
 * Create synthetic webhook data for manual trades
 */
function createSyntheticWebhookData(tradeDirection: TradeDirection, networkKey: NetworkKey): WebhookTradeData {
    const isBuyDirection = tradeDirection.includes('USDC_TO');

    // Determine product based on trade direction and network
    let product: string;
    if (networkKey === 'AVALANCHE') {
        if (tradeDirection.includes('WAVAX')) {
            product = 'AVAX/USDC';
        } else if (tradeDirection.includes('WBTC')) {
            product = 'BTC/USDC';
        } else {
            product = 'UNKNOWN/USDC';
        }
    } else if (networkKey === 'ARBITRUM') {
        if (tradeDirection.includes('WETH')) {
            product = 'ETH/USDC';
        } else if (tradeDirection.includes('WBTC')) {
            product = 'BTC/USDC';
        } else {
            product = 'UNKNOWN/USDC';
        }
    } else {
        product = 'UNKNOWN/USDC';
    }

    return {
        side: isBuyDirection ? 'buy' : 'sell',
        product,
        network: (SUPPORTED_NETWORKS as Record<NetworkKey, any>)[networkKey].name,
        exchange: 'Uniswap'
    };
}

// ==================== MAIN EXECUTION FUNCTION ====================

/**
 * Enhanced main function with network awareness
 */
/**
 * Enhanced main function with network awareness
 * 🚀 WEBHOOK FIX: Don't call process.exit() when called from webhook context
 */
async function main(trackingContext?: NetworkTradeContext): Promise<void> {
    // Global error handler
    const globalErrorHandler = (error: any) => {
        logger.error('Uncaught exception in network-aware main process', {
            error: getErrorMessage(error),
            stack: error.stack
        });

        // 🚀 WEBHOOK FIX: Only exit if not called from webhook
        if (!trackingContext) {
            process.exit(1);
        } else {
            throw error; // Let webhook handler catch and handle
        }
    };

    process.on('uncaughtException', globalErrorHandler);
    process.on('unhandledRejection', globalErrorHandler);

    // Execution timeout
    const EXECUTION_TIMEOUT = 120000; // 2 minutes for network operations
    const executionTimer = setTimeout(() => {
        logger.error('Main execution timeout - forcing exit', {
            timeout: EXECUTION_TIMEOUT,
            trackingContext: trackingContext ? {
                network: trackingContext.networkKey,
                webhookId: trackingContext.webhookId
            } : undefined
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

        logger.info('Starting Network-Aware Multi-Chain Trade Execution v2.0.0', {
            supportedNetworks: Object.keys(SUPPORTED_NETWORKS),
            trackingEnabled: !!trackingContext?.trackTrade,
            webhookContext: trackingContext ? {
                network: trackingContext.networkKey,
                tradeDirection: trackingContext.tradeDirection,
                product: trackingContext.webhookData.product
            } : undefined
        });

        // Process arguments and determine network context
        const parsedArgs = processArgs();
        let {
            direction: tradeDirection,
            amount,
            percentage,
            useBalance,
            network: argNetwork,
            trackTrade
        } = parsedArgs;

        // Determine target network (priority: webhook > args > environment > default)
        let targetNetwork: NetworkKey;
        if (trackingContext?.networkKey) {
            targetNetwork = trackingContext.networkKey;
            tradeDirection = trackingContext.tradeDirection;
            logger.info('Using network from webhook context', {
                network: targetNetwork,
                tradeDirection
            });
        } else if (argNetwork) {
            targetNetwork = argNetwork;
            logger.info('Using network from command line argument', { network: targetNetwork });
        } else {
            targetNetwork = getCurrentNetworkKey();
            logger.info('Using default network from environment', { network: targetNetwork });
        }

        // Override tracking if webhook context provided
        if (trackingContext?.trackTrade) {
            trackTrade = true;
        }

        // Initialize target network
        logger.info('Initializing target network', { network: targetNetwork });
        const networkInitialized = await initializeNetwork(targetNetwork);
        if (!networkInitialized) {
            const errorMsg = `Failed to initialize network: ${targetNetwork}`;
            logger.error(errorMsg);

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error(errorMsg);
            }
        }

        // Verify network connectivity
        logger.info('Verifying network connectivity', { network: targetNetwork });
        const networkVerified = await Promise.race([
            verifyNetwork(targetNetwork),
            new Promise<boolean>((_, reject) =>
                setTimeout(() => reject(new Error('Network verification timeout')), 30000)
            )
        ]);

        if (!networkVerified) {
            const errorMsg = `Network verification failed for ${targetNetwork}. Check RPC connectivity.`;
            logger.error(errorMsg);

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error(errorMsg);
            }
        }

        // Validate trade direction
        if (!tradeDirection) {
            logger.error('No trade direction specified');

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error('No trade direction specified');
            }
        }

        // Set trade direction
        setTradeDirection(tradeDirection, targetNetwork);

        // Handle amount determination for webhook vs manual trades
        if (trackingContext) {
            // Webhook context - use configured amounts
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
        }

        // Set trade amount using the correct setTradeAmount signature
        if (useBalance) {
            await setTradeAmount(percentage, true, targetNetwork);
        } else if (amount !== undefined) {
            await setTradeAmount(amount, false, targetNetwork);
        } else {
            logger.error('No amount or percentage specified for trade');

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error('No amount or percentage specified for trade');
            }
        }

        // Create the trade
        logger.info('Creating network-aware trade', {
            network: targetNetwork,
            direction: tradeDirection
        });

        const tradeResult: TradeResult = await Promise.race([
            createUniswapTrade(targetNetwork),
            new Promise<TradeResult>((_, reject) =>
                setTimeout(() => reject(new Error('Trade creation timeout')), 45000)
            )
        ]);

        if (!tradeResult.success) {
            logger.error('Network-aware trade creation failed', {
                error: tradeResult.error,
                network: targetNetwork,
                tradeId: tradeResult.tradeId
            });

            // Handle no balance scenario for automation
            if (tradeResult.error && tradeResult.error.includes('No balance available')) {
                logger.info('No token balance available - skipping trade for automation', {
                    network: targetNetwork,
                    direction: tradeDirection
                });
                clearTimeout(executionTimer);

                // 🚀 WEBHOOK FIX: Only exit if not called from webhook
                if (!trackingContext) {
                    process.exit(0);
                } else {
                    return; // Just return, don't kill webhook server
                }
            }

            clearTimeout(executionTimer);

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error(tradeResult.error || 'Trade creation failed');
            }
        }

        logger.info('Network-aware trade created successfully, executing...', {
            network: targetNetwork,
            tradeId: tradeResult.tradeId
        });

        // Execute the trade
        const executionResult: TradeExecutionResult = await Promise.race([
            executeUniswapTrade(tradeResult, targetNetwork),
            new Promise<TradeExecutionResult>((_, reject) =>
                setTimeout(() => reject(new Error('Trade execution timeout')), 60000)
            )
        ]);

        // Calculate elapsed time
        const endTime = process.hrtime(startTime);
        const elapsedTime = (endTime[0] + endTime[1] / 1e9).toFixed(2);
        const executionTimeMs = performance.now() - executionStartTime;

        // Record trade with network context if tracking enabled
        if (trackTrade) {
            const addressInfo = extractNetworkAwareAddressInformation(
                targetNetwork,
                tradeDirection,
                tradeResult
            );

            const webhookData = trackingContext?.webhookData ||
                createSyntheticWebhookData(tradeDirection, targetNetwork);

            await recordNetworkAwareTrade(
                targetNetwork,
                tradeDirection,
                tradeResult,
                executionResult,
                webhookData,
                addressInfo,
                trackingContext
            );
        }

        if (executionResult.state === TransactionState.Failed) {
            logger.error('Network-aware trade execution failed', {
                network: targetNetwork,
                error: executionResult.hash,
                tradeId: tradeResult.tradeId
            });
            clearTimeout(executionTimer);

            // 🚀 WEBHOOK FIX: Only exit if not called from webhook
            if (!trackingContext) {
                process.exit(1);
            } else {
                throw new Error('Trade execution failed');
            }
        }

        // Display success information
        logger.info('✅ Network-aware trade completed successfully', {
            network: targetNetwork,
            networkName: SUPPORTED_NETWORKS[targetNetwork].name,
            chainId: SUPPORTED_NETWORKS[targetNetwork].chainId,
            transactionHash: executionResult.hash,
            tradeId: tradeResult.tradeId,
            inputAmount: tradeResult.actualAmountIn,
            outputAmount: tradeResult.actualAmountOut,
            elapsedTime: `${elapsedTime}s`,
            executionTime: `${executionTimeMs.toFixed(2)}ms`,
            gasUsed: executionResult.gasUsed?.toString(),
            gasPrice: executionResult.effectiveGasPrice?.toString(),
            isWebhookTrade: !!trackingContext // 🚀 NEW: Log if this was a webhook trade
        });

        clearTimeout(executionTimer);

        // 🚀 WEBHOOK FIX: Only exit if NOT called from webhook context
        if (!trackingContext) {
            logger.info('CLI trade completed - exiting process');
            process.exit(0);
        } else {
            logger.info('🚀 Webhook trade completed - returning to webhook server');
            // Just return, don't exit - let webhook server continue running
            return;
        }

    } catch (error) {
        clearTimeout(executionTimer);
        logger.error('Fatal error in network-aware trade execution', {
            error: getErrorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString(),
            trackingContext: trackingContext ? {
                network: trackingContext.networkKey,
                webhookId: trackingContext.webhookId
            } : undefined
        });

        // 🚀 WEBHOOK FIX: Only exit if not called from webhook
        if (!trackingContext) {
            process.exit(1);
        } else {
            throw error; // Re-throw for webhook error handling
        }
    }
}

// ==================== EXPORT FUNCTIONS ====================

/**
 * 🚀 FIXED: Network-aware main function for webhook integration
 * This function properly delegates to the main() function which contains all the trade execution logic
 */
export async function executeTradeWithTracking(trackingContext: NetworkTradeContext): Promise<void> {
    logger.info('🚀 WEBHOOK: executeTradeWithTracking called', {
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

// ES Module-compatible main execution detection
const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

async function handleDirectExecution() {
    try {
        const webhookContext = parseWebhookContext();

        logger.info('Network-aware script executed directly', {
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