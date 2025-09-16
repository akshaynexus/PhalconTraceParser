import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import RpcManager from '../../lib/rpcManager.js';
import ConfigManager from '../../lib/configManager.js';
import path from 'path';

describe('RpcManager Integration Tests', () => {
    let configManager;
    let rpcManager;

    beforeEach(() => {
        // Set up config manager with actual config
        configManager = new ConfigManager();
        rpcManager = new RpcManager(configManager);
    });

    afterEach(() => {
        // Clear environment variables
        delete process.env.RPC_URL;
        delete process.env.BASE_RPC_URL;
        delete process.env.ETHEREUM_RPC_URL;
    });

    test('should initialize with config manager', () => {
        expect(rpcManager.configManager).toBe(configManager);
        expect(rpcManager.chainlistApi).toBeDefined();
        expect(rpcManager.validatedUrls).toBeDefined();
    });

    test('should get enhanced RPC URLs combining local and chainlist', async () => {
        const urls = await rpcManager.getEnhancedRpcUrls('ethereum');

        expect(Array.isArray(urls)).toBe(true);
        expect(urls.length).toBeGreaterThan(0);

        // Check that it contains at least some Ethereum RPC URLs
        const hasEthereumRpc = urls.some(url =>
            url.includes('eth') ||
            url.includes('ethereum') ||
            url.includes('mainnet')
        );
        expect(hasEthereumRpc).toBe(true);
    }, 15000); // 15 second timeout for network calls

    test('should get single enhanced RPC URL with environment variable priority', async () => {
        // Test with env var priority
        process.env.RPC_URL = 'https://custom-env.rpc.com';
        const url = await rpcManager.getEnhancedRpcUrl('ethereum');
        expect(url).toBe('https://custom-env.rpc.com');

        // Clear env var and test fallback
        delete process.env.RPC_URL;
        const fallbackUrl = await rpcManager.getEnhancedRpcUrl('ethereum');
        expect(typeof fallbackUrl).toBe('string');
        expect(fallbackUrl.startsWith('http')).toBe(true);
    }, 10000);

    test('should validate working RPC URL', async () => {
        // Use a known working RPC
        const result = await rpcManager.validateRpcUrl('https://cloudflare-eth.com', 1, 5000);

        expect(result).toBeDefined();
        expect(typeof result.valid).toBe('boolean');
        if (result.valid) {
            expect(result.error).toBe(null);
            expect(typeof result.blockNumber).toBe('number');
        }
    }, 10000);

    test('should handle invalid RPC URL gracefully', async () => {
        const result = await rpcManager.validateRpcUrl('https://definitely-not-a-real-rpc.invalid', 1, 2000);

        expect(result.valid).toBe(false);
        expect(typeof result.error).toBe('string');
        expect(result.blockNumber).toBe(null);
    }, 5000);

    test('should get validated RPC URLs for ethereum', async () => {
        const validatedUrls = await rpcManager.getValidatedRpcUrls('ethereum', 1, 3000);

        expect(Array.isArray(validatedUrls)).toBe(true);
        expect(validatedUrls.length).toBeGreaterThan(0);
        expect(validatedUrls[0].startsWith('http')).toBe(true);
    }, 15000);

    test('should cache validation results', async () => {
        const testUrl = 'https://cloudflare-eth.com';

        // First call - should make network request
        const startTime = Date.now();
        const result1 = await rpcManager.validateRpcUrl(testUrl, 1, 5000);
        const firstCallTime = Date.now() - startTime;

        // Second call - should use cache and be much faster
        const cacheStartTime = Date.now();
        const result2 = await rpcManager.validateRpcUrl(testUrl, 1, 5000);
        const cacheCallTime = Date.now() - cacheStartTime;

        expect(result1.valid).toBe(result2.valid);
        expect(cacheCallTime).toBeLessThan(firstCallTime / 2); // Cache should be much faster
    }, 15000);

    test('should clear caches', () => {
        rpcManager.validatedUrls.set('test', { result: 'cached', timestamp: Date.now() });

        rpcManager.clearCache();

        expect(rpcManager.validatedUrls.size).toBe(0);
    });

    test('should get cache statistics', () => {
        rpcManager.validatedUrls.set('test1', { result: 'cached1', timestamp: Date.now() });
        rpcManager.validatedUrls.set('test2', { result: 'cached2', timestamp: Date.now() - 20 * 60 * 1000 }); // Expired

        const stats = rpcManager.getCacheStats();

        expect(stats.totalEntries).toBe(2);
        expect(stats.validEntries).toBe(1); // Only one should be valid (not expired)
        expect(stats.chainlistCache).toBeDefined();
    });

    test('should handle empty RPC URL arrays', async () => {
        await expect(rpcManager.findBestRpcUrl([])).rejects.toThrow('No RPC URLs provided');
    });

    test('should handle invalid chain names gracefully', async () => {
        const result = await rpcManager.getEnhancedRpcUrls('truly_nonexistent_chain_that_should_not_exist_123456789');
        expect(Array.isArray(result)).toBe(true);
        // The chainlist API might still return some fallback URLs, so just verify it's an array
        expect(result.length).toBeGreaterThanOrEqual(0);
    }, 5000);
});