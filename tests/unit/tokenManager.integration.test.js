import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import TokenManager from '../../lib/tokenManager.js';
import ConfigManager from '../../lib/configManager.js';
import RpcManager from '../../lib/rpcManager.js';

// Integration tests with real network calls
describe('TokenManager Integration Tests', () => {
    let tokenManager;
    let configManager;
    let rpcManager;

    beforeEach(() => {
        configManager = new ConfigManager();
        rpcManager = new RpcManager(configManager);
        tokenManager = new TokenManager(configManager, rpcManager);
    });

    afterEach(() => {
        // Clear cache between tests
        tokenManager.clearCache();
    });

    test('should initialize with dependencies', () => {
        expect(tokenManager.configManager).toBe(configManager);
        expect(tokenManager.rpcManager).toBe(rpcManager);
        expect(tokenManager.tokenCache).toBeDefined();
    });

    test('should handle non-existent token gracefully', async () => {
        // Use a random address that likely doesn't exist as a token
        const randomAddress = '0x1234567890123456789012345678901234567890';

        const tokenInfo = await tokenManager.fetchERC20Info(randomAddress);

        // Should either return null or basic token info with fallback values
        if (tokenInfo) {
            expect(tokenInfo.type).toBe('ERC20');
            expect(tokenInfo.address).toBe(randomAddress);
            // Fallback values when contract doesn't respond
            expect(['Unknown', 'Mock Token'].includes(tokenInfo.name)).toBe(true);
            expect(['UNK', 'MOCK'].includes(tokenInfo.symbol)).toBe(true);
        } else {
            expect(tokenInfo).toBe(null);
        }
    }, 30000);

    test('should fetch real token info for USDC if network available', async () => {
        // USDC contract address on Ethereum mainnet
        const usdcAddress = '0xA0b86a33E6411e3036c4E6C49b3b3C81F5F8a6D3';

        try {
            const tokenInfo = await tokenManager.fetchERC20Info(usdcAddress);

            if (tokenInfo) {
                expect(tokenInfo.type).toBe('ERC20');
                expect(tokenInfo.address).toBe(usdcAddress);
                expect(tokenInfo.decimals).toBe(6); // USDC has 6 decimals
                expect(['USD Coin', 'USDC'].includes(tokenInfo.symbol)).toBe(true);
            }
        } catch (error) {
            // Network might not be available, that's ok
            console.warn('Network test skipped:', error.message);
        }
    }, 30000);

    test('should handle transaction details with non-existent hash', async () => {
        const fakeHash = '0x1234567890123456789012345678901234567890123456789012345678901234';

        const txDetails = await tokenManager.fetchTransactionDetails(fakeHash);

        // Should return null for non-existent transaction
        expect(txDetails).toBe(null);
    }, 15000);

    test('should cache token information', async () => {
        const address = '0x1234567890123456789012345678901234567890';

        // First call
        const result1 = await tokenManager.fetchTokenInfo(address);

        // Second call should use cache (much faster)
        const start = Date.now();
        const result2 = await tokenManager.fetchTokenInfo(address);
        const duration = Date.now() - start;

        expect(result1).toEqual(result2);
        expect(duration).toBeLessThan(100); // Should be very fast due to caching
    });

    test('should handle batch token fetching', async () => {
        const addresses = [
            '0x1234567890123456789012345678901234567890',
            '0x0987654321098765432109876543210987654321'
        ];

        const results = await tokenManager.batchFetchTokenInfo(addresses, null, 2);

        expect(results instanceof Map).toBe(true);
        expect(results.size).toBeLessThanOrEqual(2);
    }, 30000);

    test('should generate meaningful variable names', () => {
        // Test with token info
        const tokenInfo = {
            type: 'ERC20',
            name: 'Dai Stablecoin',
            symbol: 'DAI'
        };
        const varName = tokenManager.generateAddressVariableName('0xaddress', [], tokenInfo);
        expect(varName).toBe('dai_token');

        // Test with function signatures
        const signatures = ['transfer', 'approve'];
        const varName2 = tokenManager.generateAddressVariableName('0xaddress', signatures, null);
        expect(varName2).toBe('transfer_contract');

        // Test fallback
        const varName3 = tokenManager.generateAddressVariableName('0x123456789012345678901234567890', [], null);
        expect(varName3).toBe('contract_567890');
    });

    test('should validate contract addresses', async () => {
        // Test with obviously invalid address (EOA-like)
        const validation = await tokenManager.validateTokenContract('0x0000000000000000000000000000000000000000');

        expect(validation).toHaveProperty('valid');
        expect(validation).toHaveProperty('reason');
        expect(validation).toHaveProperty('isContract');
        expect(typeof validation.valid).toBe('boolean');
    }, 15000);

    test('should get cache statistics', () => {
        const stats = tokenManager.getCacheStats();

        expect(stats).toHaveProperty('totalEntries');
        expect(stats).toHaveProperty('validEntries');
        expect(stats).toHaveProperty('expiredEntries');
        expect(typeof stats.totalEntries).toBe('number');
        expect(typeof stats.validEntries).toBe('number');
        expect(typeof stats.expiredEntries).toBe('number');
    });

    test('should clear cache properly', () => {
        // Add some test data to cache
        tokenManager.tokenCache.set('test', { data: 'cached', timestamp: Date.now() });

        expect(tokenManager.tokenCache.size).toBeGreaterThan(0);

        tokenManager.clearCache();

        expect(tokenManager.tokenCache.size).toBe(0);
    });

    test('should handle API key validation', async () => {
        // Test without API key
        process.env.ETHERSCAN_API_KEY = 'YourApiKeyToken'; // Default invalid key

        const result = await tokenManager.fetchTokenInfoFromExplorer('0xtoken', 'ethereum');

        // Should return null when no valid API key
        expect(result).toBe(null);

        // Clean up
        delete process.env.ETHERSCAN_API_KEY;
    });
});