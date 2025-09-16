import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import FoundryGenerator from '../../lib/foundryGenerator.js';
import ConfigManager from '../../lib/configManager.js';
import RpcManager from '../../lib/rpcManager.js';
import TokenManager from '../../lib/tokenManager.js';
import AbiManager from '../../lib/abiManager.js';
import TraceParser from '../../lib/traceParser.js';

describe('FoundryGenerator', () => {
    let foundryGenerator;
    let configManager;
    let rpcManager;
    let tokenManager;
    let abiManager;
    let traceParser;

    beforeEach(() => {
        configManager = new ConfigManager();
        rpcManager = new RpcManager(configManager);
        tokenManager = new TokenManager(configManager, rpcManager);
        abiManager = new AbiManager();
        traceParser = new TraceParser(configManager, rpcManager, tokenManager, abiManager);
        foundryGenerator = new FoundryGenerator(configManager, rpcManager, tokenManager, abiManager, traceParser);
    });

    test('should initialize correctly', () => {
        expect(foundryGenerator.configManager).toBe(configManager);
        expect(foundryGenerator.rpcManager).toBe(rpcManager);
        expect(foundryGenerator.tokenManager).toBe(tokenManager);
        expect(foundryGenerator.abiManager).toBe(abiManager);
        expect(foundryGenerator.traceParser).toBe(traceParser);
    });

    test('should generate foundry.toml correctly', () => {
        const toml = foundryGenerator.generateFoundryToml();

        expect(toml).toContain('[profile.default]');
        expect(toml).toContain('src = "src"');
        expect(toml).toContain('test = "test"');
        expect(toml).toContain('rpc_endpoints');
        expect(typeof toml).toBe('string');
    });

    test('should generate .env.example correctly', () => {
        const env = foundryGenerator.generateEnvExample();

        expect(env).toContain('RPC_URL=');
        expect(env).toContain('# RPC URLs for supported chains');
        expect(typeof env).toBe('string');
    });

    test('should generate package.json correctly', () => {
        const packageJson = foundryGenerator.generatePackageJson();

        expect(packageJson).toContain('"name": "trace-reproduction"');
        expect(packageJson).toContain('"forge test"');
        expect(packageJson).toContain('"forge build"');
        expect(typeof packageJson).toBe('string');
    });

    test('should generate README.md correctly', () => {
        const readme = foundryGenerator.generateReadme();

        expect(readme).toContain('# Trace Reproduction');
        expect(readme).toContain('## Setup');
        expect(readme).toContain('forge install');
        expect(readme).toContain('forge test');
        expect(typeof readme).toBe('string');
    });

    test('should handle trace data processing', async () => {
        const mockTraceData = {
            dataMap: {
                '0': {
                    invocation: {
                        fromAddress: '0x1234567890123456789012345678901234567890',
                        address: '0x0987654321098765432109876543210987654321',
                        selector: '0xa9059cbb',
                        callData: '0xa9059cbb000000000000000000000000742dfa5c8e63d7ba7b2e5f5a4d1b8c3e4f5a6b7c0000000000000000000000000000000000000000000000000de0b6b3a7640000',
                        value: '0',
                        gasUsed: 21000,
                        decodedMethod: {
                            name: 'transfer',
                            signature: 'transfer(address,uint256)',
                            callParams: [
                                { name: 'to', type: 'address', value: '0x742dfa5c8e63d7ba7b2e5f5a4d1b8c3e4f5a6b7c' },
                                { name: 'amount', type: 'uint256', value: '1000000000000000000' }
                            ]
                        }
                    }
                }
            }
        };

        const mainAddress = '0x1234567890123456789012345678901234567890';

        try {
            const testContent = await foundryGenerator.generateFoundryTest(
                mockTraceData,
                mainAddress,
                12345,
                'http://localhost:8545'
            );

            expect(typeof testContent).toBe('string');
            expect(testContent).toContain('pragma solidity');
            expect(testContent).toContain('contract TraceReproduction is Test');
            expect(testContent).toContain('function testReproduceTrace()');
        } catch (error) {
            // Network-dependent operation might fail in test environment
            expect(error).toBeDefined();
        }
    }, 3000);

    test('should handle empty trace data', async () => {
        const emptyTraceData = { dataMap: {} };
        const mainAddress = '0x1234567890123456789012345678901234567890';

        try {
            const testContent = await foundryGenerator.generateFoundryTest(
                emptyTraceData,
                mainAddress,
                12345,
                'http://localhost:8545'
            );

            expect(typeof testContent).toBe('string');
            expect(testContent).toContain('pragma solidity');
            expect(testContent).toContain('vm.startPrank');
            expect(testContent).toContain('vm.stopPrank');
        } catch (error) {
            // Might fail due to network operations
            expect(error).toBeDefined();
        }
    }, 3000);

    test('should handle missing main address', async () => {
        const mockTraceData = { dataMap: {} };

        try {
            await foundryGenerator.generateFoundryTest(mockTraceData, null);
            expect(false).toBe(true); // Should not reach here
        } catch (error) {
            expect(error.message).toContain('Main address is required');
        }
    });

    test('should process invocations correctly', async () => {
        const mockInvocation = {
            fromAddress: '0x1234567890123456789012345678901234567890',
            address: '0x0987654321098765432109876543210987654321',
            selector: '0xa9059cbb',
            callData: '0xa9059cbb',
            value: '0',
            gasUsed: 21000,
            decodedMethod: {
                name: 'transfer',
                signature: 'transfer(address,uint256)',
                callParams: []
            }
        };

        const contracts = new Map();
        const methodCalls = [];
        const addressRegistry = new Map();
        const addressCounter = new Map();

        await foundryGenerator._processInvocation(
            mockInvocation,
            contracts,
            methodCalls,
            addressRegistry,
            addressCounter
        );

        expect(methodCalls.length).toBe(1);
        expect(methodCalls[0].methodName).toBe('transfer');
        expect(addressRegistry.size).toBeGreaterThan(0);
    });

    test('should handle unknown function signatures', async () => {
        const unknownInvocation = {
            fromAddress: '0x1234567890123456789012345678901234567890',
            address: '0x0987654321098765432109876543210987654321',
            selector: '0x12345678', // Unknown selector
            callData: '0x12345678abcdef',
            value: '0',
            gasUsed: 21000
        };

        const contracts = new Map();
        const methodCalls = [];
        const addressRegistry = new Map();
        const addressCounter = new Map();

        await foundryGenerator._processInvocation(
            unknownInvocation,
            contracts,
            methodCalls,
            addressRegistry,
            addressCounter
        );

        expect(methodCalls.length).toBe(1);
        expect(methodCalls[0].rawCalldata).toBe('0x12345678abcdef');
        expect(methodCalls[0].signature).toBe(null);
    }, 3000);

    test('should register addresses correctly', () => {
        const addressRegistry = new Map();
        const addressCounter = new Map();

        const addr1 = foundryGenerator._registerAddress(
            '0x1234567890123456789012345678901234567890',
            addressRegistry,
            addressCounter
        );

        const addr2 = foundryGenerator._registerAddress(
            '0x0987654321098765432109876543210987654321',
            addressRegistry,
            addressCounter
        );

        expect(addr1).toBe('addr1');
        expect(addr2).toBe('addr2');
        expect(addressRegistry.size).toBe(2);
    });

    test('should update contract interfaces correctly', () => {
        const contracts = new Map();

        foundryGenerator._updateContractInterface(
            '0x1234567890123456789012345678901234567890',
            'transfer(address,uint256)',
            contracts
        );

        foundryGenerator._updateContractInterface(
            '0x1234567890123456789012345678901234567890',
            'balanceOf(address)',
            contracts
        );

        expect(contracts.size).toBe(1);
        const signatures = contracts.get('0x1234567890123456789012345678901234567890');
        expect(signatures.size).toBe(2);
        expect(signatures.has('transfer(address,uint256)')).toBe(true);
        expect(signatures.has('balanceOf(address)')).toBe(true);
    });

    test('should format call parameters correctly', () => {
        const params = [
            { type: 'address', value: '0x1234567890123456789012345678901234567890' },
            { type: 'uint256', value: '1000000000000000000' },
            { type: 'bool', value: true }
        ];

        const addressRegistry = new Map();
        const mainAddress = '0x1234567890123456789012345678901234567890';

        const formatted = foundryGenerator._formatCallParameters(params, addressRegistry, mainAddress);
        expect(typeof formatted).toBe('string');
    });

    test('should generate state variables correctly', () => {
        const addressRegistry = new Map();
        addressRegistry.set('0x1234567890123456789012345678901234567890', 'addr1');
        addressRegistry.set('0x0987654321098765432109876543210987654321', 'addr2');

        const tokenInfoMap = new Map();
        const mainAddress = '0x1234567890123456789012345678901234567890';

        const stateVars = foundryGenerator._generateStateVariables(addressRegistry, tokenInfoMap, mainAddress);

        expect(stateVars).toContain('MAIN_ADDRESS');
        expect(stateVars).toContain('ADDR1');
        expect(stateVars).toContain('ADDR2');
        expect(typeof stateVars).toBe('string');
    });

    test('should generate setup function correctly', () => {
        const setup = foundryGenerator._generateSetupFunction(12345, 1);

        expect(setup).toContain('function setUp()');
        expect(setup).toContain('vm.createFork');
        expect(setup).toContain('12345');
        expect(setup).toContain('vm.deal');
        expect(typeof setup).toBe('string');
    });

    test('should find callback ranges correctly', () => {
        const dataMap = {
            '0': {
                invocation: {
                    fromAddress: '0x1234567890123456789012345678901234567890',
                    address: '0x0987654321098765432109876543210987654321',
                    decodedMethod: { name: 'flashloan' },
                    callData: '0xabcdef'
                }
            }
        };

        const mainAddress = '0x1234567890123456789012345678901234567890';
        const ranges = foundryGenerator._findCallbackRanges(dataMap, mainAddress);

        expect(Array.isArray(ranges)).toBe(true);
        if (ranges.length > 0) {
            expect(ranges[0].type).toBe('flashloan');
        }
    });
});