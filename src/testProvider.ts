// src/testProvider.ts
import { createPublicClient, http } from 'viem';
import { avalanche } from 'viem/chains';
import logger from './logger.ts';
import { getErrorMessage } from './utils.ts';
import dotenv from 'dotenv';
dotenv.config();

async function testProvider() {
    // Validate environment variables
    const rpcUrl = process.env.AVALANCHE_RPC_URL;
    if (!rpcUrl) {
        logger.error('AVALANCHE_RPC_URL not found in environment variables');
        process.exit(1);
    }

    try {
        // Initialize the Viem public client
        const client = createPublicClient({
            chain: avalanche,
            transport: http(rpcUrl)
        });

        // Test connection by getting block number
        const blockNumber = await client.getBlockNumber();
        logger.info('Successfully connected to provider', {
            chain: avalanche.name,
            blockNumber: blockNumber.toString(),
            timestamp: new Date().toISOString()
        });

        // Get additional chain information for verification
        const [blockInfo, chainId, gasPrice] = await Promise.all([
            client.getBlock({ blockNumber }),
            client.getChainId(),
            client.getGasPrice()
        ]);

        logger.info('Chain information', {
            chainId,
            blockHash: blockInfo.hash,
            blockTimestamp: new Date(Number(blockInfo.timestamp) * 1000).toISOString(),
            gasPrice: gasPrice.toString()
        });

    } catch (error) {
        logger.error('Failed to connect to provider', {
            error: getErrorMessage(error),
            timestamp: new Date().toISOString()
        });
        process.exit(1);
    }
}

// Execute the test
console.log('Testing provider connection...');
testProvider()
    .then(() => {
        console.log('Provider test completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Provider test failed:', error);
        process.exit(1);
    });