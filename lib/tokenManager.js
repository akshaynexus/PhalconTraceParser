const { ethers } = require('ethers');

// Standard ABIs
const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)'
];

const UNISWAP_V2_PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)'
];

/**
 * Token Information Manager
 * Handles fetching and managing token information from various sources
 */
class TokenManager {
    constructor(configManager, rpcManager) {
        this.configManager = configManager;
        this.rpcManager = rpcManager;
        this.tokenCache = new Map();
        this.cacheExpiry = 60 * 60 * 1000; // 1 hour
    }

    /**
     * Fetch comprehensive token information
     * @param {string} address - Token contract address
     * @param {string|null} rpcUrl - Optional RPC URL
     * @returns {Promise<Object|null>} Token information or null
     */
    async fetchTokenInfo(address, rpcUrl = null) {
        const cacheKey = `${address}_${rpcUrl || 'default'}`;
        const cached = this.tokenCache.get(cacheKey);

        // Return cached result if still valid
        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            return cached.data;
        }

        try {
            rpcUrl = rpcUrl || await this.rpcManager.getEnhancedRpcUrl('ethereum');
            const chain = this.configManager.detectChainFromRpc(rpcUrl);

            // Try Explorer API first (optional, falls back to RPC)
            const explorerInfo = await this.fetchTokenInfoFromExplorer(address, chain);
            if (explorerInfo) {
                this._cacheResult(cacheKey, explorerInfo);
                return explorerInfo;
            }

            // Try as Uniswap V2 Pair first
            const pairInfo = await this.fetchUniswapPairInfo(address, rpcUrl);
            if (pairInfo) {
                this._cacheResult(cacheKey, pairInfo);
                return pairInfo;
            }

            // Try as regular ERC20 token
            const tokenInfo = await this.fetchERC20Info(address, rpcUrl);
            if (tokenInfo) {
                this._cacheResult(cacheKey, tokenInfo);
                return tokenInfo;
            }

            // Cache null result to avoid repeated failed lookups
            this._cacheResult(cacheKey, null);
            return null;

        } catch (error) {
            console.warn(`Failed to fetch token info for ${address}: ${error.message}`);
            return null;
        }
    }

    /**
     * Fetch token information from blockchain explorer API
     * @param {string} address - Token contract address
     * @param {string} chain - Chain name
     * @returns {Promise<Object|null>} Token information or null
     */
    async fetchTokenInfoFromExplorer(address, chain = 'ethereum') {
        try {
            const config = this.configManager.getChainConfig(chain);
            const apiKey = process.env[config.explorerApi.apiKeyEnv];

            if (!apiKey || apiKey === 'YourApiKeyToken') {
                console.log(`No API key found for ${config.name} explorer, skipping API call`);
                return null;
            }

            const explorerApiUrl = this.configManager.getExplorerApiUrl(chain, 'token', 'tokeninfo', {
                contractaddress: address
            });

            console.log(`Fetching token info from ${config.name} explorer: ${explorerApiUrl}`);

            // TODO: Implement actual HTTP request to Explorer API
            // For now, return null to fallback to RPC calls
            return null;

        } catch (error) {
            console.warn(`${this.configManager.getChainConfig(chain).name} Explorer API request failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Fetch basic ERC20 token information
     * @param {string} address - Token contract address
     * @param {string|null} rpcUrl - Optional RPC URL
     * @returns {Promise<Object|null>} ERC20 token information or null
     */
    async fetchERC20Info(address, rpcUrl = null) {
        try {
            rpcUrl = rpcUrl || await this.rpcManager.getEnhancedRpcUrl('ethereum');
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const contract = new ethers.Contract(address, ERC20_ABI, provider);

            const [name, symbol, decimals] = await Promise.all([
                contract.name().catch(() => 'Unknown'),
                contract.symbol().catch(() => 'UNK'),
                contract.decimals().catch(() => 18)
            ]);

            return {
                type: 'ERC20',
                name,
                symbol,
                decimals: Number(decimals),
                address
            };
        } catch (error) {
            console.warn(`Failed to fetch ERC20 info for ${address}: ${error.message}`);
            return null;
        }
    }

    /**
     * Fetch Uniswap V2 pair information
     * @param {string} address - Pair contract address
     * @param {string|null} rpcUrl - Optional RPC URL
     * @returns {Promise<Object|null>} Pair information or null
     */
    async fetchUniswapPairInfo(address, rpcUrl = null) {
        try {
            rpcUrl = rpcUrl || await this.rpcManager.getEnhancedRpcUrl('ethereum');
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const pairContract = new ethers.Contract(address, UNISWAP_V2_PAIR_ABI, provider);

            // Try to get token addresses
            const [token0, token1] = await Promise.all([
                pairContract.token0(),
                pairContract.token1()
            ]);

            // Fetch token symbols for token0 and token1
            const [token0Info, token1Info] = await Promise.all([
                this.fetchERC20Info(token0, rpcUrl),
                this.fetchERC20Info(token1, rpcUrl)
            ]);

            if (!token0Info || !token1Info) {
                return null;
            }

            const pairName = `${token0Info.symbol}-${token1Info.symbol} LP`;
            const pairSymbol = `${token0Info.symbol}-${token1Info.symbol}`;

            return {
                type: 'UniswapV2Pair',
                name: pairName,
                symbol: pairSymbol,
                decimals: 18, // LP tokens typically have 18 decimals
                address,
                token0: {
                    address: token0,
                    ...token0Info
                },
                token1: {
                    address: token1,
                    ...token1Info
                }
            };

        } catch (error) {
            // Not a Uniswap pair or failed to fetch info
            return null;
        }
    }

    /**
     * Fetch transaction details
     * @param {string} txHash - Transaction hash
     * @param {string|null} rpcUrl - Optional RPC URL
     * @returns {Promise<Object|null>} Transaction details or null
     */
    async fetchTransactionDetails(txHash, rpcUrl = null) {
        try {
            rpcUrl = rpcUrl || await this.rpcManager.getEnhancedRpcUrl('ethereum');
            const provider = new ethers.JsonRpcProvider(rpcUrl);

            const tx = await provider.getTransaction(txHash);
            if (!tx) return null;

            const receipt = await provider.getTransactionReceipt(txHash);

            return {
                hash: tx.hash,
                from: tx.from,
                to: tx.to,
                value: tx.value.toString(),
                gasLimit: tx.gasLimit.toString(),
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                nonce: tx.nonce,
                blockNumber: tx.blockNumber,
                blockHash: tx.blockHash,
                status: receipt?.status,
                gasUsed: receipt?.gasUsed?.toString()
            };

        } catch (error) {
            console.warn(`Failed to fetch transaction details for ${txHash}: ${error.message}`);
            return null;
        }
    }

    /**
     * Batch fetch token information for multiple addresses
     * @param {Array<string>} addresses - Array of token addresses
     * @param {string|null} rpcUrl - Optional RPC URL
     * @param {number} batchSize - Batch size for processing
     * @returns {Promise<Map<string, Object>>} Map of address to token info
     */
    async batchFetchTokenInfo(addresses, rpcUrl = null, batchSize = 10) {
        const tokenInfoMap = new Map();
        const uniqueAddresses = [...new Set(addresses)];

        console.log(`Fetching token info for ${uniqueAddresses.length} unique addresses...`);

        // Process in batches to avoid overwhelming the RPC
        for (let i = 0; i < uniqueAddresses.length; i += batchSize) {
            const batch = uniqueAddresses.slice(i, i + batchSize);
            const promises = batch.map(async (address) => {
                const info = await this.fetchTokenInfo(address, rpcUrl);
                if (info) {
                    tokenInfoMap.set(address, info);
                }
            });

            await Promise.all(promises);

            // Small delay between batches to be nice to the RPC
            if (i + batchSize < uniqueAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        console.log(`Successfully fetched info for ${tokenInfoMap.size}/${uniqueAddresses.length} tokens`);
        return tokenInfoMap;
    }

    /**
     * Generate meaningful address variable name based on token info
     * @param {string} address - Contract address
     * @param {Array} signatures - Function signatures
     * @param {Object|null} tokenInfo - Token information
     * @returns {string} Generated variable name
     */
    generateAddressVariableName(address, signatures, tokenInfo = null) {
        // If we have token info, use it for naming
        if (tokenInfo) {
            if (tokenInfo.type === 'UniswapV2Pair') {
                return `${tokenInfo.token0.symbol.toLowerCase()}_${tokenInfo.token1.symbol.toLowerCase()}_pair`;
            } else if (tokenInfo.type === 'ERC20') {
                return `${tokenInfo.symbol.toLowerCase()}_token`;
            }
        }

        // Fallback to signature-based naming
        if (signatures && signatures.length > 0) {
            const mainFunctions = signatures
                .map(sig => sig.split('(')[0])
                .filter(name => name !== 'unknown');

            if (mainFunctions.length > 0) {
                // Sort by frequency and relevance
                const functionCounts = {};
                mainFunctions.forEach(func => {
                    functionCounts[func] = (functionCounts[func] || 0) + 1;
                });

                const sortedFunctions = Object.entries(functionCounts)
                    .sort(([,a], [,b]) => b - a)
                    .map(([func]) => func);

                const primaryFunction = sortedFunctions[0];
                return `${primaryFunction.toLowerCase()}_contract`;
            }
        }

        // Ultimate fallback
        return `contract_${address.slice(-6).toLowerCase()}`;
    }

    /**
     * Cache token information result
     * @param {string} key - Cache key
     * @param {*} data - Data to cache
     * @private
     */
    _cacheResult(key, data) {
        this.tokenCache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    /**
     * Clear token information cache
     */
    clearCache() {
        this.tokenCache.clear();
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        const now = Date.now();
        const validEntries = Array.from(this.tokenCache.values())
            .filter(entry => now - entry.timestamp < this.cacheExpiry).length;

        return {
            totalEntries: this.tokenCache.size,
            validEntries: validEntries,
            expiredEntries: this.tokenCache.size - validEntries
        };
    }

    /**
     * Validate token contract (basic checks)
     * @param {string} address - Token contract address
     * @param {string|null} rpcUrl - Optional RPC URL
     * @returns {Promise<Object>} Validation result
     */
    async validateTokenContract(address, rpcUrl = null) {
        try {
            rpcUrl = rpcUrl || await this.rpcManager.getEnhancedRpcUrl('ethereum');
            const provider = new ethers.JsonRpcProvider(rpcUrl);

            // Check if address has code
            const code = await provider.getCode(address);
            if (code === '0x') {
                return {
                    valid: false,
                    reason: 'No contract code at address',
                    isContract: false
                };
            }

            // Try to fetch basic ERC20 info
            const tokenInfo = await this.fetchERC20Info(address, rpcUrl);
            if (tokenInfo) {
                return {
                    valid: true,
                    reason: 'Valid ERC20 token contract',
                    isContract: true,
                    tokenInfo
                };
            }

            return {
                valid: true,
                reason: 'Valid contract but not standard ERC20',
                isContract: true,
                tokenInfo: null
            };

        } catch (error) {
            return {
                valid: false,
                reason: error.message,
                isContract: false
            };
        }
    }
}

module.exports = TokenManager;