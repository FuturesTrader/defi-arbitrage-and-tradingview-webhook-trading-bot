#!/usr/bin/env ts-node
import {
    createWalletClient,
    createPublicClient,
    http,
    type Address
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche } from 'viem/chains';
import dotenv from 'dotenv';
import { ARBITRAGE_ABI } from '../src/services/constants/arbitrageAbi';
import logger from '../src/logger';

// Load environment variables
dotenv.config();

// Validate required environment variables
const validateEnv = () => {
    const requiredVars = [
        'PRIVATE_KEY',
        'AVALANCHE_RPC_URL',
        'ARBITRAGE_CONTRACT_ADDRESS'
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
        console.error('Missing required environment variables:', missingVars.join(', '));
        process.exit(1);
    }
};

// Main function to pause or unpause the contract
async function pauseUnpauseContract(action: 'pause' | 'unpause') {
    validateEnv();

    try {
        // Format private key
        const privateKey = process.env.PRIVATE_KEY!.startsWith('0x')
            ? process.env.PRIVATE_KEY as `0x${string}`
            : `0x${process.env.PRIVATE_KEY}` as `0x${string}`;

        // Create account from private key
        const account = privateKeyToAccount(privateKey);

        // Create wallet and public clients
        const walletClient = createWalletClient({
            account,
            chain: avalanche,
            transport: http(process.env.AVALANCHE_RPC_URL!)
        });

        const publicClient = createPublicClient({
            chain: avalanche,
            transport: http(process.env.AVALANCHE_RPC_URL!)
        });

        // Contract address
        const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as Address;

        // Check current pause status
        const isPaused = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'paused'
        });

        console.log(`Current contract pause status: ${isPaused ? 'PAUSED' : 'UNPAUSED'}`);

        // If trying to pause an already paused contract, or unpause an unpaused one
        if ((action === 'pause' && isPaused) || (action === 'unpause' && !isPaused)) {
            console.log(`Contract is already ${action === 'pause' ? 'paused' : 'unpaused'}. No action needed.`);
            return;
        }

        // Confirm action
        console.log(`Attempting to ${action} the contract...`);

        // Execute pause or unpause
        const hash = await walletClient.writeContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: action
        });

        console.log(`Transaction hash: ${hash}`);

        // Wait for transaction receipt
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        // Verify new pause status
        const newPausedStatus = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'paused'
        });

        console.log(`Contract successfully ${action}d.`);
        console.log(`New pause status: ${newPausedStatus ? 'PAUSED' : 'UNPAUSED'}`);

        // Log to file
        logger.info(`Contract ${action}d successfully`, {
            transactionHash: hash,
            blockNumber: receipt.blockNumber,
            contractAddress
        });
    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        logger.error(`Failed to ${action} contract`, {
            error: error instanceof Error ? error.message : String(error)
        });
        process.exit(1);
    }
}

// CLI argument parsing
const args = process.argv.slice(2);

if (args.length !== 1 || !['pause', 'unpause'].includes(args[0])) {
    console.log('Usage: ts-node pauseContractCLI.ts <pause|unpause>');
    console.log('Example: ts-node pauseContractCLI.ts pause');
    console.log('Example: ts-node pauseContractCLI.ts unpause');
    process.exit(1);
}

// Run the main function
pauseUnpauseContract(args[0] as 'pause' | 'unpause')
    .then(() => {
        logger.flush?.();
        process.exit(0);
    })
    .catch(error => {
        console.error('Unhandled error:', error);
        logger.error('Unhandled error in pauseContractCLI', { error: String(error) });
        logger.flush?.();
        process.exit(1);
    });