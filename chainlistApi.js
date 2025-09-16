const https = require('https');

/**
 * Chainlist API helper for fetching RPC URLs from chainlist.org
 */
class ChainlistAPI {
    constructor() {
        this.baseUrl = 'https://chainlist.org/rpcs.json';
        this.cache = new Map(); // Cache to avoid repeated API calls
        this.cacheExpiry = 30 * 60 * 1000; // 30 minutes
    }

    /**
     * Make HTTP GET request to Chainlist API
     * @returns {Promise<Object>} - Parsed JSON response with all chains
     */
    async fetchChainlist() {
        return new Promise((resolve, reject) => {
            const request = https.get(this.baseUrl, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (error) {
                        reject(new Error(`Failed to parse JSON: ${error.message}`));
                    }
                });
            });

            request.on('error', (error) => {
                reject(new Error(`HTTP request failed: ${error.message}`));
            });

            // Set timeout for the request
            request.setTimeout(10000, () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    /**
     * Get all chains from Chainlist API with caching
     * @returns {Promise<Array>} - Array of chain objects
     */
    async getAllChains() {
        const cacheKey = 'all_chains';
        const cached = this.cache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            console.log('Using cached chainlist data');
            return cached.data;
        }

        try {
            console.log('Fetching chains from chainlist.org...');
            const chains = await this.fetchChainlist();

            // Cache the result
            this.cache.set(cacheKey, {
                data: chains,
                timestamp: Date.now()
            });

            console.log(`Fetched ${chains.length} chains from chainlist.org`);
            return chains;
        } catch (error) {
            console.warn(`Failed to fetch from chainlist API: ${error.message}`);

            // Return cached data even if expired, if available
            if (cached) {
                console.log('Using expired cached data due to API failure');
                return cached.data;
            }

            throw error;
        }
    }

    /**
     * Find chain by chain ID
     * @param {number} chainId - The chain ID to look for
     * @returns {Promise<Object|null>} - Chain object or null if not found
     */
    async getChainById(chainId) {
        try {
            const chains = await this.getAllChains();
            return chains.find(chain => chain.chainId === chainId) || null;
        } catch (error) {
            console.warn(`Failed to get chain ${chainId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Find chain by name or short name
     * @param {string} name - Chain name or short name to search for
     * @returns {Promise<Object|null>} - Chain object or null if not found
     */
    async getChainByName(name) {
        try {
            const chains = await this.getAllChains();
            const searchName = name.toLowerCase();

            return chains.find(chain =>
                chain.name.toLowerCase().includes(searchName) ||
                chain.shortName?.toLowerCase() === searchName ||
                chain.chain?.toLowerCase() === searchName ||
                chain.chainSlug?.toLowerCase() === searchName
            ) || null;
        } catch (error) {
            console.warn(`Failed to get chain by name ${name}: ${error.message}`);
            return null;
        }
    }

    /**
     * Get filtered RPC URLs for a chain
     * @param {Object} chainData - Chain object from chainlist
     * @param {Object} options - Filtering options
     * @returns {Array} - Array of filtered RPC URL strings
     */
    filterRpcUrls(chainData, options = {}) {
        if (!chainData || !chainData.rpc) {
            return [];
        }

        const {
            excludeTracking = true,      // Exclude RPC URLs with tracking
            httpsOnly = true,           // Only HTTPS URLs
            excludeWebsockets = true,   // Exclude WebSocket URLs
            excludeApiKeys = true,      // Exclude URLs requiring API keys
            limit = 10                  // Maximum number of URLs to return
        } = options;

        let rpcUrls = chainData.rpc.map(rpc => {
            // Handle both string and object format
            return typeof rpc === 'string' ? rpc : rpc.url;
        }).filter(url => {
            if (!url) return false;

            // Filter HTTPS only
            if (httpsOnly && !url.startsWith('https://')) {
                return false;
            }

            // Filter out WebSocket URLs
            if (excludeWebsockets && (url.startsWith('ws://') || url.startsWith('wss://'))) {
                return false;
            }

            // Filter out URLs with API keys (contain query parameters or path segments that look like keys)
            if (excludeApiKeys) {
                if (url.includes('?') || url.includes('api_key') || url.includes('apikey')) {
                    return false;
                }
                // Check for long hex strings in path that might be API keys
                if (/\/[a-fA-F0-9]{32,}/.test(url)) {
                    return false;
                }
            }

            return true;
        });

        // Filter by tracking preference
        if (excludeTracking && chainData.rpc) {
            const rpcObjects = chainData.rpc.filter(rpc => typeof rpc === 'object');
            const trackingMap = new Map();

            rpcObjects.forEach(rpc => {
                if (rpc.url && rpc.tracking) {
                    trackingMap.set(rpc.url, rpc.tracking);
                }
            });

            rpcUrls = rpcUrls.filter(url => {
                const tracking = trackingMap.get(url);
                return !tracking || tracking === 'none' || tracking === 'limited';
            });
        }

        // Remove duplicates and limit
        return [...new Set(rpcUrls)].slice(0, limit);
    }

    /**
     * Get RPC URLs for a specific chain ID with filtering
     * @param {number} chainId - Chain ID
     * @param {Object} options - Filtering options
     * @returns {Promise<Array>} - Array of RPC URLs
     */
    async getRpcUrlsForChain(chainId, options = {}) {
        try {
            const chainData = await this.getChainById(chainId);
            if (!chainData) {
                console.warn(`Chain ${chainId} not found in chainlist`);
                return [];
            }

            return this.filterRpcUrls(chainData, options);
        } catch (error) {
            console.warn(`Failed to get RPC URLs for chain ${chainId}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get enhanced chain information with RPC URLs
     * @param {number} chainId - Chain ID
     * @param {Object} options - Filtering options for RPC URLs
     * @returns {Promise<Object|null>} - Enhanced chain object with filtered RPC URLs
     */
    async getEnhancedChainInfo(chainId, options = {}) {
        try {
            const chainData = await this.getChainById(chainId);
            if (!chainData) {
                return null;
            }

            const filteredRpcUrls = this.filterRpcUrls(chainData, options);

            return {
                name: chainData.name,
                shortName: chainData.shortName,
                chain: chainData.chain,
                chainId: chainData.chainId,
                networkId: chainData.networkId,
                nativeCurrency: chainData.nativeCurrency,
                rpcUrls: filteredRpcUrls,
                explorers: chainData.explorers || [],
                infoURL: chainData.infoURL,
                tvl: chainData.tvl,
                originalRpcCount: chainData.rpc ? chainData.rpc.length : 0,
                filteredRpcCount: filteredRpcUrls.length
            };
        } catch (error) {
            console.warn(`Failed to get enhanced chain info for ${chainId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Search chains by partial name match
     * @param {string} searchTerm - Search term
     * @returns {Promise<Array>} - Array of matching chain objects
     */
    async searchChains(searchTerm) {
        try {
            const chains = await this.getAllChains();
            const search = searchTerm.toLowerCase();

            return chains.filter(chain =>
                chain.name.toLowerCase().includes(search) ||
                chain.shortName?.toLowerCase().includes(search) ||
                chain.chain?.toLowerCase().includes(search)
            ).map(chain => ({
                name: chain.name,
                shortName: chain.shortName,
                chainId: chain.chainId,
                chain: chain.chain,
                rpcCount: chain.rpc ? chain.rpc.length : 0
            }));
        } catch (error) {
            console.warn(`Failed to search chains: ${error.message}`);
            return [];
        }
    }

    /**
     * Get popular chains (with highest TVL or most RPC endpoints)
     * @param {number} limit - Number of chains to return
     * @returns {Promise<Array>} - Array of popular chain objects
     */
    async getPopularChains(limit = 20) {
        try {
            const chains = await this.getAllChains();

            return chains
                .filter(chain => chain.rpc && chain.rpc.length > 0)
                .sort((a, b) => {
                    // Sort by TVL first, then by RPC count
                    const tvlDiff = (b.tvl || 0) - (a.tvl || 0);
                    if (tvlDiff !== 0) return tvlDiff;
                    return (b.rpc?.length || 0) - (a.rpc?.length || 0);
                })
                .slice(0, limit)
                .map(chain => ({
                    name: chain.name,
                    shortName: chain.shortName,
                    chainId: chain.chainId,
                    chain: chain.chain,
                    tvl: chain.tvl,
                    rpcCount: chain.rpc ? chain.rpc.length : 0
                }));
        } catch (error) {
            console.warn(`Failed to get popular chains: ${error.message}`);
            return [];
        }
    }

    /**
     * Clear the cache
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Get cache statistics
     * @returns {Object} - Cache statistics
     */
    getCacheStats() {
        return {
            size: this.cache.size,
            entries: Array.from(this.cache.keys())
        };
    }
}

module.exports = ChainlistAPI;