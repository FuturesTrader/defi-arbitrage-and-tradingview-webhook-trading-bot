// scripts/withdrawFunds.ts

import { createPublicClient, createWalletClient, formatUnits, parseUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche } from 'viem/chains';
import { ARBITRAGE_ABI } from '../src/services/constants/arbitrageAbi';
import { TOKEN_CONFIGS } from '../src/constants';
import dotenv from 'dotenv';
import logger from '../src/logger';

dotenv.config();

/**
 * Script to withdraw funds from the arbitrage contract
 * This version uses hardcoded token and amount instead of CLI args.
 */
async function withdrawFunds() {
    try {
        // Validate environment variables
        if (!process.env.PRIVATE_KEY || !process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables (PRIVATE_KEY, AVALANCHE_RPC_URL, ARBITRAGE_CONTRACT_ADDRESS)');
        }

        // 1) Define token and amount as constants (replace with your values).
        const tokenSymbol = 'USDC';         // Hardcoded token
        const amountStr = '100';           // Hardcoded amount as a string

        // Validate token
        if (!TOKEN_CONFIGS[tokenSymbol]) {
            throw new Error(`Unknown token: ${tokenSymbol}. Supported tokens: ${Object.keys(TOKEN_CONFIGS).join(', ')}`);
        }

        const tokenConfig = TOKEN_CONFIGS[tokenSymbol];
        const tokenAddress = tokenConfig.address;

        // 2) Parse the hardcoded amount
        const amount = parseUnits(amountStr, tokenConfig.decimals);

        // 3) Initialize clients
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

        // 4) Get current balance
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

        // 5) Ensure sufficient contract balance
        if ((currentBalance as bigint) < amount) {
            throw new Error(`Insufficient balance. Requested: ${amountStr} ${tokenSymbol}, Available: ${formattedBalance} ${tokenSymbol}`);
        }

        console.log(`Withdrawing ${amountStr} ${tokenSymbol} from contract...`);

        // 6) Execute withdrawal
        const hash = await walletClient.writeContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'withdrawFunds',
            args: [tokenAddress, amount]
        });

        logger.info('Withdrawal transaction submitted', { hash });
        console.log(`Transaction submitted: ${hash}`);

        // 7) Wait for confirmation
        console.log('Waiting for confirmation...');
        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: 60_000 // 60 seconds
        });

        if (receipt.status === 'success') {
            logger.info('Withdrawal successful', {
                transactionHash: hash,
                blockNumber: receipt.blockNumber,
                token: tokenSymbol,
                amount: amountStr
            });

            console.log(`✅ Successfully withdrew ${amountStr} ${tokenSymbol}`);
            console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

            // 8) Get new balance
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
        } else {
            logger.error('Withdrawal failed', {
                transactionHash: hash,
                status: receipt.status
            });
            console.error('❌ Withdrawal failed');
        }

    } catch (error) {
        logger.error('Error in withdrawFunds script', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });

        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Execute the script
withdrawFunds().catch(console.error);
