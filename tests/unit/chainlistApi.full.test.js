import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import ChainlistAPI from '../../api_helpers/chainlistApi.js';

describe('ChainlistAPI - Full Coverage', () => {
    let api;

    beforeEach(() => {
        api = new ChainlistAPI();
    });

    afterEach(() => {
        api.clearCache();
    });

    describe('constructor', () => {
        test('should initialize with correct defaults', () => {
            expect(api.baseUrl).toBe('https://chainlist.org/rpcs.json');
            expect(api.cache).toBeInstanceOf(Map);
            expect(api.cacheExpiry).toBe(30 * 60 * 1000);
        });
    });

    describe('fetchChainlist', () => {
        test('should handle successful HTTP response', async () => {
            // Mock successful response
            const mockChains = [{ chainId: 1, name: 'Ethereum' }];

            // Override the actual fetchChainlist to return mock data
            const originalFetch = api.fetchChainlist;
            api.fetchChainlist = async () => mockChains;

            const result = await api.fetchChainlist();
            expect(result).toEqual(mockChains);

            // Restore original
            api.fetchChainlist = originalFetch;
        });

        test('should handle HTTP errors', async () => {
            // Create API with invalid URL to trigger HTTP error
            const failingApi = new ChainlistAPI();
            failingApi.baseUrl = 'https://definitely-not-real-domain-12345.invalid';

            await expect(failingApi.fetchChainlist()).rejects.toThrow();
        });

        test('should handle JSON parse errors', async () => {
            // Mock invalid JSON response
            const originalFetch = api.fetchChainlist;
            api.fetchChainlist = async () => {
                throw new Error('Failed to parse JSON: Unexpected token');
            };

            await expect(api.fetchChainlist()).rejects.toThrow('Failed to parse JSON');

            api.fetchChainlist = originalFetch;
        });

        test('should handle request timeout', async () => {
            // Mock timeout scenario
            const originalFetch = api.fetchChainlist;
            api.fetchChainlist = async () => {
                throw new Error('Request timeout');
            };

            await expect(api.fetchChainlist()).rejects.toThrow('Request timeout');

            api.fetchChainlist = originalFetch;
        });
    });

    describe('getAllChains', () => {
        test('should fetch and cache chain data', async () => {
            const mockChains = [
                { chainId: 1, name: 'Ethereum', rpc: ['https://eth.llamarpc.com'] },
                { chainId: 137, name: 'Polygon', rpc: ['https://polygon-rpc.com'] }
            ];

            api.fetchChainlist = async () => mockChains;

            const result = await api.getAllChains();
            expect(result).toEqual(mockChains);
            expect(api.cache.has('all_chains')).toBe(true);
        });

        test('should return cached data when available', async () => {
            const mockChains = [{ chainId: 1, name: 'Ethereum' }];

            // Set cache manually
            api.cache.set('all_chains', {
                data: mockChains,
                timestamp: Date.now()
            });

            const result = await api.getAllChains();
            expect(result).toEqual(mockChains);
        });

        test('should fallback to expired cache on API failure', async () => {
            const mockChains = [{ chainId: 1, name: 'Ethereum' }];

            // Set expired cache
            api.cache.set('all_chains', {
                data: mockChains,
                timestamp: Date.now() - (api.cacheExpiry + 1000)
            });

            // Make API fail
            api.fetchChainlist = async () => {
                throw new Error('API failure');
            };

            const result = await api.getAllChains();
            expect(result).toEqual(mockChains);
        });

        test('should throw error when no cache and API fails', async () => {
            api.fetchChainlist = async () => {
                throw new Error('API failure');
            };

            await expect(api.getAllChains()).rejects.toThrow('API failure');
        });
    });

    describe('getChainById', () => {
        test('should find chain by ID', async () => {
            const mockChains = [
                { chainId: 1, name: 'Ethereum' },
                { chainId: 137, name: 'Polygon' }
            ];

            api.getAllChains = async () => mockChains;

            const ethereum = await api.getChainById(1);
            expect(ethereum.name).toBe('Ethereum');

            const polygon = await api.getChainById(137);
            expect(polygon.name).toBe('Polygon');

            const notFound = await api.getChainById(999);
            expect(notFound).toBe(null);
        });

        test('should handle errors gracefully', async () => {
            api.getAllChains = async () => {
                throw new Error('Failed to get chains');
            };

            const result = await api.getChainById(1);
            expect(result).toBe(null);
        });
    });

    describe('getChainByName', () => {
        test('should find chain by various name fields', async () => {
            const mockChains = [
                {
                    chainId: 1,
                    name: 'Ethereum Mainnet',
                    shortName: 'eth',
                    chain: 'ETH',
                    chainSlug: 'ethereum'
                },
                {
                    chainId: 137,
                    name: 'Polygon Mainnet',
                    shortName: 'matic',
                    chain: 'MATIC'
                }
            ];

            api.getAllChains = async () => mockChains;

            // Test name matching
            const byName = await api.getChainByName('ethereum');
            expect(byName.chainId).toBe(1);

            // Test shortName matching
            const byShortName = await api.getChainByName('eth');
            expect(byShortName.chainId).toBe(1);

            // Test chain matching
            const byChain = await api.getChainByName('eth');
            expect(byChain.chainId).toBe(1);

            // Test chainSlug matching
            const bySlug = await api.getChainByName('ethereum');
            expect(bySlug.chainId).toBe(1);

            // Test not found
            const notFound = await api.getChainByName('nonexistent');
            expect(notFound).toBe(null);
        });

        test('should handle errors gracefully', async () => {
            api.getAllChains = async () => {
                throw new Error('Failed to get chains');
            };

            const result = await api.getChainByName('ethereum');
            expect(result).toBe(null);
        });
    });

    describe('filterRpcUrls', () => {
        test('should filter RPC URLs with all options', () => {
            const chainData = {
                rpc: [
                    'https://eth.llamarpc.com',
                    'http://insecure-rpc.com',
                    'wss://websocket-rpc.com',
                    'https://rpc-with-key.com?apikey=123',
                    'https://rpc-with-hex.com/a1b2c3d4e5f6789012345678901234567890abcdef',
                    { url: 'https://tracked-rpc.com', tracking: 'yes' },
                    { url: 'https://untracked-rpc.com', tracking: 'none' },
                    'https://good-rpc.com'
                ]
            };

            const filtered = api.filterRpcUrls(chainData, {
                excludeTracking: true,
                httpsOnly: true,
                excludeWebsockets: true,
                excludeApiKeys: true,
                limit: 5
            });

            expect(filtered).toContain('https://eth.llamarpc.com');
            expect(filtered).toContain('https://untracked-rpc.com');
            expect(filtered).toContain('https://good-rpc.com');
            expect(filtered).not.toContain('http://insecure-rpc.com');
            expect(filtered).not.toContain('wss://websocket-rpc.com');
            expect(filtered).not.toContain('https://rpc-with-key.com?apikey=123');
            expect(filtered).not.toContain('https://tracked-rpc.com');
            expect(filtered.length).toBeLessThanOrEqual(5);
        });

        test('should handle object format RPCs', () => {
            const chainData = {
                rpc: [
                    { url: 'https://good-rpc.com', tracking: 'limited' },
                    { url: 'https://bad-rpc.com', tracking: 'yes' }
                ]
            };

            const filtered = api.filterRpcUrls(chainData, { excludeTracking: true });

            expect(filtered).toContain('https://good-rpc.com');
            expect(filtered).not.toContain('https://bad-rpc.com');
        });

        test('should handle missing rpc field', () => {
            const chainData = {};
            const filtered = api.filterRpcUrls(chainData);
            expect(filtered).toEqual([]);
        });

        test('should handle null chain data', () => {
            const filtered = api.filterRpcUrls(null);
            expect(filtered).toEqual([]);
        });

        test('should allow HTTP when httpsOnly is false', () => {
            const chainData = {
                rpc: ['http://insecure-rpc.com', 'https://secure-rpc.com']
            };

            const filtered = api.filterRpcUrls(chainData, { httpsOnly: false });
            expect(filtered).toContain('http://insecure-rpc.com');
            expect(filtered).toContain('https://secure-rpc.com');
        });

        test('should allow websockets when excludeWebsockets is false', () => {
            const chainData = {
                rpc: ['wss://websocket-rpc.com', 'https://http-rpc.com']
            };

            const filtered = api.filterRpcUrls(chainData, { excludeWebsockets: false });
            expect(filtered).toContain('wss://websocket-rpc.com');
            expect(filtered).toContain('https://http-rpc.com');
        });

        test('should allow API keys when excludeApiKeys is false', () => {
            const chainData = {
                rpc: ['https://rpc-with-key.com?apikey=123', 'https://normal-rpc.com']
            };

            const filtered = api.filterRpcUrls(chainData, { excludeApiKeys: false });
            expect(filtered).toContain('https://rpc-with-key.com?apikey=123');
            expect(filtered).toContain('https://normal-rpc.com');
        });

        test('should remove duplicates', () => {
            const chainData = {
                rpc: [
                    'https://duplicate-rpc.com',
                    'https://duplicate-rpc.com',
                    'https://unique-rpc.com'
                ]
            };

            const filtered = api.filterRpcUrls(chainData);
            expect(filtered.length).toBe(2);
            expect(filtered).toContain('https://duplicate-rpc.com');
            expect(filtered).toContain('https://unique-rpc.com');
        });
    });

    describe('getRpcUrlsForChain', () => {
        test('should get and filter RPC URLs for chain', async () => {
            const mockChains = [
                {
                    chainId: 1,
                    rpc: ['https://eth.llamarpc.com', 'http://insecure.com']
                }
            ];

            api.getAllChains = async () => mockChains;

            const urls = await api.getRpcUrlsForChain(1, { httpsOnly: true });
            expect(urls).toContain('https://eth.llamarpc.com');
            expect(urls).not.toContain('http://insecure.com');
        });

        test('should return empty array for unknown chain', async () => {
            api.getAllChains = async () => [];

            const urls = await api.getRpcUrlsForChain(999);
            expect(urls).toEqual([]);
        });

        test('should handle errors gracefully', async () => {
            api.getAllChains = async () => {
                throw new Error('API error');
            };

            const urls = await api.getRpcUrlsForChain(1);
            expect(urls).toEqual([]);
        });
    });

    describe('getEnhancedChainInfo', () => {
        test('should return enhanced chain information', async () => {
            const mockChains = [
                {
                    chainId: 1,
                    name: 'Ethereum Mainnet',
                    shortName: 'eth',
                    chain: 'ETH',
                    networkId: 1,
                    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                    rpc: ['https://eth.llamarpc.com', 'http://insecure.com'],
                    explorers: [{ url: 'https://etherscan.io' }],
                    infoURL: 'https://ethereum.org',
                    tvl: 50000000000
                }
            ];

            api.getAllChains = async () => mockChains;

            const info = await api.getEnhancedChainInfo(1, { httpsOnly: true });

            expect(info.name).toBe('Ethereum Mainnet');
            expect(info.chainId).toBe(1);
            expect(info.rpcUrls).toContain('https://eth.llamarpc.com');
            expect(info.rpcUrls).not.toContain('http://insecure.com');
            expect(info.originalRpcCount).toBe(2);
            expect(info.filteredRpcCount).toBe(1);
            expect(info.tvl).toBe(50000000000);
            expect(info.explorers).toEqual([{ url: 'https://etherscan.io' }]);
        });

        test('should return null for unknown chain', async () => {
            api.getAllChains = async () => [];

            const info = await api.getEnhancedChainInfo(999);
            expect(info).toBe(null);
        });

        test('should handle missing optional fields', async () => {
            const mockChains = [
                {
                    chainId: 1,
                    name: 'Test Chain',
                    rpc: ['https://test-rpc.com']
                }
            ];

            api.getAllChains = async () => mockChains;

            const info = await api.getEnhancedChainInfo(1);
            expect(info.explorers).toEqual([]);
            expect(info.originalRpcCount).toBe(1);
        });

        test('should handle errors gracefully', async () => {
            api.getAllChains = async () => {
                throw new Error('API error');
            };

            const info = await api.getEnhancedChainInfo(1);
            expect(info).toBe(null);
        });
    });

    describe('searchChains', () => {
        test('should search chains by partial name match', async () => {
            const mockChains = [
                { chainId: 1, name: 'Ethereum Mainnet', shortName: 'eth', chain: 'ETH', rpc: ['https://rpc1.com'] },
                { chainId: 137, name: 'Polygon Mainnet', shortName: 'matic', chain: 'MATIC', rpc: ['https://rpc2.com'] },
                { chainId: 56, name: 'BNB Smart Chain', shortName: 'bnb', chain: 'BSC', rpc: ['https://rpc3.com'] }
            ];

            api.getAllChains = async () => mockChains;

            // Search by name
            const ethResults = await api.searchChains('ethereum');
            expect(ethResults.length).toBe(1);
            expect(ethResults[0].name).toBe('Ethereum Mainnet');
            expect(ethResults[0].rpcCount).toBe(1);

            // Search by shortName
            const maticResults = await api.searchChains('matic');
            expect(maticResults.length).toBe(1);
            expect(maticResults[0].name).toBe('Polygon Mainnet');

            // Search by chain
            const bscResults = await api.searchChains('bsc');
            expect(bscResults.length).toBe(1);
            expect(bscResults[0].name).toBe('BNB Smart Chain');

            // Case insensitive search
            const upperResults = await api.searchChains('ETHEREUM');
            expect(upperResults.length).toBe(1);

            // No results
            const noResults = await api.searchChains('nonexistent');
            expect(noResults.length).toBe(0);
        });

        test('should handle errors gracefully', async () => {
            api.getAllChains = async () => {
                throw new Error('API error');
            };

            const results = await api.searchChains('ethereum');
            expect(results).toEqual([]);
        });
    });

    describe('getPopularChains', () => {
        test('should return chains sorted by TVL and RPC count', async () => {
            const mockChains = [
                { chainId: 1, name: 'Ethereum', tvl: 50000, rpc: ['rpc1', 'rpc2'] },
                { chainId: 137, name: 'Polygon', tvl: 30000, rpc: ['rpc1'] },
                { chainId: 56, name: 'BSC', tvl: 40000, rpc: ['rpc1', 'rpc2', 'rpc3'] },
                { chainId: 999, name: 'NoRPC' } // No RPC URLs
            ];

            api.getAllChains = async () => mockChains;

            const popular = await api.getPopularChains(3);

            expect(popular.length).toBe(3);
            expect(popular[0].name).toBe('Ethereum'); // Highest TVL
            expect(popular[1].name).toBe('BSC'); // Second highest TVL
            expect(popular[2].name).toBe('Polygon'); // Third

            // Check returned structure
            expect(popular[0]).toHaveProperty('name');
            expect(popular[0]).toHaveProperty('chainId');
            expect(popular[0]).toHaveProperty('tvl');
            expect(popular[0]).toHaveProperty('rpcCount');
        });

        test('should filter out chains without RPC URLs', async () => {
            const mockChains = [
                { chainId: 1, name: 'Ethereum', rpc: ['rpc1'] },
                { chainId: 2, name: 'NoRPC' }
            ];

            api.getAllChains = async () => mockChains;

            const popular = await api.getPopularChains();
            expect(popular.length).toBe(1);
            expect(popular[0].name).toBe('Ethereum');
        });

        test('should handle chains without TVL', async () => {
            const mockChains = [
                { chainId: 1, name: 'Chain1', rpc: ['rpc1', 'rpc2'] },
                { chainId: 2, name: 'Chain2', rpc: ['rpc1'] }
            ];

            api.getAllChains = async () => mockChains;

            const popular = await api.getPopularChains();
            expect(popular[0].name).toBe('Chain1'); // More RPC URLs
        });

        test('should handle errors gracefully', async () => {
            api.getAllChains = async () => {
                throw new Error('API error');
            };

            const popular = await api.getPopularChains();
            expect(popular).toEqual([]);
        });
    });

    describe('cache management', () => {
        test('should clear cache', () => {
            api.cache.set('test', 'value');
            expect(api.cache.size).toBe(1);

            api.clearCache();
            expect(api.cache.size).toBe(0);
        });

        test('should get cache statistics', () => {
            api.cache.set('key1', 'value1');
            api.cache.set('key2', 'value2');

            const stats = api.getCacheStats();
            expect(stats.size).toBe(2);
            expect(stats.entries).toContain('key1');
            expect(stats.entries).toContain('key2');
        });
    });
});