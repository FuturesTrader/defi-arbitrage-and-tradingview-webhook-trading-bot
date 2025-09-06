// src/mainJoe.ts
import logger from './logger';
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { getErrorMessage } from './utils.ts';
import TraderJoeExecutor from './executeJoeTrade.ts';
import { TRADE_CONFIGS, TradeDirection } from './executeJoeTrade.ts';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

// Global state - Update to include WBTC directions
// Use the same TradeDirection type from executeJoeTrade.ts
let currentTradeDirection: TradeDirection = 'USDC_TO_WBTC'; // Default

// Read Avalanche RPC URL from environment variables
const AVALANCHE_RPC_URL = process.env.AVALANCHE_RPC_URL;

if (!AVALANCHE_RPC_URL) {
    logger.error("AVALANCHE_RPC_URL not found in environment variables.");
    process.exit(1);
}

// Process command line arguments to set trade direction
function processArgs() {
    const args = process.argv.slice(2);
    if (args.length > 0) {
        const directionArg = args[0].toUpperCase();

        // Map argument to trade direction
        if (directionArg === 'USDC_TO_WAVAX' || directionArg === 'WAVAX_TO_USDC' ||
            directionArg === 'USDC_TO_WBTC' || directionArg === 'WBTC_TO_USDC') {
            currentTradeDirection = directionArg as TradeDirection;
            logger.info(`Setting trade direction from command line: ${currentTradeDirection}`);
        } else {
            logger.warn(`Unknown trade direction: ${directionArg}. Using default: ${currentTradeDirection}`);
        }
    }
}

// Capture the start time
const startTime = process.hrtime();
logger.info('Starting Trader Joe Trade Execution');

async function verifyNetwork(): Promise<boolean> {
    try {
        const publicClient = createPublicClient({
            chain: avalanche,
            transport: http(AVALANCHE_RPC_URL)
        });

        const blockNumber = await publicClient.getBlockNumber();
        logger.info('Network connection verified', {
            chain: avalanche.name,
            blockNumber: blockNumber.toString(),
            timestamp: new Date().toISOString()
        });
        return true;
    } catch (error) {
        logger.error('Network verification failed', {
            error: getErrorMessage(error)
        });
        return false;
    }
}

async function main() {
    try {
        // Process command line arguments
        processArgs();

        // Verify network connectivity
        const networkVerified = await verifyNetwork();
        if (!networkVerified) {
            logger.error("Network verification failed. Please check your network connection and try again.");
            process.exit(1);
        }

        // Get trade configuration based on direction
        if (!TRADE_CONFIGS[currentTradeDirection]) {
            logger.error(`Trade configuration not found for direction: ${currentTradeDirection}`);
            process.exit(1);
        }

        const tradeConfig = TRADE_CONFIGS[currentTradeDirection];
        logger.info('Trade configuration selected', {
            direction: currentTradeDirection,
            inputToken: tradeConfig.inputToken.symbol,
            outputToken: tradeConfig.outputToken.symbol,
            amount: tradeConfig.amount
        });

        // Retrieve private key from environment variables
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            logger.error("Private key not found in environment variables.");
            process.exit(1);
        }

        // Initialize TraderJoeExecutor
        const traderExecutor = new TraderJoeExecutor(privateKey);
        if (!traderExecutor) {
            logger.error('Failed to create trade executor');
            return;
        }

        // Execute the trade
        const hash = await traderExecutor.executeTrade(tradeConfig);

        // Calculate elapsed time
        const endTime = process.hrtime(startTime);
        const elapsedTime = (endTime[0] + endTime[1] / 1e9).toFixed(2); // seconds with two decimal places

        // Handle success
        logger.info('Trader Joe Trade completed successfully', {
            hash,
            direction: currentTradeDirection,
            elapsedTime: `${elapsedTime}s`
        });

        // Log 'Done in X.XXs'
        logger.info(`Done in ${elapsedTime}s`);

    } catch (error) {
        logger.error('Trade execution failed', {
            error: getErrorMessage(error),
            direction: currentTradeDirection
        });
        process.exit(1);
    }
}

// Execute main function
main().catch((error) => {
    logger.error('Fatal error in main execution', {
        error: getErrorMessage(error)
    });
    process.exit(1);
});