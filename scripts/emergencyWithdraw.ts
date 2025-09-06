// emergencyWithdraw.ts - Updated for WBTC support with CrossDexArbitrageWithFlashLoan using Balancer flash loans

import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche } from 'viem/chains';
import { ARBITRAGE_ABI } from '../src/services/constants/arbitrageAbi';
import { TOKEN_CONFIGS, ADDRESSES } from '../src/constants';
import dotenv from 'dotenv';
import logger from '../src/logger';

dotenv.config();
const FLASH_POOL = ADDRESSES.BALANCER_V2.POOL;

/**
 * Script to perform an emergency withdrawal of tokens from the flash loan arbitrage contract
 * Updated to support WBTC/BTC.b for Balancer V2 flash loan implementation
 */
async function emergencyWithdraw() {
    try {
        // Validate environment variables
        if (!process.env.PRIVATE_KEY || !process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables (PRIVATE_KEY, AVALANCHE_RPC_URL, ARBITRAGE_CONTRACT_ADDRESS)');
        }

        // Define the token symbol you want to withdraw (from command line or default to USDC)
        const tokenSymbol = process.argv[2] || 'USDC';
        console.log(`Using token: ${tokenSymbol}`);

        // Option to specify a specific amount (optional)
        const amountStr = process.argv[3];
        const specificAmount = amountStr ? parseUnits(amountStr, TOKEN_CONFIGS[tokenSymbol]?.decimals || 6) : undefined;

        if (amountStr) {
            console.log(`Withdrawing specific amount: ${amountStr} ${tokenSymbol}`);
        } else {
            console.log(`Withdrawing all ${tokenSymbol} balance`);
        }

        // Validate the token
        if (!TOKEN_CONFIGS[tokenSymbol]) {
            throw new Error(`Unknown token: ${tokenSymbol}. Supported tokens: ${Object.keys(TOKEN_CONFIGS).join(', ')}`);
        }

        const tokenConfig = TOKEN_CONFIGS[tokenSymbol];
        const tokenAddress = tokenConfig.address;

        // Initialize clients
        const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
            ? (process.env.PRIVATE_KEY as `0x${string}`)
            : (`0x${process.env.PRIVATE_KEY}` as `0x${string}`);

        const account = privateKeyToAccount(privateKey);
        const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as `0x${string}`;

        const transport = http(process.env.AVALANCHE_RPC_URL);
        const publicClient = createPublicClient({
            chain: avalanche,
            transport
        });

        const walletClient = createWalletClient({
            account,
            chain: avalanche,
            transport
        });

        // Get current balance of the contract for the chosen token
        const currentBalance = await publicClient.readContract({
            address: tokenAddress,
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

        const formattedBalance = formatUnits(currentBalance as bigint, tokenConfig.decimals);

        logger.info('Current contract balance', {
            token: tokenSymbol,
            balance: formattedBalance,
            tokenAddress,
            contractAddress
        });

        if ((currentBalance as bigint) <= 0n) {
            throw new Error(`Contract has no ${tokenSymbol} balance to withdraw.`);
        }

        // Check if specific amount is greater than balance
        if (specificAmount && specificAmount > (currentBalance as bigint)) {
            throw new Error(`Specified amount (${amountStr} ${tokenSymbol}) exceeds contract balance (${formattedBalance} ${tokenSymbol}).`);
        }

        // Get contract stats
        let contractStats = {
            totalExecutions: 0,
            successfulExecutions: 0,
            failedExecutions: 0,
            successRate: 0,
            totalProfit: '0'
        };

        try {
            const stats = await publicClient.readContract({
                address: contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'getContractStats'
            });

            if (stats) {
                // getContractStats returns [totalTrades, successfulTrades, failedTrades, successRate, cumulativeProfit]
                const statsArray = stats as unknown as readonly bigint[];
                contractStats = {
                    totalExecutions: Number(statsArray[0] || 0n),
                    successfulExecutions: Number(statsArray[1] || 0n),
                    failedExecutions: Number(statsArray[2] || 0n),
                    successRate: Number(statsArray[3] || 0n) / 100, // Convert from basis points to percentage
                    totalProfit: formatUnits(statsArray[4] || 0n, TOKEN_CONFIGS.USDC.decimals)
                };
            }
        } catch (error) {
            console.warn('Error retrieving contract stats:', error instanceof Error ? error.message : String(error));
        }

        // Get metrics struct data
        let metricsData = {
            flashLoanExecutions: 0,
            flashLoanSuccessful: 0,
            flashLoanFailed: 0,
            flashLoanProfit: '0'
        };

        try {
            const metrics = await publicClient.readContract({
                address: contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'metrics'
            });

            if (metrics) {
                const metricsArray = metrics as unknown as readonly bigint[];
                // Metrics struct has these fields in this order:
                // [totalExecutions, successfulExecutions, failedExecutions, totalProfit,
                //  flashLoanExecutions, flashLoanSuccessful, flashLoanFailed, flashLoanProfit]
                metricsData = {
                    flashLoanExecutions: Number(metricsArray[4] || 0n),
                    flashLoanSuccessful: Number(metricsArray[5] || 0n),
                    flashLoanFailed: Number(metricsArray[6] || 0n),
                    flashLoanProfit: formatUnits(metricsArray[7] || 0n, TOKEN_CONFIGS.USDC.decimals)
                };
            }
        } catch (error) {
            console.warn('Error retrieving metrics data:', error instanceof Error ? error.message : String(error));
        }

        // Get Balancer Vault address
        let balancerVaultAddress = FLASH_POOL as `0x${string}`;
        try {
            // Try to get the immutable address from the contract
            balancerVaultAddress = await publicClient.readContract({
                address: contractAddress,
                abi: ARBITRAGE_ABI,
                functionName: 'balancerVault'
            }) as `0x${string}`;
        } catch (error) {
            // Use the address from constants as fallback
            console.warn('Error retrieving Balancer Vault address, using default:', error instanceof Error ? error.message : String(error));
        }

        // Ensure the caller is the contract owner
        const owner = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'owner'
        });

        if ((owner as string).toLowerCase() !== account.address.toLowerCase()) {
            throw new Error(`Account ${account.address} is not the contract owner (${owner}).`);
        }

        // Check if contract is paused
        const isPaused = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'paused'
        }).catch(() => false);

        // Get token pair information
        let tokenPairInfo = '';
        if (tokenSymbol === 'WBTC') {
            tokenPairInfo = `Token: ${tokenSymbol} (BTC.b) (${tokenConfig.decimals} decimals)`;
        } else if (tokenSymbol === 'WAVAX') {
            tokenPairInfo = `Token: ${tokenSymbol} (${tokenConfig.decimals} decimals)`;
        } else {
            tokenPairInfo = `Token: ${tokenSymbol} (${tokenConfig.decimals} decimals)`;
        }

        // Confirmation prompt
        console.log(`\n⚠️ EMERGENCY WITHDRAWAL CONFIRMATION ⚠️`);
        if (specificAmount) {
            console.log(`This will withdraw ${amountStr} ${tokenSymbol} from the contract`);
        } else {
            console.log(`This will withdraw ALL ${tokenSymbol} (${formattedBalance}) from the contract`);
        }
        console.log(`Contract: ${contractAddress}`);
        console.log(tokenPairInfo);
        console.log(`To: ${account.address}`);
        console.log(`Contract status: ${isPaused ? 'PAUSED' : 'ACTIVE'}`);
        console.log(`\nFlash Loan Stats:`);
        console.log(`- Flash Loan Executions: ${metricsData.flashLoanExecutions}`);
        console.log(`- Successful: ${metricsData.flashLoanSuccessful}`);
        console.log(`- Failed: ${metricsData.flashLoanFailed}`);
        console.log(`- Profit: ${metricsData.flashLoanProfit} USDC`);
        console.log(`\nTotal Contract Stats:`);
        console.log(`- Total Executions: ${contractStats.totalExecutions}`);
        console.log(`- Success Rate: ${contractStats.successRate.toFixed(2)}%`);
        console.log(`- Total Profit: ${contractStats.totalProfit} USDC`);
        console.log();
        console.log(`Please type 'CONFIRM' to proceed with the emergency withdrawal:`);

        // Node.js standard input logic for final confirmation
        const input = await new Promise<string>((resolve) => {
            process.stdin.setEncoding('utf8');
            process.stdin.once('data', (data) => {
                resolve(data.toString().trim());
            });
        });

        if (input !== 'CONFIRM') {
            console.log('Withdrawal cancelled');
            process.exit(0);
        }

        try {
            let hash;
            if (specificAmount) {
                console.log(`Executing withdrawal of ${amountStr} ${tokenSymbol}...`);

                // Use withdrawFunds function for specific amount
                hash = await walletClient.writeContract({
                    address: contractAddress,
                    abi: ARBITRAGE_ABI,
                    functionName: 'withdrawFunds',
                    args: [tokenAddress, specificAmount]
                });

                logger.info('Withdrawal transaction submitted', { hash, amount: amountStr });
                console.log(`Transaction submitted: ${hash}`);
            } else {
                console.log(`Executing emergency withdrawal of all ${tokenSymbol}...`);

                // Use emergencyWithdraw function for all funds
                hash = await walletClient.writeContract({
                    address: contractAddress,
                    abi: ARBITRAGE_ABI,
                    functionName: 'emergencyWithdraw',
                    args: [tokenAddress]
                });

                logger.info('Emergency withdrawal transaction submitted', { hash });
                console.log(`Transaction submitted: ${hash}`);
            }

            // Wait for confirmation with timeout and retry
            console.log('Waiting for confirmation...');
            const receipt = await publicClient.waitForTransactionReceipt({
                hash, // Use the hash from the transaction we just submitted
                confirmations: 1,
                timeout: 120_000, // 120 seconds
                retryCount: 5,
                retryDelay: 3_000 // 3 seconds
            });

            if (receipt.status === 'success') {
                const withdrawnAmount = specificAmount
                    ? formatUnits(specificAmount, tokenConfig.decimals)
                    : formattedBalance;

                logger.info('Withdrawal successful', {
                    transactionHash: receipt.transactionHash,
                    blockNumber: receipt.blockNumber,
                    token: tokenSymbol,
                    amount: withdrawnAmount
                });

                console.log(`✅ Successfully withdrew ${withdrawnAmount} ${tokenSymbol}`);
                console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

                // Verify new contract balance
                const newBalance = await publicClient.readContract({
                    address: tokenAddress,
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

                const formattedNewBalance = formatUnits(newBalance as bigint, tokenConfig.decimals);
                console.log(`New contract balance: ${formattedNewBalance} ${tokenSymbol}`);

                // Verify owner balance increase
                const ownerBalance = await publicClient.readContract({
                    address: tokenAddress,
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
                    args: [account.address]
                });

                const formattedOwnerBalance = formatUnits(ownerBalance as bigint, tokenConfig.decimals);
                console.log(`Your wallet balance: ${formattedOwnerBalance} ${tokenSymbol}`);
            } else {
                logger.error('Withdrawal failed', {
                    transactionHash: receipt.transactionHash,
                    status: receipt.status
                });
                console.error('❌ Withdrawal failed');

                // Try to get error details from transaction receipt
                console.error('Checking for error details...');

                // Look for StateLog events with error info
                const stateLogs = receipt.logs.filter(log =>
                    log.address.toLowerCase() === contractAddress.toLowerCase()
                );

                for (const log of stateLogs) {
                    try {
                        const decoded = decodeEventLog({
                            abi: ARBITRAGE_ABI,
                            data: log.data,
                            topics: log.topics
                        });

                        if (decoded.eventName === 'StateLog' && decoded.args) {
                            const stage = (decoded.args as any).stage;
                            const data = (decoded.args as any).data;

                            if (stage && stage.includes('Error')) {
                                console.error(`Error details: ${stage} - ${data}`);
                            }
                        }
                    } catch (e) {
                        // Skip logs that can't be decoded
                    }
                }
            }
        } catch (error) {
            logger.error('Error executing withdrawal', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });

            console.error('Error:', error instanceof Error ? error.message : String(error));

            // Try to provide specific guidance based on error
            const errorMsg = String(error);
            if (errorMsg.includes('nonce')) {
                console.error('This may be a nonce error. Try resetting your wallet\'s nonce or wait for pending transactions to complete.');
            } else if (errorMsg.includes('gas')) {
                console.error('This may be a gas estimation error. The contract might be in an unexpected state.');
            } else if (errorMsg.includes('execution reverted')) {
                console.error('The transaction was reverted by the contract. This could be due to:');
                console.error('- Insufficient gas');
                console.error('- Contract has active flash loans or is locked');
                console.error('- A requirement in the contract function is not met');
            }

            process.exit(1);
        }

    } catch (error) {
        logger.error('Error in emergencyWithdraw script', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });

        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Execute the script
emergencyWithdraw().catch(console.error);