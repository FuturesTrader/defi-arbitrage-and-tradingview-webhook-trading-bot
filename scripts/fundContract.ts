// Updated fundContract.ts for CrossDexArbitrageWithFlashLoan with Balancer flash loans

import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    parseUnits,
    http,
    type PublicClient,
    type WalletClient,
    type Address,
    type Account
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalanche } from 'viem/chains';
import { TOKEN_CONFIGS, ARBITRAGE_SETTINGS, ADDRESSES } from '../src/constants';
import { ARBITRAGE_ABI } from '../src/services/constants/arbitrageAbi';
import dotenv from 'dotenv';
import logger from '../src/logger';

dotenv.config();
const MAX_RETRY_ATTEMPTS = ARBITRAGE_SETTINGS.MAX_RETRY_ATTEMPTS;
const RETRY_DELAY = ARBITRAGE_SETTINGS.RETRY_DELAY;
const TRANSACTION_TIMEOUT = ARBITRAGE_SETTINGS.TRANSACTION_TIMEOUT;
// Use Flash pool address
const FLASH_POOL = ADDRESSES.BALANCER_V2.POOL;
/**
 * Script to fund the flash loan-enabled arbitrage smart contract with tokens
 * and configure approvals needed for Balancer flash loans
 */
async function fundContract() {
    try {
        // Validate environment variables
        if (!process.env.PRIVATE_KEY || !process.env.AVALANCHE_RPC_URL || !process.env.ARBITRAGE_CONTRACT_ADDRESS) {
            throw new Error('Missing required environment variables (PRIVATE_KEY, AVALANCHE_RPC_URL, ARBITRAGE_CONTRACT_ADDRESS)');
        }

        // 1) Get command line arguments or use defaults
        const args = process.argv.slice(2);
        const tokenSymbol = args[0] || 'USDC';
        const amountStr = args[1] || '5';
        const configureFlashLoansStr = args[2] || 'false';
        const configureFlashLoans = configureFlashLoansStr.toLowerCase() === 'true';

        // 2) Validate token
        if (!TOKEN_CONFIGS[tokenSymbol]) {
            throw new Error(`Unknown token: ${tokenSymbol}. Supported tokens: ${Object.keys(TOKEN_CONFIGS).join(', ')}`);
        }

        const tokenConfig = TOKEN_CONFIGS[tokenSymbol];
        const tokenAddress = tokenConfig.address;

        // 3) Parse amount
        const amount = parseUnits(amountStr, tokenConfig.decimals);

        // 4) Initialize clients
        const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
            ? (process.env.PRIVATE_KEY as `0x${string}`)
            : (`0x${process.env.PRIVATE_KEY}` as `0x${string}`);

        const account = privateKeyToAccount(privateKey);
        const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as `0x${string}`;

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

        // 5) Check sender balance
        const senderBalance = await publicClient.readContract({
            address: tokenAddress,
            abi: [
                {
                    inputs: [{ name: "account", type: "address" }],
                    name: "balanceOf",
                    outputs: [{ name: "", type: "uint256" }],
                    stateMutability: "view",
                    type: "function"
                }
            ],
            functionName: 'balanceOf',
            args: [account.address]
        });

        const formattedSenderBalance = formatUnits(senderBalance as bigint, tokenConfig.decimals);

        logger.info('Sender account balance', {
            token: tokenSymbol,
            balance: formattedSenderBalance,
            account: account.address
        });

        if ((senderBalance as bigint) < amount) {
            throw new Error(`Insufficient balance. Requested: ${amountStr} ${tokenSymbol}, Available: ${formattedSenderBalance} ${tokenSymbol}`);
        }

        // 6) Log current contract balance
        const contractBalance = await publicClient.readContract({
            address: tokenAddress,
            abi: [
                {
                    inputs: [{ name: "account", type: "address" }],
                    name: "balanceOf",
                    outputs: [{ name: "", type: "uint256" }],
                    stateMutability: "view",
                    type: "function"
                }
            ],
            functionName: 'balanceOf',
            args: [contractAddress]
        });

        const formattedContractBalance = formatUnits(contractBalance as bigint, tokenConfig.decimals);

        logger.info('Current contract balance', {
            token: tokenSymbol,
            balance: formattedContractBalance,
            contractAddress
        });

        // 7) Verify flash loan configuration if requested
        if (configureFlashLoans) {
            try {
                // Use verifyFlashLoanConfiguration to check Balancer Vault configuration
                const flashLoanConfig = await publicClient.readContract({
                    address: contractAddress,
                    abi: ARBITRAGE_ABI,
                    functionName: 'verifyFlashLoanConfiguration'
                });

                const balancerVaultAddress = (flashLoanConfig as any)[0];
                const currentFeeBps = (flashLoanConfig as any)[1];

                console.log('\nCurrent Balancer Flash Loan Configuration:');
                console.log(`- Balancer Vault Address: ${balancerVaultAddress}`);
                console.log(`- Flash Loan Fee BPS: ${currentFeeBps} (${Number(currentFeeBps)/100}%)`);

                // Check if Balancer Vault address is correctly set
                if (balancerVaultAddress !== FLASH_POOL) {
                    console.log(`\nBalancer Vault address mismatch. Contract has ${balancerVaultAddress}, expected ${FLASH_POOL}`);

                    if (await checkContractOwnership(publicClient, account.address, contractAddress)) {
                        console.log('You are the contract owner but Balancer Vault is immutable and cannot be changed.');
                        console.log('Consider deploying a new contract with the correct Balancer Vault address.');
                    } else {
                        console.log('⚠️ You are not the contract owner and cannot update the contract configuration.');
                    }
                } else {
                    console.log('✅ Balancer Vault address correctly configured');
                }
            } catch (error) {
                console.error('Error checking flash loan configuration:', error);

                // Try to get the immutable balancerVaultAddress directly
                try {
                    const vaultAddress = await publicClient.readContract({
                        address: contractAddress,
                        abi: ARBITRAGE_ABI,
                        functionName: 'balancerVault'
                    });

                    console.log(`\nBalancer Vault Address (immutable): ${vaultAddress}`);

                    if (vaultAddress !== FLASH_POOL) {
                        console.log(`⚠️ Warning: Vault address (${vaultAddress}) doesn't match expected (${FLASH_POOL})`);
                    } else {
                        console.log('✅ Balancer Vault address matches expected value');
                    }
                } catch (vaultError) {
                    console.error('Could not retrieve Balancer Vault address:', vaultError);
                }
            }
        }

        // 8) Check and configure contract approvals for tokens
        const isOwner = await checkContractOwnership(publicClient, account.address, contractAddress);

        if (isOwner) {
            if (tokenSymbol === 'USDC' || tokenSymbol === 'WAVAX') {
                await checkAndConfigureApprovals(
                    publicClient,
                    walletClient,
                    account,
                    contractAddress,
                    tokenAddress,
                    tokenConfig.decimals,
                    FLASH_POOL
                );
            }
        }

        // 9) Execute token transfer to fund the contract
        console.log(`\nSending ${amountStr} ${tokenSymbol} to contract ${contractAddress}...`);

        const hash = await walletClient.writeContract({
            account,
            address: tokenAddress,
            abi: [
                {
                    inputs: [
                        { name: "to", type: "address" },
                        { name: "amount", type: "uint256" }
                    ],
                    name: "transfer",
                    outputs: [{ name: "", type: "bool" }],
                    stateMutability: "nonpayable",
                    type: "function"
                }
            ],
            functionName: 'transfer',
            args: [contractAddress, amount],
            chain: avalanche
        });

        logger.info('Transfer transaction submitted', { hash });
        console.log(`Transaction submitted: ${hash}`);

        // 10) Wait for confirmation
        console.log('Waiting for confirmation...');
        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: TRANSACTION_TIMEOUT,
            retryCount: MAX_RETRY_ATTEMPTS,
            retryDelay: RETRY_DELAY
        });

        if (receipt.status === 'success') {
            logger.info('Transfer successful', {
                transactionHash: hash,
                blockNumber: receipt.blockNumber,
                token: tokenSymbol,
                amount: amountStr
            });

            console.log(`✅ Successfully sent ${amountStr} ${tokenSymbol} to contract`);
            console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

            // 11) Retrieve new contract balance for logging
            const newContractBalance = await publicClient.readContract({
                address: tokenAddress,
                abi: [
                    {
                        inputs: [{ name: "account", type: "address" }],
                        name: "balanceOf",
                        outputs: [{ name: "", type: "uint256" }],
                        stateMutability: "view",
                        type: "function"
                    }
                ],
                functionName: 'balanceOf',
                args: [contractAddress]
            });

            const formattedNewBalance = formatUnits(newContractBalance as bigint, tokenConfig.decimals);
            console.log(`New contract balance: ${formattedNewBalance} ${tokenSymbol}`);
        } else {
            logger.error('Transfer failed', {
                transactionHash: hash,
                status: receipt.status
            });
            console.error('❌ Transfer failed');
        }

    } catch (error) {
        logger.error('Error in fundContract script', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });

        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

/**
 * Checks if the given address is the owner of the contract
 */
async function checkContractOwnership(
    publicClient: PublicClient,
    walletAddress: Address | Address[],
    contractAddress: Address
): Promise<boolean> {
    try {
        const owner = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'owner'
        });

        // Convert to string and normalize case for comparison
        const normalizedOwner = (owner as string).toLowerCase();

        // Handle if walletAddress is an array (from getAddresses)
        const addressToCheck = Array.isArray(walletAddress)
            ? walletAddress[0].toLowerCase()
            : walletAddress.toLowerCase();

        return normalizedOwner === addressToCheck;
    } catch (error) {
        console.error('Error checking contract ownership:', error);
        return false;
    }
}

/**
 * Checks and configures token approvals required for the flash loan contract
 * Includes approvals for both DEX routers and the Balancer Vault
 */
async function checkAndConfigureApprovals(
    publicClient: PublicClient,
    walletClient: WalletClient,
    account: Account,
    contractAddress: Address,
    tokenAddress: Address,
    tokenDecimals: number,
    balancerVaultAddress: Address
) {
    try {
        // Get the Uniswap and TraderJoe router addresses
        const uniswapRouter = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'uniswapRouterAddress'
        }) as Address;

        const traderJoeRouter = await publicClient.readContract({
            address: contractAddress,
            abi: ARBITRAGE_ABI,
            functionName: 'traderJoeRouterAddress'
        }) as Address;

        console.log('\nChecking token approvals for contract...');

        // The addresses that need approval
        const routers = [
            { name: 'Uniswap Router', address: uniswapRouter },
            { name: 'TraderJoe Router', address: traderJoeRouter },
            { name: 'Balancer Vault', address: balancerVaultAddress }
        ];

        // Check each router and update allowances if needed
        for (const router of routers) {
            if (router.address === '0x0000000000000000000000000000000000000000') {
                console.log(`⚠️ ${router.name} address not configured, skipping`);
                continue;
            }

            // Check current allowance
            const allowance = await publicClient.readContract({
                address: tokenAddress,
                abi: [
                    {
                        inputs: [
                            { name: "owner", type: "address" },
                            { name: "spender", type: "address" }
                        ],
                        name: "allowance",
                        outputs: [{ name: "", type: "uint256" }],
                        stateMutability: "view",
                        type: "function"
                    }
                ],
                functionName: 'allowance',
                args: [contractAddress, router.address]
            });

            const formattedAllowance = formatUnits(allowance as bigint, tokenDecimals);
            console.log(`Current contract allowance to ${router.name}: ${formattedAllowance}`);

            // Set minimum required allowance (100k should be plenty)
            const minRequired = '100000';
            const minRequiredBigInt = parseUnits(minRequired, tokenDecimals);

            if ((allowance as bigint) < minRequiredBigInt) {
                console.log(`\nAllowance is less than ${minRequired}, setting approval for ${router.name}...`);

                try {
                    // Use the contract's approveRouter function
                    const hash = await walletClient.writeContract({
                        account,
                        address: contractAddress,
                        abi: ARBITRAGE_ABI,
                        functionName: 'approveRouter',
                        args: [tokenAddress, router.address, minRequiredBigInt],
                        chain: avalanche
                    });

                    console.log(`Transaction submitted: ${hash}`);
                    const receipt = await publicClient.waitForTransactionReceipt({
                        hash,
                        confirmations: 1,
                        timeout: TRANSACTION_TIMEOUT
                    });

                    if (receipt.status === 'success') {
                        console.log(`✅ Successfully approved ${router.name} to spend tokens`);
                    } else {
                        console.error(`❌ Approval transaction for ${router.name} failed`);
                    }
                } catch (error) {
                    console.error(`Error approving ${router.name}:`, error);
                }
            } else {
                console.log(`✅ Allowance for ${router.name} is sufficient`);
            }
        }
    } catch (error) {
        console.error('Error checking and configuring approvals:', error);
    }
}

// Execute the script
fundContract().catch(console.error);