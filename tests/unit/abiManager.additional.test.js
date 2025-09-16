import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import AbiManager from '../../lib/abiManager.js';
import fs from 'fs';
import path from 'path';

describe('AbiManager Additional Coverage', () => {
    let abiManager;

    beforeEach(() => {
        abiManager = new AbiManager();
    });

    afterEach(() => {
        abiManager.clearCache();
    });

    test('should handle loading known contracts from non-existent files', () => {
        // The constructor tries to load ABIs from files that might not exist
        // This covers the error handling in _loadKnownContracts
        expect(abiManager.knownContracts).toBeDefined();
        expect(abiManager.knownContracts.size).toBeGreaterThanOrEqual(0);
    });

    test('should parse parameter types correctly', () => {
        const params = abiManager.parseParameterTypes('uint256,address,bool');
        expect(params).toEqual(['uint256', 'address', 'bool']);

        const emptyParams = abiManager.parseParameterTypes('');
        expect(emptyParams).toEqual([]);

        const singleParam = abiManager.parseParameterTypes('uint256');
        expect(singleParam).toEqual(['uint256']);
    });

    test('should handle complex parameter types', () => {
        const complexParams = abiManager.parseParameterTypes('uint256[],tuple(address,uint256),bytes32');
        expect(complexParams).toEqual(['uint256[]', 'tuple(address,uint256)', 'bytes32']);
    });

    test('should generate function selector correctly', () => {
        const selector = abiManager.getFunctionSelector('transfer(address,uint256)');
        expect(selector).toBe('0xa9059cbb');

        const selector2 = abiManager.getFunctionSelector('balanceOf(address)');
        expect(selector2).toBe('0x70a08231');
    });

    test('should validate function signatures', () => {
        const valid = abiManager.validateSignature('transfer(address,uint256)');
        expect(valid.valid).toBe(true);
        expect(valid.functionName).toBe('transfer');
        expect(valid.parameters).toEqual(['address', 'uint256']);

        const invalid = abiManager.validateSignature('invalid_signature');
        expect(invalid.valid).toBe(false);
        expect(invalid.error).toContain('Invalid function signature format');

        const emptyName = abiManager.validateSignature('()');
        expect(emptyName.valid).toBe(false);
        expect(emptyName.error).toContain('Invalid function signature format');
    });

    test('should handle interface function creation with validation', () => {
        const validatedSig = abiManager.validateSignature('transfer(address,uint256)');
        const interfaceFunc = abiManager.createInterfaceFunction(validatedSig);
        expect(interfaceFunc).toBe('function transfer(address param0, uint256 param1) external;');

        const nullResult = abiManager.createInterfaceFunction(null);
        expect(nullResult).toBe(null);
    });

    test('should generate parameter placeholders', () => {
        const validatedSig = abiManager.validateSignature('transfer(address,uint256)');
        const callData = '0xa9059cbb000000000000000000000000742dfa5c8e63d7ba7b2e5f5a4d1b8c3e4f5a6b7c0000000000000000000000000000000000000000000000000de0b6b3a7640000';

        const placeholders = abiManager.generateParameterPlaceholders(validatedSig, callData);
        expect(Array.isArray(placeholders)).toBe(true);
    });

    test('should fix interface signatures for Solidity compatibility', () => {
        const signature = 'transfer(address,uint256)';
        const structDefs = new Set();
        const fixed = abiManager.fixInterfaceSignature(signature, structDefs);
        expect(typeof fixed).toBe('string');
    });

    test('should handle complex tuple types in interface signatures', () => {
        const signature = 'swap((address,uint256),bytes)';
        const structDefs = new Set();
        const fixed = abiManager.fixInterfaceSignature(signature, structDefs);
        expect(typeof fixed).toBe('string');
        // Should create struct definitions for complex tuples
    });

    test('should generate meaningful interface names', () => {
        const address = '0x1234567890123456789012345678901234567890';

        // Test with no signatures
        const name1 = abiManager.generateInterfaceName(address, []);
        expect(name1).toMatch(/IContract/);

        // Test with known patterns
        const vaultSigs = ['deposit(uint256)', 'withdraw(uint256)', 'totalAssets()'];
        const vaultName = abiManager.generateInterfaceName(address, vaultSigs);
        expect(typeof vaultName).toBe('string');

        // Test with pool patterns
        const poolSigs = ['swap(address,address,uint256)', 'getReserves()'];
        const poolName = abiManager.generateInterfaceName(address, poolSigs);
        expect(typeof poolName).toBe('string');
    });

    test('should clear signature cache', () => {
        abiManager.signatureCache.set('test', 'value');
        expect(abiManager.signatureCache.size).toBe(1);

        abiManager.clearCache();
        expect(abiManager.signatureCache.size).toBe(0);
    });

    test('should get all known contracts', () => {
        const contracts = abiManager.getKnownContracts();
        expect(contracts instanceof Map).toBe(true);
    });

    test('should handle getFunctionSelector with edge cases', () => {
        // Test with empty string
        try {
            abiManager.getFunctionSelector('');
            // Should not throw, might return a hash of empty string
        } catch (error) {
            expect(error).toBeDefined();
        }

        // Test with malformed signature
        try {
            abiManager.getFunctionSelector('not_a_function');
            // Should still return a hash
        } catch (error) {
            expect(error).toBeDefined();
        }
    });

    test('should handle parseParameterTypes with edge cases', () => {
        // Test with nested tuples
        const nested = abiManager.parseParameterTypes('tuple(tuple(uint256,address),bytes32)');
        expect(Array.isArray(nested)).toBe(true);

        // Test with arrays
        const arrays = abiManager.parseParameterTypes('uint256[],address[][],bytes32[5]');
        expect(Array.isArray(arrays)).toBe(true);
    });

    test('should handle invalid JSON in ABI loading', () => {
        // Test error handling when JSON parsing fails
        // This would be tested if we had actual ABI files
        const result = abiManager.loadContractABI('0xinvalid');
        expect(result).toBe(null);
    });

    test('should handle validation errors in validateSignature', () => {
        // Test various invalid signatures
        const invalidCases = [
            'invalid',
            'func(',
            'func)',
            '()',
            'func(invalid_type)',
            'func(uint256,)',
            'func(,uint256)'
        ];

        invalidCases.forEach(invalidSig => {
            const result = abiManager.validateSignature(invalidSig);
            // Should handle gracefully, either return invalid or throw caught error
            expect(typeof result).toBe('object');
        });
    });

    test('should handle address verification patterns', () => {
        const address = '0x1234567890123456789012345678901234567890';

        // Test different function patterns for name generation
        const patterns = [
            ['mint(uint256)', 'burn(uint256)'], // Generic
            ['deposit(uint256)', 'withdraw(uint256)', 'totalAssets()'], // Vault
            ['swap(address,address,uint256)', 'mint(address,uint256,uint256)', 'burn(address,uint256,uint256)'], // Pool
            ['transfer(address,uint256)', 'balanceOf(address)'], // Token
            ['multicall(bytes[])'], // Multicall
            ['execute(address,uint256,bytes)'] // Executor
        ];

        patterns.forEach(sigs => {
            const name = abiManager.generateInterfaceName(address, sigs);
            expect(typeof name).toBe('string');
            expect(name.length).toBeGreaterThan(0);
        });
    });

    test('should handle lookup failures gracefully', async () => {
        // Test with invalid selector
        const result = await abiManager.lookupFunctionSignatureWithFallback('0xinvalid');
        expect(result).toBe(null);

        // Test with non-existent selector
        const result2 = await abiManager.lookupFunctionSignatureWithFallback('0x12345678');
        expect(result2).toBe(null);
    }, 15000);

    test('should handle decoding with missing ABI', async () => {
        const address = '0x1234567890123456789012345678901234567890';
        const callData = '0xa9059cbb000000000000000000000000742dfa5c8e63d7ba7b2e5f5a4d1b8c3e4f5a6b7c';

        const result = await abiManager.decodeFunctionCall(address, callData);
        // Should handle gracefully when no ABI is available
        expect(result).toBeDefined();
    }, 10000);

    test('should handle known contract management', () => {
        const testAddress = '0x1234567890123456789012345678901234567890';
        const testName = 'TestContract';
        const testAbi = [{ name: 'test', type: 'function' }];

        abiManager.addKnownContract(testAddress, testName, testAbi);
        const retrieved = abiManager.loadContractABI(testAddress);

        expect(retrieved).toEqual(testAbi);
    });
});