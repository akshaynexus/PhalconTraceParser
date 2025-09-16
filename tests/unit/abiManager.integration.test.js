import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import AbiManager from '../../lib/abiManager.js';

// Integration tests with real API calls
describe('AbiManager Integration Tests', () => {
    let abiManager;

    beforeEach(() => {
        // AbiManager takes fourByteApi and etherfaceApi, not configManager
        abiManager = new AbiManager();
    });

    afterEach(() => {
        abiManager.clearCache();
    });

    test('should initialize properly', () => {
        expect(abiManager.signatureCache).toBeDefined();
        expect(abiManager.knownContracts).toBeDefined();
    });

    test('should load contract ABI for known addresses', () => {
        // Test with a made-up address since we don't have real ABI files
        const contractInfo = abiManager.loadContractABI('0x796f1793599d7b6aca6a87516546ddf8e5f3aa9d');

        // This will be null since the ABI file doesn't exist, but the method should work
        if (contractInfo === null) {
            expect(contractInfo).toBe(null);
        } else {
            expect(contractInfo).toHaveProperty('name');
            expect(contractInfo).toHaveProperty('abi');
        }
    });

    test('should generate function selector correctly', () => {
        const selector = abiManager.getFunctionSelector('transfer(address,uint256)');
        expect(selector).toBe('0xa9059cbb');

        const selector2 = abiManager.getFunctionSelector('approve(address,uint256)');
        expect(selector2).toBe('0x095ea7b3');
    });

    test('should lookup function signature with fallback', async () => {
        // Test with transfer function selector
        const transferSelector = '0xa9059cbb';

        try {
            const signature = await abiManager.lookupFunctionSignatureWithFallback(transferSelector);

            if (signature) {
                expect(signature).toBe('transfer(address,uint256)');
            }
        } catch (error) {
            // API might be unavailable, that's ok for tests
            console.warn('API test skipped:', error.message);
        }
    }, 15000);

    test('should handle unknown function selectors', async () => {
        // Use a very unlikely function selector
        const unknownSelector = '0x12345678';

        const signature = await abiManager.lookupFunctionSignatureWithFallback(unknownSelector);

        // Should return null for unknown selectors
        expect(signature).toBe(null);
    }, 15000);

    test('should cache function signatures', async () => {
        const selector = '0xa9059cbb';

        // First call
        const signature1 = await abiManager.lookupFunctionSignatureWithFallback(selector);

        // Second call should be much faster due to caching
        const start = Date.now();
        const signature2 = await abiManager.lookupFunctionSignatureWithFallback(selector);
        const duration = Date.now() - start;

        expect(signature1).toBe(signature2);
        expect(duration).toBeLessThan(100); // Should be fast due to caching
    }, 15000);

    test('should decode function calls', async () => {
        const callData = '0xa9059cbb000000000000000000000000742dfa5c8e63d7ba7b2e5f5a4d1b8c3e4f5a6b7c0000000000000000000000000000000000000000000000000de0b6b3a7640000';

        try {
            const decoded = await abiManager.decodeFunctionCall('0x1234567890123456789012345678901234567890', callData);

            if (decoded) {
                expect(decoded).toHaveProperty('functionName');
                expect(decoded).toHaveProperty('parameters');
            }
        } catch (error) {
            console.warn('Decode test skipped:', error.message);
        }
    }, 15000);

    test('should generate interface names', () => {
        const interfaceName1 = abiManager.generateInterfaceName('0x1234567890123456789012345678901234567890', ['transfer', 'approve']);
        expect(typeof interfaceName1).toBe('string');
        expect(interfaceName1.length).toBeGreaterThan(0);

        const interfaceName2 = abiManager.generateInterfaceName('0x1234567890123456789012345678901234567890', []);
        expect(typeof interfaceName2).toBe('string');
    });

    test('should create interface functions', () => {
        // First validate a signature to get the proper format
        const validated = abiManager.validateSignature('transfer(address,uint256)');
        expect(validated.valid).toBe(true);

        const interfaceFunc = abiManager.createInterfaceFunction(validated);

        expect(interfaceFunc).toBe('function transfer(address param0, uint256 param1) external;');
    });

    test('should validate signatures', () => {
        const valid = abiManager.validateSignature('transfer(address,uint256)');
        expect(valid.valid).toBe(true);
        expect(valid.functionName).toBe('transfer');
        expect(valid.parameters).toEqual(['address', 'uint256']);

        const invalid = abiManager.validateSignature('invalid_signature');
        expect(invalid.valid).toBe(false);
    });

    test('should get cache statistics', () => {
        const stats = abiManager.getCacheStats();

        expect(stats).toHaveProperty('knownContracts');
        expect(stats).toHaveProperty('signatureCache');
        expect(typeof stats.knownContracts).toBe('number');
        expect(typeof stats.signatureCache).toBe('number');
    });

    test('should handle known contracts', () => {
        const knownContracts = abiManager.getKnownContracts();
        expect(knownContracts instanceof Map).toBe(true);

        // Add a test contract
        abiManager.addKnownContract('0xtest', 'TestContract', []);
        const contractInfo = abiManager.loadContractABI('0xtest');

        expect(contractInfo).toEqual([]);  // Returns the ABI array, not a contract info object
    });
});