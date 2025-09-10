// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// Custom Errors - Consolidated to reduce bytecode
    error InvalidSetup(uint8 code);
    error TradeErrors(uint8 code, string reason);
    error FlashLoanErrors(uint8 code);
    error InvalidTokens();                   // Replaces TradeErrors(1, "")
    error ZeroAmount();                      // Replaces FlashLoanErrors(1)
    error InvalidVaultAddress();             // Replaces InvalidSetup(1)
    error DisabledToken();                   // Replaces TradeErrors(2, "")
    error UnauthorizedCaller();              // Replaces FlashLoanErrors(2)
    error InvalidExecutionId();              // Replaces TradeErrors(3, "")
    error FirstSwapFailed(string reason);    // Replaces TradeErrors(4, reason)
    error NoIntermediateTokens();            // Replaces TradeErrors(5, "")
    error SecondSwapFailed(string reason);   // Replaces TradeErrors(6, reason)
    error InsufficientProfit();              // Replaces TradeErrors(7, "")
    error InsufficientRepayment();           // Replaces FlashLoanErrors(4)
    error TestModeShortfall();               // Replaces FlashLoanErrors(5)
    error NegativeValueConversion();         // New error for int256 to uint256 conversion
    error SafeCastFailure();                 // New error for SafeCast failures

// Balancer V2 Interfaces - Simplified to avoid import conflicts
interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/**
 * @title CrossDexArbitrageWithBalancerV2
 * @notice Executes arbitrage between DEXes using Balancer V2 flash loans
 * @dev Implements IFlashLoanRecipient for Balancer V2 flash loans
 */
contract CrossDexArbitrageWithFlashLoan is Ownable, ReentrancyGuard, Pausable, IFlashLoanRecipient {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    // Constants - using immutable where possible to save gas
    uint256 private constant MAX_BPS = 10000; // 100%
    uint256 private constant MAX_GAS_FOR_CALL = 3000000;
    // Define max and min int256 values for checks
    int256 private constant MAX_INT256 = type(int256).max;
    int256 private constant MIN_INT256 = type(int256).min;

    // Main contract addresses
    IVault public immutable balancerVault;
    address public uniswapRouterAddress;
    address public traderJoeRouterAddress;

    // DEX-specific configuration
    struct DexConfig {
        address router;
        bool isEnabled;
        uint256 defaultFee; // Fee in basis points
        uint256 maxGasUsage; // Maximum gas allowed for this DEX
        mapping(address => bool) supportedPools;
        mapping(uint256 => bool) supportedFees;
    }

    // Parameters for arbitrage execution
    struct ArbitrageParams {
        address sourceToken;
        address targetToken;
        uint256 amount;
        bytes firstSwapData;
        bytes secondSwapData;
        address firstRouter;
        address secondRouter;
        bool testMode;
        int256 expectedFirstOutput;  // Keep as int256 for potential negative values
        int256 expectedSecondOutput; // Keep as int256 for potential negative values
        bytes32 executionId;
    }

    // Pool configuration
    struct PoolConfig {
        bool isEnabled;
        uint256 fee; // Fee in basis points
        uint256 minLiquidity; // Minimum liquidity requirement
        address dexRouter; // Associated DEX router
    }

    // Token configuration
    struct TokenConfig {
        bool isEnabled;
        uint256 maxAmount;
        uint256 minAmount;
        uint8 decimals;
    }

    // Trade execution context - to isolate trade-specific balances
    struct TradeContext {
        uint256 sourceTokenStartBalance;
        uint256 targetTokenStartBalance;
        uint256 tradeInputAmount;
        uint256 intermediateTokenAmount;
        int256 tradeFinalBalance;  // Can be negative in test mode
        int256 expectedFirstLegOutput; // Keep as int256
        uint256 actualFirstLegOutput;  // Changed to uint256 as actual values can't be negative
        int256 expectedSecondOutput; // Keep as int256
        int256 actualSecondOutput;  // Can be negative in test mode
        bool executed;
    }

    // Flash loan context for handling callbacks
    struct FlashLoanContext {
        address sourceToken;
        address targetToken;
        uint256 amount; // Changed to uint256 to match external interaction
        bytes firstSwapData;
        bytes secondSwapData;
        address firstRouter;
        address secondRouter;
        bool testMode;
        int256 expectedFirstOutput;  // Keep as int256
        int256 expectedSecondOutput; // Keep as int256
        bytes32 executionId;
    }

    // State variables - mapped by execution ID for improved gas efficiency
    mapping(string => DexConfig) private dexConfigs;
    mapping(address => PoolConfig) private poolConfigs;
    mapping(address => TokenConfig) private tokenConfigs;
    mapping(bytes32 => bool) public executedTrades;
    mapping(bytes32 => TradeContext) private tradeContexts;
    mapping(bytes32 => FlashLoanContext) private flashLoanContexts;

    // Metrics tracking - consolidated to reduce redundant state variables
    struct Metrics {
        uint256 totalExecutions;
        uint256 successfulExecutions;
        uint256 failedExecutions;
        uint256 totalProfit; // Changed to uint256 to only track positive profit
        uint256 flashLoanExecutions;
        uint256 flashLoanSuccessful;
        uint256 flashLoanFailed;
        uint256 flashLoanProfit; // Changed to uint256 to only track positive profit
    }
    Metrics public metrics;

    // Events - Optimized and consolidated to reduce bytecode
    event DexConfigured(string indexed dexName, address router, uint256 defaultFee, uint256 maxGasUsage);
    event PoolConfigured(address indexed pool, uint256 fee, uint256 minLiquidity, address dexRouter);
    event TokenConfigured(address indexed token, uint256 maxAmount, uint256 minAmount, uint8 decimals);
    event ApprovalUpdated(address indexed token, address indexed spender, uint256 newAmount);

    event ArbitrageExecuted(
        address indexed sourceToken,
        address indexed targetToken,
        uint256 tradeInputAmount,           // Amount used for this specific trade
        uint256 finalAccountBalance,        // Total account balance after trade
        int256 tradeFinalBalance,           // Final balance for this specific trade (can be negative)
        int256 tradeProfit,                 // Profit for this specific trade (can be negative)
        int256 expectedProfit,              // Expected profit based on quotes (can be negative)
        bool testMode
    );

    // Consolidated events for logging with reduced storage
    event StateLog(bytes32 indexed executionId, string stage, string data);
    event SwapEvent(
        bytes32 indexed executionId,
        uint8 eventType,  // 1=initiated, 2=completed, 3=checkpoint
        string stage,
        address token,
        uint256 actualBalance, // Changed to uint256 for consistency with token balances
        uint256 expectedBalance // Changed to uint256 for consistency
    );
    event FlashLoanEvent(
        bytes32 indexed executionId,
        uint8 eventType,    // 1=initiated, 2=completed, 3=failed
        address token,
        uint256 amount,     // Changed to uint256 for consistency with token amounts
        int256 feeOrProfit  // Keep as int256 to handle negative profit in test mode
    );

    /**
     * @notice Contract constructor
     * @param _balancerVaultAddress The address of the Balancer V2 Vault contract
     */
    constructor(address _balancerVaultAddress) {
        if (_balancerVaultAddress == address(0)) revert InvalidVaultAddress();
        balancerVault = IVault(_balancerVaultAddress);
    }

    /**
     * @notice Safely convert int256 to uint256, reverting on negative values
     * @param value The int256 value to convert
     * @return The uint256 value
     */
    function safeToUint256(int256 value) internal pure returns (uint256) {
        if (value < 0) revert NegativeValueConversion();
        return uint256(value);
    }

    /**
     * @notice Safely convert uint256 to int256, with overflow check
     * @param value The uint256 value to convert
     * @return The int256 value
     */
    function safeToInt256(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) {
            return MAX_INT256;
        }
        return int256(value);
    }

    /**
     * @notice Configure DEX settings
     */
    function configureDex(
        string memory dexName,
        address router,
        uint256 defaultFee,
        uint256 maxGasUsage,
        uint256[] memory supportedFeeTiers
    ) external onlyOwner {
        if (router == address(0) || bytes(dexName).length == 0) revert InvalidSetup(2);

        DexConfig storage config = dexConfigs[dexName];
        config.router = router;
        config.isEnabled = true;
        config.defaultFee = defaultFee;
        config.maxGasUsage = maxGasUsage;

        // Store router addresses for reference in error messages
        if (_compareStrings(dexName, "uniswap")) {
            uniswapRouterAddress = router;
        } else if (_compareStrings(dexName, "traderjoe")) {
            traderJoeRouterAddress = router;
        }

        unchecked {
            for (uint256 i = 0; i < supportedFeeTiers.length; i++) {
                if (supportedFeeTiers[i] >= MAX_BPS) revert InvalidSetup(3);
                config.supportedFees[supportedFeeTiers[i]] = true;
            }
        }

        emit DexConfigured(dexName, router, defaultFee, maxGasUsage);
    }

    /**
     * @notice Configure pool settings
     */
    function configurePool(
        address pool,
        uint256 fee,
        uint256 minLiquidity,
        string memory dexName
    ) external onlyOwner {
        if (pool == address(0)) revert InvalidSetup(4);
        if (!dexConfigs[dexName].isEnabled) revert InvalidSetup(5);
        if (fee >= MAX_BPS) revert InvalidSetup(3);
        if (dexConfigs[dexName].router == address(0)) revert InvalidSetup(6);

        poolConfigs[pool] = PoolConfig({
            isEnabled: true,
            fee: fee,
            minLiquidity: minLiquidity,
            dexRouter: dexConfigs[dexName].router
        });

        dexConfigs[dexName].supportedPools[pool] = true;
        emit PoolConfigured(pool, fee, minLiquidity, dexConfigs[dexName].router);
    }

    /**
     * @notice Configure token settings
     */
    function configureToken(
        address token,
        uint256 maxAmount,
        uint256 minAmount,
        uint8 decimals
    ) external onlyOwner {
        if (token == address(0)) revert InvalidSetup(7);
        if (maxAmount <= minAmount) revert InvalidSetup(8);
        if (decimals > 18) revert InvalidSetup(9);

        tokenConfigs[token] = TokenConfig({
            isEnabled: true,
            maxAmount: maxAmount,
            minAmount: minAmount,
            decimals: decimals
        });

        emit TokenConfigured(token, maxAmount, minAmount, decimals);
    }

    /**
     * @notice Execute flash loan arbitrage between DEXes using Balancer V2
     * @param sourceToken The token to borrow via flash loan
     * @param targetToken The token to swap to and back
     * @param amount Amount of sourceToken to borrow
     * @param firstSwapData Encoded swap data for first DEX
     * @param secondSwapData Encoded swap data for second DEX
     * @param firstRouter Address of first DEX router
     * @param secondRouter Address of second DEX router
     * @param testMode Whether to execute in test mode (allows negative profit)
     * @param expectedFirstOutput Expected output from first swap
     * @param expectedSecondOutput Expected output from second swap
     * @return Profit amount or actual second leg output in test mode
     */
    function executeFlashLoanArbitrage(
        address sourceToken,
        address targetToken,
        uint256 amount,
        bytes calldata firstSwapData,
        bytes calldata secondSwapData,
        address firstRouter,
        address secondRouter,
        bool testMode,
        int256 expectedFirstOutput,
        int256 expectedSecondOutput
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Validations
        if (sourceToken == targetToken) revert InvalidTokens();
        if (amount == 0) revert ZeroAmount();
        if (address(balancerVault) == address(0)) revert InvalidVaultAddress();
        if (!tokenConfigs[sourceToken].isEnabled) revert DisabledToken();

        // Log expected values for diagnostics
        emit StateLog(
            bytes32(0),
            "ExpectedValues",
            string(abi.encodePacked(
                "First: ", int2str(expectedFirstOutput),
                ", Second: ", int2str(expectedSecondOutput),
                ", TestMode: ", testMode ? "true" : "false"
            ))
        );

        // Create execution ID
        bytes32 executionId = keccak256(
            abi.encodePacked(
                sourceToken,
                targetToken,
                amount,
                firstRouter,
                secondRouter,
                block.timestamp,
                block.number,
                msg.sender,
                "flashloan"
            )
        );

        // Store context for callback
        flashLoanContexts[executionId] = FlashLoanContext({
            sourceToken: sourceToken,
            targetToken: targetToken,
            amount: amount,
            firstSwapData: firstSwapData,
            secondSwapData: secondSwapData,
            firstRouter: firstRouter,
            secondRouter: secondRouter,
            testMode: testMode,
            expectedFirstOutput: expectedFirstOutput,
            expectedSecondOutput: expectedSecondOutput,
            executionId: executionId
        });

        // Log when flash loan starts
        emit FlashLoanEvent(
            executionId,
            1,  // initiated
            sourceToken,
            amount,
            0    // No fee for Balancer flash loans
        );

        // Track pre-call token balance for verification
        uint256 preCallBalance = IERC20(sourceToken).balanceOf(address(this));

        // Pack the execution ID as userData for the callback
        bytes memory userData = abi.encode(executionId);

        // Set up token array and amount array for the flash loan
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(sourceToken);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        // Execute the flash loan with Balancer V2
        try balancerVault.flashLoan(
            this,
            tokens,
            amounts,
            userData
        ) {
            // Successfully completed flash loan
            metrics.flashLoanExecutions++;
            metrics.flashLoanSuccessful++;

            uint256 finalBalance = IERC20(sourceToken).balanceOf(address(this));

            // Log balance change
            emit StateLog(
                executionId,
                "BalanceChange",
                string(abi.encodePacked(
                    "Pre: ", uint2str(preCallBalance),
                    ", Post: ", uint2str(finalBalance)
                ))
            );

            // Log completion of flash loan
            emit StateLog(executionId, "FlashLoanComplete", "Success");

            return finalBalance;
        } catch Error(string memory reason) {
            // Standard error with reason
            emit StateLog(executionId, "FlashLoanError", reason);
            metrics.flashLoanFailed++;
            metrics.flashLoanExecutions++;

            // Clean up flash loan context on error
            delete flashLoanContexts[executionId];

            // Return current balance even on error
            return IERC20(sourceToken).balanceOf(address(this));
        } catch Panic(uint errorCode) {
            // Handle Solidity's built-in panic errors
            string memory panicReason;
            if (errorCode == 0x01) panicReason = "Assertion failed";
            else if (errorCode == 0x11) panicReason = "Arithmetic operation underflow or overflow";
            else if (errorCode == 0x12) panicReason = "Division or modulo by zero";
            else if (errorCode == 0x21) panicReason = "Invalid enum value";
            else if (errorCode == 0x22) panicReason = "Storage byte array is incorrectly encoded";
            else if (errorCode == 0x31) panicReason = "calldata is too short";
            else if (errorCode == 0x32) panicReason = "Return data too short";
            else if (errorCode == 0x41) panicReason = "Invalid array length";
            else if (errorCode == 0x51) panicReason = "Invalid memory array access";
            else panicReason = string(abi.encodePacked("Unknown panic code: ", uint2str(errorCode)));

            emit StateLog(executionId, "FlashLoanPanic", panicReason);
            metrics.flashLoanFailed++;
            metrics.flashLoanExecutions++;

            // Clean up flash loan context on error
            delete flashLoanContexts[executionId];

            // Return current balance even on error
            return IERC20(sourceToken).balanceOf(address(this));
        } catch (bytes memory errorData) {
            // Handle low-level errors
            string memory errorMsg = "Unknown error";
            if (errorData.length > 0) {
                // Try to extract error signature
                bytes4 errorSig;
                assembly {
                    errorSig := mload(add(errorData, 32))
                }
                errorMsg = string(abi.encodePacked("Error sig: ", bytes4ToString(errorSig)));
            }

            emit StateLog(executionId, "FlashLoanLowLevelError", errorMsg);
            metrics.flashLoanFailed++;
            metrics.flashLoanExecutions++;

            // Clean up flash loan context on error
            delete flashLoanContexts[executionId];

            // Return current balance even on error
            return IERC20(sourceToken).balanceOf(address(this));
        }
    }

    /**
     * @notice Balancer V2 flash loan callback function
     * @dev Called by the Balancer Vault during flash loan
     * @param amounts Array of amounts that were borrowed
     * @param feeAmounts Array of fee amounts to be paid
     * @param userData User data passed to the flash loan function (contains executionId)
     */
    function receiveFlashLoan(
        IERC20[] memory,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Verify caller is the Balancer Vault
        if (msg.sender != address(balancerVault)) revert UnauthorizedCaller();

        // Decode executionId from userData
        bytes32 executionId = abi.decode(userData, (bytes32));

        // Retrieve the context
        FlashLoanContext memory context = flashLoanContexts[executionId];
        if (context.executionId != executionId) {
            emit StateLog(executionId, "ContextRetrieval", "Invalid");
            revert InvalidExecutionId();
        }

        // Log callback start
        emit StateLog(
            executionId,
            "FlashLoanCallback",
            string(abi.encodePacked(
                "Starting callback, token: ", addressToString(context.sourceToken),
                ", amount: ", uint2str(context.amount)
            ))
        );

        // Execute the arbitrage
        bool arbitrageSuccess = false;
        int256 profit = 0;

        try this.executeArbitrageWrapper(ArbitrageParams({
            sourceToken: context.sourceToken,
            targetToken: context.targetToken,
            amount: context.amount,
            firstSwapData: context.firstSwapData,
            secondSwapData: context.secondSwapData,
            firstRouter: context.firstRouter,
            secondRouter: context.secondRouter,
            testMode: context.testMode,
            expectedFirstOutput: context.expectedFirstOutput,
            expectedSecondOutput: context.expectedSecondOutput,
            executionId: executionId
        })) returns (int256 result) {
            profit = result;
            arbitrageSuccess = true;
            emit StateLog(executionId, "ArbitrageExecution", "Success");
        } catch Error(string memory reason) {
            // Log the exact error
            emit StateLog(executionId, "ArbitrageExecutionError", reason);
            // Update trade context to record the failure
            TradeContext storage tradeContext = tradeContexts[executionId];
            tradeContext.executed = false;
        } catch Panic(uint errorCode) {
            // Add this to catch arithmetic errors (0x11 is arithmetic error code)
            string memory errorType = errorCode == 0x11 ? "Arithmetic operation" :
                errorCode == 0x01 ? "Assert failed" :
                    errorCode == 0x12 ? "Division by zero" : "Other panic";
            emit StateLog(executionId, "ArithmeticError", errorType);
            TradeContext storage tradeContext = tradeContexts[executionId];
            tradeContext.executed = false;
        } catch (bytes memory errorData) {
            // Catch any other error and try to extract useful information
            string memory errorMsg = "Unknown error";
            if (errorData.length > 0) {
                // Try to extract error signature
                bytes4 errorSig;
                assembly {
                    errorSig := mload(add(errorData, 32))
                }
                errorMsg = string(abi.encodePacked("Error sig: ", bytes4ToString(errorSig)));
            }
            emit StateLog(executionId, "ArbitrageExecution", string(abi.encodePacked("Failed with error: ", errorMsg)));
            // Update trade context
            TradeContext storage tradeContext = tradeContexts[executionId];
            tradeContext.executed = false;
        }

        // Record flash loan metrics
        if (arbitrageSuccess) {
            // Safe conversion: only add to metrics if profit is positive
            if (profit > 0) {
                // Only add positive profits to metrics
                metrics.flashLoanProfit += uint256(profit);
            } else {
                emit StateLog(executionId, "MetricsWarning", "Profit not added to metrics (negative)");
            }
        }

        // Calculate the total repayment amount (principal + fees)
        uint256 repayAmount = amounts[0] + feeAmounts[0];

        // Ensure we have enough to repay
        uint256 currentBalance = IERC20(context.sourceToken).balanceOf(address(this));

        emit StateLog(
            executionId,
            "RepaymentInfo",
            string(abi.encodePacked(
                "Principal: ", uint2str(amounts[0]),
                ", Fee: ", uint2str(feeAmounts[0]),
                ", Total: ", uint2str(repayAmount),
                ", Balance: ", uint2str(currentBalance)
            ))
        );

        if (currentBalance < repayAmount) {
            if (context.testMode) {
                // In test mode, try to cover shortfall from owner's funds
                try IERC20(context.sourceToken).transferFrom(owner(), address(this), repayAmount - currentBalance) {
                    emit StateLog(executionId, "TestModeShortfall", "Covered by owner");
                } catch {
                    emit StateLog(executionId, "TestModeShortfall", "Failed to cover");
                    revert TestModeShortfall();
                }
            } else {
                emit StateLog(executionId, "InsufficientBalance", "Cannot repay flash loan");
                revert InsufficientRepayment();
            }
        }

        // Repay the flash loan
        IERC20(context.sourceToken).transfer(address(balancerVault), repayAmount);

        // Emit event with results before cleanup
        emit FlashLoanEvent(
            executionId,
            2,  // completed
            context.sourceToken,
            context.amount,
            profit  // Can be negative in test mode
        );

        // Clean up flash loan context
        delete flashLoanContexts[executionId];
    }

    /**
     * @notice Helper function to convert bytes4 to string for error logging
     */
    function bytes4ToString(bytes4 _bytes) internal pure returns (string memory) {
        bytes memory bytesArray = new bytes(10);

        bytesArray[0] = '0';
        bytesArray[1] = 'x';

        for (uint256 i = 0; i < 4; i++) {
            uint8 byteValue = uint8(_bytes[i]);
            bytesArray[2 + i*2] = toHexChar(byteValue / 16);
            bytesArray[3 + i*2] = toHexChar(byteValue % 16);
        }

        return string(bytesArray);
    }

    /**
     * @notice Helper function to convert a nibble to hex character
     */
    function toHexChar(uint8 nibble) internal pure returns (bytes1) {
        if (nibble < 10) {
            return bytes1(uint8(bytes1('0')) + nibble);
        } else {
            return bytes1(uint8(bytes1('a')) + nibble - 10);
        }
    }

    /**
     * @notice Internal function to execute arbitrage logic
     * @param params Parameters for the arbitrage trade
     * @return tradeProfit The trade profit (can be negative in test mode)
     */
    function executeArbitrageInternal(ArbitrageParams memory params) internal returns (int256) {
        if (executedTrades[params.executionId]) {
            revert InvalidExecutionId();
        }
        executedTrades[params.executionId] = true;

        // Initialize trade context
        TradeContext storage tradeContext = tradeContexts[params.executionId];
        tradeContext.executed = false; // Will be set to true at the end if successful

        // 1) Record initial account-wide balances
        uint256 initialAccountBalance = IERC20(params.sourceToken).balanceOf(address(this));
        uint256 initialTargetBalance = IERC20(params.targetToken).balanceOf(address(this));

        // Store in trade context
        tradeContext.sourceTokenStartBalance = initialAccountBalance;
        tradeContext.targetTokenStartBalance = initialTargetBalance;
        tradeContext.tradeInputAmount = params.amount;

        // Store expected outputs - using direct assignment for int256 values
        tradeContext.expectedFirstLegOutput = params.expectedFirstOutput;
        tradeContext.expectedSecondOutput = params.expectedSecondOutput;

        // Log the input context for better error analysis
        emit StateLog(
            params.executionId,
            "InputContext",
            string(abi.encodePacked(
                "Amount: ", uint2str(params.amount),
                ", Expected1: ", int2str(params.expectedFirstOutput),
                ", Expected2: ", int2str(params.expectedSecondOutput),
                ", TestMode: ", params.testMode ? "true" : "false"
            ))
        );

        // Record checkpoint before first swap
        emit SwapEvent(
            params.executionId,
            3,  // checkpoint
            "BeforeFirstSwap",
            params.sourceToken,
            params.amount,
            params.amount
        );

        // 2) Approve first router if needed
        uint256 currentAllowanceFirst = IERC20(params.sourceToken)
            .allowance(address(this), params.firstRouter);

        if (currentAllowanceFirst < params.amount) {
            _safeApprove(params.sourceToken, params.firstRouter, type(uint256).max);
            emit StateLog(params.executionId, "FirstRouterApproval", "Updated");
        }

        // Safely convert expected first output for the event
        uint256 expectedFirstOutputForEvent;
        if (params.expectedFirstOutput > 0) {
            expectedFirstOutputForEvent = uint256(params.expectedFirstOutput);
        } else {
            expectedFirstOutputForEvent = 0;
            emit StateLog(
                params.executionId,
                "NegativeExpectedOutput",
                string(abi.encodePacked("First: ", int2str(params.expectedFirstOutput)))
            );
        }

        // Emit event before first swap
        emit SwapEvent(
            params.executionId,
            1,  // initiated
            "first",
            params.firstRouter,
            params.amount,
            expectedFirstOutputForEvent
        );

        // 3) First swap
        (bool success1, bytes memory result1) = params.firstRouter.call{ gas: MAX_GAS_FOR_CALL }(params.firstSwapData);
        if (!success1) {
            // Extract error message if possible
            string memory errorMsg = "Failed First Swap";
            if (result1.length > 4) {
                errorMsg = string(result1);
            }
            emit StateLog(params.executionId, "FirstSwapError", errorMsg);
            revert FirstSwapFailed(errorMsg);
        }

        // Record successful first swap
        emit StateLog(params.executionId, "FirstSwap", "Success");

        // 4) Check how many targetTokens we got
        uint256 currentTargetBalance = IERC20(params.targetToken).balanceOf(address(this));
        emit StateLog(
            params.executionId,
            "FirstSwapBalances",
            string(abi.encodePacked(
                "Initial: ", uint2str(initialTargetBalance),
                ", Current: ", uint2str(currentTargetBalance)
            ))
        );

        // Calculate received tokens safely
        uint256 targetTokenReceived;
        if (currentTargetBalance > initialTargetBalance) {
            targetTokenReceived = currentTargetBalance - initialTargetBalance;
        } else {
            emit StateLog(params.executionId, "BalanceCheck", "Zero or negative balance change");
            // We can proceed with zero, but this trade is likely to fail later
            targetTokenReceived = 0;
        }

        // Store in trade context
        tradeContext.intermediateTokenAmount = targetTokenReceived;
        tradeContext.actualFirstLegOutput = targetTokenReceived;

        // Record checkpoint after first swap
        emit SwapEvent(
            params.executionId,
            3,  // checkpoint
            "AfterFirstSwap",
            params.targetToken,
            targetTokenReceived,
            expectedFirstOutputForEvent
        );

        if (targetTokenReceived == 0) {
            emit StateLog(params.executionId, "IntermediateTokenReceived", "None");
            revert NoIntermediateTokens();
        }

        // 5) Approve second router for the entire intermediateBalance
        uint256 currentAllowanceSecond = IERC20(params.targetToken).allowance(address(this), params.secondRouter);
        if (currentAllowanceSecond < targetTokenReceived) {
            _safeApprove(params.targetToken, params.secondRouter, type(uint256).max);
            emit StateLog(params.executionId, "SecondRouterApproval", "Updated");
        }

        // Safely convert expected second output for the event
        uint256 expectedSecondOutputForEvent;
        if (params.expectedSecondOutput > 0) {
            expectedSecondOutputForEvent = uint256(params.expectedSecondOutput);
        } else {
            expectedSecondOutputForEvent = 0;
            emit StateLog(
                params.executionId,
                "NegativeExpectedOutput",
                string(abi.encodePacked("Second: ", int2str(params.expectedSecondOutput)))
            );
        }

        // Emit event before second swap
        emit SwapEvent(
            params.executionId,
            1,  // initiated
            "second",
            params.secondRouter,
            targetTokenReceived,
            expectedSecondOutputForEvent
        );

        // 6) Second swap
        (bool success2, bytes memory result2) = params.secondRouter.call{ gas: MAX_GAS_FOR_CALL }(params.secondSwapData);
        if (!success2) {
            // Extract error message if possible
            string memory errorMsg = "Failed Second Swap";
            if (result2.length > 4) {
                errorMsg = string(result2);
            }
            emit StateLog(params.executionId, "SecondSwapError", errorMsg);
            revert SecondSwapFailed(errorMsg);
        }

        // Record successful second swap
        emit StateLog(params.executionId, "SecondSwap", "Success");

        // 7) Determine final balances and calculate profit with safe arithmetic
        uint256 finalAccountBalance = IERC20(params.sourceToken).balanceOf(address(this));

        // Log calculation parameters with detail
        emit StateLog(
            params.executionId,
            "BalanceParams",
            string(abi.encodePacked(
                "Initial: ", uint2str(initialAccountBalance),
                ", Final: ", uint2str(finalAccountBalance),
                ", Input: ", uint2str(params.amount)
            ))
        );

        // Calculate trade profit and final balance
        int256 tradeProfit; // This can be negative in test mode
        int256 tradeFinalBalance; // This can be negative in test mode

        // Safe conversion of input amount to int256
        int256 inputAmountInt = safeToInt256(params.amount);

        // Calculate profit with safe arithmetic
        if (finalAccountBalance >= initialAccountBalance) {
            // Positive profit case
            uint256 rawProfit = finalAccountBalance - initialAccountBalance;

            // Safe conversion to int256
            if (rawProfit > uint256(type(int256).max)) {
                emit StateLog(params.executionId, "ProfitOverflow", "Profit too large for int256");
                tradeProfit = MAX_INT256;
            } else {
                tradeProfit = int256(rawProfit);
                emit StateLog(params.executionId, "ProfitCalculation", string(abi.encodePacked("+", uint2str(rawProfit))));
            }
        } else {
            // Negative profit case (loss)
            uint256 rawLoss = initialAccountBalance - finalAccountBalance;

            // Safe conversion for negative value
            if (rawLoss > uint256(type(int256).max)) {
                emit StateLog(params.executionId, "LossOverflow", "Loss too large for int256");
                tradeProfit = MIN_INT256;
            } else {
                tradeProfit = -int256(rawLoss);
                emit StateLog(params.executionId, "ProfitCalculation", string(abi.encodePacked("-", uint2str(rawLoss))));
            }
        }

        // Safe addition for calculating tradeFinalBalance
        if (tradeProfit >= 0) {
            // Check for addition overflow
            if (MAX_INT256 - tradeProfit < inputAmountInt) {
                tradeFinalBalance = MAX_INT256;
                emit StateLog(params.executionId, "FinalBalanceOverflow", "Positive overflow");
            } else {
                tradeFinalBalance = inputAmountInt + tradeProfit;
            }
        } else {
            // Check for addition underflow (with negative profit)
            if (MIN_INT256 - tradeProfit > inputAmountInt) {
                tradeFinalBalance = MIN_INT256;
                emit StateLog(params.executionId, "FinalBalanceUnderflow", "Negative overflow");
            } else {
                tradeFinalBalance = inputAmountInt + tradeProfit;
            }
        }

        // Store calculated values in trade context
        tradeContext.tradeFinalBalance = tradeFinalBalance;
        tradeContext.actualSecondOutput = tradeProfit;
        tradeContext.executed = true;

        // Calculate expected profit (can be negative in test mode)
        int256 expectedProfit;

        // Safe arithmetic for expected profit calculation
        if (params.expectedSecondOutput >= 0 && inputAmountInt >= 0) {
            // Both positive
            if (MAX_INT256 - params.expectedSecondOutput < -inputAmountInt) {
                // Will overflow
                expectedProfit = MAX_INT256;
                emit StateLog(params.executionId, "ExpectedProfitCalculationError", "Positive overflow");
            } else {
                expectedProfit = params.expectedSecondOutput - inputAmountInt;
            }
        } else if (params.expectedSecondOutput < 0 && inputAmountInt < 0) {
            // Both negative
            if (MIN_INT256 - params.expectedSecondOutput > -inputAmountInt) {
                // Will underflow
                expectedProfit = MIN_INT256;
                emit StateLog(params.executionId, "ExpectedProfitCalculationError", "Negative overflow");
            } else {
                expectedProfit = params.expectedSecondOutput - inputAmountInt;
            }
        } else {
            // Mixed signs
            if (params.expectedSecondOutput >= 0 && inputAmountInt < 0) {
                // Expected positive, input negative
                if (MAX_INT256 - params.expectedSecondOutput < -inputAmountInt) {
                    // Will overflow
                    expectedProfit = MAX_INT256;
                    emit StateLog(params.executionId, "ExpectedProfitCalculationError", "Mixed sign overflow");
                } else {
                    expectedProfit = params.expectedSecondOutput - inputAmountInt;
                }
            } else {
                // Expected negative, input positive
                if (MIN_INT256 - params.expectedSecondOutput > -inputAmountInt) {
                    // Will underflow
                    expectedProfit = MIN_INT256;
                    emit StateLog(params.executionId, "ExpectedProfitCalculationError", "Mixed sign underflow");
                } else {
                    expectedProfit = params.expectedSecondOutput - inputAmountInt;
                }
            }
        }

        // Record checkpoint after second swap - safely handle potentially negative trade balance
        uint256 finalBalanceForEvent;
        if (tradeFinalBalance > 0) {
            finalBalanceForEvent = uint256(tradeFinalBalance);
        } else {
            finalBalanceForEvent = 0;
            emit StateLog(params.executionId, "NegativeTradeFinalBalance", int2str(tradeFinalBalance));
        }

        emit SwapEvent(
            params.executionId,
            3,  // checkpoint
            "AfterSecondSwap",
            params.sourceToken,
            finalBalanceForEvent,
            expectedSecondOutputForEvent
        );

        // Log profit details
        emit StateLog(
            params.executionId,
            "ProfitDetails",
            string(abi.encodePacked(
                "Actual: ", int2str(tradeProfit),
                ", Expected: ", int2str(expectedProfit),
                ", TestMode: ", params.testMode ? "true" : "false"
            ))
        );

        // Profit validation
        if (tradeProfit > 0) {
            // Update contract stats for successful profitable trades
            metrics.successfulExecutions++;

            // Safe conversion for metrics - only add positive profit
            if (tradeProfit > 0) {
                metrics.totalProfit += uint256(tradeProfit);
            } else {
                emit StateLog(params.executionId, "MetricsUpdateWarning", "Failed to update metrics");
            }

            emit StateLog(params.executionId, "ProfitValidation", "Profitable");
        } else {
            // If testMode == false, revert on negative or zero profit
            if (!params.testMode) {
                emit StateLog(params.executionId, "ProfitValidation", "NoProfit");
                revert InsufficientProfit();
            }
            emit StateLog(params.executionId, "ProfitValidation", "TestMode");
        }

        // Update total execution count
        metrics.totalExecutions++;

        // Emit event with both trade-specific and account-wide metrics
        emit ArbitrageExecuted(
            params.sourceToken,
            params.targetToken,
            params.amount,                   // Trade input amount
            finalAccountBalance,             // Total account balance
            tradeFinalBalance,               // Trade-specific final balance (can be negative)
            tradeProfit,                     // Trade-specific profit (can be negative)
            expectedProfit,                  // Expected profit from quotes (can be negative)
            params.testMode
        );

        return tradeProfit;
    }

    /**
     * @notice External wrapper for executeArbitrageInternal to allow try-catch
     * @param params Parameters for the arbitrage trade
     * @return The trade profit (can be negative in test mode)
     */
    function executeArbitrageWrapper(ArbitrageParams calldata params) external returns (int256) {
        // Only allow this contract to call itself
        require(msg.sender == address(this), "Unauthorized");
        return executeArbitrageInternal(params);
    }

    /**
     * @notice Safe approve function with optimized gas usage
     * @param token The token to approve
     * @param spender The address to approve
     * @param amount The amount to approve
     */
    function _safeApprove(address token, address spender, uint256 amount) internal {
        // Try direct approve first - works for most tokens and saves gas
        (bool success, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );

        // If direct approve fails, try safe pattern (set to 0, then approve)
        if (!success || (result.length > 0 && !abi.decode(result, (bool)))) {
            // Try to reset approval to zero first
            try IERC20(token).approve(spender, 0) {} catch {}

            // Now try to approve with the requested amount
            IERC20(token).approve(spender, amount);
        }

        emit ApprovalUpdated(token, spender, amount);
    }

    /**
     * @notice Compare two strings efficiently for equality
     * @param a First string
     * @param b Second string
     * @return isEqual True if the strings are equal
     */
    function _compareStrings(string memory a, string memory b) internal pure returns (bool isEqual) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /**
     * @notice Converts an address to a hex string
     * @param addr The address to convert
     * @return str The string representation of the address
     */
    function addressToString(address addr) internal pure returns (string memory) {
        bytes memory addressBytes = abi.encodePacked(addr);
        bytes memory stringBytes = new bytes(42);

        // Add "0x" prefix
        stringBytes[0] = '0';
        stringBytes[1] = 'x';

        // Convert each byte to its hex representation
        for(uint i = 0; i < 20; i++) {
            uint8 value = uint8(addressBytes[i]);
            stringBytes[2+i*2] = toHexChar(value / 16);
            stringBytes[2+i*2+1] = toHexChar(value % 16);
        }

        return string(stringBytes);
    }

    /**
     * @notice Converts an int256 to a string representation with improved safety
     * @param value The int256 value to convert
     * @return str The string representation of the value
     */
    function int2str(int256 value) internal pure returns (string memory) {
        if (value == 0) return "0";

        bool negative = value < 0;

        // Handle the edge case of minimum int256 value
        if (value == type(int256).min) {
            // Return a hardcoded string for this special case
            return "-57896044618658097711785492504343953926634992332820282019728792003956564819968";
        }

        // Convert to absolute value for processing
        uint256 absValue;
        if (negative) {
            // Safe conversion - already checked for MIN_INT256
            absValue = uint256(-value);
        } else {
            absValue = uint256(value);
        }

        // Convert the absolute value to string using uint2str
        string memory absStr = uint2str(absValue);

        // Add negative sign if needed
        if (negative) {
            return string(abi.encodePacked("-", absStr));
        } else {
            return absStr;
        }
    }

    /**
     * @notice Get trade context data for analysis
     * @param executionId The ID of the execution
     * @return tradeInputAmount The amount used for the trade
     * @return tradeFinalBalance The final balance of the trade
     * @return expectedFirstOutput The expected output from the first swap
     * @return actualFirstOutput The actual output from the first swap
     * @return expectedSecondOutput The expected output from the second swap
     * @return actualSecondOutput The actual output from the second swap
     * @return executed Whether the trade was executed successfully
     */
    function getTradeContext(bytes32 executionId) external view returns (
        uint256 tradeInputAmount,
        int256 tradeFinalBalance,
        int256 expectedFirstOutput,
        uint256 actualFirstOutput,
        int256 expectedSecondOutput,
        int256 actualSecondOutput,
        bool executed
    ) {
        TradeContext storage context = tradeContexts[executionId];
        return (
            context.tradeInputAmount,
            context.tradeFinalBalance,
            context.expectedFirstLegOutput,
            context.actualFirstLegOutput,
            context.expectedSecondOutput,
            context.actualSecondOutput,
            context.executed
        );
    }

    /**
     * @notice Get DEX configuration
     * @param dexName The name of the DEX
     * @return router The router address
     * @return defaultFee The default fee
     * @return maxGasUsage The maximum gas usage
     * @return isEnabled Whether the DEX is enabled
     */
    function getDexConfig(string memory dexName) external view returns (
        address router,
        uint256 defaultFee,
        uint256 maxGasUsage,
        bool isEnabled
    ) {
        DexConfig storage config = dexConfigs[dexName];
        return (config.router, config.defaultFee, config.maxGasUsage, config.isEnabled);
    }

    /**
     * @notice Get pool configuration
     * @param pool The address of the pool
     * @return isEnabled Whether the pool is enabled
     * @return fee The fee for the pool
     * @return minLiquidity The minimum liquidity for the pool
     * @return dexRouter The associated DEX router
     */
    function getPoolConfig(address pool) external view returns (
        bool isEnabled,
        uint256 fee,
        uint256 minLiquidity,
        address dexRouter
    ) {
        PoolConfig storage config = poolConfigs[pool];
        return (config.isEnabled, config.fee, config.minLiquidity, config.dexRouter);
    }

    /**
     * @notice Get token configuration
     * @param token The address of the token
     * @return isEnabled Whether the token is enabled
     * @return maxAmount The maximum amount for the token
     * @return minAmount The minimum amount for the token
     * @return decimals The decimals for the token
     */
    function getTokenConfig(address token) external view returns (
        bool isEnabled,
        uint256 maxAmount,
        uint256 minAmount,
        uint8 decimals
    ) {
        TokenConfig storage config = tokenConfigs[token];
        return (config.isEnabled, config.maxAmount, config.minAmount, config.decimals);
    }

    /**
     * @notice Check if a DEX fee tier is supported
     * @param dexName The name of the DEX
     * @param feeTier The fee tier to check
     * @return isSupported True if the fee tier is supported
     */
    function isDexFeeTierSupported(string memory dexName, uint256 feeTier) external view returns (bool isSupported) {
        return dexConfigs[dexName].supportedFees[feeTier];
    }

    /**
     * @notice Get contract statistics
     * @return totalTrades The total number of trades
     * @return successfulTrades The number of successful trades
     * @return failedTrades The number of failed trades
     * @return successRate The success rate of trades
     * @return cumulativeProfit The cumulative profit of trades
     */
    function getContractStats() external view returns (
        uint256 totalTrades,
        uint256 successfulTrades,
        uint256 failedTrades,
        uint256 successRate,
        uint256 cumulativeProfit
    ) {
        totalTrades = metrics.totalExecutions;
        successfulTrades = metrics.successfulExecutions;
        failedTrades = metrics.totalExecutions > metrics.successfulExecutions ?
            metrics.totalExecutions - metrics.successfulExecutions : 0;
        successRate = totalTrades > 0 ? (successfulTrades * 10000) / totalTrades : 0;
        cumulativeProfit = metrics.totalProfit;
        return (totalTrades, successfulTrades, failedTrades, successRate, cumulativeProfit);
    }

    /**
     * @notice Verify flash loan configuration
     * @return vault The Balancer Vault address
     * @return currentFeeBps The current fee in basis points
     */
    function verifyFlashLoanConfiguration() external view returns (
        address vault,
        uint256 currentFeeBps
    ) {
        return (address(balancerVault), 0); // Balancer has no fees
    }

    /**
     * @notice Get flash loan fee basis points (always 0 for Balancer)
     * @return feeBps Flash loan fee in BPS (0)
     */
    function getFlashLoanFeeBps() external pure returns (uint256 feeBps) {
        return 0; // Balancer has no fees
    }

    // Emergency and administrative functions
    /**
     * @notice Emergency withdraw function
     * @param token The token to withdraw
     * @return success Success status
     */
    function emergencyWithdraw(address token) external onlyOwner returns (bool success) {
        if (token == address(0)) revert InvalidSetup(7);
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return false;
        IERC20(token).safeTransfer(owner(), balance);
        return true;
    }

    /**
     * @notice Withdraw specific amount of funds
     * @param token The token to withdraw
     * @param amount The amount to withdraw
     * @return success Success status
     */
    function withdrawFunds(address token, uint256 amount) external onlyOwner returns (bool success) {
        if (token == address(0)) revert InvalidSetup(7);
        if (amount == 0) revert InvalidSetup(8);
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) return false;
        IERC20(token).safeTransfer(owner(), amount);
        return true;
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Trigger circuit breaker to pause the contract with a reason
     * @param reason The reason for triggering the circuit breaker
     */
    function triggerCircuitBreaker(string calldata reason) external onlyOwner {
        _pause();
        emit StateLog(bytes32(0), "CircuitBreakerTriggered", reason);
    }

    /**
     * @notice Set token enabled status
     * @param token The token address
     * @param isEnabled Whether the token is enabled
     */
    function setTokenEnabled(address token, bool isEnabled) external onlyOwner {
        if (token == address(0)) revert InvalidSetup(7);
        if (tokenConfigs[token].decimals == 0) revert InvalidSetup(7);
        tokenConfigs[token].isEnabled = isEnabled;
    }

    /**
     * @notice Set DEX enabled status
     * @param dexName The name of the DEX
     * @param isEnabled Whether the DEX is enabled
     */
    function setDexEnabled(string calldata dexName, bool isEnabled) external onlyOwner {
        if (dexConfigs[dexName].router == address(0)) revert InvalidSetup(2);
        dexConfigs[dexName].isEnabled = isEnabled;
    }

    /**
     * @notice Approve router to spend tokens
     * @param token The token address
     * @param router The router address
     * @param amount The amount to approve
     */
    function approveRouter(address token, address router, uint256 amount) external onlyOwner {
        _safeApprove(token, router, amount);
    }

    /**
     * @notice Set router addresses
     * @param uni Uniswap router address
     * @param joe Trader Joe router address
     */
    function setRouterAddresses(address uni, address joe) external onlyOwner {
        uniswapRouterAddress = uni;
        traderJoeRouterAddress = joe;
    }

    /**
     * @notice Convert uint to string - utility function
     * @param _i The uint to convert
     * @return The string representation of the uint
     */
    function uint2str(uint256 _i) public pure returns (string memory) {
        if (_i == 0) return "0";

        uint256 temp = _i;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (_i != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + _i % 10));
            _i /= 10;
        }

        return string(buffer);
    }

    /**
     * @dev Fallback function to revert on direct calls
     */
    fallback() external {
        revert("Function not found");
    }
}