// src/testEnv.ts
import dotenv from 'dotenv';
dotenv.config();

console.log('Testing environment variables:');
console.log('AVALANCHE_ENDPOINT:', process.env.AVALANCHE_RPC_URL? 'Found' : 'Missing');
console.log('PRIVATE_KEY length:', process.env.PRIVATE_KEY?.length ?? 'Missing');
console.log('PRIVATE_KEY format:', process.env.PRIVATE_KEY?.startsWith('0x') ? 'Starts with 0x' : 'Missing 0x prefix');