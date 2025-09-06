// src/quoterUniswap.ts

import {
    CurrencyAmount,
    TradeType,
    Percent,
} from '@uniswap/sdk-core';
import {
    Pool,
    Route,
    Trade,
    TICK_SPACINGS
} from '@uniswap/v3-sdk';
import {
    createPublicClient,
    http,
    parseUnits,
    encodeFunctionData,
    type Address,
    type PublicClient
} from 'viem';
import { avalanche } from 'viem/chains';
import dotenv from 'dotenv';
dotenv.config();
import logger from '@/logger';
import { GasTransactionUtility, getBlockchainTime } from './utils';
import {
    TOKENS,
    ABIS,
    TRADE_SETTINGS,
    ADDRESSES,
    ARBITRAGE_SETTINGS,
    GAS_OPTIMIZATION,
} from './constants';
import type {
    SimulatedQuoteResult,
    UniswapTradeType,
    PoolData,
    SwapCalldata
} from '@/tradeTypes';

const MAX_DEADLINE = ARBITRAGE_SETTINGS.MAX_DEADLINE;
const ESTIMATED_GAS_LIMIT = GAS_OPTIMIZATION.ESTIMATED_GAS_LIMIT;
const POOL = ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX;
/**
 * Adjustment factors for Uniswap quotes based on empirical data
 */
export const UNISWAP_QUOTE_ADJUSTMENT_FACTORS = {
    // For USDC->WAVAX direction
    USDC_TO_WAVAX: 1.0000,

    // For WAVAX->USDC direction
    //WAVAX_TO_USDC: 0.9985
    WAVAX_TO_USDC: 1.0000
};
const publicClient = createPublicClient({
    chain: avalanche,
    transport: http(process.env.AVALANCHE_RPC_URL as string),
});
const gasUtility = GasTransactionUtility.getInstance(publicClient);
/**
 * Slot0Return represents the output of the pool's slot0() call.
 */
type Slot0Return = [bigint, number, number, number, number, number, boolean];

/**
 * Reads slot0 and liquidity from the Uniswap V3 pool.
 */
async function getPoolData(client: PublicClient): Promise<PoolData> {
    try {
        const poolAddress = POOL;

        // 1) Fetch slot0 data
        const slot0Data = await client.readContract({
            address: poolAddress,
            abi: ABIS.UNISWAP_V3_POOL,
            functionName: 'slot0'
        }) as Slot0Return;

        // 2) Fetch liquidity
        const rawLiquidity = await client.readContract({
            address: poolAddress,
            abi: ABIS.UNISWAP_V3_POOL,
            functionName: 'liquidity'
        }) as bigint;

        // 3) Fetch token addresses and fee
        const [token0, token1, fee] = await Promise.all([
            client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'token0'
            }) as Promise<Address>,
            client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'token1'
            }) as Promise<Address>,
            client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'fee'
            }) as Promise<number>
        ]);

        logger.info('Raw pool data retrieved', {
            sqrtPriceX96: slot0Data[0].toString(),
            tick: slot0Data[1],
            liquidity: rawLiquidity.toString(),
            token0,
            token1,
            fee
        });

        return {
            token0,
            token1,
            fee,
            sqrtPriceX96: slot0Data[0],
            tick: slot0Data[1],
            liquidity: rawLiquidity
        };
    } catch (error) {
        logger.error('Error fetching Uniswap pool data', {
            error: error instanceof Error ? error.message : 'Unknown error',
            poolAddress: POOL
        });
        throw error;
    }
}

/**
 * Creates minimal bounding ticks for a single tick range.
 */
function createWideBoundingTicks(
    currentTick: number,
    liquidity: bigint,
    tickSpacing: number,
    rangeInTickSteps: number
) {
    // Lower bound
    const tickLowerIndex = Math.floor(currentTick / tickSpacing) - rangeInTickSteps;
    // Make sure we stay above MIN_TICK in Uniswap V3 if needed
    const tickLower = tickLowerIndex * tickSpacing;

    // Upper bound
    const tickUpperIndex = Math.floor(currentTick / tickSpacing) + rangeInTickSteps;
    // Make sure we stay below MAX_TICK
    const tickUpper = tickUpperIndex * tickSpacing;

    return [
        {
            index: tickLower,
            liquidityNet: liquidity.toString(),
            liquidityGross: liquidity.toString(),
        },
        {
            index: tickUpper,
            liquidityNet: (-liquidity).toString(),
            liquidityGross: liquidity.toString(),
        }
    ];
}

/**
 * Apply the empirical adjustment factor to expected output
 * @param expectedOutput The original expected output
 * @param direction The swap direction ('USDC->WAVAX' or 'WAVAX->USDC')
 * @returns The adjusted expected output
 */
export function applyQuoteAdjustment(expectedOutput: string, direction: 'USDC->WAVAX' | 'WAVAX->USDC'): string {
    // Get the appropriate factor based on direction
    const factor = direction === 'USDC->WAVAX'
        ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.USDC_TO_WAVAX
        : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX_TO_USDC;

    // Apply the adjustment factor
    const adjustedOutput = (parseFloat(expectedOutput) * factor).toString();

    logger.debug('Applied Uniswap quote adjustment', {
        direction,
        originalOutput: expectedOutput,
        adjustmentFactor: factor,
        adjustedOutput
    });

    return adjustedOutput;
}

/**
 * getQuote():
 * - Reads on-chain pool data for a predetermined pool.
 * - Constructs a Pool from the on-chain data.
 * - Depending on the direction ("USDC->WAVAX" or "WAVAX->USDC"),
 *   builds a Route with the appropriate input/output tokens.
 * - Constructs the input CurrencyAmount using the proper decimals.
 * - Calculates the expected output amount and returns a SimulatedQuoteResult.
 *
 * @param direction - "USDC->WAVAX" or "WAVAX->USDC"
 * @param amount - The input amount as a string. For "USDC->WAVAX" the default is TRADE_SETTINGS.TRADE_SIZE.
 *                 For "WAVAX->USDC", the caller must supply the amount (typically the output from a first leg).
 */
export async function getQuote(
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    amount?: string,
    recipientOverride?: string
): Promise<SimulatedQuoteResult | null> {
    const client = createPublicClient({
        chain: avalanche,
        transport: http(process.env.AVALANCHE_RPC_URL as string),
    });

    try {
        // 1) Fetch on-chain pool data from the predetermined USDC->WAVAX pool
        const poolData = await getPoolData(client);
        const poolAddress = POOL;

        // 2) Validate pool fee
        const fee = poolData.fee;
        if (!fee || ![500, 3000].includes(fee)) {
            logger.error('Invalid or unsupported fee from Uniswap pool', {
                direction,
                poolAddress,
                fee
            });
            return null;
        }

        // 3) Lookup tick spacing and build bounding ticks
        const tickSpacing = TICK_SPACINGS[fee as keyof typeof TICK_SPACINGS];
        const rangeInTickSteps = 1000; // or 1000, etc.  If we see excessive values for pricing updated
        const boundingTicks = createWideBoundingTicks(
            poolData.tick,
            poolData.liquidity,
            tickSpacing,
            rangeInTickSteps
        );

        // 4) Construct the Pool with bounding ticks
        const pool = new Pool(
            TOKENS.USDC_UNI,
            TOKENS.WAVAX_UNI,
            fee,
            poolData.sqrtPriceX96.toString(),
            poolData.liquidity.toString(),
            poolData.tick,
            boundingTicks
        );

        // 5) Determine the route and input amount based on the direction
        let route;
        let inputAmountStr: string;
        let inputToken, outputToken;

        if (direction === 'USDC->WAVAX') {
            inputAmountStr = amount || TRADE_SETTINGS.TRADE_SIZE;
            inputToken = TOKENS.USDC_UNI;
            outputToken = TOKENS.WAVAX_UNI;
            route = new Route([pool], inputToken, outputToken);
        } else {
            if (!amount) {
                throw new Error('No input amount provided for WAVAX->USDC quote');
            }
            inputAmountStr = amount;
            inputToken = TOKENS.WAVAX_UNI;
            outputToken = TOKENS.USDC_UNI;
            route = new Route([pool], inputToken, outputToken);
        }

        // 6) Build the input CurrencyAmount
        const amountInBn = parseUnits(inputAmountStr, inputToken.decimals);
        const amountIn = CurrencyAmount.fromRawAmount(inputToken, amountInBn.toString());

        // 7) Get the output amount from the pool
        const [outputAmount] = await pool.getOutputAmount(amountIn);

        // Validate output is non-zero
        if (parseFloat(outputAmount.toExact()) <= 0.000001) {
            logger.warn('Uniswap pool returned zero or negligible output', {
                direction,
                inputAmount: inputAmountStr,
                outputAmount: outputAmount.toExact()
            });
            return null;
        }

        // 8) Create an unchecked trade with pre-calculated output
        const trade: UniswapTradeType = Trade.createUncheckedTrade({
            route,
            inputAmount: amountIn,
            outputAmount,  // Use pre-calculated non-zero output
            tradeType: TradeType.EXACT_INPUT
        });

        // 9) Format the execution price and log
        const bestExecutionPrice = trade.executionPrice.toSignificant(6);

        // 10) Calculate minimum amount out with slippage tolerance
        const slippageTolerance = new Percent(TRADE_SETTINGS.SLIPPAGE_TOLERANCE.toString(), '10000');
        const minAmountOut = trade.minimumAmountOut(slippageTolerance).toExact();

        // 11) Calculate price impact
        const priceImpactValue = parseFloat(trade.priceImpact.toSignificant(4));

        // Validate price impact is reasonable
        if (priceImpactValue > TRADE_SETTINGS.MAX_PRICE_IMPACT) {
            logger.warn('Uniswap quote exceeds maximum price impact', {
                direction,
                priceImpact: priceImpactValue,
                maxAllowed: TRADE_SETTINGS.MAX_PRICE_IMPACT
            });
            return null;
        }

        // 12) Get the adjusted gas price
        const currentGasPrice = await gasUtility.getGasPrice();

        // 13) Get raw expected output and apply adjustment factor
        const rawExpectedOutput = outputAmount.toExact();
        const adjustedExpectedOutput = applyQuoteAdjustment(rawExpectedOutput, direction);

        // 14) Prepare swap calldata for smart contract
        const swapData = await prepareSwapCalldata(trade, direction, fee, recipientOverride);

        logger.info('Final Uniswap quote', {
            direction,
            inputAmount: inputAmountStr,
            computedPrice: bestExecutionPrice,
            rawExpectedOutput: rawExpectedOutput,
            adjustedExpectedOutput: adjustedExpectedOutput,
            adjustmentFactor: direction === 'USDC->WAVAX'
                ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.USDC_TO_WAVAX
                : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX_TO_USDC,
            priceImpact: priceImpactValue,
            minAmountOut,
            calldataLength: swapData.calldata.length
        });

        // 15) Build and return the complete quote result with adjusted output
        return {
            trade,
            formattedPrice: bestExecutionPrice,
            expectedOutput: adjustedExpectedOutput, // Use the adjusted output here
            poolAddress,
            fee,
            gasPrice: currentGasPrice.toString(),
            priceImpact: priceImpactValue,
            minAmountOut,
            swapCalldata: swapData.calldata,
            estimatedGas: swapData.estimatedGas.toString(),
            routerAddress: ADDRESSES.UNISWAP_V3.ROUTER,
            quoteTimestamp: BigInt(await getBlockchainTime(client))
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes("TICK_SPACING")) {
            logger.warn("Transient TICK_SPACING error in getQuote, skipping this cycle", { error: errorMsg });
            return null;
        }

        if (errorMsg.includes("INSUFFICIENT_LIQUIDITY")) {
            logger.warn('Insufficient liquidity for Uniswap quote', { direction, amount });
            return null;
        }

        logger.error('Uniswap quote failed', { error: errorMsg });
        return null;
    }
}

/**
 * Prepares the swap calldata for the smart contract execution
 */
async function prepareSwapCalldata(
    trade: UniswapTradeType,
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    fee: number,
    recipientOverride?: string
): Promise<SwapCalldata> {
    // 1) Set up slippage tolerance and deadline
    const slippageTolerance = new Percent(TRADE_SETTINGS.SLIPPAGE_TOLERANCE.toString(), '10000');
    const deadline = Math.floor(Date.now() / 1000) + MAX_DEADLINE; // 30 minutes
    const recipient = recipientOverride;

    // 2) Determine input and output tokens
    const [tokenIn, tokenOut] = direction === 'USDC->WAVAX'
        ? [TOKENS.USDC_UNI, TOKENS.WAVAX_UNI]
        : [TOKENS.WAVAX_UNI, TOKENS.USDC_UNI];

    if (!recipientOverride) {
        throw new Error('No recipient address provided for swap');
    }

    // 3) Prepare the exactInputSingle parameters
    const params = {
        tokenIn: tokenIn.address as Address,
        tokenOut: tokenOut.address as Address,
        fee,
        recipient: recipient as Address,
        deadline,
        amountIn: BigInt(trade.inputAmount.quotient.toString()),
        amountOutMinimum: BigInt(trade.minimumAmountOut(slippageTolerance).quotient.toString()),
        sqrtPriceLimitX96: 0n
    };

    // 4) Encode the function call
    const calldata = encodeFunctionData({
        abi: ABIS.UNISWAP_V3_ROUTER,
        functionName: 'exactInputSingle',
        args: [params]
    });

    // 5) Set estimated gas (this could be refined based on historical data)
    const estimatedGas = ESTIMATED_GAS_LIMIT;

    return {
        calldata,
        value: 0n,
        estimatedGas
    };
}

// If this file is run directly, run getQuote() as a CLI script.
if (import.meta.url === `file://${process.argv[1]}`) {
    // For CLI testing, default to a USDC->WAVAX quote.
    getQuote('USDC->WAVAX')
        .then((quote) => {
            logger.info('Uniswap quote result', { quote });
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Uniswap quote failed', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
            });
            process.exit(1);
        });
}