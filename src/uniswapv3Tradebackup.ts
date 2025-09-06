// src/uniswapv3Trade.ts - Network-Aware Multi-Chain Trading v2.0.0
// 🔧 MAJOR UPGRADE: Support for Avalanche + Arbitrum with network-aware operations

import {
    CurrencyAmount,
    Percent,
    TradeType,
    Token,
    Currency,
} from '@uniswap/sdk-core';
import {
    computePoolAddress,
    Pool,
    Route,
    Trade,
} from '@uniswap/v3-sdk';

import {
    createPublicClient,
    createWalletClient,
    http,
    parseUnits,
    formatUnits,
    ContractFunctionRevertedError,
    type Abi,
    type Address,
    type PublicClient,
    type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche, arbitrum } from 'viem/chains';

import {
    ABIS,
    POOL_FEES,
    getNetworkConfig,
    getCurrentNetworkKey,
    SUPPORTED_NETWORKS,
    type NetworkKey,
    DUST_THRESHOLDS,
    type ArbitrumTokenSymbol,
    type AvalancheTokenSymbol,
    type NetworkTokenSymbol,
    type DustThresholdConfig
} from './constants';
import { getErrorMessage } from './utils.ts';

import logger from './logger';
import dotenv from 'dotenv';
import { TransactionState, type TradeResult, type TradeExecutionResult } from './tradeTypes.ts';

dotenv.config();

// ==================== NETWORK-AWARE TYPE DEFINITIONS ====================

export type TradeDirection =
// Avalanche directions
    | 'USDC_TO_WAVAX' | 'WAVAX_TO_USDC' | 'USDC_TO_WBTC' | 'WBTC_TO_USDC'
    // Arbitrum directions
    | 'USDC_TO_WETH' | 'WETH_TO_USDC' | 'USDC_TO_WBTC_ARB' | 'WBTC_TO_USDC_ARB';

export type UniswapTradeType = Trade<Currency, Currency, TradeType>;

export interface NetworkTradeConfig {
    tokens: {
        in: Token;
        out: Token;
        amountIn: number;
        poolFee: number;
    };
    direction: TradeDirection;
    network: NetworkKey;
}

export interface NetworkClients {
    publicClient: PublicClient;
    walletClient: WalletClient;
    network: NetworkKey;
}
export type { NetworkKey };
// ==================== NETWORK CLIENT MANAGEMENT ====================

class NetworkClientManager {
    private static instance: NetworkClientManager;
    private clients: Map<NetworkKey, NetworkClients> = new Map();
    private currentNetwork: NetworkKey;

    private constructor() {
        this.currentNetwork = getCurrentNetworkKey();
        this.initializeClients();
    }

    public static getInstance(): NetworkClientManager {
        if (!NetworkClientManager.instance) {
            NetworkClientManager.instance = new NetworkClientManager();
        }
        return NetworkClientManager.instance;
    }

    private initializeClients(): void {
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("PRIVATE_KEY environment variable is required");
        }

        const account = privateKeyToAccount(
            (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
        );

        // Initialize Avalanche clients
        if (process.env.AVALANCHE_RPC_URL) {
            const avalancheTransport = http(process.env.AVALANCHE_RPC_URL, {
                timeout: 45000,
                retryCount: 5,
                retryDelay: 2000
            });

            this.clients.set('AVALANCHE', {
                publicClient: createPublicClient({
                    chain: avalanche,
                    transport: avalancheTransport
                }),
                walletClient: createWalletClient({
                    account,
                    chain: avalanche,
                    transport: avalancheTransport
                }),
                network: 'AVALANCHE'
            });
        }

        // Initialize Arbitrum clients
        if (process.env.ARBITRUM_RPC_URL) {
            const arbitrumTransport = http(process.env.ARBITRUM_RPC_URL, {
                timeout: 30000, // Faster for L2
                retryCount: 3,
                retryDelay: 1000
            });

            this.clients.set('ARBITRUM', {
                publicClient: createPublicClient({
                    chain: arbitrum,
                    transport: arbitrumTransport
                }),
                walletClient: createWalletClient({
                    account,
                    chain: arbitrum,
                    transport: arbitrumTransport
                }),
                network: 'ARBITRUM'
            });
        }

        logger.info('Network clients initialized', {
            networks: Array.from(this.clients.keys()),
            currentNetwork: this.currentNetwork
        });
    }

    public getClients(network?: NetworkKey): NetworkClients {
        const targetNetwork = network || this.currentNetwork;
        const clients = this.clients.get(targetNetwork);

        if (!clients) {
            throw new Error(`No clients configured for network: ${targetNetwork}`);
        }

        return clients;
    }

    public setCurrentNetwork(network: NetworkKey): void {
        if (!this.clients.has(network)) {
            throw new Error(`Network not supported: ${network}`);
        }
        this.currentNetwork = network;
        logger.info('Current network changed', { network });
    }

    public getCurrentNetwork(): NetworkKey {
        return this.currentNetwork;
    }

    public getSupportedNetworks(): NetworkKey[] {
        return Array.from(this.clients.keys());
    }
}

// ==================== NETWORK-AWARE PRICE QUOTER ====================

interface IPriceQuoter {
    getPrice(): Promise<number>;
    updatePrice(): Promise<number>;
}

class NetworkPriceQuoter implements IPriceQuoter {
    private static instances: Map<NetworkKey, NetworkPriceQuoter> = new Map();
    private lastPrice: number;
    private lastUpdateTime: number = 0;
    private readonly updateIntervalMs: number = 5 * 60 * 1000; // 5 minutes
    private readonly network: NetworkKey;

    private constructor(network: NetworkKey) {
        this.network = network;
        const networkConfig = getNetworkConfig(network);
        this.lastPrice = networkConfig.gasConfig.NATIVE_PRICE_IN_USDC;
    }

    public static getInstance(network: NetworkKey): NetworkPriceQuoter {
        if (!NetworkPriceQuoter.instances.has(network)) {
            NetworkPriceQuoter.instances.set(network, new NetworkPriceQuoter(network));
        }
        return NetworkPriceQuoter.instances.get(network)!;
    }

    public async getPrice(): Promise<number> {
        const now = Date.now();
        if (now - this.lastUpdateTime > this.updateIntervalMs) {
            try {
                await this.updatePrice();
            } catch (error) {
                logger.warn(`Failed to update ${this.network} price`, {
                    error: getErrorMessage(error),
                    network: this.network
                });
            }
        }
        return this.lastPrice;
    }

    public async updatePrice(): Promise<number> {
        try {
            // For now, use fallback prices. This can be enhanced with actual price feeds
            const networkConfig = getNetworkConfig(this.network);
            this.lastPrice = networkConfig.gasConfig.NATIVE_PRICE_IN_USDC;
            this.lastUpdateTime = Date.now();

            logger.debug('Price updated for network', {
                network: this.network,
                price: this.lastPrice,
                symbol: networkConfig.network.nativeCurrency
            });
        } catch (error) {
            logger.error(`Failed to update ${this.network} price`, {
                error: getErrorMessage(error),
                network: this.network
            });
        }
        return this.lastPrice;
    }
}

// ==================== NETWORK-AWARE TRADE CONFIGURATIONS ====================

export const NETWORK_TRADE_CONFIGS = {
    AVALANCHE: {
        USDC_TO_WAVAX: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'USDC_TO_WAVAX' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WAVAX_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: avalancheTokens.USDC_UNI,
                    out: avalancheTokens.WAVAX_UNI,
                    amountIn: 1,
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
                    WAVAX_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: avalancheTokens.WAVAX_UNI,
                    out: avalancheTokens.USDC_UNI,
                    amountIn: 0.1,
                    poolFee: POOL_FEES.MEDIUM,
                };
            }
        },
        USDC_TO_WBTC: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'USDC_TO_WBTC' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WAVAX_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: avalancheTokens.USDC_UNI,
                    out: avalancheTokens.WBTC_UNI,
                    amountIn: 1,
                    poolFee: POOL_FEES.MEDIUM,
                };
            }
        },
        WBTC_TO_USDC: {
            network: 'AVALANCHE' as NetworkKey,
            direction: 'WBTC_TO_USDC' as TradeDirection,
            getTokens: () => {
                const config = getNetworkConfig('AVALANCHE');
                const avalancheTokens = config.tokenInstances as typeof config.tokenInstances & {
                    WAVAX_UNI: Token;
                    USDC_UNI: Token;
                    WBTC_UNI: Token;
                };
                return {
                    in: avalancheTokens.WBTC_UNI,
                    out: avalancheTokens.USDC_UNI,
                    amountIn: 0.0001,
                    poolFee: POOL_FEES.MEDIUM,
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
                    poolFee: POOL_FEES.MEDIUM,
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
                    poolFee: POOL_FEES.MEDIUM,
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
                    amountIn: 1,
                    poolFee: POOL_FEES.LOW,
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
                    poolFee: POOL_FEES.MEDIUM,
                };
            }
        }
    }
} as const;

// ==================== GLOBAL STATE MANAGEMENT ====================

let CurrentConfig: NetworkTradeConfig | null = null;
const clientManager = NetworkClientManager.getInstance();

// ==================== NETWORK-AWARE UTILITY FUNCTIONS ====================

/**
 * Get current trading configuration (backward compatible)
 */
export function getCurrentConfig(): NetworkTradeConfig | null {
    return CurrentConfig;
}

/**
 * Get network-specific pool address with type safety
 */
export function getPoolAddress(network?: NetworkKey): Address {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const config = CurrentConfig || createDefaultConfig(targetNetwork);

    const networkConfig = getNetworkConfig(targetNetwork);
    const { in: tokenIn, out: tokenOut } = config.tokens;

    const tokenInSymbol = tokenIn.symbol || 'UNKNOWN';
    const tokenOutSymbol = tokenOut.symbol || 'UNKNOWN';

    logger.debug('Getting pool address for network', {
        network: targetNetwork,
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        direction: config.direction
    });

    // Type-safe network-specific pool lookup
    if (targetNetwork === 'AVALANCHE') {
        const avalanchePools = networkConfig.addresses.UNISWAP_V3.POOLS as {
            USDC_WAVAX: Address;
            USDC_WBTC: Address;
        };

        if ((tokenInSymbol === 'USDC' && tokenOutSymbol === 'WAVAX') ||
            (tokenInSymbol === 'WAVAX' && tokenOutSymbol === 'USDC')) {
            return avalanchePools.USDC_WAVAX;
        } else if ((tokenInSymbol === 'USDC' && tokenOutSymbol === 'BTC.b') ||
            (tokenInSymbol === 'BTC.b' && tokenOutSymbol === 'USDC')) {
            return avalanchePools.USDC_WBTC;
        }
    } else if (targetNetwork === 'ARBITRUM') {
        const arbitrumPools = networkConfig.addresses.UNISWAP_V3.POOLS as {
            USDC_WETH: Address;
            USDC_WBTC: Address;
        };

        if ((tokenInSymbol === 'USDC' && tokenOutSymbol === 'WETH') ||
            (tokenInSymbol === 'WETH' && tokenOutSymbol === 'USDC')) {
            return arbitrumPools.USDC_WETH;
        } else if ((tokenInSymbol === 'USDC' && tokenOutSymbol === 'WBTC') ||
            (tokenInSymbol === 'WBTC' && tokenOutSymbol === 'USDC')) {
            return arbitrumPools.USDC_WBTC;
        }
    }

    // Fallback to computed address
    const computedAddress = computePoolAddress({
        factoryAddress: networkConfig.addresses.UNISWAP_V3.FACTORY,
        tokenA: tokenIn,
        tokenB: tokenOut,
        fee: config.tokens.poolFee,
    }) as Address;

    logger.debug('Computed pool address for network', {
        network: targetNetwork,
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        computedAddress,
        poolFee: config.tokens.poolFee
    });

    return computedAddress;
}

/**
 * Get protocol addresses for current network
 */
export function getProtocolAddresses(network?: NetworkKey): {
    routerAddress: string;
    factoryAddress: string;
    quoterAddress: string;
    poolAddress: string;
} {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const networkConfig = getNetworkConfig(targetNetwork);

    return {
        routerAddress: networkConfig.addresses.UNISWAP_V3.ROUTER,
        factoryAddress: networkConfig.addresses.UNISWAP_V3.FACTORY,
        quoterAddress: networkConfig.addresses.UNISWAP_V3.QUOTER,
        poolAddress: getPoolAddress(targetNetwork)
    };
}

/**
 * Get token addresses from current configuration
 */
export function getTokenAddresses(network?: NetworkKey): {
    inputToken: { address: string; symbol: string; decimals: number };
    outputToken: { address: string; symbol: string; decimals: number };
} {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const config = CurrentConfig || createDefaultConfig(targetNetwork);
    const { in: tokenIn, out: tokenOut } = config.tokens;

    return {
        inputToken: {
            address: tokenIn.address,
            symbol: tokenIn.symbol || 'UNKNOWN',
            decimals: tokenIn.decimals
        },
        outputToken: {
            address: tokenOut.address,
            symbol: tokenOut.symbol || 'UNKNOWN',
            decimals: tokenOut.decimals
        }
    };
}

/**
 * Create default configuration for backward compatibility
 */
function createDefaultConfig(network: NetworkKey): NetworkTradeConfig {
    if (network === 'AVALANCHE') {
        const configFactory = NETWORK_TRADE_CONFIGS.AVALANCHE.USDC_TO_WAVAX;
        return {
            ...configFactory,
            tokens: configFactory.getTokens()
        };
    } else if (network === 'ARBITRUM') {
        const configFactory = NETWORK_TRADE_CONFIGS.ARBITRUM.USDC_TO_WETH;
        return {
            ...configFactory,
            tokens: configFactory.getTokens()
        };
    }
    throw new Error(`Unsupported network: ${network}`);
}

// ==================== ENHANCED NETWORK FUNCTIONS ====================

/**
 * Network verification with multi-network support
 */
export async function verifyNetwork(network?: NetworkKey): Promise<boolean> {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const maxRetries = 3;
    const timeoutMs = 15000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`Network verification attempt ${attempt}/${maxRetries}`, {
                network: targetNetwork
            });

            const { publicClient } = clientManager.getClients(targetNetwork);
            const networkConfig = getNetworkConfig(targetNetwork);

            const networkPromise = Promise.all([
                publicClient.getChainId(),
                publicClient.getBlockNumber()
            ]);

            const [chainId, blockNumber] = await Promise.race([
                networkPromise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Network verification timeout')), timeoutMs)
                )
            ]);

            logger.info('Connected to network', {
                network: targetNetwork,
                chainName: networkConfig.network.name,
                chainId,
                expectedChainId: networkConfig.network.chainId,
                blockNumber: blockNumber.toString(),
                timestamp: new Date().toISOString(),
                attempt
            });

            if (chainId !== networkConfig.network.chainId) {
                logger.error('Chain ID mismatch', {
                    expected: networkConfig.network.chainId,
                    actual: chainId,
                    network: targetNetwork
                });
                return false;
            }

            return true;
        } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            logger.error(`Network verification failed for ${targetNetwork} (attempt ${attempt}/${maxRetries})`, {
                error: getErrorMessage(error),
                network: targetNetwork,
                isLastAttempt,
                willRetry: !isLastAttempt
            });

            if (isLastAttempt) {
                return false;
            }

            const waitTime = 1000 * attempt;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    return false;
}

/**
 * Set trade direction with network awareness
 */
export function setTradeDirection(direction: TradeDirection, network?: NetworkKey): void {
    const targetNetwork = network || clientManager.getCurrentNetwork();

    // Validate direction is supported on target network
    let configFactory;

    if (targetNetwork === 'AVALANCHE') {
        const avalancheConfigs = NETWORK_TRADE_CONFIGS.AVALANCHE;
        configFactory = Object.values(avalancheConfigs).find(c => c.direction === direction);
    } else if (targetNetwork === 'ARBITRUM') {
        const arbitrumConfigs = NETWORK_TRADE_CONFIGS.ARBITRUM;
        configFactory = Object.values(arbitrumConfigs).find(c => c.direction === direction);
    }

    if (!configFactory) {
        throw new Error(`Trade direction ${direction} not supported on network ${targetNetwork}`);
    }

    CurrentConfig = {
        ...configFactory,
        tokens: configFactory.getTokens()
    };

    // Ensure client manager is set to correct network
    clientManager.setCurrentNetwork(targetNetwork);

    logger.info('Trade direction set with network awareness', {
        direction,
        network: targetNetwork,
        tokenPair: `${CurrentConfig.tokens.in.symbol}/${CurrentConfig.tokens.out.symbol}`,
        poolFee: CurrentConfig.tokens.poolFee
    });
}

/**
 * Set trade amount with network-aware precision
 */
export async function setTradeAmount(value: number, isPercentage: boolean, network?: NetworkKey): Promise<void> {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const timeoutMs = 10000;

    if (!CurrentConfig) {
        throw new Error('No trade configuration set. Call setTradeDirection first.');
    }

    try {
        const { publicClient } = clientManager.getClients(targetNetwork);
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
                args: [clientManager.getClients(targetNetwork).walletClient.account?.address || '0x0']
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

            // Network-specific minimum trade amounts
            const minTradeAmount = getMinimumTradeAmount(tokenSymbol, targetNetwork);
            if (balanceFormatted < minTradeAmount) {
                throw new Error(`Balance too small to trade: ${balanceFormatted.toFixed(tokenIn.decimals)} ${tokenSymbol} (minimum: ${minTradeAmount})`);
            }

            // 🎯 ULTRA-PRECISE calculation with actual wei balance
            const calculatedAmount = calculateUltraPreciseBalanceAmount(
                balanceFormatted,
                value,
                tokenIn.decimals,
                tokenSymbol,
                targetNetwork,
                balanceWei // Pass actual wei balance for maximum precision
            );

            CurrentConfig.tokens.amountIn = calculatedAmount;

            logger.info('Ultra-precise network-aware trade amount set', {
                token: tokenSymbol,
                network: targetNetwork,
                tokenDecimals: tokenIn.decimals,
                requestedPercentage: value,
                availableBalance: balanceFormatted.toFixed(tokenIn.decimals),
                finalTradeAmount: calculatedAmount.toFixed(tokenIn.decimals),
                utilizationPercent: ((calculatedAmount / balanceFormatted) * 100).toFixed(8), // 8 decimal precision
                expectedRemainder: (balanceFormatted - calculatedAmount).toFixed(tokenIn.decimals),
                dustThreshold: getDustThreshold(tokenSymbol, targetNetwork)
            });

        } else {
            CurrentConfig.tokens.amountIn = value;
            logger.info('Trade amount set to fixed value', {
                token: tokenSymbol,
                network: targetNetwork,
                amount: value
            });
        }
    } catch (error) {
        logger.error('Failed to set ultra-precise trade amount with network awareness', {
            error: getErrorMessage(error),
            value,
            isPercentage,
            network: targetNetwork,
            token: CurrentConfig.tokens.in.symbol || 'UNKNOWN'
        });
        throw error;
    }
}

/**
 * 🔧 ENHANCED: Get dust threshold by token and network
 */
export function getDustThreshold(tokenSymbol: string, network: NetworkKey): number {
    const networkThresholds = DUST_THRESHOLDS[network];

    // Type-safe property access
    if (network === 'ARBITRUM') {
        const arbitrumThresholds = DUST_THRESHOLDS.ARBITRUM;
        const token = tokenSymbol as ArbitrumTokenSymbol;
        return arbitrumThresholds[token] ?? 0.000001;
    }

    if (network === 'AVALANCHE') {
        const avalancheThresholds = DUST_THRESHOLDS.AVALANCHE;
        const token = tokenSymbol as AvalancheTokenSymbol;
        return avalancheThresholds[token] ?? 0.000001;
    }

    return 0.000001; // Default fallback
}
function calculateUltraPreciseBalanceAmount(
    balanceFormatted: number,
    requestedPercentage: number,
    tokenDecimals: number,
    tokenSymbol: string,
    network: NetworkKey,
    actualBalanceWei: bigint
): number {
    if (requestedPercentage >= 100) {
        // 🚀 ULTRA-PRECISE STRATEGY for 100% sells

        // Strategy 1: Use actual wei balance for maximum precision
        const maxPossibleAmount = parseFloat(formatUnits(actualBalanceWei, tokenDecimals));

        // Strategy 2: Apply network-specific precision multipliers
        let precisionMultiplier: number;

        if (network === 'ARBITRUM') {
            // L2 networks: More aggressive precision due to lower gas costs
            if (tokenSymbol === 'WBTC' && tokenDecimals === 8) {
                // WBTC: Use 99.9999% (6 nines) to leave minimal dust
                precisionMultiplier = 0.999999;
            } else if (tokenSymbol === 'WETH' && tokenDecimals === 18) {
                // WETH: Use 99.9999% (6 nines)
                precisionMultiplier = 0.999999;
            } else {
                // Other tokens: Use 99.999% (5 nines)
                precisionMultiplier = 0.99999;
            }
        } else {
            // L1 networks: Conservative precision due to higher gas costs
            if (tokenSymbol === 'BTC.b' && tokenDecimals === 8) {
                // BTC.b: Use 99.995% (3 nines) for gas efficiency
                precisionMultiplier = 0.99995;
            } else if (tokenDecimals <= 8) {
                // High-value tokens: Use 99.99% (4 nines)
                precisionMultiplier = 0.9999;
            } else {
                // Standard tokens: Use 99.9% (3 nines)
                precisionMultiplier = 0.999;
            }
        }

        // Strategy 3: Calculate target amount with precision multiplier
        const targetAmount = maxPossibleAmount * precisionMultiplier;

        // Strategy 4: Dust threshold check - if remaining amount is below dust, use higher precision
        const remainingAmount = maxPossibleAmount - targetAmount;
        const dustThreshold = getDustThreshold(tokenSymbol, network);

        if (remainingAmount < dustThreshold) {
            // Amount is already below dust threshold, use maximum precision
            return targetAmount;
        } else {
            // Remaining amount is significant, use conservative approach
            return maxPossibleAmount * 0.999; // 99.9% to ensure trade succeeds
        }

    } else {
        // Normal percentage calculation
        return (balanceFormatted * requestedPercentage) / 100;
    }
}
/**
 * Network-aware minimum trade amounts
 */
function getMinimumTradeAmount(tokenSymbol: string | undefined, network: NetworkKey): number {
    if (!tokenSymbol) {
        return 0.000001;
    }

    // Network-specific minimums
    const baseMinimums = {
        'USDC': 0.01,
        'WAVAX': 0.001,
        'WETH': 0.0001, // Lower minimum for ETH on Arbitrum (L2 efficiency)
        'BTC.b': 0.00000001,
        'WBTC': 0.00000001,
    };

    return baseMinimums[tokenSymbol as keyof typeof baseMinimums] || 0.000001;
}

/**
 * Network-aware optimal balance calculation
 */
function calculateOptimalBalanceAmount(
    balanceFormatted: number,
    requestedPercentage: number,
    tokenDecimals: number,
    tokenSymbol: string,
    network: NetworkKey
): number {
    if (requestedPercentage >= 100) {
        // Network-specific precision strategies
        if (network === 'ARBITRUM') {
            // L2 allows for more aggressive precision due to lower costs
            return balanceFormatted * 0.999999; // 6 nines for L2
        } else {
            // L1 networks use conservative approach
            if (tokenDecimals <= 8) {
                return balanceFormatted * 0.99999; // 5 nines for high-value tokens
            } else {
                return balanceFormatted * 0.9999; // 4 nines for others
            }
        }
    } else {
        return (balanceFormatted * requestedPercentage) / 100;
    }
}

/**
 * Create slippage tolerance with network-specific defaults
 */
function createSlippageTolerance(network?: NetworkKey): Percent {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const networkConfig = getNetworkConfig(targetNetwork);

    return new Percent(
        networkConfig.tradeSettings.DEFAULT_SLIPPAGE_BPS.toString(),
        '10000'
    );
}

// ==================== NETWORK-AWARE TRADE EXECUTION ====================

/**
 * Create Uniswap trade with network awareness
 */
export async function createUniswapTrade(network?: NetworkKey): Promise<TradeResult> {
    const targetNetwork = network || clientManager.getCurrentNetwork();
    const startExecutionTime = performance.now();
    const timeoutMs = 30000;

    if (!CurrentConfig) {
        return {
            success: false,
            error: 'No trade configuration set. Call setTradeDirection first.',
            tradeId: `failed-${Date.now()}`,
            executionTimeMs: performance.now() - startExecutionTime
        };
    }

    try {
        const tradeId = `uniswap-${targetNetwork.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const { publicClient } = clientManager.getClients(targetNetwork);
        const networkConfig = getNetworkConfig(targetNetwork);

        logger.info('Starting network-aware trade creation', {
            tradeId,
            network: targetNetwork,
            direction: CurrentConfig.direction,
            timeout: `${timeoutMs}ms`
        });

        // Network-aware balance validation
        const tokenIn = CurrentConfig.tokens.in;
        const tokenInSymbol = tokenIn.symbol || 'UNKNOWN';
        const tokenOutSymbol = CurrentConfig.tokens.out.symbol || 'UNKNOWN';

        const balancePromise = publicClient.readContract({
            address: tokenIn.address as Address,
            abi: ABIS.ERC20 as Abi,
            functionName: 'balanceOf',
            args: [clientManager.getClients(targetNetwork).walletClient.account?.address || '0x0']
        }) as Promise<bigint>;

        const balance = await Promise.race([
            balancePromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Balance query timeout')), 10000)
            )
        ]);

        const balanceFormatted = parseFloat(formatUnits(balance, tokenIn.decimals));

        if (balanceFormatted === 0) {
            const errorMsg = `No balance available for ${tokenInSymbol} on ${targetNetwork}`;
            logger.info(errorMsg, {
                token: tokenInSymbol,
                network: targetNetwork,
                balance: '0'
            });
            return {
                success: false,
                error: errorMsg,
                tradeId,
                actualAmountIn: '0',
                executionTimeMs: performance.now() - startExecutionTime
            };
        }

        const actualAmountIn = CurrentConfig.tokens.amountIn;
        const poolAddress = getPoolAddress(targetNetwork);

        logger.info('Using network-specific pool address', {
            poolAddress,
            network: targetNetwork,
            tokenIn: tokenInSymbol,
            tokenOut: tokenOutSymbol,
            actualAmountIn: actualAmountIn.toFixed(tokenIn.decimals)
        });

        // Get pool info with network-aware timeout
        const pool = await Promise.race([
            getPoolInfo(poolAddress, targetNetwork),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Pool info timeout')), 15000)
            )
        ]);

        const route = new Route([pool], tokenIn, CurrentConfig.tokens.out);
        const parsedAmount = parseUnits(actualAmountIn.toString(), tokenIn.decimals);
        const inputAmount = CurrencyAmount.fromRawAmount(tokenIn, parsedAmount.toString());

        const quoteParams = {
            tokenIn: tokenIn.address as Address,
            tokenOut: CurrentConfig.tokens.out.address as Address,
            fee: pool.fee,
            amountIn: parsedAmount,
            sqrtPriceLimitX96: BigInt(0)
        };

        logger.debug('Requesting quote from network-specific quoter', {
            network: targetNetwork,
            quoter: networkConfig.addresses.UNISWAP_V3.QUOTER,
            tokenIn: tokenInSymbol,
            tokenOut: tokenOutSymbol,
            amount: actualAmountIn.toString(),
            fee: pool.fee
        });

        const quotePromise = publicClient.readContract({
            address: networkConfig.addresses.UNISWAP_V3.QUOTER,
            abi: ABIS.UNISWAP_V3_QUOTER as Abi,
            functionName: 'quoteExactInputSingle',
            args: [quoteParams]
        }) as Promise<[bigint, bigint, number, bigint]>;

        const [amountOut] = await Promise.race([
            quotePromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Quote request timeout')), 15000)
            )
        ]);

        if (amountOut === BigInt(0)) {
            const errorMsg = `Quote returned zero amount out on ${targetNetwork}`;
            logger.error(errorMsg);
            return {
                success: false,
                error: errorMsg,
                tradeId,
                actualAmountIn: actualAmountIn.toString(),
                executionTimeMs: performance.now() - startExecutionTime
            };
        }

        const outputAmount = CurrencyAmount.fromRawAmount(CurrentConfig.tokens.out, amountOut.toString());
        const trade = Trade.createUncheckedTrade({
            route,
            inputAmount,
            outputAmount,
            tradeType: TradeType.EXACT_INPUT,
        }) as UniswapTradeType;

        const expectedAmountOutFormatted = formatUnits(amountOut, CurrentConfig.tokens.out.decimals);

        logger.info('Network-aware trade created successfully', {
            network: targetNetwork,
            inputToken: tokenInSymbol,
            outputToken: tokenOutSymbol,
            inputAmount: actualAmountIn.toString(),
            estimatedOutputAmount: expectedAmountOutFormatted,
            tradeId
        });

        return {
            success: true,
            trade,
            tradeId,
            actualAmountIn: actualAmountIn.toString(),
            expectedAmountOut: expectedAmountOutFormatted,
            executionTimeMs: performance.now() - startExecutionTime
        };

    } catch (error) {
        const errorMsg = getErrorMessage(error);
        logger.error('Network-aware trade creation failed', {
            error: errorMsg,
            network: targetNetwork,
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

/**
 * Execute Uniswap trade with network awareness
 */
export async function executeUniswapTrade(tradeResult: TradeResult, network?: NetworkKey): Promise<TradeExecutionResult> {
    const targetNetwork = network || clientManager.getCurrentNetwork();

    if (!tradeResult.success || !tradeResult.trade) {
        return {
            state: TransactionState.Failed,
            error: tradeResult.error || 'Invalid trade result'
        };
    }

    const trade = tradeResult.trade as UniswapTradeType;
    const tradeId = tradeResult.tradeId || `trade-${Date.now()}`;
    const { publicClient, walletClient } = clientManager.getClients(targetNetwork);
    const networkConfig = getNetworkConfig(targetNetwork);

    // Create network-specific slippage tolerance
    const slippageTolerance = createSlippageTolerance(targetNetwork);
    const inputAmount = BigInt(trade.inputAmount.quotient.toString());
    const timeoutMs = networkConfig.gasConfig.TIMEOUT;

    try {
        // Type-safe token address access with validation
        if (!('address' in trade.inputAmount.currency) || !('address' in trade.outputAmount.currency)) {
            return {
                state: TransactionState.Failed,
                error: `Cannot execute trade with native currencies on ${targetNetwork}`
            };
        }

        const inputTokenAddress = trade.inputAmount.currency.address as Address;
        const outputTokenAddress = trade.outputAmount.currency.address as Address;
        const inputTokenDecimals = trade.inputAmount.currency.decimals;
        // 🔧 FIX 1: Define outputTokenDecimals
        const outputTokenDecimals = trade.outputAmount.currency.decimals;
        const inputTokenSymbol = trade.inputAmount.currency.symbol || 'UNKNOWN';
        // 🔧 FIX 2: Define outputTokenSymbol
        const outputTokenSymbol = trade.outputAmount.currency.symbol || 'UNKNOWN';

        // Validate wallet account
        if (!walletClient.account?.address) {
            return {
                state: TransactionState.Failed,
                error: `Wallet account not available for ${targetNetwork}`
            };
        }

        logger.info('Starting network-aware trade execution', {
            tradeId,
            network: targetNetwork,
            inputToken: inputTokenSymbol,
            outputToken: outputTokenSymbol,
            inputAmount: formatUnits(inputAmount, inputTokenDecimals)
        });

        // 🔧 FIX 3: Get output token balance BEFORE trade execution with proper typing
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
                args: [walletClient.account.address, networkConfig.addresses.UNISWAP_V3.ROUTER]
            }) as Promise<bigint>,
            outputBalanceBeforePromise  // 🔧 Include output balance before
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

        // Handle token allowance for network
        if (allowance < inputAmount) {
            logger.info('Approving token allowance for network', {
                network: targetNetwork,
                token: inputTokenSymbol,
                amount: formatUnits(inputAmount, inputTokenDecimals),
                router: networkConfig.addresses.UNISWAP_V3.ROUTER
            });

            const approveHash = await walletClient.writeContract({
                address: inputTokenAddress,
                abi: ABIS.ERC20 as Abi,
                functionName: 'approve',
                args: [networkConfig.addresses.UNISWAP_V3.ROUTER, inputAmount],
                account: walletClient.account,  // 🔧 ADD THIS
                chain: undefined  // 🔧 ADD THIS
            });

            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            logger.info('Token approval confirmed for network', {
                network: targetNetwork,
                hash: approveHash
            });
        }

        // Prepare swap parameters with network-specific slippage
        const amountOutMinimum = trade.minimumAmountOut(slippageTolerance).quotient;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes

        const params = {
            tokenIn: inputTokenAddress,
            tokenOut: outputTokenAddress,
            fee: trade.route.pools[0].fee,
            recipient: walletClient.account.address,
            deadline,
            amountIn: inputAmount,
            amountOutMinimum: BigInt(amountOutMinimum.toString()),
            sqrtPriceLimitX96: BigInt(0),
        };

        logger.info('Executing swap on network', {
            network: targetNetwork,
            router: networkConfig.addresses.UNISWAP_V3.ROUTER,
            tradeId
        });

        // Network-aware swap simulation
        const simulateSwapPromise = publicClient.simulateContract({
            account: walletClient.account,
            address: networkConfig.addresses.UNISWAP_V3.ROUTER,
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

        const hash = await walletClient.writeContract(request);
        logger.info('Swap transaction sent on network', {
            network: targetNetwork,
            hash,
            tradeId
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

        // 🔧 FIX 4: Get output token balance AFTER trade execution with proper typing
        const outputBalanceAfter = await publicClient.readContract({
            address: outputTokenAddress,
            abi: ABIS.ERC20 as Abi,
            functionName: 'balanceOf',
            args: [walletClient.account.address]
        }) as bigint;

        // 🔧 FIX 5: Calculate actual output amount with proper bigint handling
        const actualOutputAmount = outputBalanceAfter - outputBalanceBefore;
        const actualOutputFormatted = formatUnits(actualOutputAmount, outputTokenDecimals);

        // Method 3: Use expected amount as last resort
        let finalOutputAmount = actualOutputFormatted;
        if (!actualOutputFormatted || parseFloat(actualOutputFormatted) <= 0) {
            finalOutputAmount = tradeResult.expectedAmountOut || '0';
            logger.warn('Using expected output amount as fallback - actual amount could not be determined');
        }

        // 🔧 CRITICAL: Update tradeResult with actual output amount
        tradeResult.actualAmountOut = finalOutputAmount;

        logger.info('Network-aware swap transaction confirmed with output tracking', {
            network: targetNetwork,
            hash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            tradeId,
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
        const errorMessage = error instanceof ContractFunctionRevertedError
            ? `Trade reverted on ${targetNetwork}: ${error.message}`
            : getErrorMessage(error);

        logger.error('Network-aware trade execution failed', {
            error: errorMessage,
            network: targetNetwork,
            tradeId
        });

        return {
            state: TransactionState.Failed,
            error: errorMessage
        };
    }
}

/**
 * Get pool info with network awareness
 */
async function getPoolInfo(poolAddress: Address, network: NetworkKey): Promise<Pool> {
    const { publicClient } = clientManager.getClients(network);
    const networkConfig = getNetworkConfig(network);

    if (!CurrentConfig) {
        throw new Error('No trade configuration set');
    }

    const pool = {
        address: poolAddress,
        abi: ABIS.UNISWAP_V3_POOL
    } as const;

    const timeoutMs = networkConfig.gasConfig.TIMEOUT;

    try {
        logger.debug('Fetching pool information for network', {
            poolAddress,
            network
        });

        const poolDataPromise = Promise.all([
            publicClient.readContract({ ...pool, functionName: 'token0' }) as Promise<Address>,
            publicClient.readContract({ ...pool, functionName: 'token1' }) as Promise<Address>,
            publicClient.readContract({ ...pool, functionName: 'fee' }) as Promise<number>,
            publicClient.readContract({ ...pool, functionName: 'liquidity' }) as Promise<bigint>,
            publicClient.readContract({ ...pool, functionName: 'slot0' }) as Promise<[bigint, number, number, number, number, number, boolean]>
        ]);

        const [token0, token1, fee, liquidity, slot0] = await Promise.race([
            poolDataPromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Pool info query timeout')), timeoutMs)
            )
        ]);

        const [sqrtPriceX96] = slot0;

        if (!sqrtPriceX96) {
            throw new Error(`Invalid sqrtPriceX96 value from pool on ${network}`);
        }

        logger.debug('Pool data retrieved for network', {
            network,
            token0,
            token1,
            fee,
            liquidity: liquidity.toString(),
            sqrtPriceX96: sqrtPriceX96.toString(),
            tick: slot0[1]
        });

        // Ensure CurrentConfig is available before accessing
        if (!CurrentConfig) {
            throw new Error('CurrentConfig is undefined when creating pool');
        }

        return new Pool(
            CurrentConfig.tokens.in,
            CurrentConfig.tokens.out,
            fee,
            sqrtPriceX96.toString(),
            liquidity.toString(),
            slot0[1]
        );
    } catch (error) {
        logger.error('Failed to get pool info for network', {
            error: getErrorMessage(error),
            poolAddress,
            network
        });
        throw error;
    }
}

// ==================== BACKWARD COMPATIBILITY EXPORTS ====================

// Export network management for advanced usage
export { NetworkClientManager, NetworkPriceQuoter };

// Export network-aware functions
export {
    clientManager as getClientManager,
    getNetworkConfig as getConfigForNetwork
};

// ==================== NETWORK SWITCHING UTILITIES ====================

/**
 * Switch to a different network
 */
export async function switchNetwork(network: NetworkKey): Promise<boolean> {
    try {
        logger.info('Switching to network', { network });

        // Verify the target network is available
        const isVerified = await verifyNetwork(network);
        if (!isVerified) {
            logger.error('Failed to verify target network', { network });
            return false;
        }

        // Switch the client manager to the new network
        clientManager.setCurrentNetwork(network);

        // Clear current config to force reconfiguration
        CurrentConfig = null;

        logger.info('Successfully switched to network', {
            network,
            supportedNetworks: clientManager.getSupportedNetworks()
        });

        return true;
    } catch (error) {
        logger.error('Failed to switch network', {
            error: getErrorMessage(error),
            targetNetwork: network
        });
        return false;
    }
}

/**
 * Get current network information
 */
export function getNetworkInfo(): {
    currentNetwork: NetworkKey;
    supportedNetworks: NetworkKey[];
    networkConfig: ReturnType<typeof getNetworkConfig>;
    hasCurrentConfig: boolean;
} {
    const currentNetwork = clientManager.getCurrentNetwork();
    return {
        currentNetwork,
        supportedNetworks: clientManager.getSupportedNetworks(),
        networkConfig: getNetworkConfig(currentNetwork),
        hasCurrentConfig: CurrentConfig !== null
    };
}

/**
 * Initialize network with verification
 */
export async function initializeNetwork(network?: NetworkKey): Promise<boolean> {
    const targetNetwork = network || getCurrentNetworkKey();

    try {
        logger.info('Initializing network', { network: targetNetwork });

        // Verify network connectivity
        const isVerified = await verifyNetwork(targetNetwork);
        if (!isVerified) {
            logger.error('Network verification failed during initialization', {
                network: targetNetwork
            });
            return false;
        }

        // Set as current network
        clientManager.setCurrentNetwork(targetNetwork);

        // Initialize price quoter for the network
        const priceQuoter = NetworkPriceQuoter.getInstance(targetNetwork);
        await priceQuoter.updatePrice();

        logger.info('Network initialized successfully', {
            network: targetNetwork,
            nativeCurrency: getNetworkConfig(targetNetwork).network.nativeCurrency
        });

        return true;
    } catch (error) {
        logger.error('Failed to initialize network', {
            error: getErrorMessage(error),
            network: targetNetwork
        });
        return false;
    }
}

/**
 * Get gas cost estimate for current network
 */
export async function getNetworkGasCostEstimate(network?: NetworkKey): Promise<number> {
    const targetNetwork = network || clientManager.getCurrentNetwork();

    try {
        const priceQuoter = NetworkPriceQuoter.getInstance(targetNetwork);
        const nativePrice = await priceQuoter.getPrice();
        const networkConfig = getNetworkConfig(targetNetwork);

        // Estimate gas cost based on network
        const gasUnits = Number(networkConfig.gasConfig.SWAP_BASE);
        const gasPriceGwei = networkConfig.gasConfig.MAX_GAS_IN_GWEI;
        const gasCostInNative = (gasUnits * gasPriceGwei) / 1e9;
        const gasCostInUSDC = gasCostInNative * nativePrice;

        // Apply network-specific buffer
        const buffer = networkConfig.gasConfig.BUFFER_MULTIPLIER;

        logger.debug('Network gas cost estimate', {
            network: targetNetwork,
            gasUnits,
            gasPriceGwei,
            gasCostInNative,
            nativePrice,
            gasCostInUSDC,
            buffer,
            finalEstimate: gasCostInUSDC * buffer
        });

        return gasCostInUSDC * buffer;
    } catch (error) {
        logger.error('Failed to estimate gas cost for network', {
            error: getErrorMessage(error),
            network: targetNetwork
        });

        // Return fallback estimate
        const networkConfig = getNetworkConfig(targetNetwork);
        return networkConfig.gasConfig.NATIVE_PRICE_IN_USDC * 0.001; // Conservative fallback
    }
}