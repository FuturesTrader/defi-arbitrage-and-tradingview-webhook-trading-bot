import dotenv from 'dotenv';
dotenv.config();

import {
    createPublicClient,
    createWalletClient,
    http,
    formatUnits,
    parseUnits,
    type Address,
    getContract,
    ContractFunctionExecutionError
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche } from 'viem/chains';
import {
    TOKENS,
    ADDRESSES,
    ABIS,
} from './constants.ts';
import logger from "./logger.ts";

interface Slot0Data {
    sqrtPriceX96: bigint;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    feeProtocol: number;
    unlocked: boolean;
}

interface QuoteExactInputSingleParams {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    fee: number;
    sqrtPriceLimitX96: bigint;
}

interface ExactInputSingleParams {
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    recipient: Address;
    deadline: bigint;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: bigint;
}

function initializeClients() {
    if (!process.env.AVALANCHE_RPC_URL || !process.env.PRIVATE_KEY) {
        throw new Error('Missing required environment variables');
    }

    const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
        ? process.env.PRIVATE_KEY
        : `0x${process.env.PRIVATE_KEY}`;

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const transport = http(process.env.AVALANCHE_RPC_URL);

    const publicClient = createPublicClient({
        chain: avalanche,
        transport
    });

    const walletClient = createWalletClient({
        account,
        chain: avalanche,
        transport
    });

    console.log(`Using account: ${account.address}`);

    return { publicClient, walletClient, account };
}

async function estimateGas(
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    tx: any
): Promise<bigint> {
    try {
        const gasEstimate = await publicClient.estimateGas(tx);
        console.log(`Gas Estimate: ${gasEstimate.toString()}`);

        const buffer = BigInt(50000);
        const gasWithBuffer = gasEstimate + buffer;
        console.log(`Gas Estimate with Buffer: ${gasWithBuffer.toString()}`);

        return gasWithBuffer;
    } catch (error) {
        if (error instanceof ContractFunctionExecutionError) {
            console.error('Gas Estimation Failed:', error.message);
        }
        throw error;
    }
}

async function main() {
    try {
        console.log('1. Initializing Viem clients...');
        const { publicClient, walletClient, account } = initializeClients();

        console.log('\n2. Verifying pool information...');
        const poolAddress = ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX as Address;
        console.log(`Pool Address: ${poolAddress}`);

        const poolContract = {
            address: poolAddress,
            abi: ABIS.UNISWAP_V3_POOL
        };

        // Define return types for contract reads
        type Slot0Response = [bigint, number, number, number, number, number, boolean];

        // Fetch pool data with explicit type assertions
        const [token0Address, token1Address, poolFee, liquidity, slot0Raw] = await Promise.all([
            publicClient.readContract({
                ...poolContract,
                functionName: 'token0'
            }) as Promise<Address>,
            publicClient.readContract({
                ...poolContract,
                functionName: 'token1'
            }) as Promise<Address>,
            publicClient.readContract({
                ...poolContract,
                functionName: 'fee'
            }) as Promise<number>,
            publicClient.readContract({
                ...poolContract,
                functionName: 'liquidity'
            }) as Promise<bigint>,
            publicClient.readContract({
                ...poolContract,
                functionName: 'slot0'
            }) as Promise<Slot0Response>
        ]);

        const slot0Data: Slot0Data = {
            sqrtPriceX96: slot0Raw[0],
            tick: slot0Raw[1],
            observationIndex: slot0Raw[2],
            observationCardinality: slot0Raw[3],
            observationCardinalityNext: slot0Raw[4],
            feeProtocol: slot0Raw[5],
            unlocked: slot0Raw[6],
        };

        console.log('Pool Configuration:');
        console.log(`  Token0: ${token0Address}`);
        console.log(`  Token1: ${token1Address}`);
        console.log(`  Fee: ${poolFee}`);
        console.log(`  Sqrt Price X96: ${slot0Data.sqrtPriceX96.toString()}`);
        console.log(`  Tick: ${slot0Data.tick}`);
        console.log(`  Liquidity: ${liquidity.toString()}`);

        if (liquidity === BigInt(0)) {
            logger.error("Liquidity returned zero amount");
            process.exit(1);
        }

        console.log('\n3. Testing quote paths...');
        const quotePaths = [
            {
                description: 'USDC -> WAVAX (1 USDC)',
                tokenIn: TOKENS.USDC_UNI.address as Address,
                tokenOut: TOKENS.WAVAX_UNI.address as Address,
                fee: 500,
                amountIn: parseUnits('1', 6), // USDC has 6 decimals
                sqrtPriceLimitX96: BigInt(0),
            }
        ];

        let successfulQuote: {
            description: string;
            tokenIn: Address;
            tokenOut: Address;
            fee: number;
            amountIn: bigint;
            amountOut: bigint;
        } | null = null;

        for (const path of quotePaths) {
            try {
                console.log(`\nTesting ${path.description}`);
                console.log('Quote parameters:', {
                    tokenIn: path.tokenIn,
                    tokenOut: path.tokenOut,
                    fee: path.fee,
                    amountIn: path.amountIn.toString(),
                    sqrtPriceLimitX96: path.sqrtPriceLimitX96.toString(),
                });

                const quoteParams = {
                    tokenIn: path.tokenIn,
                    tokenOut: path.tokenOut,
                    amountIn: path.amountIn,
                    fee: path.fee,
                    sqrtPriceLimitX96: path.sqrtPriceLimitX96,
                };

                const quoterResponse = await publicClient.readContract({
                    address: ADDRESSES.UNISWAP_V3.QUOTER as Address,
                    abi: ABIS.UNISWAP_V3_QUOTER,
                    functionName: 'quoteExactInputSingle',
                    args: [quoteParams]
                });

                // The quoter returns a tuple, where the first element is the amount out
                const amountOut = (quoterResponse as any)[0] as bigint;

                console.log('Quote received:', {
                    amountOut: amountOut.toString(),
                    amountOutFormatted: formatUnits(amountOut, 18) // WAVAX has 18 decimals
                });

                successfulQuote = {
                    ...path,
                    amountOut
                };
                break;
            } catch (error) {
                console.log('Error fetching quote:', error);
            }
        }

        if (!successfulQuote) {
            logger.error("No successful quote paths found.");
            process.exit(1);
        }

        console.log('\n4. Preparing swap parameters for gas estimation...');
        const exactInputParams: ExactInputSingleParams = {
            tokenIn: successfulQuote.tokenIn,
            tokenOut: successfulQuote.tokenOut,
            fee: successfulQuote.fee,
            recipient: account.address,
            deadline: BigInt(Math.floor(performance.now() / 1000) + 60 * 20),
            amountIn: successfulQuote.amountIn,
            amountOutMinimum: (successfulQuote.amountOut * BigInt(995)) / BigInt(1000), // 0.5% slippage
            sqrtPriceLimitX96: BigInt(0)
        };

        const { request } = await publicClient.simulateContract({
            address: ADDRESSES.UNISWAP_V3.ROUTER as Address,
            abi: ABIS.UNISWAP_V3_ROUTER,
            functionName: 'exactInputSingle',
            args: [exactInputParams],
            account: account.address
        });

        const currentGasPrice = await publicClient.getGasPrice();
        console.log('Current Gas Price:', formatUnits(currentGasPrice, 9), 'gwei');

        console.log('\n5. Estimating gas for exactInputSingle transaction...');
        const gasWithBuffer = await estimateGas(publicClient, walletClient, request);

        console.log('\nGas estimation test completed successfully.');
        console.log(`Estimated Gas with Buffer: ${gasWithBuffer.toString()}`);
    } catch (error) {
        console.error('Test Script Failed:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('\nGas estimation test encountered an error:', error);
    process.exit(1);
});