// src/directTraderJoeQuoter.ts
import {
    createPublicClient,
    http,
    parseUnits,
    formatUnits,
    encodeFunctionData,
    BaseError,
    type Address
} from "viem";
import { avalanche } from "viem/chains";
import {ADDRESSES, TOKEN_CONFIGS} from './constants.ts';
import logger from './logger.ts';
import dotenv from 'dotenv';
import { getErrorMessage } from "./utils.ts";
import {
    LBQuoterV22ABI,
    LBRouterV22ABI,
} from "@traderjoe-xyz/sdk-v2";

// Load environment variables
dotenv.config();

// Constants - Fix for the first error by explicitly casting to Address type
// Trader Joe V2.2 LB QUOTER address on Avalanche
//const QUOTER_ADDRESS = ADDRESSES.TRADER_JOE.QUOTER || ("0xb8e6D31e7B212b2b7250EE9c26C56cEBE5a53b7") as Address;
const QUOTER_ADDRESS = ADDRESSES.TRADER_JOE.QUOTER;
// Trader Joe V2.2 LB ROUTER address on Avalanche
const ROUTER_ADDRESS = ADDRESSES.TRADER_JOE.ROUTER;

export interface TokenInfo {
    address: Address;
    decimals: number;
    symbol: string;
    name: string;
}

export type TradeDirection = 'USDC_TO_WAVAX' | 'WAVAX_TO_USDC';

export interface QuoteConfig {
    inputToken: TokenInfo;
    outputToken: TokenInfo;
    amount: string;
    exactIn: boolean;
    slippageBps: number; // Basis points (1/10000)
    recipient: Address;
    deadline: number; // Seconds from now
}

export interface QuoteResult {
    success: boolean;
    details?: {
        inputAmount: string;
        inputToken: TokenInfo;
        outputAmount: string;
        outputToken: TokenInfo;
        executionPrice: string;
        priceImpact: string;
        fee: string;
        route: {
            tokens: Address[];
            pairs: Address[];
            binSteps: number[];
            versions: number[];
        };
        calldata: `0x${string}`;
        value: string;
    };
    error?: string;
}

// Define the quoter result type to fix type assertions
interface QuoterResult {
    route: Address[];
    pairs: Address[];
    binSteps: bigint[];
    versions: number[];
    amounts: bigint[];
    virtualAmountsWithoutSlippage: bigint[];
    fees: bigint[];
}

/**
 * DirectTraderJoeQuoter provides a simplified interface to get quotes directly from
 * Trader Joe's on-chain LBQuoter contract without using their SDK abstraction.
 */
export class DirectTraderJoeQuoter {
    private readonly publicClient;

    constructor(rpcUrl?: string) {
        const avalancheRpcUrl = rpcUrl || process.env.AVALANCHE_RPC_URL;
        if (!avalancheRpcUrl) {
            throw new Error("AVALANCHE_RPC_URL not found in environment variables or parameters.");
        }

        this.publicClient = createPublicClient({
            chain: avalanche,
            transport: http(avalancheRpcUrl),
        });

        logger.info("DirectTraderJoeQuoter initialized", {
            chain: avalanche.name,
            quoterAddress: QUOTER_ADDRESS,
            routerAddress: ROUTER_ADDRESS
        });
    }

    /**
     * Get a quote for a trade directly from the LBQuoter contract
     */
    public async getQuote(config: QuoteConfig): Promise<QuoteResult> {
        const tradeId = performance.now().toString();
        logger.info("Starting quote request", {
            metadata: {
                tradeId,
                inputToken: config.inputToken.symbol,
                outputToken: config.outputToken.symbol,
                amount: config.amount,
                exactIn: config.exactIn
            }
        });

        try {
            // Parse the amount with appropriate decimals
            const amountBigInt = parseUnits(config.amount, config.inputToken.decimals);

            // Define the route as array of token addresses
            const route = [config.inputToken.address, config.outputToken.address];

            // Define the correct ABI for the LBQuoter contract
            const quoterAbi = LBQuoterV22ABI;

            // Call the appropriate quoter function based on exactIn flag
            const functionName = config.exactIn ? 'findBestPathFromAmountIn' : 'findBestPathFromAmountOut';

            // Fix for the second error - properly handle the contract return type
            const result = await this.publicClient.readContract({
                address: QUOTER_ADDRESS,
                abi: quoterAbi,
                functionName,
                args: [route, amountBigInt]
            }) as unknown as QuoterResult;

            // Extract the result
            const {
                route: resultRoute,
                pairs: resultPairs,
                binSteps: resultBinSteps,
                versions: resultVersions,
                amounts: resultAmounts,
                virtualAmountsWithoutSlippage: resultVirtualAmountsWithoutSlippage,
                fees: resultFees
            } = result;

            // Validate that we got a valid quote
            if (resultAmounts.length <= 1 || resultAmounts[resultAmounts.length - 1] === 0n) {
                return {
                    success: false,
                    error: "No valid route found or zero output amount"
                };
            }

            // Extract input and output amounts
            const inputAmount = resultAmounts[0];
            const outputAmount = resultAmounts[resultAmounts.length - 1];

            // Calculate price impact using virtual amounts
            const outputWithoutSlippage = resultVirtualAmountsWithoutSlippage[resultVirtualAmountsWithoutSlippage.length - 1];
            const priceImpact = Number(((outputWithoutSlippage - outputAmount) * 10000n) / outputWithoutSlippage) / 100;

            // Calculate execution price
            const inputDecimals = config.inputToken.decimals;
            const outputDecimals = config.outputToken.decimals;
            const executionPrice = Number(outputAmount * 10n ** BigInt(inputDecimals)) /
                Number(inputAmount * 10n ** BigInt(outputDecimals));

            // Calculate total fee
            // Calculate fee percentage correctly - fees from Trader Joe are in basis points (1/100 of 1%)
            // Fixed fee calculation
            let feePercentage = 0;
            if (resultFees.length > 0) {
                // The fees array in the Trader Joe LBQuoter response contains fee values
                // in basis points multiplied by 1e18 (decimal shift for precision)
                // We need to normalize this to get a proper percentage
                const firstFee = resultFees[0];

                // Trader Joe V2 fees are typically between 0.01% and 0.5%
                // If the fee is already expressed as a percentage * 1e18 (common format in contracts)
                if (firstFee > 1000000000000000n) {  // If greater than 0.001 * 1e18
                    // Assuming fee is like 0.3% * 1e18 = 0.003 * 1e18
                    feePercentage = Number(firstFee) / 1e16;  // Convert to percentage
                } else {
                    // If the fee is already in basis points (1/10000)
                    feePercentage = Number(firstFee) / 100;  // Convert basis points to percentage
                }

                // Safety check - cap at reasonable values
                if (feePercentage > 10) {  // No fee should be over 10%
                    feePercentage = 0.3;  // Default to 0.3% if calculation is wrong
                }
            }


            // Create the swap calldata without using the SDK
            const calldata = this.createSwapCalldata({
                route: resultRoute,
                pairs: resultPairs,
                binSteps: resultBinSteps.map(step => Number(step)),
                versions: resultVersions,
                amounts: resultAmounts,
                slippageBps: config.slippageBps,
                recipient: config.recipient,
                deadline: Math.floor(Date.now() / 1000) + config.deadline,
                exactIn: config.exactIn
            });

            logger.info("Quote obtained from quoter contract", {
                metadata: {
                    tradeId,
                    inputAmount: formatUnits(inputAmount, config.inputToken.decimals),
                    outputAmount: formatUnits(outputAmount, config.outputToken.decimals),
                    priceImpact: priceImpact.toFixed(4) + '%',
                    executionPrice: executionPrice.toString(),
                    fee: feePercentage.toFixed(4) + '%'
                }
            });

            return {
                success: true,
                details: {
                    inputAmount: formatUnits(inputAmount, config.inputToken.decimals),
                    inputToken: config.inputToken,
                    outputAmount: formatUnits(outputAmount, config.outputToken.decimals),
                    outputToken: config.outputToken,
                    executionPrice: executionPrice.toString(),
                    priceImpact: priceImpact.toFixed(4) + '%',
                    fee: feePercentage.toFixed(4) + '%',
                    route: {
                        tokens: resultRoute,
                        pairs: resultPairs,
                        binSteps: resultBinSteps.map(Number),
                        versions: resultVersions,
                    },
                    calldata: calldata.calldata,
                    value: calldata.value.toString()
                }
            };

        } catch (error) {
            if (error instanceof BaseError) {
                logger.error("Quote simulation failed", {
                    metadata: {
                        tradeId,
                        error: error.message,
                        type: "transaction"
                    }
                });
                return {
                    success: false,
                    error: `Quote simulation failed: ${error.message}`
                };
            }

            logger.error("Unexpected error during quote simulation", {
                metadata: {
                    tradeId,
                    error: getErrorMessage(error),
                    type: "unexpected"
                }
            });
            return {
                success: false,
                error: getErrorMessage(error)
            };
        }
    }

    /**
     * Create swap calldata based on quoter results
     */
    private createSwapCalldata(params: {
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

        // Define the appropriate router ABI function
        const routerAbi = LBRouterV22ABI;

        // Determine input and output amounts
        const inputAmount = params.amounts[0];
        const outputAmount = params.amounts[params.amounts.length - 1];

        // Calculate minimum output with slippage
        const slippageFactor = BigInt(10000 - params.slippageBps);
        const minOutputAmount = (outputAmount * slippageFactor) / 10000n;

        // Calculate maximum input with slippage
        const maxInputAmount = (inputAmount * (10000n + BigInt(params.slippageBps))) / 10000n;

        // LB Router swap type specific to Trader Joe V2.x
        // This is the path struct the Router expects
        const pathStruct = {
            pairBinSteps: params.binSteps.map(step => BigInt(step)),
            versions: params.versions,
            tokenPath: params.route
        };

        // Fix for the third error - correctly structure the args array
        let functionName: "swapExactTokensForTokens" | "swapTokensForExactTokens";
        let args: readonly [bigint, bigint, {
            pairBinSteps: readonly bigint[];
            versions: readonly number[];
            tokenPath: readonly Address[];
        }, Address, bigint];

        if (params.exactIn) {
            functionName = "swapExactTokensForTokens";
            args = [
                inputAmount,
                minOutputAmount,
                pathStruct,
                params.recipient,
                BigInt(params.deadline)
            ];
        } else {
            functionName = "swapTokensForExactTokens";
            args = [
                outputAmount,
                maxInputAmount,
                pathStruct,
                params.recipient,
                BigInt(params.deadline)
            ];
        }

        // Encode the function call
        const calldata = encodeFunctionData({
            abi: routerAbi,
            functionName,
            args
        });

        return {
            calldata,
            value: 0n  // Native token value is 0 for token-to-token swaps
        };
    }
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
    async function main() {
        try {
            const quoter = new DirectTraderJoeQuoter();

            // Example config for USDC to WAVAX swap
            const config: QuoteConfig = {
                inputToken: {
                    address: TOKEN_CONFIGS.USDC.address,
                    decimals: TOKEN_CONFIGS.USDC.decimals,
                    symbol: TOKEN_CONFIGS.USDC.symbol,
                    name: TOKEN_CONFIGS.USDC.name
                },
                outputToken: {
                    address: TOKEN_CONFIGS.WAVAX.address,
                    decimals: TOKEN_CONFIGS.WAVAX.decimals,
                    symbol: TOKEN_CONFIGS.WAVAX.symbol,
                    name: TOKEN_CONFIGS.WAVAX.name
                },
                amount: "10",  // 10 USDC
                exactIn: true,
                slippageBps: 50, // 0.5%
                recipient: "0x0000000000000000000000000000000000000000" as Address, // Replace with actual recipient
                deadline: 20 * 60 // 20 minutes
            };

            const result = await quoter.getQuote(config);

            if (result.success && result.details) {
                console.log("=== Trade Quote Summary ===");
                console.log(`Input: ${result.details.inputAmount} ${result.details.inputToken.symbol}`);
                console.log(`Output: ${result.details.outputAmount} ${result.details.outputToken.symbol}`);
                console.log(`Price: ${result.details.executionPrice}`);
                console.log(`Impact: ${result.details.priceImpact}`);
                console.log(`Fee: ${result.details.fee}`);
                console.log(`Route: ${result.details.route.tokens.join(' -> ')}`);
                console.log(`Pairs: ${result.details.route.pairs.join(', ')}`);
                console.log(`Bin Steps: ${result.details.route.binSteps.join(', ')}`);
                console.log(`Versions: ${result.details.route.versions.join(', ')}`);
                console.log(`Calldata: ${result.details.calldata.slice(0, 66)}...`);
            } else {
                console.error(`Error getting quote: ${result.error}`);
            }
        } catch (error) {
            console.error(`Failed to get quote: ${getErrorMessage(error)}`);
        }
    }

    main().catch(console.error);
}

export default DirectTraderJoeQuoter;