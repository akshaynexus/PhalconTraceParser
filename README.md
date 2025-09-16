# Trace Reproduction Test

This project reproduces a transaction trace using Foundry for testing and development.

## Setup

1. Install Foundry:
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

2. Copy `.env.example` to `.env` and fill in your RPC URLs:
```bash
cp .env.example .env
```

3. Set your target chain (optional):
```bash
# Supported chains: ethereum, base, arbitrum, polygon, optimism, bsc, avalanche
export CHAIN=ethereum  # Default

# Examples for other chains:
export CHAIN=base
export CHAIN=arbitrum
export CHAIN=polygon
export CHAIN=optimism
```

4. Generate the test with manual address:
```bash
# Using command line argument
node index.js path/to/trace.json 0xYourMainAddress

# Or set in environment
export MAIN_ADDRESS=0xYourMainAddress
node index.js path/to/trace.json
```

## Running Tests

```bash
# Install dependencies
forge install

# Run tests
forge test

# Run with verbose output
forge test -vvv
```

## Test Options

```bash
# Run on Ethereum mainnet
forge test --match-test testReproduceTrace -vvv --fork-url \$RPC_URL

# Run on Base chain
forge test --match-test testReproduceTrace -vvv --fork-url \$BASE_RPC_URL
```

## Generated Files

- `test/TraceReproduction.t.sol` - Main test contract
- `foundry.toml` - Foundry configuration
- `.env.example` - Environment variables template
- `package.json` - Project metadata

## Notes

- The test reproduces the exact sequence of calls from the original trace
- All addresses are labeled and organized for easy understanding
- Flash loan callbacks are automatically detected and implemented
- Token information is fetched and included as comments
