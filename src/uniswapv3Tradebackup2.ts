// src/uniswapv3Trade.ts - Network-Aware Uniswap V3 Trading v2.2.0 - NONCE MANAGEMENT INTEGRATED
// 🔧 MAJOR UPGRADE: Complete nonce management integration for concurrent webhook handling
// 🛡️ ENHANCED: Safe transaction execution with proper nonce coordination
// 🚀 PRODUCTION: Multi-network support with enhanced error handling
// ✅ TYPESCRIPT: All compilation errors resolved - Fixed network config structure

import {
    createPublicClient,
    createWalletClient,
    http,
    formatUnits,
    parseUnits,
    type Address,
    type Hash,
    type PublicClient,
    type WalletClient,
    type Abi,
    ContractFunctionRevertedError
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, avalanche } from 'viem/chains';
import {
    AlphaRouter,
    SwapType,
    type V3Route
} from '@uniswap/smart-order-router';
import { ethers } from 'ethers';
import {
    CurrencyAmount,
    Token,
    TradeType,
    Percent,
    Currency,
} from '@uniswap/sdk-core';
import { Trade } from '@uniswap/v3-sdk';
import {
    getNetworkConfig,
    getCurrentNetworkKey,
    isNetworkSupported,
    SUPPORTED_NETWORKS,
    POOL_FEES,
    ABIS,
    DUST_THRESHOLDS,
    type ChainId,
    type ArbitrumTokenSymbol,
    type AvalancheTokenSymbol
} from './constants.ts';
import { NonceManager } from './nonceManager.ts';
import logger from './logger.ts';
import {
    getErrorMessage,
    getTransactionError,
    retryOperation,
    getCurrentTimestamp
} from './utils.ts';
import type {
    TradeResult,
    TradeExecutionResult,
} from './tradeTypes.ts';
import { TransactionState } from './tradeTypes.ts';

// ==================== TYPE DEFINITIONS ====================

export type TradeDirection =
    | 'USDC_TO_WBTC' | 'WBTC_TO_USDC'        // Avalanche BTC pairs
    | 'USDC_TO_WAVAX' | 'WAVAX_TO_USDC'      // Avalanche AVAX pairs
    | 'USDC_TO_WETH' | 'WETH_TO_USDC'        // Arbitrum ETH pairs
    | 'USDC_TO_WBTC_ARB' | 'WBTC_TO_USDC_ARB'; // Arbitrum BTC pairs

// ✅ FIX: Export NetworkKey properly
export type NetworkKey = keyof typeof SUPPORTED_NETWORKS;

export interface TradeConfig {
    network: NetworkKey;
    direction: TradeDirection;
    getTokens: () => {
        in: Token;
        out: Token;
        amountIn: number;
        poolFee: number;
    };
}

// ==================== NETWORK CLIENT MANAGEMENT ====================

interface NetworkClients {
    publicClient: PublicClient;
    walletClient: WalletClient;
}

// ==================== NONCE MANAGEMENT INTEGRATION ====================

// Global nonce manager instances per network
const networkNonceManagers = new Map<string, NonceManager>();

/**
 * Get or create nonce manager for specific account/network combination
 */
function getNetworkNonceManager(accountAddress: string, networkKey: NetworkKey): NonceManager {
    const key = `${accountAddress}-${networkKey}`;

    if (!networkNonceManagers.has(key)) {
        // Create clients for the nonce manager
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

        // ✅ IMPORTANT: Import NonceManager from your nonceManager.ts file
        const nonceManager = NonceManager.getInstance(
            publicClient,
            walletClient,
            accountAddress as `0x${string}`
        );

        networkNonceManagers.set(key, nonceManager);

        logger.info('Network nonce manager created', {
            account: accountAddress,
            network: networkKey,
            key
        });
    }

    return networkNonceManagers.get(key)!;
}

/**
 * Enhanced contract write with nonce management
 */
async function writeContractWithNonce(
    walletClient: WalletClient,
    networkKey: NetworkKey,
    contractParams: {
        address: Address;
        abi: Abi;
        functionName: string;
        args: any[];
    },
    tradeId?: string,
    webhookId?: string  // ✅ ADD: webhookId parameter
): Promise<Hash> {
    if (!walletClient.account?.address) {
        throw new Error('Wallet account not available for transaction');
    }

    // ✅ ENSURE: Import getNetworkNonceManager function at top of file
    const nonceManager = getNetworkNonceManager(walletClient.account.address, networkKey);
    await nonceManager.refreshNonce();
    // ✅ FIX: Pass webhookId to nonce manager
    const nonce = await nonceManager.getNextNonce(tradeId, webhookId);

    logger.debug('Executing contract write with managed nonce', {
        network: networkKey,
        nonce,
        tradeId,
        webhookId: webhookId || 'cli',
        function: contractParams.functionName,
        contract: contractParams.address,
        account: walletClient.account.address
    });

    // Create transaction promise
    const transactionPromise = walletClient.writeContract({
        ...contractParams,
        account: walletClient.account,
        chain: undefined, // Let viem determine chain
        nonce
    });

    // ✅ FIX: Pass webhookId to registerTransaction
    nonceManager.registerTransaction(nonce, transactionPromise, tradeId, webhookId);

    try {
        const hash = await transactionPromise;

        logger.debug('Contract write successful with nonce management', {
            network: networkKey,
            nonce,
            hash,
            tradeId,
            webhookId: webhookId || 'cli',
            function: contractParams.functionName
        });

        return hash;

    } catch (error) {
        const errorMsg = getErrorMessage(error);

        logger.error('Contract write failed with nonce management', {
            network: networkKey,
            nonce,
            tradeId,
            webhookId: webhookId || 'cli',
            function: contractParams.functionName,
            error: errorMsg
        });

        // Re-throw the error to be handled by the calling function
        throw error;
    }
}

/**
 * Enhanced network client manager with nonce coordination
 */
class NetworkClientManager {
    private static instance: NetworkClientManager;
    private clients: Map<NetworkKey, NetworkClients> = new Map();
    private currentNetwork: NetworkKey;

    private constructor() {
        this.currentNetwork = getCurrentNetworkKey();
    }

    public static getInstance(): NetworkClientManager {
        if (!NetworkClientManager.instance) {
            NetworkClientManager.instance = new NetworkClientManager();
        }
        return NetworkClientManager.instance;
    }

    private createClients(networkKey: NetworkKey): NetworkClients {
        const privateKey = process.env.PRIVATE_KEY;

        if (!privateKey) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }

        const account = privateKeyToAccount(
            (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
        );

        // ✅ Network configuration (keep this)
        const chain = networkKey === 'AVALANCHE' ? avalanche : arbitrum;
        const rpcUrl = networkKey === 'AVALANCHE' ? process.env.AVALANCHE_RPC_URL : process.env.ARBITRUM_RPC_URL;
        const chainId = networkKey === 'AVALANCHE' ? 43114 : 42161;

        // ✅ Create viem clients for transactions (keep this for nonce management)
        const publicClient = createPublicClient({
            chain,
            transport: http(rpcUrl)
        });

        const walletClient = createWalletClient({
            account,
            chain,
            transport: http(rpcUrl)
        });

        // 🔧 REVERT: Create AlphaRouter the way it worked before nonce integration
        // Remove the problematic "provider: publicClient as any" and use the working approach
        logger.info('Network clients created with nonce management support', {
            network: networkKey,
            chainId,
            account: account.address,
            alphaRouterProvider: 'default_rpc' // Changed from forcing viem client
        });

        return { publicClient, walletClient };
    }

    public getClients(networkKey: NetworkKey): NetworkClients {
        if (!this.clients.has(networkKey)) {
            const clients = this.createClients(networkKey);
            this.clients.set(networkKey, clients);
        }
        return this.clients.get(networkKey)!;
    }

    public switchNetwork(networkKey: NetworkKey): void {
        const networkConfig = SUPPORTED_NETWORKS[networkKey];
        if (!networkConfig || !isNetworkSupported(networkConfig.chainId)) {
            throw new Error(`Unsupported network: ${networkKey}`);
        }
        this.currentNetwork = networkKey;
        logger.info('Current network changed with nonce manager awareness', {
            network: networkKey,
            chainId: networkConfig.chainId
        });
    }

    public getCurrentNetwork(): NetworkKey {
        return this.currentNetwork;
    }

    public async verifyNetworkConnection(networkKey: NetworkKey): Promise<void> {
        const { publicClient } = this.getClients(networkKey);

        const networkInfo = SUPPORTED_NETWORKS[networkKey];

        let attempt = 0;
        const maxAttempts = 3;

        while (attempt < maxAttempts) {
            try {
                attempt++;
                logger.info('Network verification attempt', {
                    network: networkKey,
                    attempt: `${attempt}/${maxAttempts}`
                });

                const [chainId, blockNumber] = await Promise.all([
                    publicClient.getChainId(),
                    publicClient.getBlockNumber()
                ]);

                // ✅ FIX: Use correct chainId from SUPPORTED_NETWORKS
                if (chainId !== networkInfo.chainId) {
                    throw new Error(`Chain ID mismatch: expected ${networkInfo.chainId}, got ${chainId}`);
                }

                logger.info('Connected to network with nonce management', {
                    network: networkKey,
                    chainName: networkInfo.name,
                    chainId,
                    expectedChainId: networkInfo.chainId,
                    blockNumber: blockNumber.toString(),
                    attempt
                });
                return;

            } catch (error) {
                logger.warn('Network connection attempt failed', {
                    network: networkKey,
                    attempt,
                    error: getErrorMessage(error)
                });

                if (attempt === maxAttempts) {
                    throw new Error(`Failed to connect to ${networkKey} after ${maxAttempts} attempts: ${getErrorMessage(error)}`);
                }

                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
    }
}

const clientManager = NetworkClientManager.getInstance();

// ==================== TRADE CONFIGURATION ====================

const TRADE_CONFIGS: Record<NetworkKey, Record<string, TradeConfig>> = {
    AVALANCHE: {
        USDC_TO_WBTC: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'USDC_TO_WBTC' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WBTC_UNI: Token;
                    USDC_UNI: Token;
                    WAVAX_UNI: Token;
                };
                return {
                    in: avalancheTokens.USDC_UNI,
                    out: avalancheTokens.WBTC_UNI,
                    amountIn: 15,
                    poolFee: POOL_FEES.LOW, // Fixed to use LOW (500) fee tier for WBTC
                };
            }
        },
        WBTC_TO_USDC: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'WBTC_TO_USDC' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WBTC_UNI: Token;
                    USDC_UNI: Token;
                    WAVAX_UNI: Token;
                };
                return {
                    in: avalancheTokens.WBTC_UNI,
                    out: avalancheTokens.USDC_UNI,
                    amountIn: 0.0001,
                    poolFee: POOL_FEES.LOW, // Fixed to use LOW (500) fee tier for WBTC
                };
            }
        },
        USDC_TO_WAVAX: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'USDC_TO_WAVAX' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WBTC_UNI: Token;
                    USDC_UNI: Token;
                    WAVAX_UNI: Token;
                };
                return {
                    in: avalancheTokens.USDC_UNI,
                    out: avalancheTokens.WAVAX_UNI,
                    amountIn: 15,
                    poolFee: POOL_FEES.MEDIUM,
                };
            }
        },
        WAVAX_TO_USDC: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'WAVAX_TO_USDC' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WBTC_UNI: Token;
                    USDC_UNI: Token;
                    WAVAX_UNI: Token;
                };
                return {
                    in: avalancheTokens.WAVAX_UNI,
                    out: avalancheTokens.USDC_UNI,
                    amountIn: 0.0001,
                    poolFee: POOL_FEES.LOW,
                };
            }
        }
    },
    ARBITRUM: {
        USDC_TO_WETH: {
            network: 'ARBITRUM' as NetworkKey,
            direction: 'USDC_TO_WETH' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('ARBITRUM');
                const arbitrumTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WETH_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: arbitrumTokens.USDC_UNI,
                    out: arbitrumTokens.WETH_UNI,
                    amountIn: 1,
                    poolFee: POOL_FEES.LOW,
                };
            }
        },
        WETH_TO_USDC: {
            network: 'ARBITRUM' as NetworkKey,
            direction: 'WETH_TO_USDC' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('ARBITRUM');
                const arbitrumTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WETH_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: arbitrumTokens.WETH_UNI,
                    out: arbitrumTokens.USDC_UNI,
                    amountIn: 0.001,
                    poolFee: POOL_FEES.LOW,
                };
            }
        },
        USDC_TO_WBTC_ARB: {
            network: 'ARBITRUM' as NetworkKey,
            direction: 'USDC_TO_WBTC_ARB' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('ARBITRUM');
                const arbitrumTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WETH_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: arbitrumTokens.USDC_UNI,
                    out: arbitrumTokens.WBTC_UNI,
                    amountIn: 15,
                    poolFee: POOL_FEES.LOW, // Fixed to use LOW (500) fee tier for WBTC
                };
            }
        },
        WBTC_TO_USDC_ARB: {
            network: 'ARBITRUM' as NetworkKey,
            direction: 'WBTC_TO_USDC_ARB' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('ARBITRUM');
                const arbitrumTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WETH_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: arbitrumTokens.WBTC_UNI,
                    out: arbitrumTokens.USDC_UNI,
                    amountIn: 0.0001,
                    poolFee: POOL_FEES.LOW, // Fixed to use LOW (500) fee tier for WBTC
                };
            }
        }
    }
};

// ==================== GLOBAL STATE ====================

let CurrentConfig: {
    network: NetworkKey;
    tokens: {
        in: Token;
        out: Token;
        amountIn: number;
        poolFee: number;
    };
} | undefined;

// ==================== HELPER FUNCTIONS ====================

function createSlippageTolerance(network: NetworkKey): Percent {
    // ✅ FIX: Use fallback value since MAX_SLIPPAGE doesn't exist
    const slippageBps = 50; // .05% default
    return new Percent(slippageBps, 10_000);
}

export function getPoolAddress(network: NetworkKey, direction?: TradeDirection): string {
    if (!direction) {
        return 'UNKNOWN';
    }

    try {
        // ✅ Network-specific pool mapping with proper typing
        let poolAddress: string | undefined;
        const networkConfig = getNetworkConfig(network);
        if (network === 'AVALANCHE') {
            // ✅ Cast to AVALANCHE type to access AVALANCHE-specific pools
            const avalanchePools = networkConfig.addresses.UNISWAP_V3.POOLS as {
                readonly USDC_WAVAX: `0x${string}`;
                readonly USDC_WBTC: `0x${string}`;
            };

            if (direction.includes('WBTC')) {
                poolAddress = avalanchePools.USDC_WBTC;
            } else if (direction.includes('WAVAX')) {
                poolAddress = avalanchePools.USDC_WAVAX;
            }
        } else if (network === 'ARBITRUM') {
            // ✅ Cast to ARBITRUM type to access ARBITRUM-specific pools
            const arbitrumPools = networkConfig.addresses.UNISWAP_V3.POOLS as {
                readonly USDC_WETH: `0x${string}`;
                readonly USDC_WBTC: `0x${string}`;
            };

            if (direction.includes('WBTC')) {
                poolAddress = arbitrumPools.USDC_WBTC;
            } else if (direction.includes('WETH')) {
                poolAddress = arbitrumPools.USDC_WETH;
            }
        }

        if (!poolAddress) {
            logger.warn('No pool address found in constants for direction', {
                network,
                direction,
                availablePools: Object.keys(networkConfig.addresses.UNISWAP_V3.POOLS || {})
            });
            return 'COMPUTED';
        }

        logger.debug('Pool address resolved from constants.ts', {
            network,
            direction,
            poolAddress
        });

        return poolAddress;

    } catch (error) {
        logger.warn('Error getting pool address from constants', {
            network,
            direction,
            error: getErrorMessage(error)
        });
        return 'COMPUTED';
    }
}

// ==================== EXPORT FUNCTIONS ====================

export async function initializeNetwork(network: NetworkKey): Promise<void> {
    logger.info('Initializing network with nonce management', {
        network,
        chainId: SUPPORTED_NETWORKS[network].chainId
    });

    clientManager.switchNetwork(network);
    await clientManager.verifyNetworkConnection(network);

    const networkInfo = SUPPORTED_NETWORKS[network];
    logger.info('Network initialized successfully with nonce support', {
        network,
        nativeCurrency: networkInfo.nativeCurrency
    });
}

export async function verifyNetwork(network: NetworkKey): Promise<void> {
    logger.info('Verifying network connectivity', { network });
    await clientManager.verifyNetworkConnection(network);
}

export async function switchNetwork(network: NetworkKey): Promise<void> {
    logger.info('Switching to network', { network });
    clientManager.switchNetwork(network);
    await clientManager.verifyNetworkConnection(network);
}

export function getCurrentConfig(): typeof CurrentConfig {
    return CurrentConfig;
}

export function getNetworkInfo(network: NetworkKey) {
    const networkInfo = SUPPORTED_NETWORKS[network];
    return {
        name: networkInfo.name,
        chainId: networkInfo.chainId,
        nativeCurrency: networkInfo.nativeCurrency
    };
}

export async function setTradeDirection(tradeDirection: TradeDirection): Promise<void> {
    const networkKey = clientManager.getCurrentNetwork();
    const tradeConfig = TRADE_CONFIGS[networkKey][tradeDirection];

    if (!tradeConfig) {
        throw new Error(`Invalid trade direction for network ${networkKey}: ${tradeDirection}`);
    }

    logger.info('Trade direction set with network awareness', {
        direction: tradeDirection,
        network: networkKey,
        tokenPair: `${tradeConfig.getTokens().in.symbol}/${tradeConfig.getTokens().out.symbol}`,
        poolFee: tradeConfig.getTokens().poolFee
    });

    CurrentConfig = {
        network: networkKey,
        tokens: tradeConfig.getTokens()
    };
}

/**
 * Set trade amount with network-aware precision and percentage support
 */
export async function setTradeAmount(value: number, isPercentage: boolean = false, network?: NetworkKey): Promise<void> {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const timeoutMs = 10000;

    if (!CurrentConfig) {
        throw new Error('No trade configuration set. Call setTradeDirection first.');
    }

    try {
        const { publicClient, walletClient } = clientManager.getClients(targetNetwork);
        const tokenIn = CurrentConfig.tokens.in;
        const tokenSymbol = tokenIn.symbol || 'UNKNOWN';

        if (isPercentage) {
            logger.info('Getting token balance for ultra-precise percentage calculation', {
                token: tokenSymbol,
                network: targetNetwork,
                percentage: value,
                tokenDecimals: tokenIn.decimals
            });

            // 🚀 CRITICAL: Get actual balance in wei for maximum precision
            const balancePromise = publicClient.readContract({
                address: tokenIn.address as Address,
                abi: ABIS.ERC20 as Abi,
                functionName: 'balanceOf',
                args: [walletClient.account?.address || '0x0']
            }) as Promise<bigint>;

            const balanceWei = await Promise.race([
                balancePromise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Balance query timeout')), timeoutMs)
                )
            ]);

            const balanceFormatted = parseFloat(formatUnits(balanceWei, tokenIn.decimals));

            if (balanceFormatted === 0) {
                throw new Error(`No balance available for ${tokenSymbol} on ${targetNetwork}`);
            }

            // 🚀 ULTRA-PRECISE CALCULATION: Calculate percentage amount with maximum precision
            const percentageDecimal = value / 100;
            let calculatedAmount: number;

            if (value >= 100) {
                // For 100% trades, use maximum precision to avoid dust
                calculatedAmount = balanceFormatted * 0.999999; // Leave tiny amount for gas/dust
            } else {
                // For partial percentages, use exact calculation
                calculatedAmount = balanceFormatted * percentageDecimal;
            }

            // Apply network-specific dust thresholds
            const dustThreshold = getDustThreshold(tokenSymbol, targetNetwork);
            if (calculatedAmount < dustThreshold) {
                throw new Error(`Calculated amount ${calculatedAmount} is below dust threshold ${dustThreshold} for ${tokenSymbol}`);
            }

            CurrentConfig.tokens.amountIn = calculatedAmount;

            logger.info('Trade amount set to percentage of balance', {
                token: tokenSymbol,
                network: targetNetwork,
                percentage: value,
                balanceFormatted: balanceFormatted.toFixed(8),
                calculatedAmount: calculatedAmount.toFixed(8),
                mode: 'balance_percentage'
            });

        } else {
            // Fixed amount mode
            CurrentConfig.tokens.amountIn = value;

            logger.info('Trade amount set to fixed value', {
                token: tokenSymbol,
                network: targetNetwork,
                amount: value,
                mode: 'fixed_amount'
            });
        }

    } catch (error) {
        const errorMessage = getErrorMessage(error);
        logger.error('Failed to set trade amount', {
            error: errorMessage,
            network: targetNetwork,
            token: CurrentConfig.tokens.in.symbol,
            isPercentage,
            value
        });
        throw error;
    }
}
/**
 * Get network and token specific dust threshold
 */
function getDustThreshold(tokenSymbol: string, network: NetworkKey): number {
    // Use centralized configuration from constants.ts
    if (network === 'ARBITRUM') {
        const token = tokenSymbol as ArbitrumTokenSymbol;
        return DUST_THRESHOLDS.ARBITRUM[token] ?? 0.00001; // Safe default
    } else if (network === 'AVALANCHE') {
        const token = tokenSymbol as AvalancheTokenSymbol;
        return DUST_THRESHOLDS.AVALANCHE[token] ?? 0.00001; // Safe default
    }

    // Fallback for unknown networks
    return 0.00001;
}
export async function getNetworkGasCostEstimate(
    network: NetworkKey,
    gasUsed: bigint,
    gasPrice?: bigint
): Promise<{
    gasCostNative: string;
    gasCostUSDC: string;
    nativePriceUSDC: string;
}> {
    let actualGasPrice = gasPrice;
    if (!actualGasPrice) {
        const { publicClient } = clientManager.getClients(network);
        actualGasPrice = await publicClient.getGasPrice();
    }

    const gasCostNative = formatUnits(gasUsed * actualGasPrice, 18);
    const gasPriceGwei = formatUnits(actualGasPrice, 9);

    // Get native token price
    let nativePriceUSDC = '1';
    if (network === 'AVALANCHE') {
        try {
            const { wavaxPriceQuoter } = await import('./wavaxPriceQuoter.ts');
            nativePriceUSDC = (await wavaxPriceQuoter.getPrice()).toString();
        } catch (error) {
            logger.warn('Failed to get WAVAX price, using fallback', {
                error: getErrorMessage(error)
            });
            nativePriceUSDC = '25';
        }
    } else if (network === 'ARBITRUM') {
        try {
            const { wethPriceQuoter } = await import('./wethPriceQuoter.ts');
            nativePriceUSDC = (await wethPriceQuoter.getPrice()).toString();
        } catch (error) {
            logger.warn('Failed to get WETH price, using fallback', {
                error: getErrorMessage(error)
            });
            nativePriceUSDC = '2500';
        }
    }

    const gasCostUSDC = (parseFloat(gasCostNative) * parseFloat(nativePriceUSDC)).toFixed(6);

    logger.debug('Network-aware gas cost calculated', {
        network,
        gasUsed: gasUsed.toString(),
        gasPrice: `${gasPriceGwei} Gwei`,
        gasCostNative,
        nativePriceUSDC,
        gasCostUSDC,
        nativeCurrency: SUPPORTED_NETWORKS[network].nativeCurrency
    });

    return {
        gasCostNative,
        gasCostUSDC,
        nativePriceUSDC
    };
}

// ==================== TRADE CREATION ====================

export async function createUniswapTrade(networkKey?: NetworkKey): Promise<TradeResult> {
    const startExecutionTime = performance.now();
    const targetNetwork = networkKey || clientManager.getCurrentNetwork();
    const tradeId = `uniswap-${targetNetwork.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    try {
        if (!CurrentConfig) {
            throw new Error('Trade configuration not set. Call setTradeDirection first.');
        }

        logger.info('Starting network-aware trade creation with nonce management', {
            tradeId,
            network: targetNetwork,
            direction: Object.keys(TRADE_CONFIGS[targetNetwork]).find(key =>
                TRADE_CONFIGS[targetNetwork][key].getTokens().in.symbol === CurrentConfig?.tokens.in.symbol &&
                TRADE_CONFIGS[targetNetwork][key].getTokens().out.symbol === CurrentConfig?.tokens.out.symbol
            ),
            timeout: '30000ms'
        });

        const { publicClient } = clientManager.getClients(targetNetwork);

        const inputToken = CurrentConfig.tokens.in;
        const outputToken = CurrentConfig.tokens.out;
        const inputAmount = CurrencyAmount.fromRawAmount(
            inputToken,
            parseUnits(CurrentConfig.tokens.amountIn.toString(), inputToken.decimals).toString()
        );

        logger.debug('Getting pool address for network', {
            network: targetNetwork,
            tokenIn: inputToken.symbol,
            tokenOut: outputToken.symbol,
            direction: Object.keys(TRADE_CONFIGS[targetNetwork]).find(key =>
                TRADE_CONFIGS[targetNetwork][key].getTokens().in.symbol === inputToken.symbol &&
                TRADE_CONFIGS[targetNetwork][key].getTokens().out.symbol === outputToken.symbol
            )
        });

        const poolAddress = getPoolAddress(targetNetwork, Object.keys(TRADE_CONFIGS[targetNetwork]).find(key =>
            TRADE_CONFIGS[targetNetwork][key].getTokens().in.symbol === inputToken.symbol &&
            TRADE_CONFIGS[targetNetwork][key].getTokens().out.symbol === outputToken.symbol
        ) as TradeDirection);

        logger.info('Using network-specific pool address', {
            poolAddress,
            network: targetNetwork,
            tokenIn: inputToken.symbol,
            tokenOut: outputToken.symbol,
            actualAmountIn: formatUnits(BigInt(inputAmount.quotient.toString()), inputToken.decimals)
        });

        logger.debug('Fetching pool information for network', {
            poolAddress,
            network: targetNetwork
        });
        const rpcUrl = targetNetwork === 'AVALANCHE' ? process.env.AVALANCHE_RPC_URL : process.env.ARBITRUM_RPC_URL;
        const chainId = targetNetwork === 'AVALANCHE' ? 43114 : 42161;

// Use the ethers provider that's already bundled with Uniswap
        const ethersProvider = new ethers.providers.JsonRpcProvider(rpcUrl, chainId);
        const router = new AlphaRouter({
            chainId,
            provider: ethersProvider  // ✅ Required parameter
        });
        logger.debug('AlphaRouter created with default RPC for network', {
            network: targetNetwork,
            chainId
        });
        const routerResponse = await router.route(
            inputAmount,
            outputToken,
            TradeType.EXACT_INPUT,
            // ✅ FIX: Use correct parameter structure
            {
                type: SwapType.SWAP_ROUTER_02,  // ✅ Add the required type property
                recipient: '0x0000000000000000000000000000000000000000',
                slippageTolerance: createSlippageTolerance(targetNetwork),
                deadline: Math.floor(Date.now() / 1000 + 1800)
            }
        );

        if (!routerResponse) {
            throw new Error(`No route found for ${inputToken.symbol} to ${outputToken.symbol} on ${targetNetwork}`);
        }

        const trade = routerResponse.trade;
        const expectedAmountOut = formatUnits(
            BigInt(trade.outputAmount.quotient.toString()),
            outputToken.decimals
        );

        const priceImpact = trade.priceImpact.toFixed(4);
        const price = trade.executionPrice.toFixed(6);

        logger.info('Network-aware trade route found', {
            network: targetNetwork,
            tradeId,
            inputToken: inputToken.symbol,
            outputToken: outputToken.symbol,
            inputAmount: formatUnits(BigInt(inputAmount.quotient.toString()), inputToken.decimals),
            expectedAmountOut,
            priceImpact: `${priceImpact}%`,
            price: `${price} ${outputToken.symbol}/${inputToken.symbol}`,
            // ✅ FIX: Use swaps property instead of route.pools
            poolsUsed: trade.swaps?.length || 1,
            poolAddress
        });

        return {
            success: true,
            trade: undefined,
            tradeId,
            expectedAmountOut,
            actualAmountIn: formatUnits(BigInt(inputAmount.quotient.toString()), inputToken.decimals),
            executionTimeMs: performance.now() - startExecutionTime,
            tokensTraded: {
                firstLeg: {
                    input: {
                        symbol: inputToken.symbol || 'UNKNOWN',
                        address: inputToken.address
                    },
                    output: {
                        symbol: outputToken.symbol || 'UNKNOWN',
                        address: outputToken.address
                    }
                }
            }
        };

    } catch (error) {
        const errorMsg = getErrorMessage(error);

        logger.error('Network-aware trade creation failed', {
            network: targetNetwork,
            tradeId,
            error: errorMsg,
            config: CurrentConfig ? {
                tokenIn: CurrentConfig.tokens.in.symbol || 'UNKNOWN',
                tokenOut: CurrentConfig.tokens.out.symbol || 'UNKNOWN',
                amountIn: CurrentConfig.tokens.amountIn
            } : 'No config'
        });
        return {
            success: false,
            error: errorMsg,
            tradeId: `failed-${Date.now()}`,
            executionTimeMs: performance.now() - startExecutionTime
        };
    }
}

// ==================== TRADE EXECUTION WITH NONCE MANAGEMENT ====================

export async function executeUniswapTrade(tradeResult: TradeResult, network?: NetworkKey, webhookId?: string): Promise<TradeExecutionResult> {
    const targetNetwork = network || clientManager.getCurrentNetwork();

    if (!tradeResult.success) {
        return {
            state: TransactionState.Failed,
            error: tradeResult.error || 'Invalid trade result'
        };
    }

    logger.debug('Executing trade without trade object (route-based execution)', {
        network: targetNetwork,
        hasTradeObject: !!tradeResult.trade,
        expectedAmountOut: tradeResult.expectedAmountOut,
        webhookId: webhookId || 'cli'  // ✅ ADD: Log webhook context
    });

    const tradeId = tradeResult.tradeId || `trade-${Date.now()}`;
    const { publicClient, walletClient } = clientManager.getClients(targetNetwork);

    if (!CurrentConfig) {
        return {
            state: TransactionState.Failed,
            error: 'Trade configuration not available for execution'
        };
    }

    // Store CurrentConfig in local variable to satisfy TypeScript
    const currentConfig = CurrentConfig;

    // Create network-specific slippage tolerance
    const slippageTolerance = createSlippageTolerance(targetNetwork);

    // Get token information from CurrentConfig
    const inputToken = currentConfig.tokens.in;
    const outputToken = currentConfig.tokens.out;
    const inputAmount = parseUnits(currentConfig.tokens.amountIn.toString(), inputToken.decimals);

    // Extract token addresses and info from CurrentConfig
    const inputTokenAddress = inputToken.address as Address;
    const outputTokenAddress = outputToken.address as Address;
    const inputTokenDecimals = inputToken.decimals;
    const outputTokenDecimals = outputToken.decimals;
    const inputTokenSymbol = inputToken.symbol || 'UNKNOWN';
    const outputTokenSymbol = outputToken.symbol || 'UNKNOWN';

    // Validate that we have valid token addresses
    if (!inputTokenAddress || !outputTokenAddress) {
        return {
            state: TransactionState.Failed,
            error: `Invalid token addresses for ${targetNetwork} trade`
        };
    }

    const timeoutMs = 30000;

    try {
        // Validate wallet account
        if (!walletClient.account?.address) {
            return {
                state: TransactionState.Failed,
                error: `Wallet account not available for ${targetNetwork}`
            };
        }

        logger.info('Starting network-aware trade execution with nonce management', {
            tradeId,
            network: targetNetwork,
            inputToken: inputTokenSymbol,
            outputToken: outputTokenSymbol,
            inputAmount: formatUnits(inputAmount, inputTokenDecimals),
            webhookId: webhookId || 'cli'  // ✅ ADD: Log webhook context
        });

        // ✅ Get router address from constants.ts instead of hardcoding
        const networkConfig = getNetworkConfig(targetNetwork);
        const routerAddress = networkConfig.addresses.UNISWAP_V3.ROUTER as Address;

        logger.debug('Using router address from constants.ts', {
            network: targetNetwork,
            routerAddress,
            webhookId: webhookId || 'cli'
        });

        // Get output token balance BEFORE trade execution
        const outputBalanceBeforePromise = publicClient.readContract({
            address: outputTokenAddress,
            abi: ABIS.ERC20 as Abi,
            functionName: 'balanceOf',
            args: [walletClient.account.address]
        }) as Promise<bigint>;

        // Network-aware balance and allowance checks
        const balanceAndAllowancePromise = Promise.all([
            publicClient.readContract({
                address: inputTokenAddress,
                abi: ABIS.ERC20 as Abi,
                functionName: 'balanceOf',
                args: [walletClient.account.address]
            }) as Promise<bigint>,
            publicClient.readContract({
                address: inputTokenAddress,
                abi: ABIS.ERC20 as Abi,
                functionName: 'allowance',
                args: [walletClient.account.address, routerAddress]
            }) as Promise<bigint>,
            outputBalanceBeforePromise
        ]);

        const [balance, allowance, outputBalanceBefore] = await Promise.race([
            balanceAndAllowancePromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Balance check timeout')), timeoutMs)
            )
        ]);

        // Validate sufficient balance
        if (balance < inputAmount) {
            return {
                state: TransactionState.Failed,
                error: `Insufficient balance. Required: ${formatUnits(inputAmount, inputTokenDecimals)}, Available: ${formatUnits(balance, inputTokenDecimals)}`
            };
        }

        // Handle token allowance with nonce management
        if (allowance < inputAmount) {
            logger.info('Approving token allowance for network with nonce management', {
                network: targetNetwork,
                token: inputTokenSymbol,
                amount: formatUnits(inputAmount, inputTokenDecimals),
                router: routerAddress,
                webhookId: webhookId || 'cli'
            });

            // ✅ ALREADY CORRECT: This call passes webhookId
            const approveHash = await writeContractWithNonce(
                walletClient,
                targetNetwork,
                {
                    address: inputTokenAddress,
                    abi: ABIS.ERC20 as Abi,
                    functionName: 'approve',
                    args: [routerAddress, inputAmount]
                },
                tradeId,
                webhookId  // ✅ Correct
            );

            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            logger.info('Token approval confirmed for network', {
                network: targetNetwork,
                hash: approveHash,
                webhookId: webhookId || 'cli'
            });
        }

        // ✅ Calculate minimum amount out using slippage tolerance and expected amount
        const expectedAmountOut = tradeResult.expectedAmountOut || '0';
        const expectedAmountOutBigInt = parseUnits(expectedAmountOut, outputTokenDecimals);

        // Apply slippage tolerance to get minimum amount out
        const slippagePercentage = parseFloat(slippageTolerance.toFixed()) / 100;
        const amountOutMinimum = expectedAmountOutBigInt * BigInt(Math.floor((1 - slippagePercentage) * 10000)) / 10000n;

        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes

        // ✅ Use pool fee from CurrentConfig
        const poolFee = currentConfig.tokens.poolFee || 3000;

        const params = {
            tokenIn: inputTokenAddress,
            tokenOut: outputTokenAddress,
            fee: poolFee, // ✅ Use fee from CurrentConfig
            recipient: walletClient.account.address,
            deadline,
            amountIn: inputAmount,
            amountOutMinimum,
            sqrtPriceLimitX96: BigInt(0),
        };

        logger.info('Executing swap on network with nonce management', {
            network: targetNetwork,
            router: routerAddress,
            tradeId,
            webhookId: webhookId || 'cli',
            params: {
                tokenIn: inputTokenAddress,
                tokenOut: outputTokenAddress,
                fee: poolFee,
                amountIn: formatUnits(inputAmount, inputTokenDecimals),
                amountOutMinimum: formatUnits(amountOutMinimum, outputTokenDecimals)
            }
        });

        // Network-aware swap simulation with timeout
        const simulateSwapPromise = publicClient.simulateContract({
            account: walletClient.account,
            address: routerAddress,
            abi: ABIS.UNISWAP_V3_ROUTER as Abi,
            functionName: 'exactInputSingle',
            args: [params]
        });

        const { request } = await Promise.race([
            simulateSwapPromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Swap simulation timeout')), timeoutMs)
            )
        ]);

        // ✅ CRITICAL FIX: Execute swap with nonce management - ADD webhookId
        const hash = await writeContractWithNonce(
            walletClient,
            targetNetwork,
            {
                address: request.address,
                abi: request.abi,
                functionName: request.functionName,
                args: request.args as any[]
            },
            tradeId,
            webhookId  // ✅ CRITICAL: Add the missing webhookId
        );

        logger.info('Swap transaction sent on network with nonce management', {
            network: targetNetwork,
            hash,
            tradeId,
            webhookId: webhookId || 'cli'
        });

        // Wait for transaction receipt with network-specific timeout
        const receiptPromise = publicClient.waitForTransactionReceipt({ hash });
        const confirmationTimeout = targetNetwork === 'ARBITRUM' ? 60000 : 180000; // Faster for L2

        const receipt = await Promise.race([
            receiptPromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Transaction confirmation timeout')), confirmationTimeout)
            )
        ]);

        // Get output token balance AFTER trade execution
        const outputBalanceAfter = await publicClient.readContract({
            address: outputTokenAddress,
            abi: ABIS.ERC20 as Abi,
            functionName: 'balanceOf',
            args: [walletClient.account.address]
        }) as bigint;

        // Calculate actual output amount
        const actualOutputAmount = outputBalanceAfter - outputBalanceBefore;
        const actualOutputFormatted = formatUnits(actualOutputAmount, outputTokenDecimals);

        // Use expected amount as fallback if actual amount calculation fails
        let finalOutputAmount = actualOutputFormatted;
        if (!actualOutputFormatted || parseFloat(actualOutputFormatted) <= 0) {
            finalOutputAmount = tradeResult.expectedAmountOut || '0';
            logger.warn('Using expected output amount as fallback - actual amount could not be determined');
        }

        // Update tradeResult with actual output amount
        tradeResult.actualAmountOut = finalOutputAmount;

        logger.info('Network-aware swap transaction confirmed with nonce management', {
            network: targetNetwork,
            hash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            tradeId,
            webhookId: webhookId || 'cli',
            actualOutputAmount: finalOutputAmount,
            expectedOutputAmount: tradeResult.expectedAmountOut,
            outputTokenSymbol,
            outputDeterminedBy: parseFloat(actualOutputFormatted) > 0 ? 'balance_difference' : 'expected_fallback'
        });

        return {
            state: receipt.status === 'success' ? TransactionState.Sent : TransactionState.Failed,
            hash: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.effectiveGasPrice.toString()
        };

    } catch (error) {
        const errorDetails = getTransactionError(error, {
            tradeId,
            network: targetNetwork,
            operation: 'swap_execution'
        });

        // ✅ ADD: Enhanced nonce error handling
        if (errorDetails.message.includes('nonce too low') ||
            errorDetails.message.includes('nonce too high') ||
            errorDetails.message.includes('replacement transaction underpriced')) {

            logger.error('🚨 Nonce-related error detected - attempting recovery', {
                network: targetNetwork,
                tradeId,
                webhookId: webhookId || 'cli',
                error: errorDetails.message,
                account: walletClient.account?.address,
                errorType: 'nonce_conflict'
            });

            // Force refresh nonce for next transaction
            try {
                if (!walletClient.account?.address) {
                    throw new Error('Wallet account not available for transaction');
                }

                const nonceManager = getNetworkNonceManager(walletClient.account.address, targetNetwork);

                await nonceManager.refreshNonce();
                logger.info('🔄 Nonce refreshed for future transactions', {
                    network: targetNetwork,
                    account: walletClient.account?.address,
                    webhookId: webhookId || 'cli'
                });
            } catch (refreshError) {
                logger.error('❌ Failed to refresh nonce during recovery', {
                    error: getErrorMessage(refreshError),
                    webhookId: webhookId || 'cli'
                });
            }
        }

        logger.error('Network-aware trade execution failed with nonce management', {
            network: targetNetwork,
            tradeId,
            webhookId: webhookId || 'cli',
            error: errorDetails.message,
            errorType: errorDetails.type,
            recoverable: errorDetails.recoverable
        });

        return {
            state: TransactionState.Failed,
            error: errorDetails.message
        };
    }
}

/**
 * Export nonce manager status for monitoring
 */
export function getNetworkNonceManagerStatus(): Array<{
    key: string;
    account: string;
    nextNonce: number;
    pendingCount: number;
    pendingNonces: number[];
}> {
    const status = [];
    for (const [key, manager] of networkNonceManagers.entries()) {
        const managerStatus = manager.getStatus();
        status.push({
            key,
            ...managerStatus
        });
    }
    return status;
}

/**
 * Cleanup all nonce managers (shutdown function)
 */
export function cleanupNonceManagers(): void {
    logger.info('Cleaning up all nonce managers', {
        count: networkNonceManagers.size
    });

    networkNonceManagers.forEach((manager, key) => {
        manager.cleanup();
        logger.debug('Nonce manager cleaned up', { key });
    });

    networkNonceManagers.clear();
}