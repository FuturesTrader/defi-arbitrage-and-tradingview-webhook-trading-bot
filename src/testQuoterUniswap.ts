import {
    CurrencyAmount,
    TradeType,
} from '@uniswap/sdk-core';
import {
    Pool,
    Route,
    SwapQuoter,
} from '@uniswap/v3-sdk';
import {
    createPublicClient,
    http,
    decodeAbiParameters,
    hexToBytes,
    Address,
    toHex as viemToHex,
    type Hex,
    type PublicClient, parseUnits
} from 'viem';
import { avalanche } from 'viem/chains';
import {
    TOKENS,
    ADDRESSES,
    ABIS,
    TRADE_SETTINGS,
} from './constants.ts';
import dotenv from 'dotenv';
import logger from "./logger.ts";

// Define the slot0 return type
type Slot0Result = [
    sqrtPriceX96: bigint,
    tick: number,
    observationIndex: number,
    observationCardinality: number,
    observationCardinalityNext: number,
    feeProtocol: number,
    unlocked: boolean
];

dotenv.config();

// Cache the public client
let publicClient: PublicClient;

// Define interfaces for better type safety
interface PoolData {
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
}

interface QuoteResult {
    pool: Address;
    amountIn: string;
    amountOut: string;
    inputToken: string;
    outputToken: string;
    price: string;  // Price in USDC per WAVAX
    executionTime: number;
}

// Separate pool data fetching for better error handling and reusability
async function getPoolData(client: PublicClient, poolAddress: Address): Promise<PoolData> {
    const [slot0Data, liquidity] = await Promise.all([
        client.readContract({
            address: poolAddress,
            abi: ABIS.UNISWAP_V3_POOL,
            functionName: 'slot0'
        }) as Promise<Slot0Result>,
        client.readContract({
            address: poolAddress,
            abi: ABIS.UNISWAP_V3_POOL,
            functionName: 'liquidity'
        }) as Promise<bigint>
    ]);

    return {
        sqrtPriceX96: slot0Data[0],
        tick: slot0Data[1],
        liquidity
    };
}

// Separate quote calculation logic
async function calculateQuote(
    pool: Pool,
    amountIn: CurrencyAmount<any>,
    client: PublicClient
): Promise<bigint> {
    const route = new Route([pool], TOKENS.USDC_UNI, TOKENS.WAVAX_UNI);

    const { calldata } = SwapQuoter.quoteCallParameters(
        route,
        amountIn,
        TradeType.EXACT_INPUT,
        {
            useQuoterV2: true,
        }
    );

    const quoteCallReturnData = await client.call({
        to: ADDRESSES.UNISWAP_V3.QUOTER as Address,
        data: calldata as `0x${string}`,
    });

    const returnData = processQuoteReturnData(quoteCallReturnData);
    const bytes = hexToBytes(returnData);
    const [amountOut] = decodeAbiParameters([{ type: 'uint256' }], bytes);

    return amountOut;
}

// Calculate price accounting for decimals
function calculatePrice(amountInExact: string, amountOutExact: string): string {
    // Convert string amounts to numbers
    const amountIn = parseFloat(amountInExact);
    const amountOut = parseFloat(amountOutExact);

    // Calculate price (USDC per WAVAX)
    const price = amountIn / amountOut;

    // Return formatted price with reasonable decimal places
    return price.toFixed(6);
}

// Helper function to process return data
function processQuoteReturnData(quoteCallReturnData: unknown): Hex {
    let returnData: Hex;

    if (typeof quoteCallReturnData === 'object' && quoteCallReturnData !== null && 'data' in quoteCallReturnData) {
        returnData = quoteCallReturnData.data as Hex;
    } else if (typeof quoteCallReturnData === 'string') {
        returnData = quoteCallReturnData as Hex;
    } else if (typeof quoteCallReturnData === 'bigint') {
        returnData = viemToHex(quoteCallReturnData);
    } else {
        throw new Error(`Unexpected return data type: ${typeof quoteCallReturnData}`);
    }

    if (!returnData || returnData === '0x') {
        throw new Error("No successful quote paths found");
    }

    return returnData;
}

// Validate token setup
function validateTokens() {
    if (!TOKENS.USDC_UNI.symbol) {
        throw new Error('USDC token symbol not defined');
    }
    if (!TOKENS.WAVAX_UNI.symbol) {
        throw new Error('WAVAX token symbol not defined');
    }
}

async function main(): Promise<QuoteResult> {
    const startTime = performance.now();

    try {
        // Validate tokens first
        validateTokens();
        // Initialize client only if not already initialized
        if (!publicClient) {
            const rpcUrl = process.env.AVALANCHE_RPC_URL;
            if (!rpcUrl) {
                throw new Error('AVALANCHE_RPC_URL is not defined in environment variables');
            }
            publicClient = createPublicClient({
                chain: avalanche,
                transport: http(rpcUrl)
            });
        }

        const poolAddress = ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX as Address;
        const poolData = await getPoolData(publicClient, poolAddress);

        const pool = new Pool(
            TOKENS.USDC_UNI,
            TOKENS.WAVAX_UNI,
            3000,
            poolData.sqrtPriceX96.toString(),
            poolData.liquidity.toString(),
            poolData.tick
        );
        const quoteAmount = parseUnits(TRADE_SETTINGS.TRADE_SIZE,6).toString();
        const amountIn = CurrencyAmount.fromRawAmount(
            TOKENS.USDC_UNI,
            quoteAmount// 1 USDC (6 decimals)
        );

        const amountOut = await calculateQuote(pool, amountIn, publicClient);

        const amountInExact = amountIn.toExact();
        const amountOutExact = CurrencyAmount.fromRawAmount(
            TOKENS.WAVAX_UNI,
            amountOut.toString()
        ).toExact();

        const result: QuoteResult = {
            pool: poolAddress,
            amountIn: amountInExact,
            amountOut: amountOutExact,
            inputToken: TOKENS.USDC_UNI.symbol ?? 'USDC',
            outputToken: TOKENS.WAVAX_UNI.symbol ?? 'WAVAX',
            price: calculatePrice(amountInExact, amountOutExact),
            executionTime: performance.now() - startTime
        };

        return result;

    } catch (error) {
        logger.error('Error in quoter:', error);
        throw error;
    }
}

// Export for reuse in other modules
export { main as getQuote, QuoteResult };

// Only run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main()
        .then((result) => {
            console.log('Quote result:', result);
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Quote failed:', error);
            process.exit(1);
        });
}