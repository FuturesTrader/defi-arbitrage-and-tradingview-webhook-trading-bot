// src/findPool.ts - Network-Aware Pool Discovery v2.0.0
// 🔧 MAJOR UPGRADE: Support for both Avalanche + Arbitrum pool discovery

import { createPublicClient, http, type Address } from 'viem';
import { avalanche, arbitrum } from 'viem/chains';
import {
    POOL_FEES,
    NETWORK_ADDRESSES,
    NETWORK_TOKEN_CONFIGS,
    getNetworkConfig,
    type NetworkKey,
    ABIS
} from './constants.js';
import dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

// ==================== TYPES AND INTERFACES ====================

interface PoolInfo {
    pairName: string;
    network: NetworkKey;
    address: string;
    fee: number;
    feePercent: string;
    liquidity: bigint;
    liquidityFormatted: string;
    isActive: boolean;
}

interface NetworkPoolConfig {
    name: string;
    rpcUrl: string | undefined;
    chain: typeof avalanche | typeof arbitrum;
    factory: Address;
    pairs: Array<{
        name: string;
        token0: { address: Address; symbol: string; };
        token1: { address: Address; symbol: string; };
    }>;
}

// ==================== NETWORK CONFIGURATIONS ====================

const NETWORK_CONFIGS: Record<NetworkKey, NetworkPoolConfig> = {
    AVALANCHE: {
        name: 'Avalanche',
        rpcUrl: process.env.AVALANCHE_RPC_URL,
        chain: avalanche,
        factory: NETWORK_ADDRESSES.AVALANCHE.UNISWAP_V3.FACTORY,
        pairs: [
            {
                name: 'USDC/WAVAX',
                token0: {
                    address: NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.address,
                    symbol: 'USDC'
                },
                token1: {
                    address: NETWORK_TOKEN_CONFIGS.AVALANCHE.WAVAX.address,
                    symbol: 'WAVAX'
                }
            },
            {
                name: 'USDC/WBTC',
                token0: {
                    address: NETWORK_TOKEN_CONFIGS.AVALANCHE.USDC.address,
                    symbol: 'USDC'
                },
                token1: {
                    address: NETWORK_TOKEN_CONFIGS.AVALANCHE.WBTC.address,
                    symbol: 'BTC.b'
                }
            }
        ]
    },
    ARBITRUM: {
        name: 'Arbitrum One',
        rpcUrl: process.env.ARBITRUM_RPC_URL,
        chain: arbitrum,
        factory: NETWORK_ADDRESSES.ARBITRUM.UNISWAP_V3.FACTORY,
        pairs: [
            {
                name: 'USDC/WETH',
                token0: {
                    address: NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.address,
                    symbol: 'USDC'
                },
                token1: {
                    address: NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH.address,
                    symbol: 'WETH'
                }
            },
            {
                name: 'USDC/WBTC',
                token0: {
                    address: NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC.address,
                    symbol: 'USDC'
                },
                token1: {
                    address: NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC.address,
                    symbol: 'WBTC'
                }
            }
        ]
    }
};

// ==================== FEE TIER CONFIGURATIONS ====================

const FEE_TIERS = [
    { fee: POOL_FEES.LOWEST, name: '0.01%', description: 'Lowest' },
    { fee: POOL_FEES.LOW, name: '0.05%', description: 'Low' },
    { fee: POOL_FEES.MEDIUM, name: '0.3%', description: 'Medium' },
    { fee: POOL_FEES.HIGH, name: '1%', description: 'High' }
] as const;

// ==================== POOL DISCOVERY CLASS ====================

class NetworkPoolDiscovery {
    private foundPools: PoolInfo[] = [];

    /**
     * Discover pools across all networks
     */
    async discoverAllPools(): Promise<PoolInfo[]> {
        console.log('🔍 Starting network-aware pool discovery...\n');

        this.foundPools = [];

        for (const [networkKey, config] of Object.entries(NETWORK_CONFIGS)) {
            await this.discoverNetworkPools(networkKey as NetworkKey, config);
        }

        return this.foundPools;
    }

    /**
     * Discover pools for a specific network
     */
    async discoverNetworkPools(network: NetworkKey, config: NetworkPoolConfig): Promise<void> {
        console.log(`\n🌐 ====== ${config.name} Network Discovery ======`);

        if (!config.rpcUrl) {
            console.warn(`⚠️  No RPC URL configured for ${config.name}. Skipping...`);
            return;
        }

        try {
            const client = createPublicClient({
                chain: config.chain,
                transport: http(config.rpcUrl)
            });

            // Verify network connectivity
            const blockNumber = await client.getBlockNumber();
            console.log(`✅ Connected to ${config.name} (Block: ${blockNumber})`);

            // Discover pools for each token pair
            for (const pair of config.pairs) {
                await this.discoverPairPools(client, network, config, pair);
            }

        } catch (error) {
            console.error(`❌ Failed to connect to ${config.name}:`, error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Discover pools for a specific token pair
     */
    private async discoverPairPools(
        client: any,
        network: NetworkKey,
        config: NetworkPoolConfig,
        pair: NetworkPoolConfig['pairs'][0]
    ): Promise<void> {
        console.log(`\n🔍 Checking ${pair.name} pair on ${config.name}...`);

        // Sort tokens by address (Uniswap V3 standard)
        const [token0, token1] = [pair.token0, pair.token1].sort((a, b) =>
            a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
        );

        console.log(`📊 Token0: ${token0.address} (${token0.symbol})`);
        console.log(`📊 Token1: ${token1.address} (${token1.symbol})`);

        // Check each fee tier
        for (const feeTier of FEE_TIERS) {
            await this.checkPoolAtFeeTier(client, network, config, pair, token0, token1, feeTier);
        }
    }

    /**
     * Check if a pool exists at a specific fee tier
     */
    private async checkPoolAtFeeTier(
        client: any,
        network: NetworkKey,
        config: NetworkPoolConfig,
        pair: NetworkPoolConfig['pairs'][0],
        token0: { address: Address; symbol: string; },
        token1: { address: Address; symbol: string; },
        feeTier: typeof FEE_TIERS[number]
    ): Promise<void> {
        try {
            console.log(`\n🎯 Checking ${feeTier.name} fee tier for ${pair.name}...`);

            // Query factory for pool address
            const poolAddress = await client.readContract({
                address: config.factory,
                abi: ABIS.UNISWAP_V3_FACTORY,
                functionName: 'getPool',
                args: [token0.address, token1.address, feeTier.fee]
            }) as Address;

            console.log(`📍 Pool address returned: ${poolAddress}`);

            // Check if pool exists
            if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
                console.log(`❌ No ${pair.name} pool for ${feeTier.name} fee tier`);
                return;
            }

            // Verify pool has deployed bytecode
            const code = await client.getCode({ address: poolAddress });
            if (!code || code.length <= 2) {
                console.log(`❌ Pool contract not deployed at ${poolAddress}`);
                return;
            }

            console.log(`✅ Pool contract verified at ${poolAddress}`);

            // Get pool liquidity and validate
            const liquidity = await client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'liquidity'
            }) as bigint;

            const isActive = liquidity > 0n;
            const liquidityFormatted = this.formatLiquidity(liquidity);

            console.log(`💧 Pool liquidity: ${liquidityFormatted} ${isActive ? '(Active)' : '(Inactive)'}`);

            // Store discovered pool
            this.foundPools.push({
                pairName: pair.name,
                network,
                address: poolAddress,
                fee: feeTier.fee,
                feePercent: feeTier.name,
                liquidity,
                liquidityFormatted,
                isActive
            });

            console.log(`✅ Found ${pair.name} pool: ${feeTier.name} fee tier with ${liquidityFormatted} liquidity`);

        } catch (error) {
            console.log(`❌ Error checking ${feeTier.name} fee tier for ${pair.name}:`,
                error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Format liquidity for display
     */
    private formatLiquidity(liquidity: bigint): string {
        const liquidityNum = Number(liquidity);
        if (liquidityNum === 0) return '0';
        if (liquidityNum < 1000) return liquidityNum.toString();
        if (liquidityNum < 1000000) return (liquidityNum / 1000).toFixed(1) + 'K';
        if (liquidityNum < 1000000000) return (liquidityNum / 1000000).toFixed(1) + 'M';
        return (liquidityNum / 1000000000).toFixed(1) + 'B';
    }

    /**
     * Generate comprehensive results report
     */
    generateReport(): void {
        if (this.foundPools.length === 0) {
            console.log('\n❌ No pools discovered across any networks');
            return;
        }

        // Group pools by network and pair
        const poolsByNetwork = this.foundPools.reduce((acc, pool) => {
            if (!acc[pool.network]) acc[pool.network] = {};
            if (!acc[pool.network][pool.pairName]) acc[pool.network][pool.pairName] = [];
            acc[pool.network][pool.pairName].push(pool);
            return acc;
        }, {} as Record<NetworkKey, Record<string, PoolInfo[]>>);

        console.log('\n🎉 ========== POOL DISCOVERY RESULTS ==========');

        // Display results by network
        for (const [network, pairs] of Object.entries(poolsByNetwork)) {
            const networkConfig = NETWORK_CONFIGS[network as NetworkKey];
            console.log(`\n🌐 ${networkConfig.name} Network:`);

            for (const [pairName, pools] of Object.entries(pairs)) {
                console.log(`\n  💱 ${pairName} pools:`);

                pools.forEach(pool => {
                    const status = pool.isActive ? '🟢' : '🔴';
                    console.log(`    ${status} ${pool.feePercent}: ${pool.address} (${pool.liquidityFormatted} liquidity)`);
                });

                // Recommend highest liquidity pool
                const activePools = pools.filter(p => p.isActive);
                if (activePools.length > 0) {
                    const recommended = activePools.reduce((prev, current) =>
                        prev.liquidity > current.liquidity ? prev : current
                    );
                    console.log(`    ⭐ Recommended: ${recommended.feePercent} pool (${recommended.address})`);
                }
            }
        }

        // Generate constants.ts updates
        this.generateConstantsUpdate(poolsByNetwork);
    }

    /**
     * Generate suggested constants.ts updates
     */
    private generateConstantsUpdate(poolsByNetwork: Record<NetworkKey, Record<string, PoolInfo[]>>): void {
        console.log('\n🔧 ========== SUGGESTED CONSTANTS.TS UPDATES ==========');

        for (const [network, pairs] of Object.entries(poolsByNetwork)) {
            console.log(`\n// ${NETWORK_CONFIGS[network as NetworkKey].name} pools:`);
            console.log(`${network}: {`);
            console.log(`    UNISWAP_V3: {`);
            console.log(`        // ... existing config ...`);
            console.log(`        POOLS: {`);

            for (const [pairName, pools] of Object.entries(pairs)) {
                const activePools = pools.filter(p => p.isActive);
                if (activePools.length > 0) {
                    const recommended = activePools.reduce((prev, current) =>
                        prev.liquidity > current.liquidity ? prev : current
                    );

                    const poolKey = pairName.replace('/', '_');
                    console.log(`            ${poolKey}: '${recommended.address}' as Address, // ${recommended.feePercent} fee, ${recommended.liquidityFormatted} liquidity`);
                }
            }

            console.log(`        }`);
            console.log(`    }`);
            console.log(`},`);
        }

        console.log('\n💡 Copy the above pool addresses to your constants.ts NETWORK_ADDRESSES configuration');
    }
}

// ==================== MAIN EXECUTION ====================

async function main(): Promise<void> {
    try {
        const discovery = new NetworkPoolDiscovery();

        // Check CLI arguments for specific network
        const args = process.argv.slice(2);
        const targetNetwork = args[0]?.toUpperCase() as NetworkKey;

        if (targetNetwork && ['AVALANCHE', 'ARBITRUM'].includes(targetNetwork)) {
            console.log(`🎯 Discovering pools for ${targetNetwork} only...`);
            const config = NETWORK_CONFIGS[targetNetwork];
            await discovery.discoverNetworkPools(targetNetwork, config);
        } else {
            console.log('🌐 Discovering pools across all networks...');
            await discovery.discoverAllPools();
        }

        discovery.generateReport();

        console.log('\n✅ Pool discovery completed successfully!');
        console.log('\n📝 Usage examples:');
        console.log('  yarn findPools              # Discover all networks');
        console.log('  yarn findPools avalanche    # Avalanche only');
        console.log('  yarn findPools arbitrum     # Arbitrum only');

    } catch (error) {
        console.error('❌ Pool discovery failed:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}