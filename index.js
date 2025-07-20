#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function generateFoundryTest(traceData) {
    const { dataMap } = traceData;
    
    // Find contract addresses and method calls
    const contracts = new Map();
    const methodCalls = [];
    
    // Process all invocations
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value.invocation && value.invocation.decodedMethod) {
            const { decodedMethod, address, fromAddress } = value.invocation;
            if (decodedMethod.name && decodedMethod.signature) {
                methodCalls.push({
                    id: key,
                    contract: address,
                    from: fromAddress,
                    method: decodedMethod.name,
                    signature: decodedMethod.signature,
                    params: decodedMethod.callParams || []
                });
                
                // Track contracts
                if (!contracts.has(address)) {
                    contracts.set(address, {
                        address,
                        methods: new Set()
                    });
                }
                contracts.get(address).methods.add(decodedMethod.name);
            }
        }
    });
    
    // Generate interface definitions
    const interfaces = [];
    contracts.forEach((contract, addr) => {
        const methods = Array.from(contract.methods);
        const interfaceName = `I${addr.slice(2, 8)}`;
        
        const methodDefs = methods.map(method => {
            const call = methodCalls.find(c => c.method === method);
            if (call) {
                return `    function ${call.signature};`;
            }
            return `    function ${method}();`;
        }).join('\n');
        
        interfaces.push(`interface ${interfaceName} {\n${methodDefs}\n}`);
    });
    
    // Generate test contract
    const contractName = 'TraceReproductionTest';
    const mainAddress =  '0x7d3bd50336f64b7a473c51f54e7f0bd6771cc355';
    
    // Generate method calls in order
    const orderedCalls = methodCalls
        .sort((a, b) => parseInt(a.id) - parseInt(b.id))
        
        .map(call => {
            const contractName = `I${call.contract.slice(2, 8)}`;
            const params = call.params.map(p => {
                if (p.type === 'address[]') {
                    return `new address[](1) memory path; path[0] = ${p.value[0]}; path`;
                }
                if (p.type === 'uint256') {
                    return p.value.replace(/,/g, '');
                }
                if (p.type === 'address') {
                    return p.value;
                }
                if (p.type === 'bool') {
                    return p.value.toString();
                }
                return '0';
            }).join(', ');
            
            return `        ${contractName}(${call.contract}).${call.method}(${params});`;
        }).join('\n');
    
    const testContent = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

${interfaces.join('\n\n')}

contract ${contractName} is Test {
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
${orderedCalls}
    }

    function testPriceCalls() public view {
        // Add any price/view calls here
    }
}`;

    return testContent;
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
  "devDependencies": {
    "bun": "^1.0.0"
  }
}`;
}

function generateFoundryToml() {
    return `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
rpc_endpoints = { mainnet = "\${RPC_URL}", arbitrum = "\${ARBITRUM_RPC_URL}" }

[fmt]
line_length = 120
tab_width = 4
bracket_spacing = false
int_types = "preserve"`;
}

function generateEnvExample() {
    return `RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc`;
}

function generateReadme() {
    return `# Trace Reproduction Test

This Foundry test reproduces the main calls from the provided trace.json file. It uses the actual contract addresses and method calls to simulate the transaction flow.

## Setup

1. Install dependencies:
\`\`\`bash
bun install
\`\`\`

2. Copy \`.env.example\` to \`.env\` and fill in your RPC URLs

3. Install Foundry if you haven't already:
\`\`\`bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
\`\`\`

## Running Tests

\`\`\`bash
# Run all tests
bun run test

# Run specific test
bun run test:trace
bun run test:price

# Generate new test from trace.json
bun run generate
\`\`\`

## Usage

Place your \`trace.json\` in the project root and run \`bun run generate\` to create the Foundry test boilerplate.`;
}

function main() {
    const tracePath = process.argv[2] || 'trace.json';
    
    if (!fs.existsSync(tracePath)) {
        console.error(`Error: ${tracePath} not found`);
        console.error('Usage: node index.js [path/to/trace.json]');
        process.exit(1);
    }
    
    try {
        const traceData = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
        
        // Generate files
        const testContent = generateFoundryTest(traceData);
        const packageJson = generatePackageJson();
        const foundryToml = generateFoundryToml();
        const envExample = generateEnvExample();
        const readme = generateReadme();
        
        // Write files
        fs.writeFileSync('test/TraceReproduction.t.sol', testContent);
        fs.writeFileSync('package.json', packageJson);
        fs.writeFileSync('foundry.toml', foundryToml);
        fs.writeFileSync('.env.example', envExample);
        fs.writeFileSync('README.md', readme);
        
        console.log('✅ Generated Foundry test boilerplate:');
        console.log('   - test/TraceReproduction.t.sol');
        console.log('   - package.json');
        console.log('   - foundry.toml');
        console.log('   - .env.example');
        console.log('   - README.md');
        
    } catch (error) {
        console.error('Error processing trace.json:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { generateFoundryTest };
