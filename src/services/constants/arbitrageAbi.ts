// src/services/constants/arbitrageAbi.ts
// Updated ABI for CrossDexArbitrage smart contract

export const ARBITRAGE_ABI =  [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_balancerVaultAddress",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "DisabledToken",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "reason",
        "type": "string"
      }
    ],
    "name": "FirstSwapFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientProfit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientRepayment",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidExecutionId",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "code",
        "type": "uint8"
      }
    ],
    "name": "InvalidSetup",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTokens",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidVaultAddress",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoIntermediateTokens",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "reason",
        "type": "string"
      }
    ],
    "name": "SecondSwapFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TestModeShortfall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnauthorizedCaller",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAmount",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "spender",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newAmount",
        "type": "uint256"
      }
    ],
    "name": "ApprovalUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "sourceToken",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "targetToken",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "tradeInputAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "finalAccountBalance",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "tradeFinalBalance",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "tradeProfit",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "expectedProfit",
        "type": "int256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "testMode",
        "type": "bool"
      }
    ],
    "name": "ArbitrageExecuted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "string",
        "name": "dexName",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "router",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "defaultFee",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "maxGasUsage",
        "type": "uint256"
      }
    ],
    "name": "DexConfigured",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "executionId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "eventType",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "feeOrProfit",
        "type": "int256"
      }
    ],
    "name": "FlashLoanEvent",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "Paused",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "pool",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "minLiquidity",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "dexRouter",
        "type": "address"
      }
    ],
    "name": "PoolConfigured",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "executionId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "stage",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "data",
        "type": "string"
      }
    ],
    "name": "StateLog",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "executionId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "eventType",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "stage",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "actualBalance",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "expectedBalance",
        "type": "uint256"
      }
    ],
    "name": "SwapEvent",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "maxAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "minAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "decimals",
        "type": "uint8"
      }
    ],
    "name": "TokenConfigured",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "Unpaused",
    "type": "event"
  },
  {
    "stateMutability": "nonpayable",
    "type": "fallback"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "router",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "approveRouter",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "balancerVault",
    "outputs": [
      {
        "internalType": "contract IVault",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "dexName",
        "type": "string"
      },
      {
        "internalType": "address",
        "name": "router",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "defaultFee",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "maxGasUsage",
        "type": "uint256"
      },
      {
        "internalType": "uint256[]",
        "name": "supportedFeeTiers",
        "type": "uint256[]"
      }
    ],
    "name": "configureDex",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "pool",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minLiquidity",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "dexName",
        "type": "string"
      }
    ],
    "name": "configurePool",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "maxAmount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minAmount",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "decimals",
        "type": "uint8"
      }
    ],
    "name": "configureToken",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "emergencyWithdraw",
    "outputs": [
      {
        "internalType": "bool",
        "name": "success",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "sourceToken",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "targetToken",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          },
          {
            "internalType": "bytes",
            "name": "firstSwapData",
            "type": "bytes"
          },
          {
            "internalType": "bytes",
            "name": "secondSwapData",
            "type": "bytes"
          },
          {
            "internalType": "address",
            "name": "firstRouter",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "secondRouter",
            "type": "address"
          },
          {
            "internalType": "bool",
            "name": "testMode",
            "type": "bool"
          },
          {
            "internalType": "int256",
            "name": "expectedFirstOutput",
            "type": "int256"
          },
          {
            "internalType": "int256",
            "name": "expectedSecondOutput",
            "type": "int256"
          },
          {
            "internalType": "bytes32",
            "name": "executionId",
            "type": "bytes32"
          }
        ],
        "internalType": "struct CrossDexArbitrageWithFlashLoan.ArbitrageParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "executeArbitrageWrapper",
    "outputs": [
      {
        "internalType": "int256",
        "name": "",
        "type": "int256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "sourceToken",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "targetToken",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "firstSwapData",
        "type": "bytes"
      },
      {
        "internalType": "bytes",
        "name": "secondSwapData",
        "type": "bytes"
      },
      {
        "internalType": "address",
        "name": "firstRouter",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "secondRouter",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "testMode",
        "type": "bool"
      },
      {
        "internalType": "int256",
        "name": "expectedFirstOutput",
        "type": "int256"
      },
      {
        "internalType": "int256",
        "name": "expectedSecondOutput",
        "type": "int256"
      }
    ],
    "name": "executeFlashLoanArbitrage",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "executedTrades",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getContractStats",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "totalTrades",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "successfulTrades",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "failedTrades",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "successRate",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "cumulativeProfit",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "dexName",
        "type": "string"
      }
    ],
    "name": "getDexConfig",
    "outputs": [
      {
        "internalType": "address",
        "name": "router",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "defaultFee",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "maxGasUsage",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "isEnabled",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getFlashLoanFeeBps",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "feeBps",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "pool",
        "type": "address"
      }
    ],
    "name": "getPoolConfig",
    "outputs": [
      {
        "internalType": "bool",
        "name": "isEnabled",
        "type": "bool"
      },
      {
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minLiquidity",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "dexRouter",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "getTokenConfig",
    "outputs": [
      {
        "internalType": "bool",
        "name": "isEnabled",
        "type": "bool"
      },
      {
        "internalType": "uint256",
        "name": "maxAmount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minAmount",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "decimals",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "executionId",
        "type": "bytes32"
      }
    ],
    "name": "getTradeContext",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "tradeInputAmount",
        "type": "uint256"
      },
      {
        "internalType": "int256",
        "name": "tradeFinalBalance",
        "type": "int256"
      },
      {
        "internalType": "int256",
        "name": "expectedFirstOutput",
        "type": "int256"
      },
      {
        "internalType": "uint256",
        "name": "actualFirstOutput",
        "type": "uint256"
      },
      {
        "internalType": "int256",
        "name": "expectedSecondOutput",
        "type": "int256"
      },
      {
        "internalType": "int256",
        "name": "actualSecondOutput",
        "type": "int256"
      },
      {
        "internalType": "bool",
        "name": "executed",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "dexName",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "feeTier",
        "type": "uint256"
      }
    ],
    "name": "isDexFeeTierSupported",
    "outputs": [
      {
        "internalType": "bool",
        "name": "isSupported",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "metrics",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "totalExecutions",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "successfulExecutions",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "failedExecutions",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "totalProfit",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "flashLoanExecutions",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "flashLoanSuccessful",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "flashLoanFailed",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "flashLoanProfit",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "paused",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "contract IERC20[]",
        "name": "",
        "type": "address[]"
      },
      {
        "internalType": "uint256[]",
        "name": "amounts",
        "type": "uint256[]"
      },
      {
        "internalType": "uint256[]",
        "name": "feeAmounts",
        "type": "uint256[]"
      },
      {
        "internalType": "bytes",
        "name": "userData",
        "type": "bytes"
      }
    ],
    "name": "receiveFlashLoan",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "dexName",
        "type": "string"
      },
      {
        "internalType": "bool",
        "name": "isEnabled",
        "type": "bool"
      }
    ],
    "name": "setDexEnabled",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "uni",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "joe",
        "type": "address"
      }
    ],
    "name": "setRouterAddresses",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "isEnabled",
        "type": "bool"
      }
    ],
    "name": "setTokenEnabled",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "traderJoeRouterAddress",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "reason",
        "type": "string"
      }
    ],
    "name": "triggerCircuitBreaker",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_i",
        "type": "uint256"
      }
    ],
    "name": "uint2str",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "uniswapRouterAddress",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "unpause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "verifyFlashLoanConfiguration",
    "outputs": [
      {
        "internalType": "address",
        "name": "vault",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "currentFeeBps",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "withdrawFunds",
    "outputs": [
      {
        "internalType": "bool",
        "name": "success",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
