# Trace Reproduction Test

This Foundry test reproduces the main calls from the provided trace.json file. It uses the actual contract addresses and method calls made by the specified main address in the trace.

## Supported Chains

- **Ethereum Mainnet**: Default chain with full DeFi protocol support
- **Base Chain**: Optimized for Base ecosystem with Aerodrome DEX and Base-native tokens

## Setup

1. Install dependencies:
```bash
bun install
```

2. Copy `.env.example` to `.env` and fill in your RPC URLs:
```bash
cp .env.example .env
```

3. Set your target chain (optional):
```bash
# For Ethereum (default)
export CHAIN=ethereum

# For Base chain
export CHAIN=base
export BASE_RPC_URL=https://mainnet.base.org
```

4. Generate the test with manual address:
```bash
# Using command line argument
node index.js trace.json 0x1234...5678

# Using environment variable
export MAIN_ADDRESS=0x1234...5678
node index.js trace.json

# Let it auto-detect from trace
node index.js trace.json
```

5. Run the test:
```bash
# Run on Ethereum mainnet
forge test --match-test testReproduceTrace -vvv --fork-url $RPC_URL

# Run on Base chain
forge test --match-test testReproduceTrace -vvv --fork-url $BASE_RPC_URL
```

## Test Structure

- `testReproduceTrace()`: Reproduces the exact calls made by the main address in the trace
- `testPriceCalls()`: Placeholder for additional price/view calls

## Base Chain Features

- Support for Base-native tokens (USDC, DAI, WETH, cbETH, etc.)
- Aerodrome DEX integration
- Uniswap V3 on Base
- Basescan API integration (when API key provided)