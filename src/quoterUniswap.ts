// src/quoterUniswap.ts - Updated to use Quoter Contract with WBTC support

import {
    CurrencyAmount,
    TradeType,
    Percent,
} from '@uniswap/sdk-core';
import {
    Pool,
    Route,
    Trade,
    SwapQuoter,
} from '@uniswap/v3-sdk';
import {
    createPublicClient,
    http,
    parseUnits,
    encodeFunctionData,
    formatUnits,
    hexToBytes,
    decodeAbiParameters,
    type Address,
    type Hex,
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
const QUOTER_ADDRESS = ADDRESSES.UNISWAP_V3.QUOTER;

const publicClient = createPublicClient({
    chain: avalanche,
    transport: http(process.env.AVALANCHE_RPC_URL as string),
});
const gasUtility = GasTransactionUtility.getInstance(publicClient);

// Define supported trading directions
type TradeDirection = 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC';

/**
 * Helper function to determine input and output tokens based on direction
 * @param direction Trade direction
 * @returns Array containing [inputToken, outputToken]
 */
function getTokensFromDirection(direction: TradeDirection): [typeof TOKENS.USDC_UNI | typeof TOKENS.WAVAX_UNI | typeof TOKENS.WBTC_UNI, typeof TOKENS.USDC_UNI | typeof TOKENS.WAVAX_UNI | typeof TOKENS.WBTC_UNI] {
    switch (direction) {
        case 'USDC->WAVAX':
            return [TOKENS.USDC_UNI, TOKENS.WAVAX_UNI];
        case 'WAVAX->USDC':
            return [TOKENS.WAVAX_UNI, TOKENS.USDC_UNI];
        case 'USDC->WBTC':
            return [TOKENS.USDC_UNI, TOKENS.WBTC_UNI];
        case 'WBTC->USDC':
            return [TOKENS.WBTC_UNI, TOKENS.USDC_UNI];
        default:
            throw new Error(`Unsupported trade direction: ${direction}`);
    }
}

/**
 * Helper function to get the default pool address for a given direction
 * @param direction Trade direction
 * @returns Default pool address for the trading pair
 */
function getDefaultPoolForDirection(direction: TradeDirection): Address {
    if (direction === 'USDC->WAVAX' || direction === 'WAVAX->USDC') {
        return ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX;
    } else if (direction === 'USDC->WBTC' || direction === 'WBTC->USDC') {
        return ADDRESSES.UNISWAP_V3.POOLS.USDC_WBTC;
    }

    // Fallback to USDC-WAVAX pool if direction is not recognized
    return ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX;
}

/**
 * Helper function to process return data from quoter contract
 */
function processQuoteReturnData(quoteCallReturnData: any): Hex {
    let returnData: Hex;

    if (typeof quoteCallReturnData === 'object' && quoteCallReturnData !== null && 'data' in quoteCallReturnData) {
        returnData = quoteCallReturnData.data as Hex;
    } else if (typeof quoteCallReturnData === 'string') {
        returnData = quoteCallReturnData as Hex;
    } else {
        throw new Error(`Unexpected return data type: ${typeof quoteCallReturnData}`);
    }

    if (!returnData || returnData === '0x') {
        throw new Error("No successful quote paths found");
    }

    return returnData;
}

/**
 * Reads basic pool information (tokens, fee, liquidity) from the Uniswap V3 pool.
 */
async function getPoolData(client: PublicClient, poolAddress: Address): Promise<PoolData> {
    try {
        // Fetch slot0 and liquidity data
        const [slot0Data, liquidity, fee] = await Promise.all([
            client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'slot0'
            }) as Promise<[bigint, number, number, number, number, number, boolean]>,
            client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'liquidity'
            }) as Promise<bigint>,
            client.readContract({
                address: poolAddress,
                abi: ABIS.UNISWAP_V3_POOL,
                functionName: 'fee'
            }) as Promise<number>
        ]);

        return {
            sqrtPriceX96: slot0Data[0],
            tick: slot0Data[1],
            liquidity,
            fee,
            token0: '' as Address, // Not needed for this approach
            token1: '' as Address  // Not needed for this approach
        };
    } catch (error) {
        logger.error('Error fetching Uniswap pool data', {
            error: error instanceof Error ? error.message : 'Unknown error',
            poolAddress
        });
        throw error;
    }
}

/**
 * getQuote():
 * - Uses the Uniswap Quoter contract to get accurate swap quotes
 * - Maintains the same function signature and return type as the original
 * - Returns a SimulatedQuoteResult with trade details, calldata, and price info
 *
 * @param direction - "USDC->WAVAX" or "WAVAX->USDC" or "USDC->WBTC" or "WBTC->USDC"
 * @param amount - The input amount as a string. For input directions, the default is TRADE_SETTINGS.TRADE_SIZE.
 *                 For output directions, the caller must supply the amount (typically the output from a first leg).
 * @param recipientOverride - Optional recipient address for the swap
 */
export async function getQuote(
    direction: TradeDirection,
    amount?: string,
    recipientOverride?: string
): Promise<SimulatedQuoteResult | null> {
    try {
        // 1) Determine the tokens and amount based on direction
        const [tokenIn, tokenOut] = getTokensFromDirection(direction);

        // Determine if this is a USDC-based input direction
        const isUsdcInput = tokenIn.symbol === 'USDC';
        const inputAmountStr = amount || (isUsdcInput ? TRADE_SETTINGS.TRADE_SIZE : '0');

        if (parseFloat(inputAmountStr) <= 0) {
            logger.warn('Invalid input amount for Uniswap quote', {
                direction,
                amount: inputAmountStr
            });
            return null;
        }

        // 2) Get the correct pool address for this trading pair
        const poolAddress = getDefaultPoolForDirection(direction);

        // 3) Fetch pool data (fee, liquidity, current tick)
        const poolData = await getPoolData(publicClient, poolAddress);

        // 4) Create the pool instance
        const pool = new Pool(
            tokenIn,
            tokenOut,
            poolData.fee,
            poolData.sqrtPriceX96.toString(),
            poolData.liquidity.toString(),
            poolData.tick
        );

        // 5) Create the route
        const route = new Route([pool], tokenIn, tokenOut);

        // 6) Create the input amount
        const amountIn = CurrencyAmount.fromRawAmount(
            tokenIn,
            parseUnits(inputAmountStr, tokenIn.decimals).toString()
        );

        // 7) Get quote using SwapQuoter
        logger.info('Generating calldata for Uniswap Quoter', {
            direction,
            inputAmount: inputAmountStr,
            tokenIn: tokenIn.symbol,
            tokenOut: tokenOut.symbol,
            fee: poolData.fee
        });

        // Generate calldata
        const { calldata } = SwapQuoter.quoteCallParameters(
            route,
            amountIn,
            TradeType.EXACT_INPUT,
            {
                useQuoterV2: true,
            }
        );

        // Call the quoter contract
        const quoteCallReturnData = await publicClient.call({
            to: QUOTER_ADDRESS,
            data: calldata as `0x${string}`,
        });

        // Process return data
        const returnData = processQuoteReturnData(quoteCallReturnData);
        const bytes = hexToBytes(returnData);

        // Decode the return data
        const [amountOut] = decodeAbiParameters(
            [{ type: 'uint256' }],
            bytes
        );

        // 8) Format the output amount
        const outputAmount = formatUnits(amountOut, tokenOut.decimals);

        if (parseFloat(outputAmount) <= 0.000001) {
            logger.warn('Uniswap Quoter returned zero or negligible output', {
                direction,
                inputAmount: inputAmountStr,
                outputAmount
            });
            return null;
        }

        logger.info('Uniswap Quoter returned output amount', {
            direction,
            inputAmount: inputAmountStr,
            outputAmount
        });

        // 9) Create the output currency amount
        const outputCurrencyAmount = CurrencyAmount.fromRawAmount(
            tokenOut,
            amountOut.toString()
        );

        // 10) Create a trade object for compatibility with existing code
        const trade: UniswapTradeType = Trade.createUncheckedTrade({
            route,
            inputAmount: amountIn,
            outputAmount: outputCurrencyAmount,
            tradeType: TradeType.EXACT_INPUT
        });

        // 11) Calculate execution price and min amount out with slippage
        const executionPrice = trade.executionPrice.toSignificant(6);
        const slippageTolerance = new Percent(TRADE_SETTINGS.SLIPPAGE_TOLERANCE.toString(), '10000');
        const minAmountOut = trade.minimumAmountOut(slippageTolerance).toExact();

        // 12) Calculate price impact
        const priceImpactValue = parseFloat(trade.priceImpact.toSignificant(4));

        if (priceImpactValue > TRADE_SETTINGS.MAX_PRICE_IMPACT) {
            logger.warn('Uniswap quote exceeds maximum price impact', {
                direction,
                priceImpact: priceImpactValue,
                maxAllowed: TRADE_SETTINGS.MAX_PRICE_IMPACT
            });
            return null;
        }

        // 13) Get current gas price
        const currentGasPrice = await gasUtility.getGasPrice();

        // 14) Prepare swap calldata for smart contract
        const swapData = await prepareSwapCalldata(
            trade,
            direction,
            poolData.fee,
            recipientOverride
        );

        logger.info('Final Uniswap quote via Quoter contract', {
            direction,
            inputAmount: inputAmountStr,
            outputAmount,
            executionPrice,
            priceImpact: priceImpactValue,
            minAmountOut,
            calldataLength: swapData.calldata.length
        });

        // 15) Return the quote result in the same format as before
        return {
            trade,
            formattedPrice: executionPrice,
            expectedOutput: outputAmount,
            poolAddress,
            fee: poolData.fee,
            gasPrice: currentGasPrice.toString(),
            priceImpact: priceImpactValue,
            minAmountOut,
            swapCalldata: swapData.calldata,
            estimatedGas: swapData.estimatedGas.toString(),
            routerAddress: ADDRESSES.UNISWAP_V3.ROUTER,
            quoteTimestamp: BigInt(await getBlockchainTime(publicClient))
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Handle specific error cases
        if (errorMsg.includes("execution reverted")) {
            logger.warn("Quoter contract execution reverted", {
                direction,
                amount,
                error: errorMsg
            });
            return null;
        }

        logger.error('Uniswap Quoter query failed', {
            error: errorMsg,
            direction,
            amount
        });
        return null;
    }
}

/**
 * Prepares the swap calldata for the smart contract execution
 * Enhanced to support both WAVAX and WBTC trades
 */
async function prepareSwapCalldata(
    trade: UniswapTradeType,
    direction: TradeDirection,
    fee: number,
    recipientOverride?: string
): Promise<SwapCalldata> {
    // 1) Set up slippage tolerance and deadline
    const slippageTolerance = new Percent(TRADE_SETTINGS.SLIPPAGE_TOLERANCE.toString(), '10000');
    const deadline = Math.floor(Date.now() / 1000) + MAX_DEADLINE; // 30 minutes
    const recipient = recipientOverride;

    // 2) Determine input and output tokens
    const [tokenIn, tokenOut] = getTokensFromDirection(direction);

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
    // Process command line arguments if available
    const args = process.argv.slice(2);
    const testDirection = args[0] as TradeDirection || 'USDC->WAVAX';
    const testAmount = args[1] || undefined;

    console.log(`Testing Uniswap quote for direction: ${testDirection}, amount: ${testAmount || 'default'}`);

    // For CLI testing, run the quote function with provided parameters
    getQuote(testDirection, testAmount)
        .then((quote) => {
            logger.info('Uniswap Quoter quote result', { quote });
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Uniswap Quoter quote failed', {
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
            });
            process.exit(1);
        });
}