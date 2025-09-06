
# DeFi Arbitrage Trading Bot

A sophisticated TypeScript-based arbitrage trading bot that exploits price differences between different DEXs (Uniswap and TraderJoe) across multiple blockchain networks (Avalanche and Arbitrum).

## Features

- **Multi-Network Support**: Avalanche and Arbitrum networks
- **Multi-DEX Arbitrage**: Uniswap V3 and TraderJoe integration
- **Flash Loan Implementation**: Leveraged trading with flash loans
- **Real-time Monitoring**: Price monitoring and trade execution
- **Webhook Integration**: TradingView webhook support
- **Comprehensive Reporting**: Trade analysis and reporting system
- **Gas Optimization**: Dynamic gas fee adjustment
- **Risk Management**: Emergency withdrawal and pause functionality

## Supported Networks & Tokens

### Avalanche
- USDC, WAVAX, WBTC
- TraderJoe and Uniswap V3 integration

### Arbitrum
- USDC, WETH, WBTC
- Uniswap V3 integration

## Prerequisites

- Node.js >= 23.8.0
- Yarn package manager
- Private key for wallet with sufficient funds
- RPC endpoints for Avalanche and Arbitrum networks

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd ExecuteTradeSmartContractFlashLoanV15BTCARB

cp .env.example .env
# Edit .env with your configuration

```
2. Install dependencies:
``` bash
yarn install
```
3. Set up environment variables:
cp .env.example .env
# Edit .env with your configuration

# Network RPC URLs
AVALANCHE_RPC_URL=your_avalanche_rpc_url
ARBITRUM_RPC_URL=your_arbitrum_rpc_url

# Private Keys
PRIVATE_KEY=your_private_key_here

# Contract Addresses (if deployed)
FLASH_LOAN_CONTRACT_ADDRESS=

# Webhook Configuration
WEBHOOK_SECRET=your_webhook_secret
WEBHOOK_PORT=3001

# Trading Parameters
MIN_PROFIT_BPS=50  # Minimum profit in basis points
MAX_SLIPPAGE_BPS=100  # Maximum slippage tolerance



## Usage
### Basic Trading Commands
#### Avalanche Network

# Buy BTC with USDC
yarn trade:ava:buy-btc

# Sell BTC for USDC
yarn trade:ava:sell-btc

# Buy AVAX with USDC
yarn trade:ava:buy-avax

# Sell AVAX for USDC
yarn trade:ava:sell-avax

#### Arbitrum Network
``` bash
# Buy BTC with USDC
yarn trade:arb:buy-btc

# Sell BTC for USDC
yarn trade:arb:sell-btc

# Buy ETH with USDC
yarn trade:arb:buy-eth

# Sell ETH for USDC
yarn trade:arb:sell-eth
```

### Testing Commands (Small Amounts)
``` bash
# Test trades with small amounts
yarn test:ava:buy-btc-small
yarn test:arb:buy-eth-small
```

### Arbitrage & Flash Loans
``` bash
# Test flash loan arbitrage
yarn testArbitrageFlashLoan1  # TraderJoe to Uniswap
yarn testArbitrageFlashLoan2  # Uniswap to TraderJoe
```

### Webhook Server
``` bash
# Start webhook server for TradingView integration
yarn webhook:start

# Monitor webhook activity
yarn webhook:monitor

# Test webhook functionality
yarn webhook:test
```

### Reporting & Analysis
``` bash
# Generate trading reports
yarn reports:generate
yarn reports:daily
yarn reports:weekly

# Trade management
yarn trade:summary
yarn trade:list
yarn trade:active
```

### Utilities
``` bash
# Check balances
yarn getBalance

# Get price quotes
yarn quote:ava:usdc-btc
yarn quote:arb:usdc-eth

# Emergency operations
yarn emergencyWithdrawUSDC
yarn pauseContract
```

src/
├── mainUniswap.ts          # Main trading logic
├── mainArbitrage.ts        # Arbitrage execution
├── quoterUniswap.ts        # Price quotation (Uniswap)
├── quoterTraderJoe.ts      # Price quotation (TraderJoe)
├── webhookServer.ts        # TradingView webhook handler
├── tradeReporting.ts       # Trade reporting system
└── testMonitoring.ts       # Monitoring utilities

scripts/
├── fundContract.ts         # Contract funding
├── getBalance.ts          # Balance checking
├── emergencyWithdraw.ts   # Emergency operations
└── tradeManagement.ts     # Trade management utilities

## Safety Features
- **Emergency Withdrawal**: Quick fund recovery
- **Contract Pause**: Halt all operations if needed
- **Slippage Protection**: Configurable slippage limits
- **Gas Limit Controls**: Prevent excessive gas usage
- **Trade Validation**: Pre-execution trade validation

## Risk Disclaimers
⚠️ **WARNING**: This is experimental DeFi software involving financial risks.
- Test thoroughly on testnets before mainnet deployment
- Never invest more than you can afford to lose
- Arbitrage opportunities are not guaranteed
- Gas costs can exceed profits
- Smart contract risks apply
- Market volatility can cause losses

## Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
## Support
For support and questions:
- Create an issue in this repository
- Check the documentation in `/docs` (if available)
- Review the gas adjustment guide: `gas-adjustment-guide.md`


