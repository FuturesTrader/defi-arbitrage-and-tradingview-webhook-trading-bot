// src/testPool.ts
import { createPublicClient, http } from 'viem';
import { avalanche } from 'viem/chains';
import { ADDRESSES, ABIS} from './constants.ts';
import dotenv from 'dotenv';
dotenv.config();

async function verifyPool() {
    const rpc = process.env.AVALANCHE_RPC_URL;
    if (!rpc) throw new Error('No RPC endpoint found');

    const client = createPublicClient({
        chain: avalanche,
        transport: http(rpc)
    });

    const poolAddress = ADDRESSES.UNISWAP_V3.POOLS.USDC_WAVAX;
    console.log('Checking pool address:', poolAddress);

    try {
        const code = await client.getCode({ address: poolAddress as `0x${string}` });
        if (!code) {
            console.log('No contract found at this address!');
            return;
        }
        console.log('Contract exists at address');

        // Try to get tokens
        const token0 = await client.readContract({
            address: poolAddress as `0x${string}`,
            abi: ABIS.UNISWAP_V3_POOL,
            functionName: 'token0'
        });

        const token1 = await client.readContract({
            address: poolAddress as `0x${string}`,
            abi: ABIS.UNISWAP_V3_POOL,
            functionName: 'token1'
        });

        console.log('Token0:', token0);
        console.log('Token1:', token1);
    } catch (error) {
        console.error('Error:', error);
    }
}

verifyPool().catch(console.error);