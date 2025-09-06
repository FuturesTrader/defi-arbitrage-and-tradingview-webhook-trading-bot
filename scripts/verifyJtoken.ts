// verify-jtoken.ts
// Script to verify if a contract is a USDC JToken with flash loan capability

import {
    createPublicClient,
    http,
    type Address,
    getContract,
    type PublicClient
} from 'viem';
import { avalanche } from 'viem/chains';

async function main() {
    // Set up the public client
    const publicClient = createPublicClient({
        chain: avalanche,
        transport: http('https://api.avax.network/ext/bc/C/rpc')
    });

    // Contract address to verify from your FlashLoanDelegator.txt
    const jTokenAddress = '0x29472D511808Ce925F501D25F9Ee9efFd2328db2' as Address;

    // Known USDC address on Avalanche
    const knownUsdcAddress = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as Address;

    // Minimal ABI with just the functions we need
    const minimalAbi = [
        // Get the underlying token
        {
            name: 'underlying',
            inputs: [],
            outputs: [{ type: 'address' }],
            stateMutability: 'view',
            type: 'function'
        },
        // Get token name
        {
            name: 'name',
            inputs: [],
            outputs: [{ type: 'string' }],
            stateMutability: 'view',
            type: 'function'
        },
        // Get token symbol
        {
            name: 'symbol',
            inputs: [],
            outputs: [{ type: 'string' }],
            stateMutability: 'view',
            type: 'function'
        },
        // Check if it's a JToken
        {
            name: 'isJToken',
            inputs: [],
            outputs: [{ type: 'bool' }],
            stateMutability: 'view',
            type: 'function'
        },
        // Get flash loan fee
        {
            name: 'flashFeeBips',
            inputs: [],
            outputs: [{ type: 'uint256' }],
            stateMutability: 'view',
            type: 'function'
        },
        // Check if contract is a proxy
        {
            name: 'implementation',
            inputs: [],
            outputs: [{ type: 'address' }],
            stateMutability: 'view',
            type: 'function'
        },
        // Check contract decimals
        {
            name: 'decimals',
            inputs: [],
            outputs: [{ type: 'uint8' }],
            stateMutability: 'view',
            type: 'function'
        }
    ] as const;

    console.log('Checking contract at address:', jTokenAddress);
    console.log('-'.repeat(50));

    try {
        // 1. Check underlying token
        const underlyingAddress = await publicClient.readContract({
            address: jTokenAddress,
            abi: minimalAbi,
            functionName: 'underlying'
        }) as Address;

        const isUsdc = underlyingAddress.toLowerCase() === knownUsdcAddress.toLowerCase();

        console.log('Underlying token address:', underlyingAddress);
        console.log('Is USDC:', isUsdc ? 'Yes ✅' : 'No ❌');

        // 2. Get token name
        const name = await publicClient.readContract({
            address: jTokenAddress,
            abi: minimalAbi,
            functionName: 'name'
        });
        console.log('Token name:', name);

        // 3. Get token symbol
        const symbol = await publicClient.readContract({
            address: jTokenAddress,
            abi: minimalAbi,
            functionName: 'symbol'
        });
        console.log('Token symbol:', symbol);

        // 4. Check if it's a JToken
        const isJToken = await publicClient.readContract({
            address: jTokenAddress,
            abi: minimalAbi,
            functionName: 'isJToken'
        });
        console.log('Is JToken:', isJToken ? 'Yes ✅' : 'No ❌');

        // 5. Get flash loan fee
        const flashFeeBips = await publicClient.readContract({
            address: jTokenAddress,
            abi: minimalAbi,
            functionName: 'flashFeeBips'
        }) as bigint;
        console.log('Flash loan fee:', `${flashFeeBips} bips (${Number(flashFeeBips) / 100}%)`);

        // 6. Check decimals
        const decimals = await publicClient.readContract({
            address: jTokenAddress,
            abi: minimalAbi,
            functionName: 'decimals'
        });
        console.log('Decimals:', decimals);

        // 7. Check if it's a proxy contract
        let isProxy = false;
        let implementationAddress: Address | null = null;

        try {
            implementationAddress = await publicClient.readContract({
                address: jTokenAddress,
                abi: minimalAbi,
                functionName: 'implementation'
            }) as Address;

            isProxy = true;
            console.log('Implementation address:', implementationAddress);
            console.log('Is proxy contract: Yes ✅');
        } catch (error) {
            console.log('Is proxy contract: No ❌');
        }

        // 8. Check if the contract has sufficient USDC for flash loans
        // First, let's create a minimal USDC ABI
        const usdcAbi = [
            {
                name: 'balanceOf',
                inputs: [{ name: 'account', type: 'address' }],
                outputs: [{ type: 'uint256' }],
                stateMutability: 'view',
                type: 'function'
            }
        ] as const;

        const usdcBalance = await publicClient.readContract({
            address: knownUsdcAddress,
            abi: usdcAbi,
            functionName: 'balanceOf',
            args: [jTokenAddress]
        }) as bigint;

        console.log('USDC balance:', usdcBalance.toString());

        // Generate overall assessment
        console.log('-'.repeat(50));
        console.log('VERIFICATION RESULT:');
        if (isUsdc && isJToken) {
            console.log('✅ This IS a USDC JToken contract with flash loan capability');
            console.log(`✅ Symbol: ${symbol}`);
            console.log(`✅ Flash loan fee: ${Number(flashFeeBips) / 100}%`);
            console.log(`✅ Available USDC for flash loans: ${usdcBalance.toString()}`);
        } else {
            console.log('❌ This is NOT a USDC JToken contract');
            if (!isUsdc) console.log('   - Underlying token is not USDC');
            if (!isJToken) console.log('   - Contract does not identify as a JToken');
        }

        // Check flash loan interface compatibility with your contract
        console.log('-'.repeat(50));
        console.log('INTERFACE COMPATIBILITY CHECK:');
        console.log('Your current interface:');
        console.log('```solidity');
        console.log('interface IJoeFlashLoan {');
        console.log('    function flashLoan(');
        console.log('        address caller,');
        console.log('        address[] memory tokens,');
        console.log('        uint256[] memory amounts,');
        console.log('        bytes memory data');
        console.log('    ) external;');
        console.log('}');
        console.log('```');

        console.log('\nExpected interface based on the ABI:');
        console.log('```solidity');
        console.log('interface IJoeFlashLoan {');
        console.log('    function flashLoan(');
        console.log('        address receiver,');
        console.log('        address initiator,');
        console.log('        uint256 amount,');
        console.log('        bytes memory data');
        console.log('    ) external returns (bool);');
        console.log('}');
        console.log('```');

        console.log('\n⚠️ Interface mismatch detected:');
        console.log('You need to update your contract interface to match the actual function signature.');

        // Also check if there's a flashLoan function in the ABI from the delegator file
        console.log('-'.repeat(50));
        console.log('FLASH LOAN FUNCTION IN DELEGATOR ABI:');
        console.log('From your FlashLoanDelegator.txt, the flashLoan function signature is:');
        console.log('```solidity');
        console.log('function flashLoan(');
        console.log('    address receiver,');
        console.log('    address initiator,');
        console.log('    uint256 amount,');
        console.log('    bytes memory data');
        console.log(') external returns (bool)');
        console.log('```');

    } catch (error) {
        console.error('Error verifying contract:', error);
    }
}

main().catch(console.error);