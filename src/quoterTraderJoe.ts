// src/quoterTraderJoe.ts

import {
    createPublicClient,
    http,
    parseUnits,
    formatUnits,
    encodeFunctionData,
    BaseError,
    type Address,
    type PublicClient
} from 'viem';
import { avalanche } from 'viem/chains';
import { getBlockchainTime, GasTransactionUtility, getErrorMessage } from './utils';
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
} from './constants';
import {
    LBQuoterV22ABI,
    LBRouterV22ABI,
} from "@traderjoe-xyz/sdk-v2";

import type {
    SimulatedQuoteResult,
    TraderJoeTradeType,
    SwapCalldata,
} from '@/tradeTypes';

const CHAIN_ID = CHAIN_IDS.AVALANCHE;
const MAX_DEADLINE = ARBITRAGE_SETTINGS.MAX_DEADLINE;
const ESTIMATED_GAS_LIMIT = GAS_OPTIMIZATION.ESTIMATED_GAS_LIMIT;

// Get addresses from constants
const QUOTER_ADDRESS = ADDRESSES.TRADER_JOE.QUOTER;
const ROUTER_ADDRESS = ADDRESSES.TRADER_JOE.ROUTER;

// Create a shared public client for chain reads
const publicClient = createPublicClient({
    chain: avalanche,
    transport: http(process.env.AVALANCHE_RPC_URL as string),
});

const gasUtility = GasTransactionUtility.getInstance(publicClient);

// Define type for the quoter result from Trader Joe
interface QuoterResult {
    route: Address[];
    pairs: Address[];
    binSteps: bigint[];
    versions: number[];
    amounts: bigint[];
    virtualAmountsWithoutSlippage: bigint[];
    fees: bigint[];
}

// Define the supported trading directions
type TradeDirection = 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC';

/**
 * getQuote()
 * ----------------------------------------------------------------------
 * Gets a quote directly from TraderJoe's on-chain LBQuoter contract for the given direction and amount.
 * Provides swap calldata for smart contract execution.
 * Now supports USDC-WAVAX and USDC-WBTC trading pairs.
 *
 * @param direction - Trading direction (USDC->WAVAX, WAVAX->USDC, USDC->WBTC, or WBTC->USDC)
 * @param amount    - The input amount as a string. If not provided and direction involves USDC as input,
 *                   a default TRADE_SETTINGS.TRADE_SIZE is used.
 * @param recipientOverride - Optional recipient address for the swap.
 * @returns SimulatedQuoteResult with trade details, call data, price info, etc.
 */
export async function getQuote(
    direction: TradeDirection,
    amount?: string,
    recipientOverride?: Address
): Promise<SimulatedQuoteResult | null> {
    try {
        // 1) Get current gas price
        const currentGasPrice = await gasUtility.getGasPrice();
        logger.info('Current gas price (wei):', { gasPrice: currentGasPrice.toString() });

        // 2) Determine input and output tokens based on direction
        const [inputToken, outputToken] = getTokensFromDirection(direction);

        logger.info('Input and output tokens determined', {
            direction,
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

        // 3) Use the provided amount or a default (for USDC as input)
        const isUsdcInput = inputToken.symbol === 'USDC';
        const inputAmountStr = amount || (isUsdcInput ? TRADE_SETTINGS.TRADE_SIZE : '0');
        if (parseFloat(inputAmountStr) <= 0) {
            logger.warn('Invalid input amount for TraderJoe quote', {
                direction,
                amount,
                inputAmountStr,
            });
            return null;
        }
        logger.info('Input amount string', { inputAmountStr });

        // 4) Parse the amount with appropriate decimals
        const amountBigInt = parseUnits(inputAmountStr, inputToken.decimals);

        // 5) Define the route as array of token addresses
        const route = [inputToken.address, outputToken.address];

        // 6) Define the appropriate quoter function
        const functionName = 'findBestPathFromAmountIn'; // We're always doing exactIn

        logger.debug('Calling TraderJoe quoter', {
            quoterAddress: QUOTER_ADDRESS,
            functionName,
            route: route.map(r => r.toString()),
            amountBigInt: amountBigInt.toString()
        });

        // 7) Get quote from on-chain quoter
        const quoterResult = await publicClient.readContract({
            address: QUOTER_ADDRESS,
            abi: LBQuoterV22ABI,
            functionName,
            args: [route, amountBigInt]
        }) as unknown as QuoterResult;

        // 8) Extract and validate the quote result
        const {
            route: resultRoute,
            pairs: resultPairs,
            binSteps: resultBinSteps,
            versions: resultVersions,
            amounts: resultAmounts,
            virtualAmountsWithoutSlippage: resultVirtualAmountsWithoutSlippage,
            fees: resultFees
        } = quoterResult;

        // 9) Validate that we got a valid quote
        if (resultAmounts.length <= 1 || resultAmounts[resultAmounts.length - 1] === 0n) {
            logger.warn('TraderJoe quoter returned zero output amount', {
                direction,
                inputAmount: inputAmountStr
            });
            return null;
        }

        // 10) Extract input and output amounts
        const inputAmount = resultAmounts[0];
        const outputAmount = resultAmounts[resultAmounts.length - 1];
        const expectedOutput = formatUnits(outputAmount, outputToken.decimals);

        // 11) Calculate price impact using virtual amounts
        const outputWithoutSlippage = resultVirtualAmountsWithoutSlippage[resultVirtualAmountsWithoutSlippage.length - 1];
        const priceImpact = Number(((outputWithoutSlippage - outputAmount) * 10000n) / outputWithoutSlippage) / 100;

        // 12) Check price impact against limit
        if (priceImpact > TRADE_SETTINGS.MAX_PRICE_IMPACT) {
            logger.warn('TraderJoe quote exceeds max price impact', {
                direction,
                priceImpact: priceImpact.toFixed(4) + '%',
                maxPriceImpact: TRADE_SETTINGS.MAX_PRICE_IMPACT + '%'
            });
            return null;
        }

        // 13) Calculate execution price
        const inputDecimals = inputToken.decimals;
        const outputDecimals = outputToken.decimals;
        const executionPrice = Number(outputAmount * 10n ** BigInt(inputDecimals)) /
            Number(inputAmount * 10n ** BigInt(outputDecimals));

        const formattedPrice = executionPrice.toFixed(6);

        // 14) Extract and normalize fee percentage
        let feePercentage = 0;
        if (resultFees.length > 0) {
            const firstFee = resultFees[0];
            // Trader Joe V2 fees are typically between 0.01% and 0.5%
            if (firstFee > 1000000000000000n) {  // If greater than 0.001 * 1e18
                feePercentage = Number(firstFee) / 1e16;  // Convert to percentage
            } else {
                feePercentage = Number(firstFee) / 100;  // Convert basis points to percentage
            }
            // Safety check - cap at reasonable values
            if (feePercentage > 10) {
                feePercentage = 0.3;  // Default to 0.3% if calculation is wrong
            }
        }

        // 15) Generate minimum output amount with slippage
        const slippageTolerance = TRADE_SETTINGS.SLIPPAGE_TOLERANCE;
        const slippageFactor = BigInt(10000 - slippageTolerance);
        const minOutputAmountBigInt = (outputAmount * slippageFactor) / 10000n;
        const minAmountOut = formatUnits(minOutputAmountBigInt, outputToken.decimals);

        // 16) Extract or use default pool address
        const poolAddress = resultPairs[0] || getDefaultPoolForDirection(direction);

        // 17) Get recipient address
        const recipient = recipientOverride || process.env.ARBITRAGE_CONTRACT_ADDRESS as Address || '0x0000000000000000000000000000000000000000' as Address;

        // 18) Create swap calldata
        const swapData = createSwapCalldata({
            route: resultRoute,
            pairs: resultPairs,
            binSteps: resultBinSteps.map(step => Number(step)),
            versions: resultVersions,
            amounts: resultAmounts,
            slippageBps: slippageTolerance,
            recipient,
            deadline: Math.floor(Date.now() / 1000) + MAX_DEADLINE,
            exactIn: true
        });

        logger.info('TraderJoe quote generated', {
            direction,
            inputAmount: formatUnits(inputAmount, inputToken.decimals),
            expectedOutput,
            executionPrice: formattedPrice,
            priceImpact: priceImpact.toFixed(4) + '%',
            fee: feePercentage.toFixed(4) + '%',
            calldataLength: swapData.calldata.length,
        });

        // 19) Create a mock trade object to maintain compatibility
        // This is needed because the existing priceMonitorService expects a trade object
        const mockTrade = createMockTraderJoeTrade(
            direction,
            inputAmountStr,
            expectedOutput,
            inputToken,
            outputToken
        );

        // 20) Build the final result
        const quoteResult: SimulatedQuoteResult = {
            trade: mockTrade,
            formattedPrice,
            expectedOutput,
            poolAddress,
            fee: feePercentage,
            gasPrice: currentGasPrice.toString(),
            priceImpact,
            minAmountOut,
            swapCalldata: swapData.calldata,
            estimatedGas: ESTIMATED_GAS_LIMIT.toString(),
            routerAddress: ROUTER_ADDRESS,
            quoteTimestamp: BigInt(await getBlockchainTime(publicClient))
        };

        return quoteResult;
    } catch (error) {
        if (error instanceof BaseError) {
            logger.error("TraderJoe quote simulation failed", {
                error: error.message,
                direction,
                amount
            });
        } else {
            logger.error('TraderJoe quote simulation failed', {
                error: error instanceof Error ? error.message : String(error),
                direction,
                amount,
            });
        }
        return null;
    }
}

/**
 * Helper function to determine input and output tokens based on direction
 * @param direction Trade direction
 * @returns Array containing [inputToken, outputToken]
 */
function getTokensFromDirection(direction: TradeDirection): [typeof TOKEN_CONFIGS.USDC | typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC, typeof TOKEN_CONFIGS.USDC | typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC] {
    switch (direction) {
        case 'USDC->WAVAX':
            return [TOKEN_CONFIGS.USDC, TOKEN_CONFIGS.WAVAX];
        case 'WAVAX->USDC':
            return [TOKEN_CONFIGS.WAVAX, TOKEN_CONFIGS.USDC];
        case 'USDC->WBTC':
            return [TOKEN_CONFIGS.USDC, TOKEN_CONFIGS.WBTC];
        case 'WBTC->USDC':
            return [TOKEN_CONFIGS.WBTC, TOKEN_CONFIGS.USDC];
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
        return ADDRESSES.TRADER_JOE.POOLS.USDC_WAVAX;
    } else if (direction === 'USDC->WBTC' || direction === 'WBTC->USDC') {
        return ADDRESSES.TRADER_JOE.POOLS.USDC_WBTC;
    }

    // Fallback to USDC-WAVAX pool if direction is not recognized
    return ADDRESSES.TRADER_JOE.POOLS.USDC_WAVAX;
}

/**
 * Create swap calldata based on quoter results
 */
function createSwapCalldata(params: {
    route: Address[];
    pairs: Address[];
    binSteps: number[];
    versions: number[];
    amounts: bigint[];
    slippageBps: number;
    recipient: Address;
    deadline: number;
    exactIn: boolean;
}): { calldata: `0x${string}`; value: bigint } {
    // Determine input and output amounts
    const inputAmount = params.amounts[0];
    const outputAmount = params.amounts[params.amounts.length - 1];

    // Calculate minimum output with slippage
    const slippageFactor = BigInt(10000 - params.slippageBps);
    const minOutputAmount = (outputAmount * slippageFactor) / 10000n;

    // LB Router path struct
    const pathStruct = {
        pairBinSteps: params.binSteps.map(step => BigInt(step)),
        versions: params.versions,
        tokenPath: params.route
    };

    // For exact input swaps (which is what we're doing)
    const functionName = "swapExactTokensForTokens";
    const args = [
        inputAmount,
        minOutputAmount,
        pathStruct,
        params.recipient,
        BigInt(params.deadline)
    ] as const;

    // Encode the function call
    const calldata = encodeFunctionData({
        abi: LBRouterV22ABI,
        functionName,
        args
    });

    return {
        calldata,
        value: 0n  // Native token value is 0 for token-to-token swaps
    };
}

/**
 * Create a mock TraderJoe trade object to maintain compatibility with existing code
 * Updated to support both WAVAX and WBTC trading pairs
 */
function createMockTraderJoeTrade(
    direction: TradeDirection,
    inputAmountStr: string,
    outputAmountStr: string,
    inputToken: typeof TOKEN_CONFIGS.USDC | typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC,
    outputToken: typeof TOKEN_CONFIGS.USDC | typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC
): TraderJoeTradeType {
    // Create a minimal trade object
    // This is a workaround since we're not using the SDK to create trades
    return {
        executionPrice: {
            toSignificant: (significantDigits: number) => {
                // Simple price calculation based on input and output amounts
                const input = parseFloat(inputAmountStr);
                const output = parseFloat(outputAmountStr);
                const price = output / input;
                return price.toFixed(significantDigits);
            }
        },
        inputAmount: {
            toExact: () => inputAmountStr,
            token: {
                symbol: inputToken.symbol,
                address: inputToken.address
            }
        },
        outputAmount: {
            toExact: () => outputAmountStr,
            token: {
                symbol: outputToken.symbol,
                address: outputToken.address
            }
        },
        priceImpact: {
            toSignificant: (significantDigits: number) => "0.5"  // Default value
        },
        minimumAmountOut: (slippage: any) => {
            return {
                toExact: () => {
                    // Calculate minimum output with slippage
                    const output = parseFloat(outputAmountStr);
                    const slippagePercent = parseFloat(slippage.numerator) / parseFloat(slippage.denominator);
                    const minOut = output * (1 - slippagePercent);
                    return minOut.toFixed(outputToken.decimals);
                }
            };
        },
        getTradeFee: async () => {
            return {
                totalFeePct: {
                    toSignificant: (significantDigits: number) => "0.3"  // Default value
                },
                feeAmountIn: {
                    toExact: () => {
                        // Calculate fee amount
                        const input = parseFloat(inputAmountStr);
                        const feeAmount = input * 0.003;  // 0.3% default fee
                        return feeAmount.toFixed(inputToken.decimals);
                    }
                }
            };
        },
        swapCallParameters: (options: any) => {
            // This is a stub - we're calculating calldata directly
            return {
                methodName: "swapExactTokensForTokens",
                args: [],
                value: "0"
            };
        }
    } as unknown as TraderJoeTradeType;
}

// Optional: CLI testing snippet
if (import.meta.url === `file://${process.argv[1]}`) {
    // Parse command line arguments to determine which direction to test
    const args = process.argv.slice(2);
    const testDirection = args[0] as TradeDirection || 'USDC->WAVAX';
    const testAmount = args[1] || undefined;

    console.log(`Testing TraderJoe quote for direction: ${testDirection}, amount: ${testAmount || 'default'}`);

    getQuote(testDirection, testAmount)
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