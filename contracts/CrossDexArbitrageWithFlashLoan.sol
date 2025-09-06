// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title Balancer V3 Flash Loan Interface
interface IBalancerVault {
    function unlock(bytes calldata data) external returns (bytes memory);
    function sendTo(IERC20 token, address to, uint256 amount) external;
    function settle(IERC20 token, uint256 amount) external;
}

/// Custom Errors - Consolidated to reduce bytecode
    error InvalidSetup(uint8 code);
    error TradeErrors(uint8 code, string reason);
    error FlashLoanErrors(uint8 code);

/**
 * @title CrossDexArbitrageWithFlashLoan
 * @notice Executes arbitrage between DEXes using Balancer V3 flash loans
 * @dev Optimized for reduced gas usage and contract size
 */
contract CrossDexArbitrageWithFlashLoan is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Constants - using immutable where possible to save gas
    uint256 private constant MAX_BPS = 10000; // 100%
    uint256 private constant MAX_GAS_FOR_CALL = 3000000;

    // Main contract addresses
    address public immutable balancerVaultAddress;
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
        uint256 expectedFirstOutput;
        uint256 expectedSecondOutput;
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
        int256 tradeFinalBalance;
        int256 expectedFirstLegOutput;
        int256 actualFirstLegOutput;
        int256 expectedSecondLegOutput;
        int256 actualSecondLegOutput;
        bool executed;
    }

    // Flash loan context for handling callbacks
    struct FlashLoanContext {
        address sourceToken;
        address targetToken;
        uint256 amount;
        bytes firstSwapData;
        bytes secondSwapData;
        address firstRouter;
        address secondRouter;
        bool testMode;
        uint256 expectedFirstOutput;
        uint256 expectedSecondOutput;
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
        uint256 totalProfit;
        uint256 flashLoanExecutions;
        uint256 flashLoanSuccessful;
        uint256 flashLoanFailed;
        uint256 flashLoanProfit;
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
        int256 tradeFinalBalance,           // Final balance for this specific trade
        int256 tradeProfit,                 // Profit for this specific trade
        int256 expectedProfit,              // Expected profit based on quotes
        bool testMode
    );

    // Consolidated events for logging with reduced storage
    event StateLog(bytes32 indexed executionId, string stage, string data);
    event SwapEvent(
        bytes32 indexed executionId,
        uint8 eventType,  // 1=initiated, 2=completed, 3=checkpoint
        string stage,
        address token,
        uint256 actualBalance,
        uint256 expectedBalance
    );
    event FlashLoanEvent(
        bytes32 indexed executionId,
        uint8 eventType,    // 1=initiated, 2=completed, 3=failed
        address token,
        uint256 amount,
        uint256 feeOrProfit  // Fee for initiated, profit for completed
    );

    /**
     * @notice Contract constructor
     * @param _balancerVaultAddress The address of the Balancer V3 Vault contract
     */
    constructor(address _balancerVaultAddress) {
        if (_balancerVaultAddress == address(0)) revert InvalidSetup(1);
        balancerVaultAddress = _balancerVaultAddress;
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
     * @notice Executes a flash loan-based arbitrage using Balancer V3
     * @param sourceToken Token to borrow in the flash loan
     * @param targetToken Intermediate token used in the arbitrage
     * @param amount Amount to borrow
     * @param firstSwapData Calldata for the first swap
     * @param secondSwapData Calldata for the second swap
     * @param firstRouter Address of the first DEX router
     * @param secondRouter Address of the second DEX router
     * @param testMode Whether to run in test mode (allows negative profit)
     * @param expectedFirstOutput Expected output from the first swap
     * @param expectedSecondOutput Expected output from the second swap
     * @return finalBalance The final balance after the arbitrage
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
        uint256 expectedFirstOutput,
        uint256 expectedSecondOutput
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Validations
        if (sourceToken == targetToken) revert TradeErrors(1, "");
        if (amount == 0) revert FlashLoanErrors(1);
        if (balancerVaultAddress == address(0)) revert InvalidSetup(1);
        if (!tokenConfigs[sourceToken].isEnabled) revert TradeErrors(2, "");

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

        emit FlashLoanEvent(
            executionId,
            1,  // initiated
            sourceToken,
            amount,
            0    // No fee for Balancer flash loans
        );

        // Call Balancer Vault to unlock and execute flash loan
        IBalancerVault(balancerVaultAddress).unlock(
            abi.encodeWithSelector(this.onFlashLoan.selector, abi.encode(executionId))
        );

        // Get final balance after flash loan
        metrics.flashLoanExecutions++;
        uint256 finalBalance = IERC20(sourceToken).balanceOf(address(this));
        return finalBalance;
    }

    /**
     * @notice Balancer flash loan callback function
     * @dev Called by Balancer Vault during the flash loan
     * @param data Encoded execution ID and parameters
     */
    function onFlashLoan(bytes memory data) external {
        // Verify caller is the Balancer Vault
        if (msg.sender != balancerVaultAddress) {
            revert FlashLoanErrors(2);
        }

        // Decode the execution ID
        bytes32 executionId = abi.decode(data, (bytes32));

        // Retrieve the context
        FlashLoanContext memory context = flashLoanContexts[executionId];
        if (context.executionId != executionId) {
            emit StateLog(executionId, "ContextRetrieval", "Invalid");
            revert TradeErrors(3, "");
        }

        // Borrow funds from Balancer Vault
        IBalancerVault(balancerVaultAddress).sendTo(
            IERC20(context.sourceToken),
            address(this),
            context.amount
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
            testMode: true,  // Always use test mode for flash loans
            expectedFirstOutput: context.expectedFirstOutput,
            expectedSecondOutput: context.expectedSecondOutput,
            executionId: executionId
        })) returns (int256 result) {
            profit = result;
            arbitrageSuccess = true;
            emit StateLog(executionId, "ArbitrageExecution", "Success");
        } catch Error(string memory reason) {
            // Get the string error
            emit StateLog(executionId, "ArbitrageExecution", string(abi.encodePacked("Failed: ", reason)));

            // Update trade context to record the failure
            TradeContext storage tradeContext = tradeContexts[executionId];
            tradeContext.executed = false;
        } catch (bytes memory) {
            // Catch any other error
            emit StateLog(executionId, "ArbitrageExecution", "Failed with unknown error");

            // Update trade context
            TradeContext storage tradeContext = tradeContexts[executionId];
            tradeContext.executed = false;
        }

        // Record flash loan metrics
        if (arbitrageSuccess) {
            metrics.flashLoanSuccessful++;
            if (profit > 0) {
                // Convert positive int256 to uint256 before adding to totalProfit
                metrics.flashLoanProfit += profit > 0 ? uint256(profit) : 0;
            }
        } else {
            metrics.flashLoanFailed++;
        }

        // Repay the flash loan to Balancer
        uint256 repayAmount = context.amount;
        IERC20(context.sourceToken).transfer(balancerVaultAddress, repayAmount);
        IBalancerVault(balancerVaultAddress).settle(IERC20(context.sourceToken), repayAmount);

        // Emit event with results
        emit FlashLoanEvent(
            executionId,
            2,  // completed
            context.sourceToken,
            context.amount,
            profit > 0 ? uint256(profit) : 0  // Convert to uint256 for event
        );

        // Clean up context
        delete flashLoanContexts[executionId];
    }

    /**
     * @notice Internal function to execute arbitrage logic
     * @param params Parameters for the arbitrage trade
     * @return tradeProfit The trade profit (can be negative in test mode)
     */
    function executeArbitrageInternal(ArbitrageParams memory params) internal returns (int256) {
        if (executedTrades[params.executionId]) {
            revert TradeErrors(3, "");
        }
        executedTrades[params.executionId] = true;

        // Initialize trade context
        TradeContext storage tradeContext = tradeContexts[params.executionId];

        // 1) Record initial account-wide balances
        uint256 initialAccountBalance = IERC20(params.sourceToken).balanceOf(address(this));
        uint256 initialTargetBalance = IERC20(params.targetToken).balanceOf(address(this));

        // Store in trade context
        tradeContext.sourceTokenStartBalance = initialAccountBalance;
        tradeContext.targetTokenStartBalance = initialTargetBalance;
        tradeContext.tradeInputAmount = params.amount;
        tradeContext.expectedFirstLegOutput = int256(params.expectedFirstOutput);  // Convert to int256
        tradeContext.expectedSecondLegOutput = int256(params.expectedSecondOutput);  // Convert to int256

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
        uint256 currentAllowanceFirst = IERC20(params.sourceToken).allowance(address(this), params.firstRouter);
        if (currentAllowanceFirst < params.amount) {
            _safeApprove(params.sourceToken, params.firstRouter, type(uint256).max);
            emit StateLog(params.executionId, "FirstRouterApproval", "Updated");
        }

        // Emit event before first swap
        emit SwapEvent(
            params.executionId,
            1,  // initiated
            "first",
            params.firstRouter,
            params.amount,
            params.expectedFirstOutput
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
            revert TradeErrors(4, errorMsg);
        }

        // Record successful first swap
        emit StateLog(params.executionId, "FirstSwap", "Success");

        // 4) Check how many targetTokens we got
        uint256 currentTargetBalance = IERC20(params.targetToken).balanceOf(address(this));
        uint256 targetTokenReceived = currentTargetBalance - initialTargetBalance;

        // Store in trade context
        tradeContext.intermediateTokenAmount = targetTokenReceived;
        tradeContext.actualFirstLegOutput = int256(targetTokenReceived);  // Convert to int256

        // Record checkpoint after first swap
        emit SwapEvent(
            params.executionId,
            3,  // checkpoint
            "AfterFirstSwap",
            params.targetToken,
            targetTokenReceived,
            params.expectedFirstOutput
        );

        if (targetTokenReceived == 0) {
            emit StateLog(params.executionId, "IntermediateTokenReceived", "None");
            revert TradeErrors(5, "");
        }

        // 5) Approve second router for the entire intermediateBalance
        uint256 currentAllowanceSecond = IERC20(params.targetToken).allowance(address(this), params.secondRouter);
        if (currentAllowanceSecond < targetTokenReceived) {
            _safeApprove(params.targetToken, params.secondRouter, type(uint256).max);
            emit StateLog(params.executionId, "SecondRouterApproval", "Updated");
        }

        // Emit event before second swap
        emit SwapEvent(
            params.executionId,
            1,  // initiated
            "second",
            params.secondRouter,
            targetTokenReceived,
            params.expectedSecondOutput
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
            revert TradeErrors(6, errorMsg);
        }

        // Record successful second swap
        emit StateLog(params.executionId, "SecondSwap", "Success");

        // 7) Determine final balances and calculate profit
        uint256 finalAccountBalance = IERC20(params.sourceToken).balanceOf(address(this));

        // Calculate trade-specific final balance
        int256 sourceTokenReceived = int256(finalAccountBalance) - int256(initialAccountBalance);
        int256 tradeFinalBalance = int256(params.amount) + sourceTokenReceived;

        // Store in trade context
        tradeContext.tradeFinalBalance = tradeFinalBalance;
        tradeContext.actualSecondLegOutput = sourceTokenReceived;
        tradeContext.executed = true;

        // Record checkpoint after second swap
        emit SwapEvent(
            params.executionId,
            3,  // checkpoint
            "AfterSecondSwap",
            params.sourceToken,
            tradeFinalBalance > 0 ? uint256(tradeFinalBalance) : 0,  // Convert to uint256 for event
            params.expectedSecondOutput
        );

        // Calculate trade-specific profit
        int256 tradeProfit = tradeFinalBalance - int256(params.amount);
        int256 expectedProfit = int256(params.expectedSecondOutput) - int256(params.amount);

        if (tradeProfit > 0) {
            // Update contract stats for successful profitable trades
            metrics.successfulExecutions++;
            // Convert positive int256 to uint256 before adding to totalProfit
            metrics.totalProfit += uint256(tradeProfit);
            emit StateLog(params.executionId, "ProfitValidation", "Profitable");
        } else {
            // If testMode == false, revert on negative or zero profit
            if (!params.testMode) {
                emit StateLog(params.executionId, "ProfitValidation", "NoProfit");
                revert TradeErrors(7, "");
            }
            emit StateLog(params.executionId, "ProfitValidation", "TestMode");
        }

        // Update total execution count
        metrics.totalExecutions++;

        // Emit event with both trade-specific and account-wide metrics
        emit ArbitrageExecuted(
            params.sourceToken,
            params.targetToken,
            params.amount,               // Trade input amount
            finalAccountBalance,         // Total account balance
            tradeFinalBalance,           // Trade-specific final balance
            tradeProfit,                 // Trade-specific profit
            expectedProfit,              // Expected profit from quotes
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
        int256 actualFirstOutput,
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
            context.expectedSecondLegOutput,
            context.actualSecondLegOutput,
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
        failedTrades = metrics.failedExecutions;
        successRate = totalTrades > 0 ? (successfulTrades * 10000) / totalTrades : 0;
        cumulativeProfit = metrics.totalProfit;
        return (totalTrades, successfulTrades, failedTrades, successRate, cumulativeProfit);
    }

    /**
     * @notice Verify flash loan configuration
     * @return vault The Balancer Vault address
     * @return currentFeeBps The current fee in basis points (0 for Balancer)
     */
    function verifyFlashLoanConfiguration() external view returns (
        address vault,
        uint256 currentFeeBps
    ) {
        return (balancerVaultAddress, 0); // Balancer has no fees
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
     * @return str The string representation of the uint
     */
    function uint2str(uint256 _i) public pure returns (string memory str) {
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