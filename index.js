const fs = require('fs');
const path = require('path');

function generateFoundryTest(traceData, mainAddress) {
    const { dataMap } = traceData;
    
    if (!mainAddress) {
        // Fallback to finding from root transaction if not provided
        const rootKey = Object.keys(dataMap).find(key => key === '0' || key === 'root');
        if (rootKey && dataMap[rootKey].invocation) {
            mainAddress = dataMap[rootKey].invocation.from;
        }
    }
    
    if (!mainAddress) {
        throw new Error('Could not determine main address from trace and none provided');
    }
    
    const contracts = new Map();
    const methodCalls = [];
    
    // Debug: log what we're looking for
    console.log(`Filtering for calls from address: ${mainAddress}`);
    
    // Process all invocations and filter for calls FROM main address
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value.invocation && value.invocation.decodedMethod) {
            const invocation = value.invocation;
            const from = invocation.from?.toLowerCase();
            const to = invocation.to?.toLowerCase();
            
            // More flexible filtering - accept any call-like operation
            const isCall = invocation.operation === 'CALL' || 
                          invocation.type === 'CALL' || 
                          !invocation.operation || // Default to include if no operation specified
                          (invocation.operation && invocation.operation !== 'STATICCALL');
            
            if (from === mainAddress.toLowerCase() && isCall) {
                const contractAddress = to;
                const methodName = invocation.decodedMethod.name;
                const signature = invocation.decodedMethod.signature || `${methodName}()`;
                const params = invocation.decodedMethod.callParams || [];
                
                console.log(`Found call: ${methodName} from ${invocation.from} to ${to}`);
                
                // Track contract interfaces
                if (!contracts.has(contractAddress)) {
                    contracts.set(contractAddress, new Set());
                }
                contracts.get(contractAddress).add(signature);
                
                // Store method call with proper parameter formatting
                methodCalls.push({
                    contractAddress,
                    methodName,
                    signature,
                    params
                });
            }
        }
    });
    
    // Debug: log what we found
    console.log(`Found ${methodCalls.length} calls to include`);
    
    // Generate interfaces
    let interfaces = '';
    contracts.forEach((signatures, address) => {
        const interfaceName = `I${address.slice(2, 8)}`;
        interfaces += `interface ${interfaceName} {\n`;
        
        Array.from(signatures).forEach(signature => {
            interfaces += `    function ${signature};\n`;
        });
        
        interfaces += '}\n\n';
    });
    
    // Generate test calls with proper parameter handling
    let testCalls = '';
    methodCalls.forEach(({ contractAddress, methodName, signature, params }) => {
        const interfaceName = `I${contractAddress.slice(2, 8)}`;
        
        // Format parameters based on type
        const paramValues = params.map((param) => {
            if (param.type === 'address') {
                return param.value;
            } else if (param.type === 'uint256' || param.type === 'uint128' || param.type === 'uint64') {
                return param.value.replace(/,/g, '');
            } else if (param.type === 'bool') {
                return param.value.toString();
            } else if (param.type === 'address[]') {
                return `[${param.value.join(', ')}]`;
            } else if (param.type === 'bytes') {
                return param.value;
            } else {
                return `"${param.value}"`;
            }
        }).join(', ');
        
        testCalls += `        ${interfaceName}(${contractAddress}).${methodName}(${paramValues});\n`;
    });
    
    return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

${interfaces}
contract TraceReproductionTest is Test {
    address constant MAIN_ADDRESS = ${mainAddress};
    
    function setUp() public {
        // Fork mainnet or testnet where these contracts exist
        vm.createSelectFork(vm.envString("RPC_URL"));
        
        // Impersonate the main address
        vm.startPrank(MAIN_ADDRESS);
        
        // Give some ETH to the main address
        vm.deal(MAIN_ADDRESS, 1 ether);
    }
    
    function testReproduceTrace() public {
${testCalls}    }
    
    function testPriceCalls() public view {
        // Add any price/view calls here
    }
}`;
}

function generatePackageJson() {
    return `{
  "name": "trace-reproduction",
  "version": "1.0.0",
  "description": "Foundry test to reproduce Ethereum transaction flow from trace.json",
  "scripts": {
    "test": "forge test -vvv",
    "test:trace": "forge test --match-test testReproduceTrace -vvv",
    "test:price": "forge test --match-test testPriceCalls -vvv",
    "generate": "node index.js"
  },
  "keywords": ["foundry", "ethereum", "testing", "trace"],
  "author": "",
  "license": "ISC"
}`;
}

function generateFoundryToml() {
    return `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
rpc_endpoints = { mainnet = "${RPC_URL}", arbitrum = "${ARBITRUM_RPC_URL}" }

[fmt]
line_length = 120
tab_width = 4`;
}

function generateEnvExample() {
    return `RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc`;
}

function generateReadme() {
    return `# Trace Reproduction Test

This Foundry test reproduces the main calls from the provided trace.json file. It uses the actual contract addresses and method calls made by the specified main address in the trace.

## Setup

1. Install dependencies:
\`\`\`bash
bun install
\`\`\`

2. Copy \`.env.example\` to \`.env\) and fill in your RPC URLs:
\`\`\`bash
cp .env.example .env
\`\`\`

3. Generate the test with manual address:
\`\`\`bash
# Using command line argument
node index.js trace.json 0x1234...5678

# Using environment variable
export MAIN_ADDRESS=0x1234...5678
node index.js trace.json

# Let it auto-detect from trace
node index.js trace.json
\`\`\`

4. Run the test:
\`\`\`bash
bun run test:trace
\`\`\`

## Test Structure

- \`testReproduceTrace()\`: Reproduces the exact calls made by the main address in the trace
- \`testPriceCalls()\`: Placeholder for additional price/view calls`;
}

function main() {
    const tracePath = process.argv[2] || 'trace.json';
    let mainAddress = process.argv[3] || process.env.MAIN_ADDRESS || '0x7d3bd50336f64b7a473c51f54e7f0bd6771cc355';
    
    if (!fs.existsSync(tracePath)) {
        console.error(`Error: ${tracePath} not found`);
        console.error('Usage: node index.js [path/to/trace.json] [main_address]');
        console.error('Or set MAIN_ADDRESS environment variable');
        process.exit(1);
    }
    
    try {
        const traceData = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
        
        // Generate Foundry test
        const testContent = generateFoundryTest(traceData, mainAddress);
        fs.writeFileSync('test/TraceReproduction.t.sol', testContent);
        
        // Generate package.json
        const packageJson = generatePackageJson();
        fs.writeFileSync('package.json', packageJson);
        
        // Generate foundry.toml
        const foundryToml = generateFoundryToml();
        fs.writeFileSync('foundry.toml', foundryToml);
        
        // Generate .env.example
        const envExample = generateEnvExample();
        fs.writeFileSync('.env.example', envExample);
        
        // Generate README.md
        const readme = generateReadme();
        fs.writeFileSync('README.md', readme);
        
        console.log('✅ Generated Foundry test and configuration files');
        console.log(`   - Main address: ${mainAddress}`);
        
        // Count calls for debugging
        let callCount = 0;
        Object.entries(traceData.dataMap).forEach(([key, value]) => {
            if (value.invocation && value.invocation.decodedMethod) {
                const invocation = value.invocation;
                const from = invocation.from?.toLowerCase();
                const isCall = invocation.operation === 'CALL' || 
                              invocation.type === 'CALL' || 
                              !invocation.operation;
                
                if (from === mainAddress.toLowerCase() && isCall) {
                    callCount++;
                }
            }
        });
        console.log(`   - Found ${callCount} calls to include`);
        
    } catch (error) {
        console.error('Error processing trace:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { generateFoundryTest };
