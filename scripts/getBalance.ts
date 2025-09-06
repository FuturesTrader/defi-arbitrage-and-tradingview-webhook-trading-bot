// getBalance.ts - Updated to include WBTC support for CrossDexArbitrageWithFlashLoan with Balancer Flash Loans

import { createPublicClient, formatUnits, http } from 'viem';
import { avalanche } from 'viem/chains';
import dotenv from 'dotenv';
import logger from '../src/logger';
import { TOKEN_CONFIGS, ADDRESSES } from '../src/constants';
import { ARBITRAGE_ABI } from '../src/services/constants/arbitrageAbi';

dotenv.config();
const FLASH_POOL = ADDRESSES.BALANCER_V2.POOL;

/**
 * Script to get the arbitrage contract's ERC-20 token balances and Balancer flash loan stats
 * Updated to include WBTC (BTC.b) support
 */
async function getBalance() {
    try {
        // Validate environment variables
        if (!process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables (AVALANCHE_RPC_URL, ARBITRAGE_CONTRACT_ADDRESS)');
        }

        const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as `0x${string}`;

        // Create a public (read-only) client to interact with the Avalanche chain
        const transport = http(process.env.AVALANCHE_RPC_URL);
        const publicClient = createPublicClient({
            chain: avalanche,
            transport
        });

        // Object for holding balances
        const contractBalances: Record<string, {
            formatted: string;
            raw: string;
            decimals: number;
        }> = {};

        // 1. Loop over each token in TOKEN_CONFIGS
        for (const [symbol, config] of Object.entries(TOKEN_CONFIGS)) {
            // Standard ERC-20 minimal ABI for balanceOf
            const rawBalance = await publicClient.readContract({
                address: config.address,
                abi: [
                    {
                        inputs: [{ name: "account", type: "address" }],
                        name: "balanceOf",
                        outputs: [{ name: "", type: "uint256" }],
                        stateMutability: "view",
                        type: "function"
                    }
                ],
                functionName: 'balanceOf',
                args: [contractAddress]
            });

            // Store the raw balance for logging
            const rawBalanceString = (rawBalance as bigint).toString();

            // Convert from rawBalance (bigint) to a human-readable format
            const formattedBalance = formatUnits(rawBalance as bigint, config.decimals);

            // You can adjust this precision as needed
            const displayPrecision = 12;
            const roundedBalance = Number(formattedBalance).toFixed(displayPrecision);

            contractBalances[symbol] = {
                formatted: roundedBalance,
                raw: rawBalanceString,
                decimals: config.decimals
            };
        }

        // 2. Initialize metrics data structure
        let metricData = {
            totalExecutions: 0n,
            successfulExecutions: 0n,
            failedExecutions: 0n,
            totalProfit: 0n,
            flashLoanExecutions: 0n,
            flashLoanSuccessful: 0n,
            flashLoanFailed: 0n,
            flashLoanProfit: 0n,
            successRate: 0n
        };

        // 3. Get contract stats using getContractStats
        try {
            const stats = await publicClient.readContract({
                address: contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'getContractStats'
            });

            if (stats) {
                // getContractStats returns [totalTrades, successfulTrades, failedTrades, successRate, cumulativeProfit]
                // Convert to unknown first to handle readonly array
                const statsArray = stats as unknown as readonly bigint[];
                metricData.totalExecutions = statsArray[0] || 0n;
                metricData.successfulExecutions = statsArray[1] || 0n;
                metricData.failedExecutions = statsArray[2] || 0n;
                metricData.successRate = statsArray[3] || 0n;
                metricData.totalProfit = statsArray[4] || 0n;

                logger.info('Retrieved contract stats', {
                    totalExecutions: metricData.totalExecutions.toString(),
                    successfulExecutions: metricData.successfulExecutions.toString(),
                    successRate: metricData.successRate.toString(),
                    totalProfit: metricData.totalProfit.toString()
                });
            }
        } catch (error) {
            logger.warn('Error retrieving contract stats', {
                error: error instanceof Error ? error.message : String(error)
            });
        }

        // 4. Get metrics struct data
        try {
            const metricsData = await publicClient.readContract({
                address: contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'metrics'
            });

            if (metricsData) {
                // Convert to unknown first to handle readonly array
                const metricsArray = metricsData as unknown as readonly bigint[];

                // Update flash loan related metrics from the struct
                metricData.flashLoanExecutions = metricsArray[4] || 0n;
                metricData.flashLoanSuccessful = metricsArray[5] || 0n;
                metricData.flashLoanFailed = metricsArray[6] || 0n;
                metricData.flashLoanProfit = metricsArray[7] || 0n;

                logger.info('Retrieved flash loan metrics', {
                    flashLoanExecutions: metricData.flashLoanExecutions.toString(),
                    flashLoanSuccessful: metricData.flashLoanSuccessful.toString(),
                    flashLoanProfit: metricData.flashLoanProfit.toString()
                });
            }
        } catch (error) {
            logger.warn('Error retrieving metrics struct', {
                error: error instanceof Error ? error.message : String(error)
            });
        }

        // 5. Get flash loan fee from contract
        const flashLoanFeeBps = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'getFlashLoanFeeBps'
        }).catch(() => 0n);

        // 6. Get flash loan provider address
        let flashLoanProviderAddress;
        try {
            const flashLoanConfig = await publicClient.readContract({
                address: contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'verifyFlashLoanConfiguration'
            });

            // Extract vault address from result - handle readonly array
            const configArray = flashLoanConfig as unknown as readonly unknown[];
            flashLoanProviderAddress = configArray[0] as string || '0x0000000000000000000000000000000000000000';
        } catch (error) {
            // Try using the immutable balancerVault
            try {
                flashLoanProviderAddress = await publicClient.readContract({
                    address: contractAddress,
                    abi: ARBITRAGE_ABI,
                    functionName: 'balancerVault'
                });
            } catch (vaultError) {
                // Fall back to the address from constants
                flashLoanProviderAddress = FLASH_POOL ||
                    '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

                logger.warn('Using fallback Balancer Vault address', {
                    fallbackAddress: flashLoanProviderAddress
                });
            }
        }

        // 7. Get contract state (paused status)
        const paused = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'paused'
        }).catch(() => false);

        // 8. Get contract owner
        const owner = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'owner'
        }).catch(() => '0x0000000000000000000000000000000000000000');

        // 9. Get router addresses
        const uniswapRouter = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'uniswapRouterAddress'
        }).catch(() => '0x0000000000000000000000000000000000000000');

        const traderJoeRouter = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'traderJoeRouterAddress'
        }).catch(() => '0x0000000000000000000000000000000000000000');

        // Log the balances to both logger and console
        logger.info('Arbitrage contract balances and stats', {
            contractAddress,
            owner,
            contractStatus: paused ? 'PAUSED' : 'ACTIVE',
            contractBalances,
            balancerSettings: {
                flashLoanProvider: flashLoanProviderAddress,
                flashLoanFeeBps: (flashLoanFeeBps as bigint).toString(),
                flashLoanFeePercent: ((Number(flashLoanFeeBps) / 10000) * 100).toFixed(4) + '%'
            },
            routerAddresses: {
                uniswapRouter,
                traderJoeRouter
            },
            flashLoanStats: {
                flashLoanExecutions: metricData.flashLoanExecutions.toString(),
                flashLoanSuccessful: metricData.flashLoanSuccessful.toString(),
                flashLoanFailed: metricData.flashLoanFailed.toString(),
                flashLoanProfit: metricData.flashLoanProfit.toString()
            },
            contractStats: {
                totalExecutions: metricData.totalExecutions.toString(),
                successfulExecutions: metricData.successfulExecutions.toString(),
                failedExecutions: metricData.failedExecutions.toString(),
                totalProfit: metricData.totalProfit.toString(),
                successRate: metricData.successRate.toString()
            }
        });

        // Format output for console
        console.log(`\n=== Contract Information ===`);
        console.log(`Address: ${contractAddress}`);
        console.log(`Owner: ${owner}`);
        console.log(`Status: ${paused ? 'PAUSED' : 'ACTIVE'}`);
        console.log(`Flash Loan Provider: ${flashLoanProviderAddress} (Balancer V2 Vault)`);
        console.log(`Flash Loan Fee: ${((Number(flashLoanFeeBps) / 10000) * 100).toFixed(4)}% (Balancer has 0% fees)`);
        console.log(`Uniswap Router: ${uniswapRouter}`);
        console.log(`TraderJoe Router: ${traderJoeRouter}`);

        console.log(`\n=== Token Balances ===`);
        for (const [symbol, balanceInfo] of Object.entries(contractBalances)) {
            console.log(`- ${symbol}: ${balanceInfo.formatted}`);

            // For extremely precise display, also show scientific notation for very small numbers
            const numValue = Number(balanceInfo.formatted);
            if (numValue > 0 && numValue < 0.0001) {
                console.log(`  Scientific notation: ${numValue.toExponential(8)}`);
            }
        }

        console.log(`\n=== Flash Loan Statistics ===`);
        console.log(`- Total Flash Loan Executions: ${metricData.flashLoanExecutions}`);
        console.log(`- Successful Flash Loans: ${metricData.flashLoanSuccessful}`);
        console.log(`- Failed Flash Loans: ${metricData.flashLoanFailed}`);

        // Format profit with proper decimals (assuming USDC with 6 decimals)
        const formattedFlashLoanProfit = formatUnits(metricData.flashLoanProfit, TOKEN_CONFIGS.USDC.decimals);
        console.log(`- Total Flash Loan Profit: ${formattedFlashLoanProfit} USDC`);

        console.log(`\n=== Overall Contract Statistics ===`);
        console.log(`- Total Executions: ${metricData.totalExecutions}`);
        console.log(`- Successful Executions: ${metricData.successfulExecutions}`);
        console.log(`- Failed Executions: ${metricData.failedExecutions}`);

        // Format profit with proper decimals
        const formattedTotalProfit = formatUnits(metricData.totalProfit, TOKEN_CONFIGS.USDC.decimals);
        console.log(`- Total Profit: ${formattedTotalProfit} USDC`);

        // Calculate success rate
        if (metricData.successRate > 0n) {
            // Success rate from contract is in basis points (1/100 of a percent)
            const successRatePercent = (Number(metricData.successRate) / 100).toFixed(2);
            console.log(`- Success Rate: ${successRatePercent}% (from contract)`);
        } else if (Number(metricData.totalExecutions) > 0) {
            // Calculate it manually if not provided by contract
            const successRate = (Number(metricData.successfulExecutions) / Number(metricData.totalExecutions)) * 100;
            console.log(`- Success Rate: ${successRate.toFixed(2)}% (calculated)`);
        }

        // Calculate flash loan success rate if there were executions
        if (Number(metricData.flashLoanExecutions) > 0) {
            const flashLoanSuccessRate = (Number(metricData.flashLoanSuccessful) / Number(metricData.flashLoanExecutions)) * 100;
            console.log(`- Flash Loan Success Rate: ${flashLoanSuccessRate.toFixed(2)}%`);
        }

        // Add a section for token pair arbitrage statistics
        console.log(`\n=== Token Pair Arbitrage Statistics ===`);
        // Display separate stats for WAVAX and WBTC pairs if available
        // Note: This would require the contract to track stats by token pair
        // For now, we'll just notify that both pairs are supported
        console.log(`- Supported Trading Pairs:`);
        console.log(`  • USDC/WAVAX`);
        console.log(`  • USDC/WBTC (BTC.b)`);

    } catch (error) {
        logger.error('Error in getBalance script', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Execute the script
getBalance().catch(console.error);