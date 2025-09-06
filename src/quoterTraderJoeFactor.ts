// src/quoterTraderJoe.ts

import { createPublicClient, http, parseUnits, encodeFunctionData,
    type PublicClient,} from 'viem';
import { avalanche } from 'viem/chains';
import {
    Token as JoeToken,
    TokenAmount,
    Percent,
} from '@traderjoe-xyz/sdk-core';
import {
    PairV2,
    RouteV2,
    TradeV2,
    jsonAbis,
} from '@traderjoe-xyz/sdk-v2';  // Make sure your sdk-v2 includes LB logic
import { getBlockchainTime, GasTransactionUtility } from './utils';
import dotenv from 'dotenv';
dotenv.config();

import logger from '@/logger';
import {
    TOKEN_CONFIGS,
    TRADE_SETTINGS,
    CHAIN_IDS,
    ADDRESSES,
    ARBITRAGE_SETTINGS,
    GAS_OPTIMIZATION,
} from './constants.ts';
import type {
    SimulatedQuoteResult,
    TraderJoeTradeType,
    SwapCalldata,
} from '@/tradeTypes';

const CHAIN_ID = CHAIN_IDS.AVALANCHE;
const MAX_DEADLINE = ARBITRAGE_SETTINGS.MAX_DEADLINE;
const ESTIMATED_GAS_LIMIT = GAS_OPTIMIZATION.ESTIMATED_GAS_LIMIT;

// 1) Create a shared public client for chain reads
const publicClient = createPublicClient({
    chain: avalanche,
    transport: http(process.env.AVALANCHE_RPC_URL as string),
});
const gasUtility = GasTransactionUtility.getInstance(publicClient);
// 2) Define the tokens from constants
const TRADERJOE_TOKENS = {
    USDC: new JoeToken(
        CHAIN_ID,
        TOKEN_CONFIGS.USDC.address,
        TOKEN_CONFIGS.USDC.decimals,
        TOKEN_CONFIGS.USDC.symbol,
        TOKEN_CONFIGS.USDC.name
    ),
    WAVAX: new JoeToken(
        CHAIN_ID,
        TOKEN_CONFIGS.WAVAX.address,
        TOKEN_CONFIGS.WAVAX.decimals,
        TOKEN_CONFIGS.WAVAX.symbol,
        TOKEN_CONFIGS.WAVAX.name
    ),
};
export const TRADERJOE_QUOTE_ADJUSTMENT_FACTORS = {
    // For USDC->WAVAX direction
    USDC_TO_WAVAX: 1.0000,

    // For WAVAX->USDC direction
    //WAVAX_TO_USDC: 0.9982
    WAVAX_TO_USDC: 1.000
};

/**
 * Apply the empirical adjustment factor to expected output
 * @param expectedOutput The original expected output
 * @param direction The swap direction ('USDC->WAVAX' or 'WAVAX->USDC')
 * @returns The adjusted expected output
 */
export function applyQuoteAdjustment(expectedOutput: string, direction: 'USDC->WAVAX' | 'WAVAX->USDC'): string {
    // Get the appropriate factor based on direction
    const factor = direction === 'USDC->WAVAX'
        ? TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.USDC_TO_WAVAX
        : TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WAVAX_TO_USDC;

    // Apply the adjustment factor
    const adjustedOutput = (parseFloat(expectedOutput) * factor).toString();
    return adjustedOutput;
}
/**
 * getQuote()
 * ----------------------------------------------------------------------
 * Simulates a Trader Joe V2 (Liquidity Book) swap for the given direction and amount.
 * Provides swap calldata for smart contract execution via LBRouter's swapExactTokensForTokens().
 *
 * @param direction - "USDC->WAVAX" or "WAVAX->USDC".
 * @param amount    - The input amount as a string. If not provided and direction=USDC->WAVAX,
 *                   a default TRADE_SETTINGS.TRADE_SIZE is used.
 * @returns SimulatedQuoteResult with trade details, call data, price info, etc.
 */
export async function getQuote(
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    amount?: string,
    recipientOverride?: string
): Promise<SimulatedQuoteResult | null> {
    try {
        // 1) Get current gas price
        const currentGasPrice = await gasUtility.getGasPrice();
        logger.info('Current gas price (wei):', { gasPrice: currentGasPrice.toString() });

        // 2) Determine input and output tokens
        const inputToken =
            direction === 'USDC->WAVAX' ? TRADERJOE_TOKENS.USDC : TRADERJOE_TOKENS.WAVAX;
        const outputToken =
            direction === 'USDC->WAVAX' ? TRADERJOE_TOKENS.WAVAX : TRADERJOE_TOKENS.USDC;

        logger.info('Input and output tokens determined', {
            inputToken: {
                symbol: inputToken.symbol,
                address: inputToken.address,
                decimals: inputToken.decimals,
            },
            outputToken: {
                symbol: outputToken.symbol,
                address: outputToken.address,
                decimals: outputToken.decimals,
            },
        });

        // 3) Use the provided amount or a default (for USDC->WAVAX)
        const inputAmountStr =
            amount || (direction === 'USDC->WAVAX' ? TRADE_SETTINGS.TRADE_SIZE : '0');
        if (parseFloat(inputAmountStr) <= 0) {
            logger.warn('Invalid input amount for TraderJoe quote', {
                direction,
                amount,
                inputAmountStr,
            });
            return null;
        }
        logger.info('Input amount string', { inputAmountStr });

        // 4) Create TokenAmount for the input
        const rawAmount = parseUnits(inputAmountStr, inputToken.decimals);
        const tokenAmount = new TokenAmount(inputToken, rawAmount.toString());
        logger.info('Converted input amount', {
            rawAmount: rawAmount.toString(),
            tokenAmount: tokenAmount.toExact(),
        });

        // 5) Set up "base tokens" to help build routes
        const baseTokens =
            direction === 'USDC->WAVAX'
                ? [TRADERJOE_TOKENS.USDC, TRADERJOE_TOKENS.WAVAX]
                : [TRADERJOE_TOKENS.WAVAX, TRADERJOE_TOKENS.USDC];

        logger.info('Using base tokens for TraderJoe quote', {
            direction,
            baseTokens: baseTokens.map((t) => t.symbol),
            inputAmount: inputAmountStr,
        });

        // 6) Create and init pairs
        const tokenPairs = PairV2.createAllTokenPairs(inputToken, outputToken, baseTokens);
        logger.debug('Token pairs created', { numPairs: tokenPairs.length });

        const pairs = await PairV2.initPairs(tokenPairs);
        logger.debug('Initialized pairs', { numPairs: pairs.length });

        // 7) Create routes
        const routes = RouteV2.createAllRoutes(pairs, inputToken, outputToken);
        logger.info('Routes created', { numRoutes: routes.length });

        if (!routes.length) {
            logger.warn('No valid routes found for TraderJoe LB');
            return null;
        }

        // 8) Build trades from routes
        const possibleTrades = await TradeV2.getTradesExactIn(
            routes,
            tokenAmount,
            outputToken,
            false, // don't maximize output
            false, // don't use stable pairs
            publicClient,
            CHAIN_ID
        );

        // 9) Filter valid trades and pick the best
        const validTrades = possibleTrades.filter((t): t is TradeV2 => !!t);
        logger.info('Number of valid trades found', { numValidTrades: validTrades.length });
        if (!validTrades.length) return null;

        const bestTrade = TradeV2.chooseBestTrade(validTrades, true);
        if (!bestTrade) {
            logger.warn('Could not determine best LB trade');
            return null;
        }

        // 10) Log best trade
        logger.info('Best trade selected', {
            executionPrice: bestTrade.executionPrice.toSignificant(6),
            expectedOutput: bestTrade.outputAmount.toExact(),
            priceImpact: bestTrade.priceImpact.toSignificant(4),
        });

        // 11) Check nonzero output
        if (parseFloat(bestTrade.outputAmount.toExact()) < 0.000001) {
            logger.warn('TraderJoe trade returned negligible output', {
                direction,
                inputAmount: inputAmountStr,
            });
            return null;
        }

        // 12) Get raw output and apply adjustment factor
        const rawExpectedOutput = bestTrade.outputAmount.toExact();
        const adjustedExpectedOutput = applyQuoteAdjustment(rawExpectedOutput, direction);

        // 13) Min amount out, fee info
        const slippageTolerance = new Percent(TRADE_SETTINGS.SLIPPAGE_TOLERANCE.toString(), '10000');
        const minAmountOut = bestTrade.minimumAmountOut(slippageTolerance).toExact();

        const feeInfo = await bestTrade.getTradeFee();
        const feeValue = parseFloat(feeInfo.totalFeePct.toSignificant(6));
        logger.info('Trade fee details', {
            totalFeePct: feeInfo.totalFeePct.toSignificant(6),
            feeAmountIn: feeInfo.feeAmountIn.toExact(),
        });

        // 14) Price impact check
        const priceImpactValue = parseFloat(bestTrade.priceImpact.toSignificant(4));
        if (priceImpactValue > TRADE_SETTINGS.MAX_PRICE_IMPACT) {
            logger.warn('TraderJoe LB quote exceeds max price impact', {
                direction,
                priceImpact: priceImpactValue,
            });
            return null;
        }

        // 15) Extract pool address (if relevant)
        const dynamicPoolAddress =
            (bestTrade.route as any)?.pairs?.[0]?.poolAddress ||
            ADDRESSES.TRADER_JOE.POOLS.USDC_WAVAX;

        // 16) Prepare swap calldata
        const swapData = await prepareSwapCalldata(bestTrade, direction, recipientOverride);

        // 17) Build the final result with adjusted output
        const result: SimulatedQuoteResult = {
            trade: bestTrade,
            formattedPrice: bestTrade.executionPrice.toSignificant(6),
            expectedOutput: adjustedExpectedOutput, // Use adjusted output here
            poolAddress: dynamicPoolAddress,
            fee: feeValue,
            gasPrice: currentGasPrice.toString(),
            priceImpact: priceImpactValue,
            minAmountOut,
            swapCalldata: swapData.calldata,
            estimatedGas: swapData.estimatedGas.toString(),
            routerAddress: ADDRESSES.TRADER_JOE.ROUTER, // or your LB Router address
            quoteTimestamp: BigInt(await getBlockchainTime(publicClient))
        };

        logger.info('TraderJoe quote generated', {
            direction,
            inputAmount: inputAmountStr,
            rawExpectedOutput,
            adjustedExpectedOutput,
            adjustmentFactor: direction === 'USDC->WAVAX'
                ? TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.USDC_TO_WAVAX
                : TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WAVAX_TO_USDC,
            priceImpact: priceImpactValue,
            fee: feeValue,
            calldataLength: swapData.calldata.length,
        });

        return result;
    } catch (error) {
        logger.error('TraderJoe quote simulation failed', {
            error: error instanceof Error ? error.message : String(error),
            direction,
            amount,
        });
        return null;
    }
}

/**
 * prepareSwapCalldata()
 * ------------------------------------------------------------------
 * Creates the LB 'Path' struct and calls swapExactTokensForTokens().
 *
 * For a single-hop: pathStruct = {
 *   pairBinSteps: [binStep],
 *   versions: [versionNum],  // often 2 for LB v2.2, or 1 for v2.1
 *   tokenPath: [tokenIn, tokenOut]
 * }
 *
 * For multi-hop: pathStruct.pairBinSteps might have multiple binSteps, etc.
 */
async function prepareSwapCalldata(
    trade: TraderJoeTradeType,
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    recipientOverride?: string
): Promise<SwapCalldata> {
    // 1) Slippage & deadline
    const slippageTolerance = new Percent(TRADE_SETTINGS.SLIPPAGE_TOLERANCE.toString(), '10000');
    const deadline = Math.floor(Date.now() / 1000) + MAX_DEADLINE;

    // Use the provided recipient or fail if none is provided
    if (!recipientOverride) {
        throw new Error('No recipient address provided for swap');
    }

    const recipient = recipientOverride;

    // 2) tokenIn, tokenOut (keeping this for logging purposes)
    const [tokenIn, tokenOut] =
        direction === 'USDC->WAVAX'
            ? [TRADERJOE_TOKENS.USDC, TRADERJOE_TOKENS.WAVAX]
            : [TRADERJOE_TOKENS.WAVAX, TRADERJOE_TOKENS.USDC];

    try {
        // 3) Create swap options similar to executeJoeTrade.ts
        const swapOptions = {
            allowedSlippage: slippageTolerance,
            ttl: MAX_DEADLINE,
            recipient: recipient,
            feeOnTransfer: false,
        };

        // 4) Let the SDK generate the swap parameters (method name, args, value)
        const swapParams = trade.swapCallParameters(swapOptions);

        logger.debug('TraderJoe SDK-generated swap parameters', {
            methodName: swapParams.methodName,
            recipient,
            deadline,
            value: swapParams.value,
            inputToken: tokenIn.symbol,
            outputToken: tokenOut.symbol,
            inputAmount: trade.inputAmount.toExact(),
            minOutputAmount: trade.minimumAmountOut(slippageTolerance).toExact()
        });

        // 5) Encode the call using the SDK-provided method name and args
        const calldata = encodeFunctionData({
            abi: jsonAbis.LBRouterV22ABI,
            functionName: swapParams.methodName,
            args: swapParams.args
        });

        // 6) Return data
        return {
            calldata,
            value: BigInt(swapParams.value),
            estimatedGas: ESTIMATED_GAS_LIMIT,
        };

    } catch (error) {
        logger.error('Error preparing TraderJoe swap calldata', {
            error: error instanceof Error ? error.message : String(error),
            direction,
            inputAmount: trade.inputAmount.toExact(),
            outputAmount: trade.outputAmount.toExact(),
            tokenIn: tokenIn.symbol,
            tokenOut: tokenOut.symbol,
            recipient
        });

        return {
            calldata: '0x',
            value: 0n,
            estimatedGas: ESTIMATED_GAS_LIMIT,
        };
    }
}


// Optional: CLI testing snippet
if (import.meta.url === `file://${process.argv[1]}`) {
    getQuote('USDC->WAVAX')
        .then((quote) => {
            logger.info('TraderJoe quote result', { quote });
            process.exit(0);
        })
        .catch((error) => {
            logger.error('TraderJoe quote failed', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
            });
            process.exit(1);
        });
}
