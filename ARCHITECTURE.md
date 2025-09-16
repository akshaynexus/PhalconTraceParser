# PhalconTraceParser - Modular Architecture

## Overview

The PhalconTraceParser has been refactored into a clean, modular architecture that separates concerns and makes the codebase more maintainable, testable, and readable.

## Module Structure

```
PhalconTraceParser/
├── index.js                 # Main entry point and orchestrator
├── index_original.js        # Backup of original monolithic code
├── lib/                     # Core modules
│   ├── configManager.js     # Configuration management
│   ├── rpcManager.js        # RPC URL management and validation
│   ├── tokenManager.js      # Token information fetching
│   ├── abiManager.js        # ABI handling and function signatures
│   ├── traceParser.js       # Trace parsing and analysis
│   └── foundryGenerator.js  # Foundry test generation
├── fourByteApi.js           # 4byte.directory API client
├── etherfaceApi.js          # Etherface.io API client
├── chainlistApi.js          # Chainlist.org API client
└── config.json              # Chain configurations
```

## Module Responsibilities

### 1. ConfigManager (`lib/configManager.js`)
- **Purpose**: Manages chain configurations from `config.json`
- **Key Features**:
  - Loads and validates chain configurations
  - Provides fallback configurations
  - Handles environment variable mapping
  - Explorer API URL generation
  - Chain detection from RPC URLs

```javascript
const configManager = new ConfigManager();
const ethConfig = configManager.getChainConfig('ethereum');
const rpcUrl = configManager.getRpcUrl('ethereum');
```

### 2. RpcManager (`lib/rpcManager.js`)
- **Purpose**: Advanced RPC URL management with Chainlist integration
- **Key Features**:
  - Enhanced RPC URLs from Chainlist API
  - RPC connectivity validation
  - Performance testing and best URL selection
  - Intelligent caching and fallback mechanisms

```javascript
const rpcManager = new RpcManager(configManager);
const bestRpcUrl = await rpcManager.getEnhancedRpcUrl('ethereum');
const validUrls = await rpcManager.getValidatedRpcUrls('base', 3);
```

### 3. TokenManager (`lib/tokenManager.js`)
- **Purpose**: Token information fetching and management
- **Key Features**:
  - ERC20 token information retrieval
  - Uniswap V2 pair detection
  - Explorer API integration
  - Batch token info fetching
  - Transaction details fetching

```javascript
const tokenManager = new TokenManager(configManager, rpcManager);
const tokenInfo = await tokenManager.fetchTokenInfo('0x...');
const txDetails = await tokenManager.fetchTransactionDetails('0x...');
```

### 4. AbiManager (`lib/abiManager.js`)
- **Purpose**: ABI and function signature management
- **Key Features**:
  - Known contract ABI loading
  - Function signature lookup with 4byte + Etherface fallback
  - Function call decoding
  - Interface name generation
  - Solidity signature fixing

```javascript
const abiManager = new AbiManager(fourByteApi, etherfaceApi);
const signature = await abiManager.lookupFunctionSignatureWithFallback('0x70a08231');
const decoded = await abiManager.decodeFunctionCall(address, callData, abi);
```

### 5. TraceParser (`lib/traceParser.js`)
- **Purpose**: Complex trace parsing and analysis
- **Key Features**:
  - Transaction trace parsing
  - Callback pattern detection (flashloans, swaps)
  - Call extraction within callback ranges
  - Parameter formatting for Solidity
  - Address variable name generation

```javascript
const traceParser = new TraceParser(configManager, rpcManager, tokenManager, abiManager);
const callbacks = traceParser.extractCallsInFlashloanRange(dataMap, startId, endId, mainAddress);
const functions = traceParser.generateCallbackFunctions(callbacks, contracts, addressRegistry);
```

### 6. FoundryGenerator (`lib/foundryGenerator.js`)
- **Purpose**: Complete Foundry test and project generation
- **Key Features**:
  - Foundry test contract generation
  - Interface creation with struct handling
  - Supporting file generation (foundry.toml, .env.example, README.md)
  - State variable management
  - Test function orchestration

```javascript
const generator = new FoundryGenerator(configManager, rpcManager, tokenManager, abiManager, traceParser);
const testContent = await generator.generateFoundryTest(traceData, mainAddress, blockNumber, rpcUrl);
```

### 7. PhalconTraceParser (Main Class)
- **Purpose**: Orchestrates all modules and provides main interface
- **Key Features**:
  - Module initialization and dependency injection
  - Main processing pipeline
  - Status reporting and cache management
  - Error handling and validation

## Key Benefits

### 1. **Maintainability**
- **Separation of Concerns**: Each module has a single, well-defined responsibility
- **Reduced Complexity**: Original 2,500+ line file split into focused modules
- **Clear Dependencies**: Explicit dependency injection makes relationships obvious

### 2. **Testability**
- **Unit Testing**: Each module can be tested independently
- **Mock Dependencies**: Easy to mock dependencies for isolated testing
- **Focused Testing**: Test specific functionality without side effects

### 3. **Readability**
- **Clear Structure**: Easy to find and understand specific functionality
- **Comprehensive Documentation**: Each method and class is well-documented
- **Consistent Patterns**: Similar structure across all modules

### 4. **Extensibility**
- **Easy Module Addition**: New modules can be added without affecting others
- **Plugin Architecture**: API clients are modular and swappable
- **Configuration Driven**: New chains and features via configuration

### 5. **Reusability**
- **Modular Imports**: Use specific modules in other projects
- **API Compatibility**: Maintains backward compatibility
- **Component Libraries**: Modules can be used as standalone libraries

## Usage Examples

### Basic Usage (Same as Before)
```bash
node index.js trace.json 0x742d35Cc6634C0532925a3b8D89d0B9b5d7d50b5
```

### Programmatic Usage
```javascript
const { PhalconTraceParser } = require('./index.js');

const parser = new PhalconTraceParser();
await parser.process('trace.json', mainAddress, 'test/MyTest.t.sol');

// Get system status
const status = parser.getStatus();
console.log('Supported chains:', status.configManager.chainsLoaded);

// Use individual modules
const ethRpcUrl = await parser.rpcManager.getEnhancedRpcUrl('ethereum');
const tokenInfo = await parser.tokenManager.fetchTokenInfo('0x...');
```

### Module-Specific Usage
```javascript
const ConfigManager = require('./lib/configManager');
const RpcManager = require('./lib/rpcManager');

const config = new ConfigManager();
const rpc = new RpcManager(config);

const bestUrl = await rpc.findBestRpcUrl(['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'], 1);
```

## File Size Reduction

- **Original**: `index.js` - 2,568 lines
- **New**: `index.js` - 247 lines (-90% reduction)
- **Modules**: Total ~1,500 lines across 6 focused files
- **Net Result**: Better organized, more maintainable codebase

## Performance Improvements

- **Intelligent Caching**: Multiple cache layers prevent redundant API calls
- **Parallel Processing**: RPC validation and token fetching in parallel
- **Smart Fallbacks**: Graceful degradation when services are unavailable
- **Connection Pooling**: Optimized HTTP requests with timeouts

## Configuration Management

The new architecture uses `config.json` for all chain configurations, making it easy to:
- Add new chains without code changes
- Update RPC URLs and explorer APIs
- Configure environment variables
- Set default preferences

## Backward Compatibility

The refactored code maintains full backward compatibility:
- Same CLI interface and arguments
- Same output format and files
- Same environment variables
- Legacy export for `generateFoundryTest`

## Error Handling

Enhanced error handling with:
- Module-level error isolation
- Graceful fallbacks for each service
- Detailed error messages with context
- Debug mode for development

This modular architecture provides a solid foundation for future enhancements while maintaining the powerful functionality that makes PhalconTraceParser effective for transaction trace analysis and Foundry test generation.