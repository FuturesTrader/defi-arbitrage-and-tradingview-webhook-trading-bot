// src/testPool.ts
import {Address, createPublicClient, http} from 'viem';
import { avalanche } from 'viem/chains';
import dotenv from 'dotenv';
import { PairV2} from '@traderjoe-xyz/sdk-v2'
import {ADDRESSES} from './constants.ts'

dotenv.config();
const POOL = ADDRESSES.TRADER_JOE.POOLS.USDC_WAVAX as Address;
const publicClient = createPublicClient({
    chain: avalanche,
    transport: http(process.env.AVALANCHE_RPC_URL as string)
});
async function verifyPool() {
    const pairVersion = 'v22';
    const lbPairData = await PairV2.getLBPairReservesAndId(POOL, pairVersion, publicClient)
    const tokenx = lbPairData.reserveX;
    const tokeny = lbPairData.reserveY;
    const activeBinId = lbPairData.activeId;
    console.log("Active Bin ID:", activeBinId);
    console.log("reserves for tokenx, tokeny:", tokenx,tokeny)
    console.log("lbPair:", POOL);
}

verifyPool().catch(console.error);