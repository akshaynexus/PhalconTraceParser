const fs = require('fs');
const path = require('path');

/**
 * Foundry Test Generator Module
 * Handles generation of Foundry test files, configuration, and project structure
 */
class FoundryGenerator {
    constructor(configManager, rpcManager, tokenManager, abiManager, traceParser) {
        this.configManager = configManager;
        this.rpcManager = rpcManager;
        this.tokenManager = tokenManager;
        this.abiManager = abiManager;
        this.traceParser = traceParser;
    }

    /**
     * Generate complete Foundry test from trace data
     * @param {Object} traceData - Parsed trace data
     * @param {string} mainAddress - Main contract address
     * @param {number|null} blockNumber - Block number for forking
     * @param {string|null} rpcUrl - RPC URL
     * @returns {Promise<string>} Generated Foundry test code
     */
    async generateFoundryTest(traceData, mainAddress, blockNumber = null, rpcUrl = null) {
        rpcUrl = rpcUrl || await this.rpcManager.getEnhancedRpcUrl('ethereum');
        const chain = this.configManager.detectChainFromRpc(rpcUrl);
        const { dataMap } = traceData;

        if (!mainAddress) {
            throw new Error('Main address is required for test generation');
        }

        console.log(`Generating Foundry test for ${mainAddress} on ${chain}${blockNumber ? ` at block ${blockNumber}` : ''}`);

        const contracts = new Map();
        const methodCalls = [];
        const addressRegistry = new Map();
        const addressCounter = new Map();

        // Process trace data to extract contract interactions
        await this._processTraceData(dataMap, mainAddress, contracts, methodCalls, addressRegistry, addressCounter);

        // Find callback ranges (flashloan patterns)
        const callbackRanges = this._findCallbackRanges(dataMap, mainAddress);
        let callbacks = new Map();

        // Process callback ranges to extract calls within them
        for (const range of callbackRanges) {
            const callbackData = await this.traceParser.extractCallsInFlashloanRange(
                dataMap, range.startId, range.endId, mainAddress, contracts, addressRegistry, addressCounter
            );

            if (callbackData && callbackData.length > 0) {
                if (range.type === 'flashloan') {
                    const callbackType = this.traceParser.detectCallbackType(range.methodName, range.contractAddress, range.callData);
                    callbacks.set(callbackType, callbackData);
                } else {
                    callbacks.set(range.type, callbackData);
                }
            }
        }

        // Fetch token information for all unique addresses
        const uniqueAddresses = this._getUniqueAddresses(methodCalls, addressRegistry);
        const tokenInfoMap = await this.tokenManager.batchFetchTokenInfo(uniqueAddresses, rpcUrl);

        // Generate the complete test
        return this._generateTestContent(
            mainAddress, chain, blockNumber, rpcUrl, contracts, methodCalls,
            addressRegistry, tokenInfoMap, callbacks
        );
    }

    /**
     * Process trace data to extract contract interactions
     * @param {Object} dataMap - Trace data map
     * @param {string} mainAddress - Main contract address
     * @param {Map} contracts - Contracts map to populate
     * @param {Array} methodCalls - Method calls array to populate
     * @param {Map} addressRegistry - Address registry to populate
     * @param {Map} addressCounter - Address counter to populate
     * @private
     */
    async _processTraceData(dataMap, mainAddress, contracts, methodCalls, addressRegistry, addressCounter) {
        for (const [id, entry] of Object.entries(dataMap)) {
            // Handle both plural and singular forms
            const invocations = entry.invocations || (entry.invocation ? [entry.invocation] : []);
            if (invocations.length === 0) continue;

            for (const invocation of invocations) {
                // Check both 'from' and 'fromAddress' fields
                const fromAddr = invocation.from || invocation.fromAddress;
                if (fromAddr && fromAddr.toLowerCase() === mainAddress.toLowerCase()) {
                    await this._processInvocation(invocation, contracts, methodCalls, addressRegistry, addressCounter);
                }
            }
        }
    }

    /**
     * Process individual invocation
     * @param {Object} invocation - Invocation data
     * @param {Map} contracts - Contracts map
     * @param {Array} methodCalls - Method calls array
     * @param {Map} addressRegistry - Address registry
     * @param {Map} addressCounter - Address counter
     * @private
     */
    async _processInvocation(invocation, contracts, methodCalls, addressRegistry, addressCounter) {
        let methodName = 'unknown';
        let signature = 'unknown()';
        let params = [];
        let useRawCall = false;

        // Get the target address (handle both 'to' and 'address' fields)
        const targetAddress = invocation.to || invocation.address;

        // Try to decode the method call
        if (invocation.decodedMethod && invocation.decodedMethod.name) {
            methodName = invocation.decodedMethod.name;
            signature = invocation.decodedMethod.signature || `${methodName}()`;
            params = invocation.decodedMethod.callParams || [];
        } else if (invocation.selector) {
            // Try to decode using ABI first
            const abi = this.abiManager.loadContractABI(targetAddress);
            const decodedCall = abi && invocation.callData && invocation.callData !== '0x'
                ? await this.abiManager.decodeFunctionCall(targetAddress, invocation.callData, abi)
                : null;

            if (decodedCall) {
                methodName = decodedCall.name;
                signature = decodedCall.signature;
                params = this._convertAbiInputsToParams(decodedCall);
            } else {
                // Try API with fallback
                const apiResult = await this.abiManager.lookupFunctionSignatureWithFallback(invocation.selector);
                if (apiResult) {
                    methodName = apiResult.functionName;
                    signature = apiResult.textSignature;
                    params = await this._decodeParametersFromCallData(invocation.callData, apiResult);
                } else {
                    // If no signature found, use raw call
                    console.log(`⚠️  Could not decode function ${invocation.selector} - will use raw calldata`);
                    methodName = `unknownFunction_${invocation.selector}`;
                    useRawCall = true;
                }
            }
        } else if (invocation.callData && invocation.callData !== '0x') {
            // No selector but has calldata (constructor or raw call)
            console.log(`⚠️  No selector found, using raw calldata`);
            methodName = 'unknownCall';
            useRawCall = true;
        }

        // Register address and update interface
        const addressVar = this._registerAddress(targetAddress, addressRegistry, addressCounter);

        // Only update interface if we have a valid signature and not using raw call
        if (!useRawCall && signature && signature !== 'unknown()') {
            this._updateContractInterface(targetAddress, signature, contracts);
        }

        // Add to method calls
        methodCalls.push({
            to: targetAddress,
            addressVar: addressVar,
            methodName: methodName,
            signature: useRawCall ? null : signature,
            params: useRawCall ? null : params,
            value: invocation.value || '0',
            gasUsed: invocation.gasUsed || 'unknown',
            rawCalldata: useRawCall ? (invocation.callData || '0x') : null  // Store raw calldata if using raw call
        });
    }

    /**
     * Convert ABI inputs to parameter format
     * @param {Object} decodedCall - Decoded call data
     * @returns {Array} Parameters array
     * @private
     */
    _convertAbiInputsToParams(decodedCall) {
        if (decodedCall.decodedData && decodedCall.inputs) {
            return decodedCall.inputs.map((input, index) => ({
                type: input.type,
                name: input.name || `param${index}`,
                value: decodedCall.decodedData[index]?.toString() || 'unknown'
            }));
        }
        return [];
    }

    /**
     * Decode parameters from call data using API result
     * @param {string} callData - Call data
     * @param {Object} apiResult - API result
     * @returns {Promise<Array>} Parameters array
     * @private
     */
    async _decodeParametersFromCallData(callData, apiResult) {
        if (!callData || callData.length <= 10) {
            return [];
        }

        try {
            const { ethers } = require('ethers');
            const paramData = '0x' + callData.slice(10);
            const decodedParams = ethers.AbiCoder.defaultAbiCoder().decode(apiResult.parameters, paramData);

            return apiResult.parameters.map((paramType, index) => ({
                type: paramType,
                name: `param${index}`,
                value: decodedParams[index]?.toString() || 'unknown'
            }));
        } catch (error) {
            console.warn(`Failed to decode parameters: ${error.message}`);
            return [{ type: 'bytes', value: callData }];
        }
    }

    /**
     * Find callback ranges in trace data
     * @param {Object} dataMap - Trace data map
     * @param {string} mainAddress - Main contract address
     * @returns {Array} Array of callback ranges
     * @private
     */
    _findCallbackRanges(dataMap, mainAddress) {
        const callbackRanges = [];
        const flashloanPatterns = ['flashloan', 'executeOperation', 'receiveFlashLoan', 'callFunction'];

        for (const [id, entry] of Object.entries(dataMap)) {
            // Handle both plural and singular forms
            const invocations = entry.invocations || (entry.invocation ? [entry.invocation] : []);
            if (invocations.length === 0) continue;

            for (const invocation of invocations) {
                // Check both 'from' and 'fromAddress' fields
                const fromAddr = invocation.from || invocation.fromAddress;
                const targetAddress = invocation.to || invocation.address;

                if (fromAddr && fromAddr.toLowerCase() === mainAddress.toLowerCase()) {
                    const methodName = invocation.decodedMethod?.name || invocation.selector || 'unknown';

                    // Check for flashloan patterns
                    if (flashloanPatterns.some(pattern => methodName.toLowerCase().includes(pattern.toLowerCase()))) {
                        callbackRanges.push({
                            type: 'flashloan',
                            startId: parseInt(id),
                            endId: parseInt(id) + 50, // Estimate callback range
                            methodName: methodName,
                            contractAddress: targetAddress,
                            callData: invocation.callData
                        });
                    }
                }
            }
        }

        return callbackRanges;
    }

    /**
     * Get unique addresses from method calls and registry
     * @param {Array} methodCalls - Method calls
     * @param {Map} addressRegistry - Address registry
     * @returns {Array} Unique addresses
     * @private
     */
    _getUniqueAddresses(methodCalls, addressRegistry) {
        const addresses = new Set();

        // Add addresses from method calls
        methodCalls.forEach(call => {
            if (call.to) addresses.add(call.to);
        });

        // Add addresses from registry
        addressRegistry.forEach((varName, address) => {
            addresses.add(address);
        });

        return Array.from(addresses);
    }

    /**
     * Generate complete test content
     * @param {string} mainAddress - Main contract address
     * @param {string} chain - Chain name
     * @param {number|null} blockNumber - Block number
     * @param {string} rpcUrl - RPC URL
     * @param {Map} contracts - Contracts map
     * @param {Array} methodCalls - Method calls
     * @param {Map} addressRegistry - Address registry
     * @param {Map} tokenInfoMap - Token info map
     * @param {Map} callbacks - Callbacks map
     * @returns {string} Generated test content
     * @private
     */
    _generateTestContent(mainAddress, chain, blockNumber, rpcUrl, contracts, methodCalls, addressRegistry, tokenInfoMap, callbacks) {
        const className = `TraceReproduction`;
        const chainConfig = this.configManager.getChainConfig(chain);

        let testContent = `// SPDX-License-Identifier: MIT\n`;
        testContent += `pragma solidity ^0.8.19;\n\n`;

        testContent += `import "forge-std/Test.sol";\n`;
        testContent += `import "forge-std/console.sol";\n\n`;

        // Generate interfaces
        testContent += this._generateInterfaces(contracts, tokenInfoMap);

        // Generate main test contract
        testContent += `contract ${className} is Test {\n`;

        // Generate state variables
        testContent += this._generateStateVariables(addressRegistry, tokenInfoMap, mainAddress);

        // Generate setup function
        testContent += this._generateSetupFunction(blockNumber, chainConfig.chainId);

        // Generate callback functions if any
        if (callbacks.size > 0) {
            testContent += this.traceParser.generateCallbackFunctions(callbacks, contracts, addressRegistry, mainAddress);
        }

        // Generate main test function
        testContent += this._generateMainTestFunction(methodCalls, addressRegistry, mainAddress, contracts);

        testContent += `}\n`;

        return testContent;
    }

    /**
     * Generate Solidity interfaces
     * @param {Map} contracts - Contracts map
     * @param {Map} tokenInfoMap - Token info map
     * @returns {string} Generated interfaces
     * @private
     */
    _generateInterfaces(contracts, tokenInfoMap) {
        let interfaces = '';
        const processedInterfaces = new Set();

        for (const [address, signatures] of contracts.entries()) {
            const interfaceName = this.abiManager.generateInterfaceName(address, Array.from(signatures));

            if (processedInterfaces.has(interfaceName)) continue;
            processedInterfaces.add(interfaceName);

            interfaces += `interface ${interfaceName} {\n`;

            const structDefinitions = new Set();
            for (const signature of signatures) {
                const fixedSignature = this.abiManager.fixInterfaceSignature(signature, structDefinitions);
                interfaces += `    function ${fixedSignature} external;\n`;
            }

            // Add struct definitions if any
            if (structDefinitions.size > 0) {
                interfaces += `\n    // Struct definitions\n`;
                for (const structDef of structDefinitions) {
                    interfaces += `    ${structDef}\n`;
                }
            }

            interfaces += `}\n\n`;
        }

        return interfaces;
    }

    /**
     * Generate state variables
     * @param {Map} addressRegistry - Address registry
     * @param {Map} tokenInfoMap - Token info map
     * @param {string} mainAddress - Main contract address
     * @returns {string} Generated state variables
     * @private
     */
    _generateStateVariables(addressRegistry, tokenInfoMap, mainAddress) {
        let variables = `    // Addresses\n`;
        variables += `    address constant MAIN_ADDRESS = ${this.traceParser.toChecksumAddress(mainAddress)};\n`;

        // Sort addresses by variable name for consistent output
        const sortedAddresses = Array.from(addressRegistry.entries())
            .sort(([, varA], [, varB]) => varA.localeCompare(varB));

        for (const [address, varName] of sortedAddresses) {
            const tokenInfo = tokenInfoMap.get(address);
            const comment = this._generateAddressComment(address, tokenInfo);

            variables += `    address constant ${varName.toUpperCase()} = ${this.traceParser.toChecksumAddress(address)};${comment}\n`;
        }

        variables += `\n`;
        return variables;
    }

    /**
     * Generate setup function
     * @param {number|null} blockNumber - Block number
     * @param {number} chainId - Chain ID
     * @returns {string} Generated setup function
     * @private
     */
    _generateSetupFunction(blockNumber, chainId) {
        let setup = `    function setUp() public {\n`;

        if (blockNumber) {
            setup += `        // Fork at specific block\n`;
            setup += `        vm.createFork(vm.envString("RPC_URL"), ${blockNumber});\n`;
        } else {
            setup += `        // Fork at latest block\n`;
            setup += `        vm.createFork(vm.envString("RPC_URL"));\n`;
        }

        setup += `        vm.selectFork(0);\n`;
        setup += `        \n`;
        setup += `        // Setup test environment\n`;
        setup += `        vm.label(MAIN_ADDRESS, "MainContract");\n`;
        setup += `        \n`;
        setup += `        // Deal some ETH to main address for gas\n`;
        setup += `        vm.deal(MAIN_ADDRESS, 10 ether);\n`;
        setup += `    }\n\n`;

        return setup;
    }

    /**
     * Generate main test function
     * @param {Array} methodCalls - Method calls
     * @param {Map} addressRegistry - Address registry
     * @param {string} mainAddress - Main contract address
     * @param {Map} contracts - Contracts map with signatures
     * @returns {string} Generated test function
     * @private
     */
    _generateMainTestFunction(methodCalls, addressRegistry, mainAddress, contracts) {
        let testFunc = `    function testReproduceTrace() public {\n`;
        testFunc += `        // Start prank as main address\n`;
        testFunc += `        vm.startPrank(MAIN_ADDRESS);\n\n`;

        // Group calls by target address for better organization
        const callsByAddress = new Map();
        methodCalls.forEach(call => {
            if (!callsByAddress.has(call.to)) {
                callsByAddress.set(call.to, []);
            }
            callsByAddress.get(call.to).push(call);
        });

        // Generate calls
        for (const [address, calls] of callsByAddress.entries()) {
            const addressVar = addressRegistry.get(address.toLowerCase()) || address;
            testFunc += `        // Calls to ${addressVar.toUpperCase()}\n`;

            for (const call of calls) {
                testFunc += this._generateSingleCall(call, addressRegistry, mainAddress, contracts);
            }

            testFunc += `\n`;
        }

        testFunc += `        vm.stopPrank();\n`;
        testFunc += `    }\n`;

        return testFunc;
    }

    /**
     * Generate single method call
     * @param {Object} call - Call data
     * @param {Map} addressRegistry - Address registry
     * @param {string} mainAddress - Main contract address
     * @param {Map} contracts - Contracts map with signatures
     * @returns {string} Generated call
     * @private
     */
    _generateSingleCall(call, addressRegistry, mainAddress, contracts) {
        const addressVar = call.addressVar.toUpperCase();
        let callCode = `        // ${call.methodName}\n`;

        // If signature is unknown, use raw calldata
        if (!call.signature && call.rawCalldata !== null) {
            // For empty calldata (0x), we need to construct the selector
            let hexData = call.rawCalldata;
            if (hexData === '0x' && call.methodName.startsWith('unknownFunction_0x')) {
                // Construct calldata from selector
                const selector = call.methodName.replace('unknownFunction_', '');
                hexData = selector;
            }

            callCode += `        // ⚠️  Unknown function selector - using raw calldata\n`;
            callCode += `        (bool success, bytes memory result) = ${addressVar}.call`;
            if (call.value && call.value !== '0') {
                callCode += `{value: ${call.value}}`;
            }
            callCode += `(\n`;
            // Only slice if it starts with 0x
            const dataToUse = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
            callCode += `            hex"${dataToUse}"\n`;
            callCode += `        );\n`;
            callCode += `        require(success, "Raw call failed");\n`;
            callCode += `        console.logBytes(result); // Log the result for debugging\n\n`;
        } else if (call.value && call.value !== '0') {
            const formattedParams = this._formatCallParameters(call.params, addressRegistry, mainAddress);
            callCode += `        (bool success, ) = ${addressVar}.call{value: ${call.value}}(\n`;
            callCode += `            abi.encodeWithSignature("${call.signature}", ${formattedParams})\n`;
            callCode += `        );\n`;
            callCode += `        require(success, "Call failed");\n\n`;
        } else if (call.signature) {
            const formattedParams = this._formatCallParameters(call.params, addressRegistry, mainAddress);
            // Use consolidated interface from contracts map
            const contractSignatures = contracts.get(call.to) || new Set([call.signature]);
            const interfaceName = this.abiManager.generateInterfaceName(call.to, Array.from(contractSignatures));
            callCode += `        ${interfaceName}(${addressVar}).${call.methodName}(${formattedParams});\n\n`;
        }

        return callCode;
    }

    /**
     * Generate address comment
     * @param {string} address - Address
     * @param {Object|null} tokenInfo - Token information
     * @returns {string} Generated comment
     * @private
     */
    _generateAddressComment(address, tokenInfo) {
        if (!tokenInfo) return '';

        if (tokenInfo.type === 'UniswapV2Pair') {
            return ` // ${tokenInfo.name}`;
        } else if (tokenInfo.type === 'ERC20') {
            return ` // ${tokenInfo.name} (${tokenInfo.symbol})`;
        }

        return ` // ${tokenInfo.name || 'Contract'}`;
    }

    /**
     * Format parameters for function calls
     * @param {Array} params - Parameters
     * @param {Map} addressRegistry - Address registry
     * @param {string} mainAddress - Main contract address
     * @returns {string} Formatted parameters
     * @private
     */
    _formatCallParameters(params, addressRegistry, mainAddress) {
        if (!params || params.length === 0) return '';

        return params.map(param =>
            this.traceParser.formatParameterValueForCall(param, addressRegistry, mainAddress)
        ).join(', ');
    }

    /**
     * Register address and return variable name
     * @param {string} address - Address to register
     * @param {Map} addressRegistry - Address registry
     * @param {Map} addressCounter - Address counter
     * @returns {string} Variable name
     * @private
     */
    _registerAddress(address, addressRegistry, addressCounter) {
        const lowerAddr = address.toLowerCase();

        if (!addressRegistry.has(lowerAddr)) {
            let counter = addressCounter.get('total') || 0;
            counter++;
            addressCounter.set('total', counter);

            const varName = `addr${counter}`;
            addressRegistry.set(lowerAddr, varName);
        }

        return addressRegistry.get(lowerAddr);
    }

    /**
     * Update contract interface with signature
     * @param {string} address - Contract address
     * @param {string} signature - Function signature
     * @param {Map} contracts - Contracts map
     * @private
     */
    _updateContractInterface(address, signature, contracts) {
        if (!contracts.has(address)) {
            contracts.set(address, new Set());
        }
        contracts.get(address).add(signature);
    }

    /**
     * Generate package.json file
     * @returns {string} Generated package.json content
     */
    generatePackageJson() {
        return `{
  "name": "trace-reproduction",
  "version": "1.0.0",
  "description": "Reproduced transaction trace using Foundry",
  "scripts": {
    "test": "forge test",
    "build": "forge build",
    "fmt": "forge fmt"
  },
  "devDependencies": {
    "forge-std": "^1.7.0"
  },
  "license": "MIT"
}`;
    }

    /**
     * Generate foundry.toml configuration
     * @returns {string} Generated foundry.toml content
     */
    generateFoundryToml() {
        const supportedChains = this.configManager.getSupportedChains();
        const rpcEndpoints = supportedChains.map(chain => {
            const config = this.configManager.getChainConfig(chain);
            const envVar = config.envVars[0]; // Use first env var
            return `${chain} = "\${${envVar}}"`;
        }).join(', ');

        return `[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
rpc_endpoints = { ${rpcEndpoints} }

[fmt]
line_length = 120
tab_width = 4
bracket_spacing = true
int_types = "long"`;
    }

    /**
     * Generate .env.example file
     * @returns {string} Generated .env.example content
     */
    generateEnvExample() {
        const supportedChains = this.configManager.getSupportedChains();
        const envVars = [];
        const apiKeys = [];

        supportedChains.forEach(chain => {
            const config = this.configManager.getChainConfig(chain);

            // Add RPC URL env vars
            config.envVars.forEach(envVar => {
                const defaultUrl = config.rpcUrls[0].replace('YOUR_INFURA_KEY', 'YOUR_INFURA_KEY');
                envVars.push(`${envVar}=${defaultUrl}`);
            });

            // Add API key env vars
            const apiKeyEnv = config.explorerApi.apiKeyEnv;
            if (!apiKeys.some(key => key.startsWith(apiKeyEnv))) {
                apiKeys.push(`${apiKeyEnv}=Your${config.name.replace(' ', '')}ApiKey`);
            }
        });

        return `# RPC URLs for supported chains
${envVars.join('\n')}

# Explorer API Keys (optional)
${apiKeys.join('\n')}

# Default chain to use
CHAIN=ethereum`;
    }

    /**
     * Generate README.md file
     * @returns {string} Generated README.md content
     */
    generateReadme() {
        return `# Trace Reproduction Test

This project reproduces a transaction trace using Foundry for testing and development.

## Setup

1. Install Foundry:
\`\`\`bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
\`\`\`

2. Copy \`.env.example\` to \`.env\` and fill in your RPC URLs:
\`\`\`bash
cp .env.example .env
\`\`\`

3. Set your target chain (optional):
\`\`\`bash
# Supported chains: ${this.configManager.getSupportedChains().join(', ')}
export CHAIN=ethereum  # Default

# Examples for other chains:
export CHAIN=base
export CHAIN=arbitrum
export CHAIN=polygon
export CHAIN=optimism
\`\`\`

4. Generate the test with manual address:
\`\`\`bash
# Using command line argument
node index.js path/to/trace.json 0xYourMainAddress

# Or set in environment
export MAIN_ADDRESS=0xYourMainAddress
node index.js path/to/trace.json
\`\`\`

## Running Tests

\`\`\`bash
# Install dependencies
forge install

# Run tests
forge test

# Run with verbose output
forge test -vvv
\`\`\`

## Test Options

\`\`\`bash
# Run on Ethereum mainnet
forge test --match-test testReproduceTrace -vvv --fork-url \\$RPC_URL

# Run on Base chain
forge test --match-test testReproduceTrace -vvv --fork-url \\$BASE_RPC_URL
\`\`\`

## Generated Files

- \`test/TraceReproduction.t.sol\` - Main test contract
- \`foundry.toml\` - Foundry configuration
- \`.env.example\` - Environment variables template
- \`package.json\` - Project metadata

## Notes

- The test reproduces the exact sequence of calls from the original trace
- All addresses are labeled and organized for easy understanding
- Flash loan callbacks are automatically detected and implemented
- Token information is fetched and included as comments
`;
    }
}

module.exports = FoundryGenerator;