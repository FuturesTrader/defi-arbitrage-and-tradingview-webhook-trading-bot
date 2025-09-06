// src/executeJoeTrade.ts
import {
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
    jsonAbis,
} from "@traderjoe-xyz/sdk-v2";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseUnits,
    BaseError,
    ContractFunctionRevertedError,
    formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import { ABIS, CHAIN_IDS, TOKEN_CONFIGS } from './constants.ts';
import logger from './logger.ts';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();
const CHAIN_ID = CHAIN_IDS.AVALANCHE;

export const TOKENS = {
    USDC: new Token(
        CHAIN_ID,
        TOKEN_CONFIGS.USDC.address as `0x${string}`,
        TOKEN_CONFIGS.USDC.decimals,
        TOKEN_CONFIGS.USDC.symbol,
        TOKEN_CONFIGS.USDC.name
    ),
    WAVAX: new Token(
        CHAIN_ID,
        TOKEN_CONFIGS.WAVAX.address as `0x${string}`,
        TOKEN_CONFIGS.WAVAX.decimals,
        TOKEN_CONFIGS.WAVAX.symbol,
        TOKEN_CONFIGS.WAVAX.name
    ),
    WBTC: new Token(
        CHAIN_ID,
        TOKEN_CONFIGS.WBTC.address as `0x${string}`,
        TOKEN_CONFIGS.WBTC.decimals,
        TOKEN_CONFIGS.WBTC.symbol,
        TOKEN_CONFIGS.WBTC.name
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

export type TradeDirection = 'USDC_TO_WAVAX' | 'WAVAX_TO_USDC' | 'USDC_TO_WBTC' | 'WBTC_TO_USDC';

export const TRADE_CONFIGS: Record<TradeDirection, TradeConfig> = {
    USDC_TO_WAVAX: {
        inputToken: TOKENS.USDC,
        outputToken: TOKENS.WAVAX,
        amount: "1", // 1 USDC
        isExactIn: true,
        slippagePercent: "100", // 1%
        ttlSeconds: 1800, // 30 minutes
        feeOnTransfer: false
    },
    WAVAX_TO_USDC: {
        inputToken: TOKENS.WAVAX,
        outputToken: TOKENS.USDC,
        amount: "0.1", // 0.1 WAVAX
        isExactIn: true,
        slippagePercent: "100", // 1%
        ttlSeconds: 1800, // 30 minutes
        feeOnTransfer: false
    },
    // New configurations for WBTC trades
    USDC_TO_WBTC: {
        inputToken: TOKENS.USDC,
        outputToken: TOKENS.WBTC,
        amount: "1", // 1 USDC (adjust as needed based on your testing budget)
        isExactIn: true,
        slippagePercent: "100", // 1%
        ttlSeconds: 1800, // 30 minutes
        feeOnTransfer: false
    },
    WBTC_TO_USDC: {
        inputToken: TOKENS.WBTC,
        outputToken: TOKENS.USDC,
        amount: "0.00001", // 0.00001 BTC (adjust as needed based on your testing budget)
        isExactIn: true,
        slippagePercent: "100", // 1%
        ttlSeconds: 1800, // 30 minutes
        feeOnTransfer: false
    }
};

// Validate private key
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
    logger.error("Private key not found in environment variables.");
    process.exit(1);
}

// Read Avalanche RPC URL from environment variables
const AVALANCHE_RPC_URL = process.env.AVALANCHE_RPC_URL;
if (!AVALANCHE_RPC_URL) {
    logger.error("AVALANCHE_RPC_URL not found in environment variables.");
    process.exit(1);
}

export function getApprovalAmount(token: Token): bigint {
    // $1000 * (10 ** decimals)
    return BigInt(1000) * BigInt(10 ** token.decimals);
}

// Base tokens used for routing - now including WBTC
const BASES = [TOKENS.WAVAX, TOKENS.USDC, TOKENS.WBTC];

class TraderJoeExecutor {
    private readonly publicClient;
    private readonly walletClient;
    private readonly account;

    constructor(privateKey: string) {
        logger.info("Initializing TraderJoeExecutor");
        try {
            if (!privateKey) {
                logger.error("Private key not found in environment variables.");
                process.exit(1);
            }
            // Ensure private key starts with 0x
            const formattedPrivateKey = privateKey.startsWith('0x')
                ? privateKey
                : `0x${privateKey}`;

            this.account = privateKeyToAccount(formattedPrivateKey as `0x${string}`);
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
            logger.error("Failed to initialize TraderJoeExecutor", { error });
            throw error;
        }
    }

    async checkBalance(token: Token): Promise<{ hasBalance: boolean, balance: string }> {
        try {
            // For native token check ETH balance
            if (token.address.toLowerCase() === WAVAX.address.toLowerCase()) {
                const balance = await this.publicClient.getBalance({
                    address: this.account.address,
                });
                const formattedBalance = formatUnits(balance, token.decimals);
                logger.info(`Native token balance: ${formattedBalance} ${token.symbol}`);
                return {
                    hasBalance: balance > 0n,
                    balance: formattedBalance
                };
            }

            // For other tokens, check ERC20 balance
            const balance = await this.publicClient.readContract({
                address: token.address as `0x${string}`,
                abi: ABIS.ERC20,
                functionName: 'balanceOf',
                args: [this.account.address],
            }) as bigint;

            const formattedBalance = formatUnits(balance, token.decimals);
            logger.info(`Token balance: ${formattedBalance} ${token.symbol}`);
            return {
                hasBalance: balance > 0n,
                balance: formattedBalance
            };
        } catch (error) {
            logger.error(`Failed to check balance for ${token.symbol}`, { error });
            return { hasBalance: false, balance: '0' };
        }
    }

    async checkAndApproveToken(token: Token, amount: bigint, tradeId: string): Promise<void> {
        try {
            // Skip approval for native token
            if (token.address.toLowerCase() === WAVAX.address.toLowerCase()) {
                logger.debug("Skipping approval for native token", { tradeId });
                return;
            }

            // Check current allowance
            const allowance = await this.publicClient.readContract({
                address: token.address as `0x${string}`,
                abi: ABIS.ERC20,
                functionName: 'allowance',
                args: [this.account.address, ROUTER],
            }) as bigint;

            logger.debug("Current allowance", {
                tradeId,
                token: token.symbol,
                allowance: formatUnits(allowance, token.decimals)
            });

            // If allowance is insufficient, approve
            if (allowance < amount) {
                logger.info("Insufficient allowance, approving tokens", {
                    tradeId,
                    token: token.symbol,
                    required: formatUnits(amount, token.decimals),
                    current: formatUnits(allowance, token.decimals)
                });

                const { request } = await this.publicClient.simulateContract({
                    address: token.address as `0x${string}`,
                    abi: ABIS.ERC20,
                    functionName: 'approve',
                    args: [ROUTER, getApprovalAmount(token)],
                    account: this.account,
                });

                const hash = await this.walletClient.writeContract(request);

                logger.info("Approval transaction submitted", {
                    tradeId,
                    token: token.symbol,
                    hash
                });

                // Wait for approval confirmation
                const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
                logger.info("Approval confirmed", {
                    tradeId,
                    token: token.symbol,
                    status: receipt.status
                });
            } else {
                logger.info("Token already approved", {
                    tradeId,
                    token: token.symbol,
                    allowance: formatUnits(allowance, token.decimals)
                });
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error("Token approval failed", {
                tradeId,
                token: token.symbol,
                error: errorMessage
            });
            throw new Error(`Token approval failed: ${errorMessage}`);
        }
    }

    async executeTrade(config: TradeConfig): Promise<`0x${string}`> {
        const tradeId = performance.now().toString(); // Unique identifier for this trade
        logger.info("Starting trade execution", {
            tradeId,
            inputToken: config.inputToken.symbol,
            outputToken: config.outputToken.symbol,
            amount: config.amount,
            slippage: config.slippagePercent
        });

        try {
            // Check balances first
            const balanceInfo = await this.checkBalance(config.inputToken);
            if (!balanceInfo.hasBalance) {
                throw new Error(`Insufficient ${config.inputToken.symbol} balance for trade. Current balance: ${balanceInfo.balance}`);
            }

            // Create token amount
            const parsedAmount = parseUnits(config.amount, config.inputToken.decimals);
            const tokenAmount = new TokenAmount(config.inputToken, parsedAmount);

            // Check and approve token before trading
            await this.checkAndApproveToken(config.inputToken, parsedAmount, tradeId);

            logger.debug("Token amount parsed", {
                tradeId,
                rawAmount: config.amount,
                parsedAmount: parsedAmount.toString()
            });

            // Generate routes
            logger.debug("Generating token pairs", { tradeId });
            const tokenPairs = PairV2.createAllTokenPairs(
                config.inputToken,
                config.outputToken,
                BASES
            );
            const pairs = PairV2.initPairs(tokenPairs);
            const routes = RouteV2.createAllRoutes(pairs, config.inputToken, config.outputToken);
            logger.info("Routes generated", {
                tradeId,
                routeCount: routes.length
            });

            // Check if trade is possible
            if (routes.length === 0) {
                logger.error("No routes found between tokens", {
                    tradeId,
                    inputToken: config.inputToken.symbol,
                    outputToken: config.outputToken.symbol
                });
                throw new Error(`No routes found between ${config.inputToken.symbol} and ${config.outputToken.symbol}`);
            }

            // Get best trade
            const isNativeIn = config.inputToken.address.toLowerCase() === WAVAX.address.toLowerCase();
            const isNativeOut = config.outputToken.address.toLowerCase() === WAVAX.address.toLowerCase();

            logger.debug("Fetching possible trades", {
                tradeId,
                isNativeIn,
                isNativeOut
            });

            const possibleTrades = await TradeV2.getTradesExactIn(
                routes,
                tokenAmount,
                config.outputToken,
                isNativeIn,
                isNativeOut,
                this.publicClient,
                CHAIN_ID
            );

            // Filter out undefined trades
            const validTrades = possibleTrades.filter((trade): trade is TradeV2 => trade !== undefined);
            logger.info("Valid trades found", {
                tradeId,
                totalTrades: possibleTrades.length,
                validTrades: validTrades.length
            });

            if (validTrades.length === 0) {
                logger.error("No valid trade routes found", { tradeId });
                throw new Error("No valid trade routes found");
            }

            const bestTrade = TradeV2.chooseBestTrade(validTrades, config.isExactIn);
            if (!bestTrade) {
                logger.error("Could not determine best trade route", { tradeId });
                throw new Error("Could not determine best trade route");
            }

            // Log trade details
            await this.logTradeDetails(bestTrade, tradeId);

            // Get the estimated output amount
            const expectedOutput = bestTrade.outputAmount;
            const quote = bestTrade?.exactQuote;
            logger.info("Estimated Output Amount", {
                tradeId,
                amount: expectedOutput.toSignificant(6), // formatted for readability
                token: expectedOutput.token.symbol,
                quote: quote,
            });

            // Execute trade
            const swapOptions: TradeOptions = {
                allowedSlippage: new Percent(config.slippagePercent, "10000"),
                ttl: config.ttlSeconds,
                recipient: this.account.address,
                feeOnTransfer: config.feeOnTransfer,
            };

            const { methodName, args, value } = bestTrade.swapCallParameters(swapOptions);
            logger.debug("Swap parameters prepared", {
                tradeId,
                methodName,
                value: value.toString(),
                recipient: this.account.address
            });

            // Simulate before executing
            logger.info("Simulating transaction", { tradeId });
            const { request } = await this.publicClient.simulateContract({
                address: ROUTER,
                abi: jsonAbis.LBRouterV22ABI,
                functionName: methodName as any,
                args,
                account: this.account,
                value: BigInt(value),
            });
            logger.info("Transaction simulation successful", { tradeId });

            // Execute the trade
            logger.info("Executing transaction", { tradeId });
            const hash = await this.walletClient.writeContract(request);
            logger.info("Transaction submitted successfully", {
                tradeId,
                hash,
                methodName,
                value: value.toString()
            });

            return hash;

        } catch (error) {
            if (error instanceof BaseError) {
                if (error instanceof ContractFunctionRevertedError) {
                    logger.error("Trade reverted", {
                        tradeId,
                        error: error.message,
                        type: "revert"
                    });
                    throw new Error(`Trade reverted: ${error.message}`);
                }
                logger.error("Transaction failed", {
                    tradeId,
                    error: error.message,
                    type: "transaction"
                });
                throw new Error(`Transaction failed: ${error.message}`);
            }
            logger.error("Unexpected error during trade execution", {
                tradeId,
                error,
                type: "unexpected"
            });
            throw error;
        }
    }

    private async logTradeDetails(trade: TradeV2, tradeId: string) {
        const tradeLog = trade.toLog();
        logger.info("Trade route details", {
            tradeId,
            route: tradeLog
        });

        const { totalFeePct, feeAmountIn } = await trade.getTradeFee();
        logger.info("Trade fee details", {
            tradeId,
            totalFeePercent: totalFeePct.toSignificant(6),
            feeAmount: feeAmountIn.toSignificant(6),
            feeToken: feeAmountIn.token.symbol
        });
    }
}

export default TraderJoeExecutor;