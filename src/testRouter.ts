import {
    createPublicClient,
    http,
    getAddress,
    type Address
} from 'viem';
import { avalanche } from 'viem/chains';
import { ADDRESSES, ABIS } from './constants.ts';
import dotenv from 'dotenv';
dotenv.config();

async function testRouter() {
    try {
        // Initialize client
        console.log('1. Initializing client...');
        const transport = http(process.env.AVALANCHE_RPC_URL as Address);
        const publicClient = createPublicClient({
            chain: avalanche,
            transport
        });

        const routerAddress = ADDRESSES.UNISWAP_V3.ROUTER as Address;
        console.log('\nRouter address:', routerAddress);

        // Check if address is valid
        console.log('\n2. Validating address format...');
        try {
            const validatedAddress = getAddress(routerAddress);
            console.log('✓ Address format is valid');
        } catch (error) {
            console.error('✗ Invalid address format:', error);
            return;
        }

        // Get contract code
        console.log('\n3. Checking contract code...');
        const code = await publicClient.getCode({
            address: routerAddress
        });

        if (!code || code === '0x') {
            console.error('✗ No contract code found at this address');
            return;
        }
        console.log('✓ Contract code exists at address');
        console.log('Code length:', code.length, 'bytes');

        // Try to read factory address from router
        console.log('\n4. Testing router interface...');
        try {
            const factory = await publicClient.readContract({
                address: routerAddress,
                abi: ABIS.UNISWAP_V3_ROUTER,
                functionName: 'factory'
            });
            console.log('✓ Successfully read factory address:', factory);
        } catch (error) {
            console.error('✗ Failed to read factory address:', error);
        }

        // Try to read WETH9 address
        try {
            const weth9 = await publicClient.readContract({
                address: routerAddress,
                abi: ABIS.UNISWAP_V3_ROUTER,
                functionName: 'WETH9'
            });
            console.log('✓ Successfully read WETH9 address:', weth9);
        } catch (error) {
            console.error('✗ Failed to read WETH9 address:', error);
        }

    } catch (error) {
        console.error('Test failed:', error);
    }
}

// Run the test
console.log('Starting router verification...');
testRouter()
    .then(() => {
        console.log('\nRouter verification completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\nRouter verification failed:', error);
        process.exit(1);
    });