// /src/constants.ts - Multi-Network Architecture v2.0.0
// 🔧 MAJOR RESTRUCTURE: Network-first hierarchy supporting Avalanche + Arbitrum

import { Token as UniToken } from '@uniswap/sdk-core';
import { Token as JoeToken } from '@traderjoe-xyz/sdk-core';
import { parseUnits, type Address } from 'viem';

// Import ABIs (these remain network-agnostic)
import UniswapV3FactoryABI from '../abis/UniswapV3Factory.json';
import UniswapV3PoolABI from '../abis/UniswapV3Pool.json';
import UniswapV3RouterABI from '../abis/UniswapV3Router.json';
import ERC20ABI from '../abis/ERC20.json';
import UniswapV3QuoterABI from '../abis/UniswapV3Quoter.json';
import TraderJoePairABI from '../abis/TraderJoePair.json';

import dotenv from 'dotenv';
dotenv.config();

/**
 * SUPPORTED NETWORKS
 * ------------------------------------------------------------------
 * Core network definitions with chain IDs and metadata
 */
export const SUPPORTED_NETWORKS = {
    AVALANCHE: {
        chainId: 43114,
        name: 'Avalanche',
        nativeCurrency: 'AVAX',
        wrappedNativeSymbol: 'WAVAX',
        rpcUrl: process.env.AVALANCHE_RPC_URL,
        explorerUrl: 'https://snowtrace.io'
    },
    ARBITRUM: {
        chainId: 42161,
        name: 'Arbitrum One',
        nativeCurrency: 'ETH',
        wrappedNativeSymbol: 'WETH',
        rpcUrl: process.env.ARBITRUM_RPC_URL,
        explorerUrl: 'https://arbiscan.io'
    }
} as const;

export type NetworkKey = keyof typeof SUPPORTED_NETWORKS;
export type ChainId = typeof SUPPORTED_NETWORKS[NetworkKey]['chainId'];

// Legacy support - maintain backward compatibility
export const CHAIN_IDS = {
    AVALANCHE: SUPPORTED_NETWORKS.AVALANCHE.chainId,
    ARBITRUM: SUPPORTED_NETWORKS.ARBITRUM.chainId,
    BASE: 8453,      // Keep for future expansion
    POLYGON: 137     // Keep for future expansion
} as const;

/**
 * NETWORK-SPECIFIC GAS OPTIMIZATION
 * ------------------------------------------------------------------
 * Gas settings tailored for each network's characteristics
 */
export const NETWORK_GAS_OPTIMIZATION = {
    AVALANCHE: {
        BASE_FEE_MULTIPLIER: 1.1,
        PRIORITY_FEE: {
            LOW: Number(parseUnits('2', 9)),
            MEDIUM: Number(parseUnits('3', 9)),
            HIGH: Number(parseUnits('5', 9))
        },
        MAX_GAS_IN_GWEI: 3,
        NATIVE_PRICE_IN_USDC: 28, // AVAX price fallback
        ESTIMATED_GAS_LIMIT: 300000n,
        GAS_LIMIT_BUFFER: 1.3,
        BASE_GAS: 2000000n,
        SWAP_BASE: 2000000n,
        TOKEN_TRANSFER: 65000n,
        BUFFER_MULTIPLIER: 1.1,
        CONFIRMATIONS: 1,
        MAX_CONFIRMATIONS: 3,
        MIN_DEADLINE: 60_000,
        MAX_DEADLINE: 300,
        TIMEOUT: 15000,
        POLLING_INTERVAL: 3_000
    },
    ARBITRUM: {
        BASE_FEE_MULTIPLIER: 1.05, // Lower multiplier for L2
        PRIORITY_FEE: {
            LOW: Number(parseUnits('0.01', 9)),   // Much lower for L2
            MEDIUM: Number(parseUnits('0.05', 9)),
            HIGH: Number(parseUnits('0.1', 9))
        },
        MAX_GAS_IN_GWEI: 0.1, // Much lower for Arbitrum
        NATIVE_PRICE_IN_USDC: 3500, // ETH price fallback
        ESTIMATED_GAS_LIMIT: 800000n, // Higher gas limits on L2
        GAS_LIMIT_BUFFER: 1.2,
        BASE_GAS: 500000n,
        SWAP_BASE: 500000n,
        TOKEN_TRANSFER: 100000n,
        BUFFER_MULTIPLIER: 1.05,
        CONFIRMATIONS: 1,
        MAX_CONFIRMATIONS: 2, // Faster confirmations on L2
        MIN_DEADLINE: 60_000,
        MAX_DEADLINE: 300,
        TIMEOUT: 10000, // Faster timeout for L2
        POLLING_INTERVAL: 2_000 // Faster polling for L2
    }
} as const;

// Legacy support - defaults to Avalanche
export const GAS_OPTIMIZATION = NETWORK_GAS_OPTIMIZATION.AVALANCHE;

/**
 * SHARED ARBITRAGE SETTINGS
 * ------------------------------------------------------------------
 * Network-agnostic arbitrage configuration
 */
export const ARBITRAGE_SETTINGS = {
    MIN_PROFIT_THRESHOLD: 0.0001,
    EXECUTION_RETRY_DELAY: 5000,
    MONITORING_INTERVAL: 5000,
    TRANSACTION_TIMEOUT: 28_000,
    PRICE_HISTORY_LENGTH: 10,
    MAX_RETRY_ATTEMPTS: 5,
    RETRY_DELAY: 4_000,
    PERFORMANCE_THRESHOLD: 1000,
    POLLING_INTERVAL: 2000,
    CONFIRMATION_TIMEOUT: 30000,
    MAX_PRICE_IMPACT: 5,
    DEFAULT_SLIPPAGE_BPS: 200,
    DEFAULT_DEADLINE_MINS: 30,
    MAX_PROFIT_THRESHOLD: 2,
    MIN_DEADLINE: 60,
    MAX_DEADLINE: 120,
    MAX_QUOTE_AGE: 30,
    ON_CHAIN_TEST_MODE: false,
    OFF_CHAIN_TEST_MODE: false,
    FLASH_LOANS_ENABLED: true,
    TEST_FLASH_LOANS: false, // set to false to read trade amount in export const NETWORK_TRADE_SETTINGS. true will test 1 USDC
    FLASH_LOAN_THRESHOLD: 0.00001,
    MIN_FLASH_LOAN_PROFIT_PERCENT: 0.00001,
    TIME_SYNC_CHECK_INTERVAL: 1000,
    BALANCE_CHECK_INTERVAL: 5000,
} as const;

/**
 * NETWORK-SPECIFIC TOKEN CONFIGURATIONS
 * ------------------------------------------------------------------
 * Token addresses and metadata for each supported network
 */
export interface TokenConfig {
    address: Address;
    decimals: number;
    symbol: string;
    name: string;
    chainId: number;
}

export const NETWORK_TOKEN_CONFIGS = {
    AVALANCHE: {
        WAVAX: {
            address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' as Address,
            decimals: 18,
            symbol: 'WAVAX',
            name: 'Wrapped AVAX',
            chainId: CHAIN_IDS.AVALANCHE
        },
        USDC: {
            address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as Address,
            decimals: 6,
            symbol: 'USDC',
            name: 'USD Coin',
            chainId: CHAIN_IDS.AVALANCHE
        },
        WBTC: {
            address: '0x152b9d0FdC40C096757F570A51E494bd4b943E50' as Address,
            decimals: 8,
            symbol: 'BTC.b',
            name: 'Bitcoin',
            chainId: CHAIN_IDS.AVALANCHE
        }
    },
    ARBITRUM: {
        WETH: {
            address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as Address,
            decimals: 18,
            symbol: 'WETH',
            name: 'Wrapped Ether',
            chainId: CHAIN_IDS.ARBITRUM
        },
        USDC: {
            address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address,
            decimals: 6,
            symbol: 'USDC',
            name: 'USD Coin',
            chainId: CHAIN_IDS.ARBITRUM
        },
        WBTC: {
            address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address,
            decimals: 8,
            symbol: 'WBTC',
            name: 'Wrapped BTC',
            chainId: CHAIN_IDS.ARBITRUM
        }
    }
} as const;

// Legacy support - defaults to Avalanche
export const TOKEN_CONFIGS: Record<string, TokenConfig> = NETWORK_TOKEN_CONFIGS.AVALANCHE;
/**
 * SHARED POOL FEES AND TICK SPACING
 * ------------------------------------------------------------------
 * Uniswap V3 fee tiers (same across all networks)
 */
export const POOL_FEES = {
    LOWEST: 100,    // 0.01%
    LOW: 500,       // 0.05%
    MEDIUM: 3000,   // 0.3%
    HIGH: 10000,    // 1%
} as const;

export const TICK_SPACING = {
    LOW: 10,        // 0.05%
    MEDIUM: 60,     // 0.3%
    HIGH: 200       // 1%
} as const;

/**
 * NETWORK-SPECIFIC PROTOCOL ADDRESSES
 * ------------------------------------------------------------------
 * DEX addresses for each supported network
 */
export const NETWORK_ADDRESSES = {
    AVALANCHE: {
        UNISWAP_V3: {
            FACTORY: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD' as Address,
            ROUTER: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE' as Address,
            QUOTER: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F' as Address,
            POOLS: {
                USDC_WAVAX: '0xfAe3f424a0a47706811521E3ee268f00cFb5c45E' as Address, // .05% pool fee pool
                USDC_WBTC: '0x2E587b9E7aA638d7EB7DB5fe7447513bC4D0D28B' as Address, // .05% pool fee pool
            }
        },
        TRADER_JOE: {
            FACTORY: '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10' as Address,
            ROUTER: '0x18556DA13313f3532c54711497A8FedAC273220E' as Address,
            QUOTER: '0x9A550a522BBaDFB69019b0432800Ed17855A51C3' as Address,
            POOLS: {
                USDC_WAVAX: '0x864d4e5Ee7318e97483DB7EB0912E09F161516EA' as Address,
                USDC_WBTC: '0x4224f6f4c9280509724db2dbac314621e4465c29' as Address,
            },
        },
        AAVE_V3: {
            POOL: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            FLASH_LOAN_BPS: 5,
        },
        BALANCER_V3: {
            POOL: '0xbA1333333333a1BA1108E8412f11850A5C319bA9',
            FLASH_LOAN_BPS: 0,
        },
        BALANCER_V2: {
            POOL: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            FLASH_LOAN_BPS: 0,
        },
    },
    ARBITRUM: {
        UNISWAP_V3: {
            FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984' as Address,
            ROUTER: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as Address,
            QUOTER: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as Address,

            POOLS: {
                //USDC_WETH: '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d' as Address,
                USDC_WETH: '0xC6962004f452bE9203591991D15f6b388e09E8D0' as Address, // .05% pool fee pool
                USDC_WBTC: '0x0e4831319a50228b9e450861297ab92dee15b44f' as Address, // .05% pool fee pool
                // USDC_WETH 0xc473e2aee3441bf9240be85eb122abb059a3b57c  .3% pool
                //0xac70bd92f89e6739b3a08db9b6081a923912f73d low volume on arbitrum
            }
        },
        // Note: TraderJoe is not available on Arbitrum, keeping structure for consistency
        TRADER_JOE: {
            FACTORY: '0x0000000000000000000000000000000000000000' as Address,
            ROUTER: '0x0000000000000000000000000000000000000000' as Address,
            QUOTER: '0x0000000000000000000000000000000000000000' as Address,
            POOLS: {
                USDC_WETH: '0x0000000000000000000000000000000000000000' as Address,
                USDC_WBTC: '0x0000000000000000000000000000000000000000' as Address,
            },
        },
        AAVE_V3: {
            POOL: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            FLASH_LOAN_BPS: 5,
        },
        BALANCER_V3: {
            POOL: '0xbA1333333333a1BA1108E8412f11850A5C319bA9',
            FLASH_LOAN_BPS: 0,
        },
        BALANCER_V2: {
            POOL: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            FLASH_LOAN_BPS: 0,
        },
    }
} as const;


// Token symbol types for each network
export type ArbitrumTokenSymbol = 'WBTC' | 'WETH' | 'USDC';
export type AvalancheTokenSymbol = 'BTC.b' | 'WAVAX' | 'USDC';
export type NetworkTokenSymbol = ArbitrumTokenSymbol | AvalancheTokenSymbol;

// Dust threshold configuration type
export interface DustThresholdConfig {
    readonly ARBITRUM: Record<ArbitrumTokenSymbol, number>;
    readonly AVALANCHE: Record<AvalancheTokenSymbol, number>;
}

// Enhanced dust threshold with full type safety
export const DUST_THRESHOLDS: DustThresholdConfig = {
    ARBITRUM: {
        'WBTC': 0.0000001,   // ~$0.10 worth at $105k BTC
        'WETH': 0.00001,     // ~$0.35 worth at $3.5k ETH
        'USDC': 0.001
    },
    AVALANCHE: {
        'BTC.b': 0.0000001,
        'WAVAX': 0.001,
        'USDC': 0.001
    }
} as const;

// Legacy support - defaults to Avalanche
export const ADDRESSES = NETWORK_ADDRESSES.AVALANCHE;



/**
 * NETWORK-SPECIFIC TOKEN INSTANCES
 * ------------------------------------------------------------------
 * Pre-instantiated token objects for each DEX and network
 */
export const NETWORK_TOKENS = {
    AVALANCHE: {
        // Uniswap tokens
        WAVAX_UNI: new UniToken(
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.chainId,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.address,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.decimals,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.symbol,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.name
        ),
        USDC_UNI: new UniToken(
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.chainId,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.address,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.decimals,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.symbol,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.name
        ),
        WBTC_UNI: new UniToken(
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.chainId,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.address,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.decimals,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.symbol,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.name
        ),

        // TraderJoe tokens
        WAVAX_JOE: new JoeToken(
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.chainId,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.address,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.decimals,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.symbol,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.name
        ),
        USDC_JOE: new JoeToken(
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.chainId,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.address,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.decimals,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.symbol,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.name
        ),
        WBTC_JOE: new JoeToken(
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.chainId,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.address,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.decimals,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.symbol,
            NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.name
        )
    },
    ARBITRUM: {
        // Uniswap tokens (TraderJoe not available on Arbitrum)
        WETH_UNI: new UniToken(
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH.chainId,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH.address,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH.decimals,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH.symbol,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH.name
        ),
        USDC_UNI: new UniToken(
            NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.chainId,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.address,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.decimals,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.symbol,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.name
        ),
        WBTC_UNI: new UniToken(
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC.chainId,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC.address,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC.decimals,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC.symbol,
            NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC.name
        )
    }
} as const;

// Legacy support - defaults to Avalanche
export const TOKENS = NETWORK_TOKENS.AVALANCHE;

/**
 * NETWORK-SPECIFIC TRADE DIRECTIONS
 * ------------------------------------------------------------------
 * Available trading pairs for each network
 */
export const NETWORK_TRADE_DIRECTIONS = {
    AVALANCHE: {
        // Uniswap WAVAX directions
        USDC_TO_WAVAX_UNI: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.USDC_UNI,
            tokenOut: NETWORK_TOKENS.AVALANCHE.WAVAX_UNI,
        },
        WAVAX_TO_USDC_UNI: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.WAVAX_UNI,
            tokenOut: NETWORK_TOKENS.AVALANCHE.USDC_UNI,
        },
        // TraderJoe WAVAX directions
        USDC_TO_WAVAX_JOE: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.USDC_JOE,
            tokenOut: NETWORK_TOKENS.AVALANCHE.WAVAX_JOE,
        },
        WAVAX_TO_USDC_JOE: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.WAVAX_JOE,
            tokenOut: NETWORK_TOKENS.AVALANCHE.USDC_JOE,
        },
        // Uniswap WBTC directions
        USDC_TO_WBTC_UNI: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.USDC_UNI,
            tokenOut: NETWORK_TOKENS.AVALANCHE.WBTC_UNI,
        },
        WBTC_TO_USDC_UNI: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.WBTC_UNI,
            tokenOut: NETWORK_TOKENS.AVALANCHE.USDC_UNI,
        },
        // TraderJoe WBTC directions
        USDC_TO_WBTC_JOE: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.USDC_JOE,
            tokenOut: NETWORK_TOKENS.AVALANCHE.WBTC_JOE,
        },
        WBTC_TO_USDC_JOE: {
            tokenIn: NETWORK_TOKENS.AVALANCHE.WBTC_JOE,
            tokenOut: NETWORK_TOKENS.AVALANCHE.USDC_JOE,
        },
    },
    ARBITRUM: {
        // Uniswap WETH directions (primary native asset)
        USDC_TO_WETH_UNI: {
            tokenIn: NETWORK_TOKENS.ARBITRUM.USDC_UNI,
            tokenOut: NETWORK_TOKENS.ARBITRUM.WETH_UNI,
        },
        WETH_TO_USDC_UNI: {
            tokenIn: NETWORK_TOKENS.ARBITRUM.WETH_UNI,
            tokenOut: NETWORK_TOKENS.ARBITRUM.USDC_UNI,
        },
        // Uniswap WBTC directions
        USDC_TO_WBTC_UNI: {
            tokenIn: NETWORK_TOKENS.ARBITRUM.USDC_UNI,
            tokenOut: NETWORK_TOKENS.ARBITRUM.WBTC_UNI,
        },
        WBTC_TO_USDC_UNI: {
            tokenIn: NETWORK_TOKENS.ARBITRUM.WBTC_UNI,
            tokenOut: NETWORK_TOKENS.ARBITRUM.USDC_UNI,
        },
    }
} as const;

/**
 * NETWORK-AWARE TRADE SETTINGS
 * ------------------------------------------------------------------
 * Trade configuration with network-specific defaults
 */
export const NETWORK_TRADE_SETTINGS = {
    AVALANCHE: {
        TRADE_SIZE: '100',
        SAFETY_MARGIN: 1,
        MAX_PRICE_IMPACT: 15.0,
        PRICE_CHECK_INTERVAL: 1000,
        SLIPPAGE_TOLERANCE: 500,
        MAX_SLIPPAGE_RECOVERY: 5.0,
        DEFAULT_SLIPPAGE_BPS: 500,
        DIRECTIONS: NETWORK_TRADE_DIRECTIONS.AVALANCHE,
    },
    ARBITRUM: {
        TRADE_SIZE: '100',
        SAFETY_MARGIN: 1,
        MAX_PRICE_IMPACT: 10.0, // Lower for L2 efficiency
        PRICE_CHECK_INTERVAL: 500, // Faster for L2
        SLIPPAGE_TOLERANCE: 300, // Lower slippage tolerance for L2
        MAX_SLIPPAGE_RECOVERY: 3.0,
        DEFAULT_SLIPPAGE_BPS: 300,
        DIRECTIONS: NETWORK_TRADE_DIRECTIONS.ARBITRUM,
    }
} as const;

// Legacy support - defaults to Avalanche
export const TRADE_SETTINGS = NETWORK_TRADE_SETTINGS.AVALANCHE;

/**
 * SHARED ABIs
 * ------------------------------------------------------------------
 * Contract ABIs (same across all networks)
 */
export const ABIS = {
    UNISWAP_V3_FACTORY: UniswapV3FactoryABI,
    UNISWAP_V3_POOL: UniswapV3PoolABI,
    UNISWAP_V3_ROUTER: UniswapV3RouterABI,
    ERC20: ERC20ABI,
    UNISWAP_V3_QUOTER: UniswapV3QuoterABI,
    TRADERJOE_PAIR: TraderJoePairABI,
} as const;

/**
 * NETWORK UTILITY FUNCTIONS
 * ------------------------------------------------------------------
 * Helper functions for network-aware operations
 */
export function getNetworkConfig(networkKey: NetworkKey) {
    return {
        network: SUPPORTED_NETWORKS[networkKey],
        tokens: NETWORK_TOKEN_CONFIGS[networkKey],
        addresses: NETWORK_ADDRESSES[networkKey],
        gasConfig: NETWORK_GAS_OPTIMIZATION[networkKey],
        tradeSettings: NETWORK_TRADE_SETTINGS[networkKey],
        tokenInstances: NETWORK_TOKENS[networkKey]
    };
}

export function getNetworkByChainId(chainId: ChainId): NetworkKey | undefined {
    return Object.keys(SUPPORTED_NETWORKS).find(
        key => SUPPORTED_NETWORKS[key as NetworkKey].chainId === chainId
    ) as NetworkKey | undefined;
}

export function isNetworkSupported(chainId: number): boolean {
    return Object.values(SUPPORTED_NETWORKS).some(network => network.chainId === chainId);
}

export function getDefaultNetworkKey(): NetworkKey {
    // Default to Avalanche for backward compatibility
    return 'AVALANCHE';
}

// Environment-based network selection
export function getCurrentNetworkKey(): NetworkKey {
    const envNetwork = process.env.CURRENT_NETWORK?.toUpperCase() as NetworkKey;
    if (envNetwork && SUPPORTED_NETWORKS[envNetwork]) {
        return envNetwork;
    }
    return getDefaultNetworkKey();
}