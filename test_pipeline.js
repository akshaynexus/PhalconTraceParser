#!/usr/bin/env node

/**
 * Integration test script to validate the complete pipeline works
 * Uses real network calls and APIs
 */

const fs = require('fs');
const path = require('path');
const { PhalconTraceParser } = require('./index.js');

async function runIntegrationTest() {
    console.log('🧪 Starting PhalconTraceParser Integration Test');

    try {
        // Test 1: Initialize parser
        console.log('\n📋 Test 1: Initialize parser');
        const parser = new PhalconTraceParser();
        console.log('✅ Parser initialized successfully');

        // Test 2: Check if trace.json exists
        console.log('\n📋 Test 2: Check trace.json file');
        const traceFile = path.join(__dirname, 'trace.json');
        if (!fs.existsSync(traceFile)) {
            throw new Error('trace.json file not found');
        }
        console.log('✅ trace.json file exists');

        // Test 3: Process trace with minimal output
        console.log('\n📋 Test 3: Process trace file (this may take a while...)');
        const outputDir = path.join(__dirname, 'test_output');

        // Clean up previous test output
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }

        const outputFile = path.join(outputDir, 'test/TraceReproduction.t.sol');

        // The process method doesn't return a structured result, it processes and generates files
        await parser.process(
            traceFile,
            '0x5b9b4b4dafbcfceea7afba56958fcbb37d82d4a2', // Main address from trace
            outputFile
        );
        console.log('✅ Trace processing completed successfully');

        // Test 4: Verify output files
        console.log('\n📋 Test 4: Verify generated files');

        // Main Solidity test file goes in output directory
        const testFile = path.join(outputDir, 'test/TraceReproduction.t.sol');
        if (!fs.existsSync(testFile)) {
            throw new Error('Expected test file not found: test/TraceReproduction.t.sol');
        }
        console.log('✅ Generated: test/TraceReproduction.t.sol');

        // Supporting files are generated in current directory
        const supportingFiles = [
            'foundry.toml',
            '.env.example',
            'README.md',
            'package.json'
        ];

        for (const file of supportingFiles) {
            const filePath = path.join(__dirname, file);
            if (!fs.existsSync(filePath)) {
                throw new Error(`Expected supporting file not found: ${file}`);
            }
            console.log(`✅ Generated: ${file}`);
        }

        // Test 5: Validate Solidity file content
        console.log('\n📋 Test 5: Validate Solidity content');
        const solidityFile = path.join(outputDir, 'test/TraceReproduction.t.sol');
        const solidityContent = fs.readFileSync(solidityFile, 'utf8');

        const requiredPatterns = [
            'pragma solidity',
            'import "forge-std/Test.sol"',
            'contract TraceReproduction is Test',
            'function setUp()',
            'function testReproduceTrace()'
        ];

        for (const pattern of requiredPatterns) {
            if (!solidityContent.includes(pattern)) {
                throw new Error(`Solidity file missing required pattern: ${pattern}`);
            }
        }
        console.log('✅ Solidity file contains all required patterns');

        // Test 6: Check parser status
        console.log('\n📋 Test 6: Check parser status');
        const status = parser.getStatus();
        console.log(`📊 Parser Status:`);
        console.log(`   - Initialized: ${status.initialized}`);
        console.log(`   - Config loaded: ${status.configLoaded}`);
        console.log(`   - Modules ready: ${status.modulesReady}`);

        console.log('✅ Parser status available');

        // Test 7: Test configuration loading
        console.log('\n📋 Test 7: Test configuration system');
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (!config.chains || Object.keys(config.chains).length === 0) {
                throw new Error('Configuration file missing chain data');
            }
            console.log(`✅ Configuration loaded with ${Object.keys(config.chains).length} chains`);
        }

        console.log('\n🎉 All integration tests passed!');
        console.log(`\n📁 Test output generated in: ${outputDir}`);
        console.log('\n🔧 Next steps to run the generated test:');
        console.log(`   1. cd ${path.relative(process.cwd(), outputDir)}`);
        console.log('   2. cp .env.example .env');
        console.log('   3. Edit .env with your RPC_URL');
        console.log('   4. forge install');
        console.log('   5. forge test -vvv');

    } catch (error) {
        console.error('\n❌ Integration test failed:', error.message);
        console.error('\n🔍 Error details:', error);
        process.exit(1);
    }
}

// Run the integration test
if (require.main === module) {
    runIntegrationTest().catch(error => {
        console.error('Unexpected error:', error);
        process.exit(1);
    });
}

module.exports = { runIntegrationTest };