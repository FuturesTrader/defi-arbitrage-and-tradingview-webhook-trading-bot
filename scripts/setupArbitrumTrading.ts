/**
 * setupArbitrumTrading.ts - Wallet Configuration for Arbitrum Trading
 *
 * This script sets up trading allowances and validates wallet configuration
 * for safe live trading on Arbitrum network.
 */

import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SUPPORTED_NETWORKS, ABIS, getNetworkConfig, NETWORK_TOKEN_CONFIGS } from '../src/constants';
import type { NetworkKey } from '../src/constants';

// Trading limits and safety configuration
interface TradingLimits {
    maxUSDCPerTrade: number;        // Maximum USDC per single trade
    maxDailyVolume: number;         // Maximum daily trading volume
    minBalanceReserve: number;      // Minimum balance to keep
    allowanceAmount: string;        // Token allowance amount ("unlimited" or specific amount)
}

const ARBITRUM_TRADING_LIMITS: TradingLimits = {
    maxUSDCPerTrade: 1500,          // $100 max per trade (adjust as needed)
    maxDailyVolume: 1500,           // $500 daily limit (adjust as needed)
    minBalanceReserve: 5,         // Keep $10 minimum balance
    allowanceAmount: "1500"        // Limited allowance instead of unlimited
};

class ArbitrumTradingSetup {
    private publicClient;
    private walletClient;
    private account;
    private networkConfig;

    constructor() {
        if (!process.env.PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY environment variable is required');
        }

        if (!process.env.ARBITRUM_RPC_URL) {
            throw new Error('ARBITRUM_RPC_URL environment variable is required');
        }

        const privateKey = process.env.PRIVATE_KEY;
        this.account = privateKeyToAccount(
            (privateKey.startsWith('0x') ?
                privateKey :
                `0x${privateKey}`) as `0x${string}`
        );

        this.publicClient = createPublicClient({
            chain: arbitrum,
            transport: http(process.env.ARBITRUM_RPC_URL)
        });

        this.walletClient = createWalletClient({
            account: this.account,
            chain: arbitrum,
            transport: http(process.env.ARBITRUM_RPC_URL)
        });

        this.networkConfig = getNetworkConfig('ARBITRUM');
    }

    /**
     * 🔧 Check current wallet balances on Arbitrum
     */
    async checkWalletBalances(): Promise<void> {
        console.log('\n🔍 Checking Arbitrum wallet balances...\n');

        try {
            // Get native ETH balance
            const ethBalance = await this.publicClient.getBalance({
                address: this.account.address
            });

            console.log(`ETH Balance: ${formatUnits(ethBalance, 18)} ETH`);

            // Check token balances for trading pairs
            const tokens = [
                { symbol: 'USDC', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC },
                { symbol: 'WETH', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH },
                { symbol: 'WBTC', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC }
            ];

            for (const token of tokens) {
                try {
                    const tokenAddress = token.config.address;

                    if (tokenAddress && tokenAddress !== '0x0000000000000000000000000000000000000000') {
                        const balance = await this.publicClient.readContract({
                            address: tokenAddress as `0x${string}`,
                            abi: ABIS.ERC20,
                            functionName: 'balanceOf',
                            args: [this.account.address]
                        }) as bigint;

                        console.log(`${token.config.symbol} Balance: ${formatUnits(balance, token.config.decimals)} ${token.config.symbol}`);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.log(`${token.symbol}: Unable to fetch balance (${errorMessage})`);
                }
            }

            // Check if minimum balance requirements are met
            const ethBalanceNumber = parseFloat(formatUnits(ethBalance, 18));
            if (ethBalanceNumber < 0.005) { // Minimum 0.005 ETH for gas
                console.log('⚠️  WARNING: Low ETH balance for gas fees. Consider adding more ETH.');
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('❌ Error checking balances:', errorMessage);
            throw error;
        }
    }

    /**
     * 🔧 Check current allowances for Uniswap V3 router
     */
    async checkAllowances(): Promise<void> {
        console.log('\n🔍 Checking token allowances for Uniswap V3 Router...\n');

        const routerAddress = this.networkConfig.addresses.UNISWAP_V3.ROUTER;
        const tokens = [
            { symbol: 'USDC', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC },
            { symbol: 'WETH', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH },
            { symbol: 'WBTC', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC }
        ];

        for (const token of tokens) {
            try {
                const tokenAddress = token.config.address;

                if (tokenAddress && tokenAddress !== '0x0000000000000000000000000000000000000000') {
                    const allowance = await this.publicClient.readContract({
                        address: tokenAddress as `0x${string}`,
                        abi: ABIS.ERC20,
                        functionName: 'allowance',
                        args: [this.account.address, routerAddress]
                    }) as bigint;

                    const allowanceFormatted = formatUnits(allowance, token.config.decimals);
                    const isUnlimited = allowance > parseUnits('1000000', token.config.decimals);

                    console.log(`${token.config.symbol} Allowance: ${allowanceFormatted} ${token.config.symbol}${isUnlimited ? ' (Unlimited)' : ''}`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.log(`${token.symbol}: Unable to check allowance (${errorMessage})`);
            }
        }
    }

    /**
     * 🔧 Set safe allowances for trading tokens
     */
    async setSafeAllowances(): Promise<void> {
        console.log('\n🔧 Setting safe token allowances...\n');

        const routerAddress = this.networkConfig.addresses.UNISWAP_V3.ROUTER;
        const allowanceAmount = parseUnits(ARBITRUM_TRADING_LIMITS.allowanceAmount, 6); // USDC has 6 decimals

        const tokens = [
            { symbol: 'USDC', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.USDC },
            { symbol: 'WETH', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.WETH },
            { symbol: 'WBTC', config: NETWORK_TOKEN_CONFIGS.ARBITRUM.WBTC }
        ];

        for (const token of tokens) {
            try {
                const tokenAddress = token.config.address;

                if (tokenAddress && tokenAddress !== '0x0000000000000000000000000000000000000000') {
                    // Calculate appropriate allowance based on token decimals
                    const tokenAllowance = token.symbol === 'USDC'
                        ? allowanceAmount
                        : token.symbol === 'WETH'
                            ? parseUnits('0.5', token.config.decimals) // 0.5 WETH allowance
                            : parseUnits('0.01', token.config.decimals); // 0.01 WBTC allowance

                    console.log(`Setting ${token.config.symbol} allowance to ${formatUnits(tokenAllowance, token.config.decimals)} ${token.config.symbol}...`);

                    // Simulate approval first
                    const { request } = await this.publicClient.simulateContract({
                        account: this.account,
                        address: tokenAddress as `0x${string}`,
                        abi: ABIS.ERC20,
                        functionName: 'approve',
                        args: [routerAddress, tokenAllowance]
                    });

                    // Execute approval
                    const hash = await this.walletClient.writeContract(request);
                    console.log(`✅ ${token.config.symbol} approval submitted: ${hash}`);

                    // Wait for confirmation
                    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
                    console.log(`✅ ${token.config.symbol} approval confirmed in block ${receipt.blockNumber}`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`❌ Error setting ${token.symbol} allowance:`, errorMessage);
            }
        }
    }

    /**
     * 🔧 Validate trading configuration
     */
    async validateTradingSetup(): Promise<boolean> {
        console.log('\n🔍 Validating Arbitrum trading setup...\n');

        let isValid = true;

        try {
            // Check network connectivity
            const blockNumber = await this.publicClient.getBlockNumber();
            console.log(`✅ Connected to Arbitrum (Block: ${blockNumber})`);

            // Validate contract addresses
            const routerCode = await this.publicClient.getBytecode({
                address: this.networkConfig.addresses.UNISWAP_V3.ROUTER as `0x${string}`
            });

            if (!routerCode) {
                console.error('❌ Uniswap V3 Router contract not found');
                isValid = false;
            } else {
                console.log('✅ Uniswap V3 Router contract validated');
            }

            // Check pool addresses
            const pools = this.networkConfig.addresses.UNISWAP_V3.POOLS;
            for (const [pairName, poolAddress] of Object.entries(pools)) {
                if (poolAddress !== '0x0000000000000000000000000000000000000000') {
                    const poolCode = await this.publicClient.getBytecode({
                        address: poolAddress as `0x${string}`
                    });

                    if (poolCode) {
                        console.log(`✅ ${pairName} pool validated`);
                    } else {
                        console.error(`❌ ${pairName} pool not found at ${poolAddress}`);
                        isValid = false;
                    }
                }
            }

            return isValid;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('❌ Error validating setup:', errorMessage);
            return false;
        }
    }

    /**
     * 🔧 Display trading limits summary
     */
    displayTradingLimits(): void {
        console.log('\n📋 Arbitrum Trading Limits Configuration:\n');
        console.log(`Maximum USDC per trade: $${ARBITRUM_TRADING_LIMITS.maxUSDCPerTrade}`);
        console.log(`Maximum daily volume: $${ARBITRUM_TRADING_LIMITS.maxDailyVolume}`);
        console.log(`Minimum balance reserve: $${ARBITRUM_TRADING_LIMITS.minBalanceReserve}`);
        console.log(`Token allowance: $${ARBITRUM_TRADING_LIMITS.allowanceAmount} USDC equivalent\n`);

        console.log('⚠️  Remember to:');
        console.log('   - Start with small test trades');
        console.log('   - Monitor gas costs on L2');
        console.log('   - Keep some ETH for gas fees');
        console.log('   - Review trade results before scaling up');
    }
}

/**
 * 🚀 Main setup function
 */
async function setupArbitrumTrading() {
    console.log('🚀 Arbitrum Trading Setup Starting...\n');

    try {
        const setup = new ArbitrumTradingSetup();

        // Display trading limits
        setup.displayTradingLimits();

        // Check current wallet state
        await setup.checkWalletBalances();
        await setup.checkAllowances();

        // Validate setup
        const isValid = await setup.validateTradingSetup();

        if (!isValid) {
            console.error('\n❌ Setup validation failed. Please check configuration.');
            process.exit(1);
        }

        // Ask user if they want to set allowances
        console.log('\n❓ Do you want to set safe token allowances now? (y/n)');

        // In a real environment, you'd use readline or prompt
        // For now, this is informational
        console.log('\n🔧 To set allowances, run:');
        console.log('tsx -r tsconfig-paths/register setupArbitrumTrading.ts --set-allowances');

        console.log('\n✅ Arbitrum trading setup validation complete!');
        console.log('🎯 Ready for live trading with safety limits in place.');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('\n❌ Setup failed:', errorMessage);
        process.exit(1);
    }
}

// CLI handling for ES modules
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);

    if (args.includes('--set-allowances')) {
        setupArbitrumTrading().then(async () => {
            const setup = new ArbitrumTradingSetup();
            await setup.setSafeAllowances();
        });
    } else {
        setupArbitrumTrading();
    }
}

export { ArbitrumTradingSetup, ARBITRUM_TRADING_LIMITS };