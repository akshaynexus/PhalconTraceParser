#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Import all our modules
const ConfigManager = require('./lib/configManager');
const RpcManager = require('./lib/rpcManager');
const TokenManager = require('./lib/tokenManager');
const AbiManager = require('./lib/abiManager');
const TraceParser = require('./lib/traceParser');
const FoundryGenerator = require('./lib/foundryGenerator');

// Import API classes
const FourByteAPI = require('./api_helpers/fourByteApi');
const EtherfaceAPI = require('./api_helpers/etherfaceApi');

/**
 * Main Application Class
 * Orchestrates the entire trace parsing and Foundry test generation process
 */
class PhalconTraceParser {
    constructor() {
        // Initialize configuration manager first
        this.configManager = new ConfigManager();

        // Initialize RPC manager with config
        this.rpcManager = new RpcManager(this.configManager);

        // Initialize token manager with dependencies
        this.tokenManager = new TokenManager(this.configManager, this.rpcManager);

        // Initialize API clients
        this.fourByteApi = new FourByteAPI();
        this.etherfaceApi = new EtherfaceAPI();

        // Initialize ABI manager with APIs
        this.abiManager = new AbiManager(this.fourByteApi, this.etherfaceApi);

        // Initialize trace parser with all dependencies
        this.traceParser = new TraceParser(
            this.configManager,
            this.rpcManager,
            this.tokenManager,
            this.abiManager
        );

        // Initialize Foundry generator with all dependencies
        this.foundryGenerator = new FoundryGenerator(
            this.configManager,
            this.rpcManager,
            this.tokenManager,
            this.abiManager,
            this.traceParser
        );

        console.log('PhalconTraceParser initialized with modular architecture');
    }

    /**
     * Main processing function
     * @param {string} traceFile - Path to trace file
     * @param {string|null} mainAddress - Main contract address
     * @param {string|null} outputFile - Output file path
     * @param {number|null} blockNumber - Block number for forking
     * @param {string|null} txHash - Transaction hash
     */
    async process(traceFile, mainAddress = null, outputFile = null, blockNumber = null, txHash = null) {
        try {
            console.log(`Processing trace file: ${traceFile}`);

            // Validate input file
            if (!fs.existsSync(traceFile)) {
                throw new Error(`Trace file not found: ${traceFile}`);
            }

            // Load and parse trace data
            const traceData = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
            console.log('Trace data loaded successfully');

            // Extract transaction hash from trace if not provided
            if (!txHash) {
                txHash = this.traceParser.extractTransactionHashFromTrace(traceData);
            }

            // Determine main address if not provided
            if (!mainAddress || mainAddress === '0xd649A0876453Fc7626569B28E364262192874E18') {
                mainAddress = await this._determineMainAddress(traceData, txHash);
            }

            if (!mainAddress) {
                throw new Error('Could not determine main address from trace and none provided');
            }

            console.log(`Main address: ${mainAddress}`);

            // Determine chain and RPC URL
            const chainName = process.env.CHAIN || 'ethereum';
            let rpcUrl = await this.rpcManager.getEnhancedRpcUrl(chainName);

            // Fetch transaction details if available
            let txDetails = null;
            if (txHash) {
                console.log(`Fetching transaction details for ${txHash}...`);
                txDetails = await this.tokenManager.fetchTransactionDetails(txHash, rpcUrl);
                if (txDetails) {
                    console.log(`Transaction found at block ${txDetails.blockNumber}`);
                    if (!blockNumber) {
                        blockNumber = txDetails.blockNumber;
                    }
                }
            }

            // Get current block number if needed
            if (!blockNumber) {
                try {
                    const validatedUrls = await this.rpcManager.getValidatedRpcUrls(chainName, 1);
                    if (validatedUrls.length > 0) {
                        const { ethers } = require('ethers');
                        const provider = new ethers.JsonRpcProvider(validatedUrls[0]);
                        const currentBlock = await provider.getBlockNumber();
                        blockNumber = currentBlock - 1; // Use previous block for safety
                        console.log(`Using block ${blockNumber} for forking`);
                    }
                } catch (error) {
                    console.warn('Could not fetch current block number, using default forking');
                    blockNumber = null;
                }
            }

            // Update chain detection from RPC URL if needed
            const detectedChain = this.configManager.detectChainFromRpc(rpcUrl);
            if (detectedChain !== chainName) {
                console.log(`Detected chain: ${detectedChain} from RPC URL`);
            }

            // Generate Foundry test
            console.log('Generating Foundry test...');
            const testContent = await this.foundryGenerator.generateFoundryTest(
                traceData, mainAddress, blockNumber, rpcUrl
            );

            // Write test file
            const testOutputPath = outputFile || 'test/TraceReproduction.t.sol';
            this._ensureDirectoryExists(path.dirname(testOutputPath));
            fs.writeFileSync(testOutputPath, testContent);
            console.log(`Test written to: ${testOutputPath}`);

            // Generate supporting files
            await this._generateSupportingFiles();

            console.log('\n✅ Trace processing completed successfully!');
            console.log('\nGenerated files:');
            console.log('- test/TraceReproduction.t.sol - Main test contract');
            console.log('- foundry.toml - Foundry configuration');
            console.log('- .env.example - Environment variables template');
            console.log('- package.json - Project metadata');
            console.log('- README.md - Setup instructions');

            console.log('\nNext steps:');
            console.log('1. Copy .env.example to .env and configure your RPC URLs');
            console.log('2. Run: forge install');
            console.log('3. Run: forge test -vvv');

        } catch (error) {
            console.error('❌ Error processing trace:', error.message);
            if (process.env.DEBUG) {
                console.error('Stack trace:', error.stack);
            }
            process.exit(1);
        }
    }

    /**
     * Generate supporting project files
     * @private
     */
    async _generateSupportingFiles() {
        console.log('Generating supporting files...');

        // Generate foundry.toml
        const foundryToml = this.foundryGenerator.generateFoundryToml();
        fs.writeFileSync('foundry.toml', foundryToml);

        // Generate .env.example
        const envExample = this.foundryGenerator.generateEnvExample();
        fs.writeFileSync('.env.example', envExample);

        // Generate package.json
        const packageJson = this.foundryGenerator.generatePackageJson();
        fs.writeFileSync('package.json', packageJson);

        // Generate README.md
        const readme = this.foundryGenerator.generateReadme();
        fs.writeFileSync('README.md', readme);

        console.log('Supporting files generated successfully');
    }

    /**
     * Determine main address from trace data
     * @param {Object} traceData - Trace data
     * @param {string|null} txHash - Transaction hash
     * @returns {Promise<string|null>} Main address or null
     * @private
     */
    async _determineMainAddress(traceData, txHash) {
        // If we have transaction hash, fetch transaction details
        if (txHash) {
            try {
                const txDetails = await this.tokenManager.fetchTransactionDetails(txHash);
                if (txDetails && txDetails.from) {
                    console.log(`Determined main address from transaction: ${txDetails.from}`);
                    return txDetails.from;
                }
            } catch (error) {
                console.warn('Could not fetch transaction details for main address determination');
            }
        }

        // Fallback: analyze trace data
        const { dataMap } = traceData;
        if (!dataMap) return null;

        // Find the most frequent 'from' address in invocations
        const fromAddresses = new Map();

        for (const entry of Object.values(dataMap)) {
            if (entry.invocations) {
                for (const invocation of entry.invocations) {
                    if (invocation.from) {
                        const addr = invocation.from.toLowerCase();
                        fromAddresses.set(addr, (fromAddresses.get(addr) || 0) + 1);
                    }
                }
            }
        }

        if (fromAddresses.size > 0) {
            // Return the most frequent from address
            const sortedAddresses = Array.from(fromAddresses.entries())
                .sort(([,a], [,b]) => b - a);

            const mainAddr = sortedAddresses[0][0];
            console.log(`Determined main address from trace analysis: ${mainAddr}`);
            return mainAddr;
        }

        return null;
    }

    /**
     * Ensure directory exists
     * @param {string} dirPath - Directory path
     * @private
     */
    _ensureDirectoryExists(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Get system status and statistics
     * @returns {Object} System status
     */
    getStatus() {
        return {
            configManager: {
                loaded: this.configManager.isLoaded(),
                supportedChains: this.configManager.getSupportedChains().length,
                chainsLoaded: this.configManager.getSupportedChains()
            },
            rpcManager: this.rpcManager.getCacheStats(),
            tokenManager: this.tokenManager.getCacheStats(),
            abiManager: this.abiManager.getCacheStats(),
            apis: {
                fourByte: this.fourByteApi.getCacheStats(),
                etherface: this.etherfaceApi.getCacheStats()
            }
        };
    }

    /**
     * Clear all caches
     */
    clearCaches() {
        this.rpcManager.clearCache();
        this.tokenManager.clearCache();
        this.abiManager.clearCache();
        this.fourByteApi.clearCache();
        this.etherfaceApi.clearCache();
        console.log('All caches cleared');
    }
}

/**
 * Main execution function
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log(`
PhalconTraceParser - Convert transaction traces to Foundry tests

Usage:
  node index.js <trace-file> [main-address] [output-file] [block-number] [tx-hash]

Examples:
  node index.js trace.json
  node index.js trace.json 0x742d35Cc6634C0532925a3b8D89d0B9b5d7d50b5
  node index.js trace.json 0x742d35Cc6634C0532925a3b8D89d0B9b5d7d50b5 test/MyTest.t.sol
  node index.js trace.json 0x742d35Cc6634C0532925a3b8D89d0B9b5d7d50b5 test/MyTest.t.sol 18500000
  node index.js trace.json 0x742d35Cc6634C0532925a3b8D89d0B9b5d7d50b5 test/MyTest.t.sol 18500000 0xabc123...

Environment Variables:
  CHAIN=ethereum          # Target chain (ethereum, base, arbitrum, polygon, optimism, bsc, avalanche)
  RPC_URL=...            # RPC endpoint URL
  DEBUG=true             # Enable debug output

Supported Chains:
  ethereum, base, arbitrum, polygon, optimism, bsc, avalanche

For more information, see README.md
        `);
        process.exit(1);
    }

    const [traceFile, mainAddress, outputFile, blockNumberStr, txHash] = args;
    const blockNumber = blockNumberStr ? parseInt(blockNumberStr) : null;

    const parser = new PhalconTraceParser();
    await parser.process(traceFile, mainAddress, outputFile, blockNumber, txHash);
}

// Export for use as module
module.exports = {
    PhalconTraceParser,
    ConfigManager,
    RpcManager,
    TokenManager,
    AbiManager,
    TraceParser,
    FoundryGenerator,
    // Legacy compatibility
    generateFoundryTest: async (traceData, mainAddress, blockNumber, rpcUrl) => {
        const parser = new PhalconTraceParser();
        return await parser.foundryGenerator.generateFoundryTest(traceData, mainAddress, blockNumber, rpcUrl);
    }
};

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}