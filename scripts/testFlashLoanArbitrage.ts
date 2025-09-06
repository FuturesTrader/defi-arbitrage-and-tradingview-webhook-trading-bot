#!/usr/bin/env ts-node
import {
    createPublicClient,
    http,
    formatUnits,
    parseUnits,
    type Address
} from 'viem';
import { avalanche } from 'viem/chains';
import dotenv from 'dotenv';
import { getQuote as getUniswapQuote } from '../src/quoterUniswap';
import { getQuote as getTraderJoeQuote } from '../src/quoterTraderJoe';
import { TOKEN_CONFIGS, ADDRESSES } from '../src/constants';
import { getErrorMessage, sleep } from '../src/utils';
import logger from '../src/logger';
import { SmartContractService } from '../src/services/smartContractService';
import { FlashLoanService } from '../src/services/flashLoanService';
import type {
    DexType,
    ArbitrageConfig,
    SimulatedQuoteResult,
    TraderJoeTradeType,
    UniswapTradeType
} from '../src/tradeTypes';

dotenv.config();
// Use flash loan fee
const FLASH_LOAN_FEE_BPS = ADDRESSES.BALANCER_V2.FLASH_LOAN_BPS;
// Use pool address for flash loans
const FLASH_LOAN_POOL = ADDRESSES.BALANCER_V2.POOL;

// Parse command line arguments with enhanced options
const args = {
    path: process.argv[2] || 'uniswap-to-traderjoe', // must be 'uniswap-to-traderjoe' or 'traderjoe-to-uniswap'
    amount: process.argv[3] || '1', // test amount in USDC
    // New parameter for token pair, with default to WAVAX
    tokenPair: (process.argv[4] || 'wavax').toLowerCase(), // 'wavax' or 'wbtc'
    debug: process.argv.includes('--debug'),
    highGas: process.argv.includes('--high-gas'),
    testMode: !process.argv.includes('--production') // defaults to test mode
};

// Validate token pair argument
if (!['wavax', 'wbtc'].includes(args.tokenPair)) {
    console.error('Invalid token pair. Must be "wavax" or "wbtc".');
    process.exit(1);
}

// Log the selected token pair
console.log(`Selected token pair: USDC-${args.tokenPair.toUpperCase()}`);

if (
    !process.env.PRIVATE_KEY ||
    !process.env.AVALANCHE_RPC_URL ||
    !process.env.ARBITRAGE_CONTRACT_ADDRESS
) {
    console.error('Missing required environment variables');
    process.exit(1);
}

const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
    ? (process.env.PRIVATE_KEY as `0x${string}`)
    : (`0x${process.env.PRIVATE_KEY}` as `0x${string}`);

const transport = http(process.env.AVALANCHE_RPC_URL as string);
const publicClient = createPublicClient({
    chain: avalanche,
    transport
});

const contractAddress = process.env.ARBITRAGE_CONTRACT_ADDRESS as Address;
const smartContractService = new SmartContractService(privateKey, contractAddress);
const flashLoanService = new FlashLoanService(
    smartContractService,
    FLASH_LOAN_POOL as Address
);

/**
 * validateCalldata ensures that the provided calldata is nonempty, starts with "0x",
 * and has at least 10 characters (4 bytes selector + "0x").
 */
function validateCalldata(calldata: string, dex: string, direction: string): string {
    if (!calldata) {
        throw new Error(`Missing calldata for ${dex} ${direction}`);
    }
    const formattedCalldata = calldata.startsWith('0x') ? calldata : `0x${calldata}`;
    if (formattedCalldata.length < 10) {
        throw new Error(`Calldata too short for ${dex} ${direction}: ${formattedCalldata.length} chars`);
    }
    if (args.debug) {
        logger.debug(`Validated calldata for ${dex} ${direction}`, {
            calldata: formattedCalldata,
            length: formattedCalldata.length
        });
    }
    return formattedCalldata;
}

/**
 * Helper function to create a minimal Uniswap trade object for testing
 * This satisfies TypeScript's type checking without needing the full SDK implementation
 */
function createMinimalUniswapTrade(
    inputToken: string = 'USDC',
    outputToken: string = args.tokenPair.toUpperCase()
): UniswapTradeType {
    // Get token decimals based on token symbols
    const inputDecimals = inputToken === 'USDC' ? 6 : (inputToken === 'WAVAX' ? 18 : 8);
    const outputDecimals = outputToken === 'USDC' ? 6 : (outputToken === 'WAVAX' ? 18 : 8);

    return {
        route: {
            path: [],
            pools: [],
            input: {},
            output: {},
            midPrice: {
                toSignificant: () => "0",
                invert: () => ({ toSignificant: () => "0" })
            }
        },
        swaps: [],
        tradeType: 'EXACT_INPUT',
        inputAmount: {
            currency: {
                isToken: true,
                isNative: false,
                symbol: inputToken,
                decimals: inputDecimals
            },
            toExact: () => '0',
            toFixed: () => '0'
        },
        outputAmount: {
            currency: {
                isToken: true,
                isNative: false,
                symbol: outputToken,
                decimals: outputDecimals
            },
            toExact: () => '0',
            toFixed: () => '0'
        },
        executionPrice: {
            toSignificant: () => '0',
            invert: () => ({ toSignificant: () => '0' })
        },
        priceImpact: {
            toSignificant: () => '0'
        },
        // Force cast as a workaround for TypeScript
    } as unknown as UniswapTradeType;
}

/**
 * Helper function to create a minimal TraderJoe trade object for testing
 * This satisfies TypeScript's type checking without needing the full SDK implementation
 */
function createMinimalTraderJoeTrade(
    inputToken: string = 'USDC',
    outputToken: string = args.tokenPair.toUpperCase()
): TraderJoeTradeType {
    // Get token decimals based on token symbols
    const inputDecimals = inputToken === 'USDC' ? 6 : (inputToken === 'WAVAX' ? 18 : 8);
    const outputDecimals = outputToken === 'USDC' ? 6 : (outputToken === 'WAVAX' ? 18 : 8);

    return {
        route: {
            pools: [],
            path: [],
            input: {},
            output: {}
        },
        type: 'exactIn',
        inputAmount: {
            token: {
                symbol: inputToken,
                decimals: inputDecimals
            },
            toExact: () => '0',
            toSignificant: () => '0'
        },
        outputAmount: {
            token: {
                symbol: outputToken,
                decimals: outputDecimals
            },
            toExact: () => '0',
            toSignificant: () => '0'
        },
        executionPrice: {
            toSignificant: () => '0'
        },
        priceImpact: {
            toSignificant: () => '0'
        },
        getLiquidityVariant: () => 0,
        // Force cast as a workaround for TypeScript
    } as unknown as TraderJoeTradeType;
}

/**
 * Safely parses a string to a bigint, handling negative values properly
 */
function safeParseUnits(valueStr: string, decimals: number): bigint {
    // Parse the value to a float first to handle scientific notation
    const floatValue = parseFloat(valueStr);

    // Check if the value is negative
    if (floatValue < 0) {
        // Convert the absolute value to bigint with decimals and then negate it
        const absValue = Math.abs(floatValue);
        return -parseUnits(absValue.toString(), decimals);
    } else {
        // Normal positive or zero case
        return parseUnits(valueStr, decimals);
    }
}

/**
 * Helper function to determine trade direction based on token pair
 */
function getTradeDirection(baseDirection: string, tokenPair: string): string {
    const tokenSymbol = tokenPair.toUpperCase();

    if (baseDirection === 'USDC->WAVAX' && tokenSymbol === 'WBTC') {
        return 'USDC->WBTC';
    } else if (baseDirection === 'WAVAX->USDC' && tokenSymbol === 'WBTC') {
        return 'WBTC->USDC';
    }

    return baseDirection;
}

/**
 * Get the target token config based on selected token pair
 */
function getTargetTokenConfig(): typeof TOKEN_CONFIGS.WAVAX | typeof TOKEN_CONFIGS.WBTC {
    return args.tokenPair === 'wavax' ? TOKEN_CONFIGS.WAVAX : TOKEN_CONFIGS.WBTC;
}

/**
 * handleNegativeProfitForTestMode logs profit breakdown and, if the net profit is negative,
 * warns the user but returns the original expected output (so test mode allows negative profit).
 * It also checks for sufficient wallet allowances for test mode.
 */
async function handleNegativeProfitForTestMode(
    inputAmount: string,
    expectedOutput: string,
    walletAddress: Address,
    contractAddress: Address
): Promise<{
    expectedOutput: string,
    isNegativeProfit: boolean,
    hasSufficientAllowance: boolean
}> {
    const input = parseFloat(inputAmount);
    const output = parseFloat(expectedOutput);
    const expectedProfit = output - input;
    const flashLoanFee = input * FLASH_LOAN_FEE_BPS/10000;
    const netProfit = expectedProfit - flashLoanFee;
    const isNegativeProfit = netProfit <= 0;

    console.log(`\nProfit Analysis:`);
    console.log(`Input:           ${input.toFixed(6)} USDC`);
    console.log(`Expected Output: ${output.toFixed(6)} USDC`);
    console.log(`Expected Profit: ${expectedProfit.toFixed(6)} USDC`);
    console.log(`Flash Loan Fee:  ${flashLoanFee.toFixed(6)} USDC (${FLASH_LOAN_FEE_BPS/100}% of input amount)`);
    console.log(`Net Profit:      ${netProfit.toFixed(6)} USDC`);

    let hasSufficientAllowance = true;

    if (isNegativeProfit) {
        console.log(`WARNING: Negative or zero profit detected (${netProfit.toFixed(6)} USDC)`);
        console.log(`This is normal in test mode, but requires owner wallet funds to cover the shortfall.`);

        // Check if the wallet has granted sufficient allowance to the contract
        try {
            const ownerAllowance = await publicClient.readContract({
                address: TOKEN_CONFIGS.USDC.address,
                abi: [{
                    inputs: [
                        { name: "owner", type: "address" },
                        { name: "spender", type: "address" }
                    ],
                    name: "allowance",
                    outputs: [{ name: "", type: "uint256" }],
                    stateMutability: "view",
                    type: "function"
                }],
                functionName: 'allowance',
                args: [walletAddress, contractAddress]
            }) as bigint;

            const shortfallAmount = Math.abs(netProfit);
            const requiredAllowance = parseUnits(shortfallAmount.toString(), TOKEN_CONFIGS.USDC.decimals);

            const formattedAllowance = formatUnits(ownerAllowance, TOKEN_CONFIGS.USDC.decimals);
            console.log(`Wallet allowance to contract: ${formattedAllowance} USDC`);
            console.log(`Required allowance: ${shortfallAmount.toFixed(6)} USDC`);

            if (ownerAllowance < requiredAllowance) {
                console.log(`⚠️ WARNING: Wallet allowance is insufficient to cover the shortfall!`);
                console.log(`Run approveFlashLoan.js to set the necessary wallet-to-contract approvals.`);
                hasSufficientAllowance = false;
            } else {
                console.log(`✅ Wallet allowance is sufficient to cover the shortfall.`);
            }
        } catch (error) {
            console.error(`Error checking wallet allowance: ${getErrorMessage(error)}`);
            console.log(`WARNING: Could not verify wallet allowance. Make sure to run approveFlashLoan.js first.`);
            hasSufficientAllowance = false;
        }

        console.log(`Keeping original expected output: ${expectedOutput} USDC for test mode\n`);
    }

    return {
        expectedOutput,
        isNegativeProfit,
        hasSufficientAllowance
    };
}

/**
 * getArbitrageQuotes fetches the quotes for both swap legs
 * (USDC->WAVAX/WBTC and WAVAX/WBTC->USDC) based on the specified path.
 */
async function getArbitrageQuotes(
    amount: string,
    path: 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap'
): Promise<{
    firstLegQuote: SimulatedQuoteResult;
    secondLegQuote: SimulatedQuoteResult;
}> {
    // Determine which quoter functions to use based on the path
    const getFirstLegQuote = path === 'uniswap-to-traderjoe' ? getUniswapQuote : getTraderJoeQuote;
    const getSecondLegQuote = path === 'uniswap-to-traderjoe' ? getTraderJoeQuote : getUniswapQuote;

    // Determine the token pair for trade directions
    const targetToken = args.tokenPair.toUpperCase();
    const firstLegDirection = getTradeDirection(`USDC->${targetToken}`, args.tokenPair);
    const secondLegDirection = getTradeDirection(`${targetToken}->USDC`, args.tokenPair);

    console.log(`Getting first leg quote (${path === 'uniswap-to-traderjoe' ? 'Uniswap' : 'TraderJoe'}, ${firstLegDirection})...`);
    const firstLegQuote = await getFirstLegQuote(firstLegDirection as any, amount, contractAddress);
    if (!firstLegQuote) {
        throw new Error(`Failed to get first leg quote for ${path} (${firstLegDirection})`);
    }

    // Ensure we have a valid trade object (required by SimulatedQuoteResult type)
    const firstLegWithRequiredFields: SimulatedQuoteResult = {
        ...firstLegQuote,
        swapCalldata: validateCalldata(
            firstLegQuote.swapCalldata || '',
            path === 'uniswap-to-traderjoe' ? 'Uniswap' : 'TraderJoe',
            firstLegDirection
        ),
        // If trade is missing, create a minimal valid trade object
        trade: firstLegQuote.trade || (
            path === 'uniswap-to-traderjoe'
                ? createMinimalUniswapTrade('USDC', targetToken)
                : createMinimalTraderJoeTrade('USDC', targetToken)
        ),
        // Ensure routerAddress is present
        routerAddress: firstLegQuote.routerAddress || ('0x0000000000000000000000000000000000000000' as Address)
    };

    logger.info('First leg quote received', {
        dex: path === 'uniswap-to-traderjoe' ? 'Uniswap' : 'TraderJoe',
        direction: firstLegDirection,
        expectedOutput: firstLegWithRequiredFields.expectedOutput,
        priceImpact: firstLegWithRequiredFields.priceImpact,
        calldataLength: firstLegWithRequiredFields.swapCalldata ? firstLegWithRequiredFields.swapCalldata.length : 0
    });

    console.log(`Getting second leg quote (${path === 'uniswap-to-traderjoe' ? 'TraderJoe' : 'Uniswap'}, ${secondLegDirection})...`);
    const secondLegQuote = await getSecondLegQuote(secondLegDirection as any, firstLegWithRequiredFields.expectedOutput, contractAddress);
    if (!secondLegQuote) {
        throw new Error(`Failed to get second leg quote for ${path} (${secondLegDirection})`);
    }

    // Ensure we have a valid trade object (required by SimulatedQuoteResult type)
    const secondLegWithRequiredFields: SimulatedQuoteResult = {
        ...secondLegQuote,
        swapCalldata: validateCalldata(
            secondLegQuote.swapCalldata || '',
            path === 'uniswap-to-traderjoe' ? 'TraderJoe' : 'Uniswap',
            secondLegDirection
        ),
        // If trade is missing, create a minimal valid trade object
        trade: secondLegQuote.trade || (
            path === 'uniswap-to-traderjoe'
                ? createMinimalTraderJoeTrade(targetToken, 'USDC')
                : createMinimalUniswapTrade(targetToken, 'USDC')
        ),
        // Ensure routerAddress is present
        routerAddress: secondLegQuote.routerAddress || ('0x0000000000000000000000000000000000000000' as Address)
    };

    logger.info('Second leg quote received', {
        dex: path === 'uniswap-to-traderjoe' ? 'TraderJoe' : 'Uniswap',
        direction: secondLegDirection,
        expectedOutput: secondLegWithRequiredFields.expectedOutput,
        priceImpact: secondLegWithRequiredFields.priceImpact,
        calldataLength: secondLegWithRequiredFields.swapCalldata ? secondLegWithRequiredFields.swapCalldata.length : 0
    });

    const inputAmount = parseFloat(amount);
    const expectedOutput = parseFloat(secondLegWithRequiredFields.expectedOutput);
    const profit = expectedOutput - inputAmount;
    const profitPercent = (profit / inputAmount) * 100.0;
    const flashLoanFee = inputAmount * FLASH_LOAN_FEE_BPS/10000;
    const netProfit = profit - flashLoanFee;
    const netProfitPercent = (netProfit / inputAmount) * 100.0;

    logger.info('Flash loan arbitrage opportunity analysis', {
        path,
        tokenPair: `USDC-${targetToken}`,
        inputAmount: amount,
        expectedOutput: secondLegWithRequiredFields.expectedOutput,
        profit: profit.toFixed(6),
        profitPercent: `${profitPercent.toFixed(4)}%`,
        flashLoanFee: flashLoanFee.toFixed(6),
        feePercent: `${(FLASH_LOAN_FEE_BPS/100).toFixed(3)}%`,
        netProfit: netProfit.toFixed(6),
        netProfitPercent: `${netProfitPercent.toFixed(4)}%`
    });

    return {
        firstLegQuote: firstLegWithRequiredFields,
        secondLegQuote: secondLegWithRequiredFields
    };
}

async function executeTestFlashLoanArbitrage(): Promise<void> {
    try {
        // Get the target token configuration based on selected token pair
        const targetTokenConfig = getTargetTokenConfig();

        logger.info('Starting flash loan arbitrage test', {
            path: args.path,
            amount: args.amount,
            tokenPair: `USDC-${args.tokenPair.toUpperCase()}`,
            debugMode: args.debug,
            highGas: args.highGas,
            testMode: args.testMode,
            contract: contractAddress,
            flashLoanProvider: FLASH_LOAN_POOL
        });

        console.log(`
Flash Loan Arbitrage Test Configuration:
---------------------------------
Path: ${args.path}
Amount: ${args.amount} USDC
Token Pair: USDC-${args.tokenPair.toUpperCase()}
Debug Mode: ${args.debug ? 'enabled' : 'disabled'}
High Gas Mode: ${args.highGas ? 'enabled' : 'disabled'}
Test Mode: ${args.testMode ? 'enabled' : 'disabled'}
Contract: ${contractAddress}
Flash Loan Provider: ${FLASH_LOAN_POOL}
Flash Loan Fee: ${FLASH_LOAN_FEE_BPS/100}%
    `);

        // Validate path argument
        if (!['uniswap-to-traderjoe', 'traderjoe-to-uniswap'].includes(args.path)) {
            throw new Error('Invalid path. Must be "uniswap-to-traderjoe" or "traderjoe-to-uniswap"');
        }

        // Verify contract has correct pool configuration
        try {
            const flashLoanConfig = await publicClient.readContract({
                address: contractAddress,
                abi: [{
                    inputs: [],
                    name: "verifyFlashLoanConfiguration",
                    outputs: [
                        { name: "provider", type: "address" },
                        { name: "currentFeeBps", type: "uint256" }
                    ],
                    stateMutability: "view",
                    type: "function"
                }],
                functionName: 'verifyFlashLoanConfiguration'
            }) as [Address, bigint];

            if (flashLoanConfig && flashLoanConfig[0]) {
                console.log(`Contract flash loan configuration:`);
                console.log(`Provider: ${flashLoanConfig[0]}`);
                console.log(`Fee BPS: ${Number(flashLoanConfig[1])/100}%`);

                if (flashLoanConfig[0].toLowerCase() !== FLASH_LOAN_POOL.toLowerCase()) {
                    console.warn(`⚠️ WARNING: Contract flash loan provider (${flashLoanConfig[0]}) doesn't match expected pool (${FLASH_LOAN_POOL})`);
                }
            }
        } catch (error) {
            console.warn(`Could not verify flash loan configuration: ${getErrorMessage(error)}`);
        }

        // Retrieve current USDC balances
        const walletAddress = smartContractService.getWalletAddress();
        const usdcBalance = await publicClient.readContract({
            address: TOKEN_CONFIGS.USDC.address,
            abi: [{
                inputs: [{ name: "account", type: "address" }],
                name: "balanceOf",
                outputs: [{ name: "", type: "uint256" }],
                stateMutability: "view",
                type: "function"
            }],
            functionName: 'balanceOf',
            args: [walletAddress]
        }) as bigint;

        const contractUsdcBalance = await publicClient.readContract({
            address: TOKEN_CONFIGS.USDC.address,
            abi: [{
                inputs: [{ name: "account", type: "address" }],
                name: "balanceOf",
                outputs: [{ name: "", type: "uint256" }],
                stateMutability: "view",
                type: "function"
            }],
            functionName: 'balanceOf',
            args: [contractAddress]
        }) as bigint;

        // Also check owner wallet's allowance to the contract (needed for test mode to cover shortfalls)
        const ownerAllowance = await publicClient.readContract({
            address: TOKEN_CONFIGS.USDC.address,
            abi: [{
                inputs: [
                    { name: "owner", type: "address" },
                    { name: "spender", type: "address" }
                ],
                name: "allowance",
                outputs: [{ name: "", type: "uint256" }],
                stateMutability: "view",
                type: "function"
            }],
            functionName: 'allowance',
            args: [walletAddress, contractAddress]
        }) as bigint;

        console.log(`Wallet USDC balance:    ${formatUnits(usdcBalance, TOKEN_CONFIGS.USDC.decimals)} USDC`);
        console.log(`Contract USDC balance:  ${formatUnits(contractUsdcBalance, TOKEN_CONFIGS.USDC.decimals)} USDC`);
        console.log(`Wallet allowance:       ${formatUnits(ownerAllowance, TOKEN_CONFIGS.USDC.decimals)} USDC`);

        // Get quotes for both swap legs
        const { firstLegQuote, secondLegQuote } = await getArbitrageQuotes(
            args.amount,
            args.path as 'uniswap-to-traderjoe' | 'traderjoe-to-uniswap'
        );

        const startDex: DexType = args.path === 'uniswap-to-traderjoe' ? 'uniswap' : 'traderjoe';
        const endDex: DexType = args.path === 'uniswap-to-traderjoe' ? 'traderjoe' : 'uniswap';

        const firstRouter = firstLegQuote.routerAddress;
        const secondRouter = secondLegQuote.routerAddress;
        if (!firstRouter || !secondRouter) {
            throw new Error(`Missing router address. First: ${firstRouter}, Second: ${secondRouter}`);
        }

        // Adjust expected output for negative profit scenarios in test mode
        const firstLegExpectedOutput = firstLegQuote.expectedOutput;
        const {
            expectedOutput: secondLegExpectedOutput,
            isNegativeProfit,
            hasSufficientAllowance
        } = await handleNegativeProfitForTestMode(
            args.amount,
            secondLegQuote.expectedOutput,
            walletAddress,
            contractAddress
        );

        // If in test mode with negative profit but insufficient allowance, warn and exit
        if (args.testMode && isNegativeProfit && !hasSufficientAllowance) {
            console.error(`❌ Cannot proceed: Test mode with negative profit requires wallet allowance to cover shortfall.`);
            console.error(`Please run approveFlashLoan.js first to set the necessary approvals.`);
            process.exit(1);
        }

        // Safely parse expected outputs with proper handling of negative values
        let expectedFirstOutputBigInt = safeParseUnits(
            firstLegExpectedOutput,
            targetTokenConfig.decimals
        );

        let expectedSecondOutputBigInt = safeParseUnits(
            secondLegExpectedOutput,
            TOKEN_CONFIGS.USDC.decimals
        );

        // Build configuration object for the flash loan arbitrage call with proper typing
        const config: ArbitrageConfig = {
            startDex,
            endDex,
            inputAmount: args.amount,
            quoteTimestamp: Math.floor(Date.now() / 1000),
            testMode: args.testMode,
            simulatedTradeData: {
                firstLeg: firstLegQuote,
                secondLeg: secondLegQuote
            }
        };

        console.log(`\nExpected Outputs:`);
        console.log(`First leg (USDC->${args.tokenPair.toUpperCase()}): ${firstLegExpectedOutput} ${args.tokenPair.toUpperCase()}`);
        console.log(`Second leg (${args.tokenPair.toUpperCase()}->USDC): ${secondLegExpectedOutput} USDC`);

        // Calculate flash loan costs
        const inputAmountNum = parseFloat(args.amount);
        const flashLoanFee = (inputAmountNum * FLASH_LOAN_FEE_BPS) / 10000;
        const expectedOutput = parseFloat(secondLegExpectedOutput);
        const expectedProfit = expectedOutput - inputAmountNum;
        const netProfit = expectedProfit - flashLoanFee;

        console.log(`Flash loan fee: ${flashLoanFee.toFixed(6)} USDC (${FLASH_LOAN_FEE_BPS/100}% of ${args.amount} USDC)`);
        console.log(`Expected profit: ${expectedProfit.toFixed(6)} USDC`);
        console.log(`Net profit: ${netProfit.toFixed(6)} USDC`);

        // Log detailed parameters for debugging
        if (args.debug) {
            console.log("Flash Loan Parameters:", {
                sourceToken: TOKEN_CONFIGS.USDC.address,
                targetToken: targetTokenConfig.address,
                amount: parseUnits(args.amount, TOKEN_CONFIGS.USDC.decimals).toString(),
                firstRouter,
                secondRouter,
                testMode: args.testMode,
                expectedFirstOutput: expectedFirstOutputBigInt.toString(),
                expectedSecondOutput: expectedSecondOutputBigInt.toString(),
                firstOutputIsNegative: expectedFirstOutputBigInt < 0n,
                secondOutputIsNegative: expectedSecondOutputBigInt < 0n,
                tokenPair: `USDC-${args.tokenPair.toUpperCase()}`
            });

            console.log("First leg calldata:", firstLegQuote.swapCalldata);
            console.log("Second leg calldata:", secondLegQuote.swapCalldata);
        }

        // Warn if we're likely to need owner funds in test mode
        if (netProfit <= 0 && args.testMode) {
            console.log(`\n⚠️ WARNING: This trade is expected to be unprofitable after flash loan fees.`);
            console.log(`In test mode, the contract will attempt to borrow funds from the owner wallet to cover the shortfall.`);
            console.log(`Make sure your wallet has sufficient USDC and has approved the contract to spend it.\n`);

            // Check if the owner wallet has sufficient funds and allowance
            const requiredOwnerFunds = Math.abs(netProfit);
            const walletBalanceFloat = parseFloat(formatUnits(usdcBalance, TOKEN_CONFIGS.USDC.decimals));
            const walletAllowanceFloat = parseFloat(formatUnits(ownerAllowance, TOKEN_CONFIGS.USDC.decimals));

            if (walletBalanceFloat < requiredOwnerFunds) {
                console.warn(`⚠️ Your wallet has insufficient USDC balance to cover the expected shortfall of ${requiredOwnerFunds.toFixed(6)} USDC`);
            }

            if (walletAllowanceFloat < requiredOwnerFunds) {
                console.warn(`⚠️ Your wallet has insufficient allowance to the contract to cover the expected shortfall of ${requiredOwnerFunds.toFixed(6)} USDC`);
                console.warn(`Run approveFlashLoan.js to increase the allowance.`);
            }
        }

        console.log(`\n>>> Executing flash loan arbitrage in ${args.testMode ? 'test' : 'production'} mode (${startDex} -> ${endDex})...`);
        console.log(`Token pair: USDC-${args.tokenPair.toUpperCase()}\n`);

        // Execute the flash loan arbitrage with proper type safety
        const result = await flashLoanService.executeFlashLoanArbitrage({
            startDex: config.startDex,
            endDex: config.endDex,
            inputAmount: config.inputAmount,
            quoteTimestamp: config.quoteTimestamp,
            testMode: config.testMode,
            simulatedTradeData: {
                firstLeg: {
                    ...firstLegQuote,
                    expectedOutput: firstLegExpectedOutput
                },
                secondLeg: {
                    ...secondLegQuote,
                    expectedOutput: secondLegExpectedOutput
                }
            }
        });

        if (result.success) {
            const newContractUsdcBalance = await publicClient.readContract({
                address: TOKEN_CONFIGS.USDC.address,
                abi: [{
                    inputs: [{ name: "account", type: "address" }],
                    name: "balanceOf",
                    outputs: [{ name: "", type: "uint256" }],
                    stateMutability: "view",
                    type: "function"
                }],
                functionName: 'balanceOf',
                args: [contractAddress]
            }) as bigint;

            const balanceDiff = newContractUsdcBalance - contractUsdcBalance;
            const balanceDiffFormatted = formatUnits(balanceDiff, TOKEN_CONFIGS.USDC.decimals);

            logger.info('Flash loan arbitrage execution successful', {
                transactionHash: result.firstLegHash,
                profit: result.profit || "0",
                netProfit: result.netProfit || "0",
                flashLoanFee: result.flashLoanFee || "0",
                gasUsed: result.gasUsed || "0",
                effectiveGasPrice: result.effectiveGasPrice || "0",
                tokenPair: `USDC-${args.tokenPair.toUpperCase()}`
            });

            console.log('\n**** Flash Loan Arbitrage Execution Succeeded ****');
            console.log(`Transaction confirmed in block ${result.receipt?.blockNumber}`);
            console.log(`Gas used:            ${result.gasUsed}`);
            console.log(`Effective gas price: ${result.effectiveGasPrice}`);

            if (result.profit && result.flashLoanFee && result.netProfit) {
                console.log(`Gross profit (USDC):  ${result.profit}`);
                console.log(`Flash loan fee:       ${result.flashLoanFee}`);
                console.log(`Net profit (USDC):    ${result.netProfit}`);
            }

            console.log(`Contract balance change: ${balanceDiffFormatted} USDC`);

            // Display tokens traded information if available
            if (result.tokensTraded) {
                console.log('\nTokens Traded:');
                console.log('First Leg:');
                console.log(`  Input: ${result.tokensTraded.firstLeg.input.symbol} (${result.tokensTraded.firstLeg.input.address})`);
                console.log(`  Output: ${result.tokensTraded.firstLeg.output.symbol} (${result.tokensTraded.firstLeg.output.address})`);

                if (result.tokensTraded.secondLeg) {
                    console.log('Second Leg:');
                    console.log(`  Input: ${result.tokensTraded.secondLeg.input.symbol} (${result.tokensTraded.secondLeg.input.address})`);
                    console.log(`  Output: ${result.tokensTraded.secondLeg.output.symbol} (${result.tokensTraded.secondLeg.output.address})`);
                }
            }

            // Display swap checkpoint data if available
            if (result.swapCheckpoints && result.swapCheckpoints.length > 0) {
                console.log('\nSwap Checkpoints:');
                for (const checkpoint of result.swapCheckpoints) {
                    console.log(`- ${checkpoint.stage}:`);
                    console.log(`  Token: ${checkpoint.token}`);
                    console.log(`  Expected: ${checkpoint.expectedBalance}`);
                    console.log(`  Actual:   ${checkpoint.actualBalance}`);
                    console.log(`  Difference: ${checkpoint.difference}`);
                    const cpAny = checkpoint as any;
                    if (cpAny.accountTotalBalance) {
                        console.log(`  Account Total Balance: ${cpAny.accountTotalBalance}`);
                    }
                }
            }

            // Display validation checkpoints as execution flow
            if (result.validationCheckpoints && result.validationCheckpoints.length > 0) {
                console.log('\nExecution Flow:');
                for (const cp of result.validationCheckpoints) {
                    console.log(`- ${cp.stage}: ${cp.detail}`);
                }
            }

            // Display trade context details if available
            if (result.tradeContext) {
                const tc = result.tradeContext;
                console.log('\nTrade Context Details:');

                try {
                    console.log(`  Trade Input Amount:     ${formatUnits(tc.tradeInputAmount, TOKEN_CONFIGS.USDC.decimals)} USDC`);
                } catch (error) {
                    console.log(`  Trade Input Amount:     Error formatting: ${tc.tradeInputAmount.toString()}`);
                }

                // Handle potentially negative values safely
                try {
                    const tradeFinalBalanceFormatted = tc.tradeFinalBalance >= 0n
                        ? formatUnits(tc.tradeFinalBalance, TOKEN_CONFIGS.USDC.decimals)
                        : `-${formatUnits(-tc.tradeFinalBalance, TOKEN_CONFIGS.USDC.decimals)}`;
                    console.log(`  Trade Final Balance:    ${tradeFinalBalanceFormatted} USDC`);
                } catch (error) {
                    console.log(`  Trade Final Balance:    Error formatting: ${tc.tradeFinalBalance.toString()}`);
                }

                try {
                    const expectedFirstOutputFormatted = tc.expectedFirstOutput >= 0n
                        ? formatUnits(tc.expectedFirstOutput, targetTokenConfig.decimals)
                        : `-${formatUnits(-tc.expectedFirstOutput, targetTokenConfig.decimals)}`;
                    console.log(`  Expected First Output:  ${expectedFirstOutputFormatted} ${args.tokenPair.toUpperCase()}`);
                } catch (error) {
                    console.log(`  Expected First Output:  Error formatting: ${tc.expectedFirstOutput.toString()}`);
                }

                try {
                    console.log(`  Actual First Output:    ${formatUnits(tc.actualFirstOutput, targetTokenConfig.decimals)} ${args.tokenPair.toUpperCase()}`);
                } catch (error) {
                    console.log(`  Actual First Output:    Error formatting: ${tc.actualFirstOutput.toString()}`);
                }

                try {
                    const expectedSecondOutputFormatted = tc.expectedSecondOutput >= 0n
                        ? formatUnits(tc.expectedSecondOutput, TOKEN_CONFIGS.USDC.decimals)
                        : `-${formatUnits(-tc.expectedSecondOutput, TOKEN_CONFIGS.USDC.decimals)}`;
                    console.log(`  Expected Second Output: ${expectedSecondOutputFormatted} USDC`);
                } catch (error) {
                    console.log(`  Expected Second Output: Error formatting: ${tc.expectedSecondOutput.toString()}`);
                }

                try {
                    const actualSecondOutputFormatted = tc.actualSecondOutput >= 0n
                        ? formatUnits(tc.actualSecondOutput, TOKEN_CONFIGS.USDC.decimals)
                        : `-${formatUnits(-tc.actualSecondOutput, TOKEN_CONFIGS.USDC.decimals)}`;
                    console.log(`  Actual Second Output:   ${actualSecondOutputFormatted} USDC`);
                } catch (error) {
                    console.log(`  Actual Second Output:   Error formatting: ${tc.actualSecondOutput.toString()}`);
                }

                console.log(`  Trade Executed:         ${tc.executed ? 'Yes' : 'No'}`);
            }

            // Check if owner covered shortfall
            const shortfallCoveredEvent = result.validationCheckpoints?.find(
                cp => (cp.stage === 'FlashLoanRepayment' && cp.detail === 'Shortfall covered in test mode') ||
                    (cp.stage === 'OwnerCoverage' && cp.detail.includes('transferred')) ||
                    (cp.stage === 'TestModeNegativeProfit')
            );

            if (shortfallCoveredEvent) {
                console.log('\n**** IMPORTANT: Owner wallet covered shortfall in test mode ****');
                console.log('This means the trade was not profitable enough to cover the flash loan fee,');
                console.log('but the test completed successfully by using owner wallet funds.');
            }
        } else {
            logger.error('Flash loan arbitrage execution failed', {
                error: result.error,
                errorType: result.errorType,
                transactionHash: result.firstLegHash,
                tokenPair: `USDC-${args.tokenPair.toUpperCase()}`
            });
            console.error('\n**** Flash Loan Arbitrage Execution Failed ****');
            console.error(`Error: ${result.error}`);
            console.error(`ErrorType: ${result.errorType}`);

            if (result.validationCheckpoints && result.validationCheckpoints.length > 0) {
                console.log('\nValidation Checkpoints:');
                for (const checkpoint of result.validationCheckpoints) {
                    console.log(`- ${checkpoint.stage}: ${checkpoint.detail}`);
                }
            }

            // Suggest specific remedial actions based on error type
            if (result.errorType === 'FLASH_LOAN_CALLBACK_FAILED') {
                console.error('\nThe flash loan callback failed. This often means the arbitrage trade failed during execution.');
                console.error('Check the transaction trace for more details.');
            } else if (result.errorType === 'INSUFFICIENT_REPAYMENT_BALANCE') {
                console.error('\nThe contract did not have enough tokens to repay the flash loan.');
                if (args.testMode) {
                    console.error('In test mode, make sure your wallet has enough USDC and has approved the contract to spend it.');
                    console.error('Run approveFlashLoan.js to set the necessary approvals.');
                } else {
                    console.error('This suggests the arbitrage was not profitable enough to cover the flash loan fee.');
                }
            } else if (result.errorType === 'OWNER_WALLET_INSUFFICIENT_COVERAGE') {
                console.error('\nIn test mode, the owner wallet did not have enough USDC funds or allowance to cover the trade shortfall.');
                console.error('Please fund your wallet with USDC and run approveFlashLoan.js to approve the contract to spend it.');
            } else if (result.errorType === 'INVALID_FLASH_LOAN_PROVIDER') {
                console.error('\nThe contract is not configured with the correct flash loan provider address.');
                console.error('Run configureFlashLoan.js to set the correct provider address.');
            } else if (result.errorType === 'INVALID_FLASH_LOAN_AMOUNT') {
                console.error('\nThe flash loan amount is invalid. Amount must be greater than zero.');
            } else if (result.errorType === 'INSUFFICIENT_ALLOWANCE') {
                console.error('\nThe contract does not have sufficient allowance to spend tokens from the flash loan pool.');
                console.error('Run approveFlashLoan.js to set the necessary approvals.');
            } else if (result.errorType === 'FIRST_SWAP_FAILED' || result.errorType === 'SECOND_SWAP_FAILED') {
                console.error('\nOne of the DEX swaps failed during execution. This could be due to:');
                console.error('1. Insufficient liquidity');
                console.error('2. Price movement causing slippage > tolerance');
                console.error('3. Invalid router or pool addresses');
                console.error('4. Incorrect calldata formatting');
            } else if (result.errorType === 'TRANSACTION_REVERTED') {
                console.error('\nTransaction reverted. This could be due to arithmetic overflow/underflow in the contract.');
                console.error('Please check your expected output values and make sure they are properly formatted.');
                console.error('For test mode with negative expected profit, ensure approveFlashLoan.js has been run.');
            }
        }
    } catch (err) {
        const msg = getErrorMessage(err);
        logger.error('executeTestFlashLoanArbitrage encountered an error', { error: msg });
        console.error('Flash loan test error:', msg);
    }
}

async function main(): Promise<void> {
    try {
        await executeTestFlashLoanArbitrage();
        // Wait for logs to flush before exiting
        await sleep(5000);
        await logger.flush?.();
        process.exit(0);
    } catch (error) {
        logger.error('Fatal error in main', { error: getErrorMessage(error) });
        process.exit(1);
    }
}

void main();