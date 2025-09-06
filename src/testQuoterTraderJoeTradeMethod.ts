// src/executeJoeTrade.ts
import {
    ChainId,
    Token,
    TokenAmount,
    Percent,
} from "@traderjoe-xyz/sdk-core";
import {
    PairV2,
    RouteV2,
    TradeV2,
    TradeOptions,
    LB_ROUTER_V22_ADDRESS,
    LB_QUOTER_V22_ADDRESS,
    LBQuoterV22ABI,
    LBRouterV22ABI,
} from "@traderjoe-xyz/sdk-v2";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseUnits,
    BaseError,
    ContractFunctionRevertedError,
    type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import {TOKEN_CONFIGS} from './constants.ts';
import logger from './logger.ts';
import dotenv from 'dotenv';
import {getErrorMessage} from "@/utils.ts";

// Load environment variables
dotenv.config();
const CHAIN_ID = ChainId.AVALANCHE;

export const TOKENS = {
    USDC: new Token(
        CHAIN_ID,
        TOKEN_CONFIGS.USDC.address,
        TOKEN_CONFIGS.USDC.decimals,
        TOKEN_CONFIGS.USDC.symbol,
        TOKEN_CONFIGS.USDC.name
    ),
    WAVAX: new Token(
        CHAIN_ID,
        TOKEN_CONFIGS.WAVAX.address,
        TOKEN_CONFIGS.WAVAX.decimals,
        TOKEN_CONFIGS.WAVAX.symbol,
        TOKEN_CONFIGS.WAVAX.name
    )
} as const;

// Constants
const ROUTER = LB_ROUTER_V22_ADDRESS[CHAIN_ID];
const WAVAX = TOKENS.WAVAX;

export interface TradeConfig {
    inputToken: Token;
    outputToken: Token;
    amount: string;
    isExactIn: boolean;
    slippagePercent: string;
    ttlSeconds: number;
    feeOnTransfer: boolean;
}
export interface ExecutionParams {
    methodName: string;
    args: unknown[];
    value: bigint;
    routerAddress: string;
    tokenToApprove?: {
        address: string;
        amount: bigint;
    };
}

export interface QuoteResult {
    success: boolean;
    quote?: {
        inputAmount: string;
        inputToken: string;
        outputAmount: string;
        outputToken: string;
        executionPrice: string;
        priceImpact: string;
        route: string;
        fees: {
            totalFeePercent: string;
            feeAmount: string;
            feeToken: string;
        };
    };
    executionParams?: ExecutionParams;
    error?: string;
}
interface TokenInfo {
    symbol: string;
    address: string;
}

interface FormattedRoute {
    swap: {
        type: string;
        input: {
            amount: string;
            exactInput: boolean;
        };
        output: {
            amount: string;
            exactOutput: boolean;
        };
        execution: {
            price: string;
            impact: string;
            exactQuote: string;
        };
    };
    path: {
        tokens: TokenInfo[];
        pool: {
            address: string;
            version: string;
            binStep: string;
        };
    };
    amounts: {
        raw: bigint[];
        withoutSlippage: bigint[];
        fee: bigint;
    };
}
export type TradeDirection = 'USDC_TO_WAVAX' | 'WAVAX_TO_USDC';

export const TRADE_CONFIGS: Record<TradeDirection, TradeConfig> = {
    USDC_TO_WAVAX: {
        inputToken: TOKENS.USDC,
        outputToken: TOKENS.WAVAX,
        amount: "10", // 10 USDC
        isExactIn: true,
        slippagePercent: "100", // 1%
        ttlSeconds: 1800, // 30 minutes
        feeOnTransfer: false
    },
    WAVAX_TO_USDC: {
        inputToken: TOKENS.WAVAX,
        outputToken: TOKENS.USDC,
        amount: ".1", // 0.1 WAVAX
        isExactIn: true,
        slippagePercent: "100", // 1%
        ttlSeconds: 1800, // 30 minutes
        feeOnTransfer: false
    }
};

// Base tokens used for routing
const BASES = [TOKENS.WAVAX, TOKENS.USDC];

export class TraderJoeExecutor {
    private readonly publicClient;
    private readonly walletClient;
    private readonly account;

    constructor(privateKey: string) {
        logger.info("Initializing TraderJoeExecutor");
        try {
            if (!privateKey) {
                throw new Error("Private key not found in environment variables.");
            }

            const AVALANCHE_RPC_URL = process.env.AVALANCHE_RPC_URL;
            if (!AVALANCHE_RPC_URL) {
                throw new Error("AVALANCHE_RPC_URL not found in environment variables.");
            }

            // Ensure private key starts with 0x
            const formattedPrivateKey = privateKey.startsWith('0x')
                ? privateKey
                : `0x${privateKey}`;

            this.account = privateKeyToAccount(formattedPrivateKey as Hash);
            this.publicClient = createPublicClient({
                chain: avalanche,
                transport: http(AVALANCHE_RPC_URL),
            });
            this.walletClient = createWalletClient({
                account: this.account,
                chain: avalanche,
                transport: http(AVALANCHE_RPC_URL),
            });

            logger.info("TraderJoeExecutor initialized successfully", {
                address: this.account.address,
                chain: avalanche.name
            });
        } catch (error) {
            logger.error("Failed to initialize TraderJoeExecutor", {error});
            throw error;
        }
    }

    async getTradeQuote(config: TradeConfig): Promise<QuoteResult> {
        const tradeId = performance.now().toString();
        logger.info("Starting quote simulation", {
            metadata: {
                tradeId,
                inputToken: config.inputToken.symbol,
                outputToken: config.outputToken.symbol,
                amount: config.amount
            }
        });

        try {
            // Create token amount
            const parsedAmount = parseUnits(config.amount, config.inputToken.decimals);
            const tokenAmount = new TokenAmount(config.inputToken, parsedAmount);

            // Generate routes
            const tokenPairs = PairV2.createAllTokenPairs(
                config.inputToken,
                config.outputToken,
                BASES
            );
            const pairs = PairV2.initPairs(tokenPairs);
            const routes = RouteV2.createAllRoutes(pairs, config.inputToken, config.outputToken);

            if (routes.length === 0) {
                return {
                    success: false,
                    error: "No routes found between tokens"
                };
            }

            // Get best trade
            const isNativeIn = config.inputToken.address.toLowerCase() === WAVAX.address.toLowerCase();
            const isNativeOut = config.outputToken.address.toLowerCase() === WAVAX.address.toLowerCase();

            logger.debug("Fetching possible trades", {
                metadata: {
                    tradeId,
                    isNativeIn,
                    isNativeOut
                }
            });

            const possibleTrades = await TradeV2.getTradesExactIn(
                routes,
                tokenAmount,
                config.outputToken,
                false,
                false,
                this.publicClient,
                CHAIN_ID
            );

            // Filter out undefined trades
            const validTrades = possibleTrades.filter((trade): trade is TradeV2 => trade !== undefined);

            logger.info("Valid trades found", {
                metadata: {
                    tradeId,
                    totalTrades: possibleTrades.length,
                    validTrades: validTrades.length
                }
            });

            if (validTrades.length === 0) {
                return {
                    success: false,
                    error: "No valid trade routes found"
                };
            }

            const bestTrade = TradeV2.chooseBestTrade(validTrades, config.isExactIn);
            if (!bestTrade) {
                return {
                    success: false,
                    error: "Could not determine best trade route"
                };
            }

            // Get trade details
            const {totalFeePct, feeAmountIn} = await bestTrade.getTradeFee();
            const tradeLog = bestTrade.toLog();
            const routeInfo = JSON.parse(typeof tradeLog === 'string' ? tradeLog : JSON.stringify(tradeLog));

            // Format the quote response
            const quote = {
                inputAmount: bestTrade.inputAmount.toSignificant(6),
                inputToken: bestTrade.inputAmount.token.symbol || 'Unknown',
                outputAmount: bestTrade.outputAmount.toSignificant(6),
                outputToken: bestTrade.outputAmount.token.symbol || 'Unknown',
                executionPrice: bestTrade.executionPrice.toSignificant(6),
                priceImpact: bestTrade.priceImpact.toSignificant(6),
                route: JSON.stringify(routeInfo),
                fees: {
                    totalFeePercent: totalFeePct.toSignificant(6),
                    feeAmount: feeAmountIn.toSignificant(6),
                    feeToken: feeAmountIn.token.symbol || 'Unknown'
                }
            };

            // Prepare swap parameters
            const swapOptions: TradeOptions = {
                allowedSlippage: new Percent(config.slippagePercent, "10000"),
                ttl: config.ttlSeconds,
                recipient: this.account.address,
                feeOnTransfer: config.feeOnTransfer,
            };

            const swapParams = bestTrade.swapCallParameters(swapOptions);

            // Prepare execution parameters for token swap
            const executionParams: ExecutionParams = {
                methodName: 'swapExactTokensForTokens',
                args: swapParams.args as unknown[],
                value: BigInt(0),
                routerAddress: ROUTER,
                tokenToApprove: {
                    address: config.inputToken.address,
                    amount: parsedAmount
                }
            };

            // Log detailed quote information
            const logMetadata = {
                contracts: {
                    router: ROUTER,
                    tokens: {
                        usdc: TOKEN_CONFIGS.USDC.address,
                        wavax: TOKEN_CONFIGS.WAVAX.address
                    },
                    pool: routeInfo.quote.pairs
                },
                trade: {
                    type: routeInfo.tradeType,
                    input: {
                        amount: `${quote.inputAmount} ${quote.inputToken}`,
                        exactInput: config.isExactIn
                    },
                    output: {
                        amount: `${quote.outputAmount} ${quote.outputToken}`,
                        exactOutput: !config.isExactIn
                    },
                    executionDetails: {
                        price: `${quote.executionPrice} ${quote.outputToken} / ${quote.inputToken}`,
                        impact: `${quote.priceImpact}%`,
                        exactQuote: routeInfo.exactQuote
                    }
                },
                route: {
                    path: (routeInfo.route.path as string).split(', ').map((token: string): string => {
                        const matches = token.match(/([^(]+)\(([^)]+)\)/);
                        if (!matches) {
                            logger.error(`Invalid token format: ${token}`);
                            throw new Error(`Invalid token format: ${token}`);
                        }
                        const [, symbol, address] = matches;
                        return `${symbol.trim()} (${address})`;
                    }),
                    pool: {
                        address: routeInfo.quote.pairs,
                        version: `V${routeInfo.quote.versions}`,
                        binStep: routeInfo.quote.binSteps
                    }
                },
                amounts: {
                    raw: routeInfo.quote.amounts.split(', '),
                    withoutSlippage: routeInfo.quote.virtualAmountsWithoutSlippage.split(', '),
                    fee: routeInfo.quote.fees
                },
                fees: {
                    totalFee: `${quote.fees.totalFeePercent}%`,
                    feeAmount: `${quote.fees.feeAmount} ${quote.fees.feeToken}`
                }
            };

            logger.info("Trade Quote Details", { metadata: logMetadata });

            // Log execution parameters
            logger.info("Execution Parameters", {
                metadata: {
                    method: executionParams.methodName,
                    value: executionParams.value.toString(),
                    tokenApproval: executionParams.tokenToApprove ? {
                        required: true,
                        token: executionParams.tokenToApprove.address,
                        amount: executionParams.tokenToApprove.amount.toString()
                    } : {
                        required: false
                    }
                }
            });

            // Log execution parameters
            logger.info("Execution Parameters", {
                metadata: {
                    method: executionParams.methodName,
                    value: executionParams.value.toString(),
                    tokenApproval: executionParams.tokenToApprove ? {
                        required: true,
                        token: executionParams.tokenToApprove.address,
                        amount: executionParams.tokenToApprove.amount.toString()
                    } : {
                        required: false
                    }
                }
            });

            return {
                success: true,
                quote,
                executionParams
            };

        } catch (error) {
            if (error instanceof BaseError) {
                if (error instanceof ContractFunctionRevertedError) {
                    logger.error("Quote simulation reverted", {
                        metadata: {
                            tradeId,
                            error: error.message,
                            type: "revert"
                        }
                    });
                    return {
                        success: false,
                        error: `Quote simulation reverted: ${error.message}`
                    };
                }
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
}

// Example usage:

async function main() {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        logger.error("Private key not found");
        throw new Error("Private key not found");
    }

    const executor = new TraderJoeExecutor(privateKey);

    // Get quote for USDC to WAVAX trade
    const quoteResult = await executor.getTradeQuote(TRADE_CONFIGS.WAVAX_TO_USDC);

    if (quoteResult.success && quoteResult.quote) {
        // Parse route information
        const routeInfo = JSON.parse(quoteResult.quote.route);

        const formattedRoute: FormattedRoute = {
            swap: {
                type: routeInfo.tradeType,
                input: {
                    amount: routeInfo.inputAmount,
                    exactInput: routeInfo.tradeType === 'EXACT_INPUT'
                },
                output: {
                    amount: routeInfo.outputAmount,
                    exactOutput: routeInfo.tradeType === 'EXACT_OUTPUT'
                },
                execution: {
                    price: routeInfo.executionPrice,
                    impact: routeInfo.priceImpact,
                    exactQuote: routeInfo.exactQuote
                }
            },
            path: {
                tokens: routeInfo.route.path.split(', ').map((token: string) => {
                    const matches = token.match(/([^(]+)\(([^)]+)\)/);
                    if (!matches) {
                        logger.error(`Invalid token format: ${token}`);
                        throw new Error(`Invalid token format: ${token}`);
                    }
                    const [, symbol, address] = matches;
                    return { symbol, address };
                }),
                pool: {
                    address: routeInfo.quote.pairs,
                    version: routeInfo.quote.versions,
                    binStep: routeInfo.quote.binSteps
                }
            },
            amounts: {
                raw: routeInfo.quote.amounts.split(', ').map(BigInt),
                withoutSlippage: routeInfo.quote.virtualAmountsWithoutSlippage.split(', ').map(BigInt),
                fee: BigInt(routeInfo.quote.fees)
            }
        };

        // Log structured trade summary
        logger.info("Trade Quote Details", {
            metadata: {
                contracts: {
                    router: ROUTER,
                    tokens: {
                        usdc: TOKEN_CONFIGS.USDC.address,
                        wavax: TOKEN_CONFIGS.WAVAX.address
                    },
                    pool: formattedRoute.path.pool.address
                },
                trade: {
                    type: formattedRoute.swap.type,
                    input: formattedRoute.swap.input,
                    output: formattedRoute.swap.output,
                    executionDetails: formattedRoute.swap.execution
                },
                route: {
                    path: formattedRoute.path.tokens.map((t: TokenInfo) => `${t.symbol} (${t.address})`),
                    pool: {
                        address: formattedRoute.path.pool.address,
                        version: `V${formattedRoute.path.pool.version}`,
                        binStep: formattedRoute.path.pool.binStep
                    }
                },
                amounts: {
                    raw: formattedRoute.amounts.raw.map((n: bigint) => n.toString()),
                    withoutSlippage: formattedRoute.amounts.withoutSlippage.map((n: bigint) => n.toString()),
                    fee: formattedRoute.amounts.fee.toString()
                },
                fees: {
                    totalFee: `${quoteResult.quote.fees.totalFeePercent}%`,
                    feeAmount: `${quoteResult.quote.fees.feeAmount} ${quoteResult.quote.fees.feeToken}`
                }
            }
        });

        // Log execution parameters if available
        if (quoteResult.executionParams) {
            logger.info("Execution Parameters", {
                metadata: {
                    method: quoteResult.executionParams.methodName,
                    value: quoteResult.executionParams.value.toString(),
                    tokenApproval: quoteResult.executionParams.tokenToApprove ? {
                        required: true,
                        token: quoteResult.executionParams.tokenToApprove.address,
                        amount: quoteResult.executionParams.tokenToApprove.amount.toString()
                    } : {
                        required: false
                    }
                }
            });
        }

        // Print CLI summary
        printTradeQuoteSummary(formattedRoute, quoteResult);
    } else {
        const errorMsg = `Error getting quote: ${quoteResult.error}`;
        logger.error(errorMsg);
        console.error('\n' + errorMsg);
    }
}
function printTradeQuoteSummary(formattedRoute: FormattedRoute, quoteResult: QuoteResult) {
    if (!quoteResult.quote) {
        console.log('\nNo quote available to display');
        return;
    }

    // Console output for CLI feedback
    console.log('\n=== Trade Quote Summary ===');

    console.log('\nRoute Overview:');
    console.log(`• Type: ${formattedRoute.swap.type}`);
    console.log(`• Path: ${formattedRoute.path.tokens.map(t => t.symbol).join(' → ')}`);
    console.log(`• Pool Version: V${formattedRoute.path.pool.version}`);
    console.log(`• Bin Step: ${formattedRoute.path.pool.binStep}`);

    console.log('\nTrade Details:');
    console.log(`• Input: ${formattedRoute.swap.input.amount}`);
    console.log(`• Output: ${formattedRoute.swap.output.amount}`);
    console.log(`• Execution Price: ${formattedRoute.swap.execution.price}`);
    console.log(`• Price Impact: ${formattedRoute.swap.execution.impact}`);
    console.log(`• Exact Quote: ${formattedRoute.swap.execution.exactQuote}`);

    console.log('\nContract Addresses:');
    console.log(`• Router: ${ROUTER}`);
    console.log(`• Pool: ${formattedRoute.path.pool.address}`);
    formattedRoute.path.tokens.forEach((token: TokenInfo) => {
        console.log(`• ${token.symbol}: ${token.address}`);
    });

    console.log('\nFees:');
    console.log(`• Total Fee: ${quoteResult.quote.fees.totalFeePercent}%`);
    console.log(`• Fee Amount: ${quoteResult.quote.fees.feeAmount} ${quoteResult.quote.fees.feeToken}`);

    if (quoteResult.executionParams) {
        console.log('\nExecution Info:');
        console.log(`• Method: ${quoteResult.executionParams.methodName}`);
        console.log(`• Value: ${quoteResult.executionParams.value.toString()} wei`);

        if (quoteResult.executionParams.tokenToApprove) {
            console.log(`• Token Approval Required: Yes`);
            console.log(`  - Token: ${quoteResult.executionParams.tokenToApprove.address}`);
            console.log(`  - Amount: ${quoteResult.executionParams.tokenToApprove.amount.toString()}`);
        }
    }

    console.log('\n========================\n');
}
// Execute main function with error handling
main().catch((error) => {

    const errorMsg = `Error in main execution: ${getErrorMessage(error)}`;
    logger.error(errorMsg);
    console.error('\n' + errorMsg);
    process.exit(1);
});