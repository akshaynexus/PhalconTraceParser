const { ethers } = require('ethers');
const ChainlistAPI = require('../chainlistApi');

/**
 * RPC URL Manager
 * Handles RPC URL management with Chainlist integration, validation, and fallback mechanisms
 */
class RpcManager {
    constructor(configManager) {
        this.configManager = configManager;
        this.chainlistApi = new ChainlistAPI();
        this.validatedUrls = new Map(); // Cache for validated URLs
        this.cacheExpiry = 10 * 60 * 1000; // 10 minutes
    }

    /**
     * Get enhanced RPC URLs from both local config and Chainlist
     * @param {string} chainName - Chain name
     * @param {Object} options - Filtering options
     * @returns {Promise<Array<string>>} Array of RPC URLs
     */
    async getEnhancedRpcUrls(chainName, options = {}) {
        try {
            const config = this.configManager.getChainConfig(chainName);
            if (!config) return [];

            // Get RPC URLs from Chainlist API
            const chainlistUrls = await this.chainlistApi.getRpcUrlsForChain(config.chainId, {
                excludeTracking: true,
                httpsOnly: true,
                excludeWebsockets: true,
                excludeApiKeys: true,
                limit: 10,
                ...options
            });

            // Combine with local config URLs
            const localUrls = config.rpcUrls || [];
            const allUrls = [...localUrls, ...chainlistUrls];

            // Remove duplicates while preserving order (local URLs first)
            const uniqueUrls = [...new Set(allUrls)];

            console.log(`Found ${uniqueUrls.length} RPC URLs for ${chainName} (${localUrls.length} local + ${chainlistUrls.length} from chainlist)`);
            return uniqueUrls;

        } catch (error) {
            console.warn(`Failed to get enhanced RPC URLs for ${chainName}: ${error.message}`);

            // Fallback to local config
            const config = this.configManager.getChainConfig(chainName);
            return config.rpcUrls || [];
        }
    }

    /**
     * Get single best RPC URL with Chainlist enhancement
     * @param {string} chainName - Chain name
     * @returns {Promise<string>} Best RPC URL
     */
    async getEnhancedRpcUrl(chainName = 'ethereum') {
        const config = this.configManager.getChainConfig(chainName);

        // Check environment variables first (highest priority)
        for (const envVar of config.envVars) {
            if (process.env[envVar]) {
                return process.env[envVar];
            }
        }

        try {
            // Get enhanced URLs from chainlist
            const enhancedUrls = await this.getEnhancedRpcUrls(chainName, { limit: 3 });
            if (enhancedUrls.length > 0) {
                return enhancedUrls[0]; // Return first (best) URL
            }
        } catch (error) {
            console.warn(`Chainlist lookup failed for ${chainName}: ${error.message}`);
        }

        // Fallback to local config
        return config.rpcUrls[0];
    }

    /**
     * Validate RPC URL connectivity
     * @param {string} rpcUrl - RPC URL to validate
     * @param {number|null} chainId - Expected chain ID
     * @param {number} timeout - Timeout in milliseconds
     * @returns {Promise<Object>} Validation result
     */
    async validateRpcUrl(rpcUrl, chainId = null, timeout = 2000) {
        const cacheKey = `${rpcUrl}_${chainId}`;
        const cached = this.validatedUrls.get(cacheKey);

        // Return cached result if still valid
        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            return cached.result;
        }

        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl);

            // Create timeout promise
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Timeout')), timeout);
            });

            // Test basic connectivity
            const blockNumberPromise = provider.getBlockNumber();
            const blockNumber = await Promise.race([blockNumberPromise, timeoutPromise]);

            // Verify chain ID if provided
            if (chainId) {
                const networkPromise = provider.getNetwork();
                const network = await Promise.race([networkPromise, timeoutPromise]);

                if (Number(network.chainId) !== chainId) {
                    const result = {
                        valid: false,
                        error: `Chain ID mismatch: expected ${chainId}, got ${network.chainId}`,
                        blockNumber: null
                    };

                    // Cache result
                    this.validatedUrls.set(cacheKey, {
                        result,
                        timestamp: Date.now()
                    });

                    return result;
                }
            }

            const result = {
                valid: true,
                error: null,
                blockNumber: blockNumber
            };

            // Cache successful result
            this.validatedUrls.set(cacheKey, {
                result,
                timestamp: Date.now()
            });

            return result;

        } catch (error) {
            const result = {
                valid: false,
                error: error.message,
                blockNumber: null
            };

            // Cache failed result (shorter cache time)
            this.validatedUrls.set(cacheKey, {
                result,
                timestamp: Date.now() - this.cacheExpiry / 2 // Shorter cache for failures
            });

            return result;
        }
    }

    /**
     * Find best working RPC URL from a list
     * @param {Array<string>} rpcUrls - Array of RPC URLs to test
     * @param {number|null} chainId - Expected chain ID
     * @param {number} timeout - Timeout per URL in milliseconds
     * @returns {Promise<string>} Best working RPC URL
     */
    async findBestRpcUrl(rpcUrls, chainId = null, timeout = 5000) {
        if (!rpcUrls || rpcUrls.length === 0) {
            throw new Error('No RPC URLs provided');
        }

        console.log(`Testing ${rpcUrls.length} RPC URLs for best connectivity...`);

        const startTime = Date.now();

        // Test URLs in parallel with timeout
        const testPromises = rpcUrls.map(async (url, index) => {
            const testStart = Date.now();

            try {
                const result = await this.validateRpcUrl(url, chainId, timeout);
                const latency = Date.now() - testStart;

                return {
                    url,
                    index,
                    latency,
                    ...result
                };
            } catch (error) {
                return {
                    url,
                    index,
                    valid: false,
                    error: error.message,
                    blockNumber: null,
                    latency: Infinity
                };
            }
        });

        const results = await Promise.all(testPromises);

        // Find valid URLs and sort by preference
        const validUrls = results
            .filter(result => result.valid)
            .sort((a, b) => {
                // Prefer original order (local config first), then by latency
                if (a.index < 3 && b.index >= 3) return -1; // Local config URLs first
                if (b.index < 3 && a.index >= 3) return 1;

                // Then sort by latency
                return a.latency - b.latency;
            });

        if (validUrls.length === 0) {
            const errors = results.map(r => `${r.url}: ${r.error}`).join(', ');
            throw new Error(`No working RPC URLs found. Errors: ${errors}`);
        }

        const bestUrl = validUrls[0];
        const totalTime = Date.now() - startTime;

        console.log(`Best RPC URL: ${bestUrl.url} (block: ${bestUrl.blockNumber}, latency: ${bestUrl.latency}ms, total test time: ${totalTime}ms)`);

        return bestUrl.url;
    }

    /**
     * Get multiple validated RPC URLs for redundancy
     * @param {string} chainName - Chain name
     * @param {number} count - Number of URLs to return
     * @param {number} timeout - Timeout per URL
     * @returns {Promise<Array<string>>} Array of validated RPC URLs
     */
    async getValidatedRpcUrls(chainName, count = 1, timeout = 2000) {
        try {
            const allUrls = await this.getEnhancedRpcUrls(chainName);
            const config = this.configManager.getChainConfig(chainName);

            if (allUrls.length === 0) {
                throw new Error(`No RPC URLs available for ${chainName}`);
            }

            // Only test first 2 URLs to avoid long delays
            const urlsToTest = allUrls.slice(0, Math.min(2, allUrls.length));
            console.log(`Testing ${urlsToTest.length} RPC URLs for ${chainName}...`);

            // Test URLs sequentially, stop after first success
            for (const url of urlsToTest) {
                try {
                    const result = await this.validateRpcUrl(url, config.chainId, timeout);
                    if (result.valid) {
                        console.log(`✅ Found working RPC: ${url}`);
                        return [url];
                    } else {
                        console.log(`❌ RPC failed: ${url} - ${result.error}`);
                    }
                } catch (error) {
                    console.log(`❌ RPC error: ${url} - ${error.message}`);
                }
            }

            // If no URLs work, return first local URL without validation
            console.log(`⚠️  No RPC validation successful, using first available URL: ${allUrls[0]}`);
            return [allUrls[0]];

        } catch (error) {
            console.warn(`Failed to get validated RPC URLs for ${chainName}: ${error.message}`);

            // Fallback to local config without validation
            const config = this.configManager.getChainConfig(chainName);
            return config.rpcUrls.slice(0, count);
        }
    }

    /**
     * Clear validation cache
     */
    clearCache() {
        this.validatedUrls.clear();
        this.chainlistApi.clearCache();
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        const now = Date.now();
        const validEntries = Array.from(this.validatedUrls.values())
            .filter(entry => now - entry.timestamp < this.cacheExpiry).length;

        return {
            totalEntries: this.validatedUrls.size,
            validEntries: validEntries,
            chainlistCache: this.chainlistApi.getCacheStats()
        };
    }

    /**
     * Test RPC URL performance
     * @param {string} rpcUrl - RPC URL to test
     * @param {number} iterations - Number of test iterations
     * @returns {Promise<Object>} Performance metrics
     */
    async testRpcPerformance(rpcUrl, iterations = 5) {
        const results = [];

        for (let i = 0; i < iterations; i++) {
            const start = Date.now();
            try {
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                await provider.getBlockNumber();
                const latency = Date.now() - start;
                results.push({ success: true, latency });
            } catch (error) {
                const latency = Date.now() - start;
                results.push({ success: false, latency, error: error.message });
            }
        }

        const successful = results.filter(r => r.success);
        const avgLatency = successful.length > 0
            ? successful.reduce((sum, r) => sum + r.latency, 0) / successful.length
            : null;

        return {
            url: rpcUrl,
            iterations,
            successCount: successful.length,
            successRate: successful.length / iterations,
            averageLatency: avgLatency,
            results: results
        };
    }
}

module.exports = RpcManager;