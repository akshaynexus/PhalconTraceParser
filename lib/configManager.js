const fs = require('fs');
const path = require('path');

/**
 * Configuration Manager
 * Handles loading and managing chain configurations from config.json
 */
class ConfigManager {
    constructor(configPath = null) {
        this.configPath = configPath || path.join(__dirname, '..', 'config.json');
        this.chainConfigs = {};
        this.config = {};
        this.loaded = false;

        // Load configuration on instantiation
        this.loadConfig();
    }

    /**
     * Load configuration from config.json
     * @returns {Object} Configuration loading result
     */
    loadConfig() {
        try {
            const configData = fs.readFileSync(this.configPath, 'utf8');
            this.config = JSON.parse(configData);
            this.chainConfigs = this.config.chains || {};
            this.loaded = true;

            console.log(`Loaded configuration for ${Object.keys(this.chainConfigs).length} chains from config.json`);

            return {
                success: true,
                chainsLoaded: Object.keys(this.chainConfigs).length,
                defaultChain: this.config.defaultChain
            };
        } catch (error) {
            console.warn(`Failed to load config.json: ${error.message}`);
            console.warn('Using fallback configuration for Ethereum only');

            this._loadFallbackConfig();

            return {
                success: false,
                error: error.message,
                chainsLoaded: 1,
                defaultChain: 'ethereum'
            };
        }
    }

    /**
     * Load minimal fallback configuration
     * @private
     */
    _loadFallbackConfig() {
        this.chainConfigs = {
            ethereum: {
                name: 'Ethereum',
                chainId: 1,
                rpcUrls: ['https://eth.llamarpc.com'],
                explorerApi: {
                    baseUrl: 'https://api.etherscan.io/api',
                    apiKeyEnv: 'ETHERSCAN_API_KEY'
                },
                nativeToken: { symbol: 'ETH', decimals: 18 },
                envVars: ['RPC_URL', 'ETHEREUM_RPC_URL']
            }
        };
        this.config = { chains: this.chainConfigs, defaultChain: 'ethereum' };
        this.loaded = true;
    }

    /**
     * Reload configuration from config.json
     * @returns {Object} Configuration loading result
     */
    reloadConfig() {
        return this.loadConfig();
    }

    /**
     * Get chain configuration by name
     * @param {string} chainName - Chain name (case insensitive)
     * @returns {Object} Chain configuration object
     */
    getChainConfig(chainName) {
        if (!this.loaded) {
            this.loadConfig();
        }

        const chain = chainName.toLowerCase();
        const defaultChain = this.config.defaultChain || 'ethereum';
        return this.chainConfigs[chain] || this.chainConfigs[defaultChain] || this.chainConfigs.ethereum;
    }

    /**
     * Get all supported chain names
     * @returns {Array<string>} Array of supported chain names
     */
    getSupportedChains() {
        if (!this.loaded) {
            this.loadConfig();
        }
        return Object.keys(this.chainConfigs);
    }

    /**
     * Get explorer API URL for a chain
     * @param {string} chainName - Chain name
     * @param {string} module - API module
     * @param {string} action - API action
     * @param {Object} params - Additional parameters
     * @returns {string} Complete explorer API URL
     */
    getExplorerApiUrl(chainName, module, action, params = {}) {
        const config = this.getChainConfig(chainName);
        const apiKey = process.env[config.explorerApi.apiKeyEnv] || 'YourApiKeyToken';

        const baseParams = {
            module,
            action,
            apikey: apiKey,
            ...params
        };

        const queryString = new URLSearchParams(baseParams).toString();
        return `${config.explorerApi.baseUrl}?${queryString}`;
    }

    /**
     * Get RPC URL for a chain (environment variables take precedence)
     * @param {string} chainName - Chain name
     * @returns {string} RPC URL
     */
    getRpcUrl(chainName = 'ethereum') {
        const config = this.getChainConfig(chainName);

        // Check environment variables first
        for (const envVar of config.envVars) {
            if (process.env[envVar]) {
                return process.env[envVar];
            }
        }

        // Return first default RPC URL
        return config.rpcUrls[0];
    }

    /**
     * Detect chain from RPC URL
     * @param {string} rpcUrl - RPC URL to analyze
     * @returns {string} Detected chain name
     */
    detectChainFromRpc(rpcUrl) {
        const url = rpcUrl.toLowerCase();

        // Check each chain's RPC URLs and patterns
        for (const [chainName, config] of Object.entries(this.chainConfigs)) {
            // Check against configured RPC URLs
            for (const rpc of config.rpcUrls) {
                const rpcDomain = rpc.toLowerCase();
                if (url.includes(rpcDomain.split('://')[1].split('/')[0])) {
                    return chainName;
                }
            }

            // Check chain ID in URL
            if (url.includes(config.chainId.toString())) {
                return chainName;
            }
        }

        // Fallback pattern matching
        const patterns = {
            base: ['base', '8453'],
            arbitrum: ['arbitrum', '42161'],
            polygon: ['polygon', '137'],
            optimism: ['optimism', '10'],
            bsc: ['bsc', 'binance', '56'],
            avalanche: ['avalanche', 'avax', '43114']
        };

        for (const [chain, keywords] of Object.entries(patterns)) {
            if (keywords.some(keyword => url.includes(keyword))) {
                return chain;
            }
        }

        return 'ethereum'; // Default fallback
    }

    /**
     * Check if configuration is loaded
     * @returns {boolean} True if configuration is loaded
     */
    isLoaded() {
        return this.loaded;
    }

    /**
     * Get raw configuration object
     * @returns {Object} Raw configuration
     */
    getRawConfig() {
        return this.config;
    }

    /**
     * Get all chain configurations
     * @returns {Object} All chain configurations
     */
    getAllChainConfigs() {
        return this.chainConfigs;
    }

    /**
     * Validate chain configuration
     * @param {string} chainName - Chain name to validate
     * @returns {Object} Validation result
     */
    validateChainConfig(chainName) {
        const config = this.getChainConfig(chainName);
        const issues = [];

        if (!config.name) issues.push('Missing chain name');
        if (!config.chainId) issues.push('Missing chain ID');
        if (!config.rpcUrls || config.rpcUrls.length === 0) issues.push('Missing RPC URLs');
        if (!config.explorerApi || !config.explorerApi.baseUrl) issues.push('Missing explorer API configuration');
        if (!config.nativeToken || !config.nativeToken.symbol) issues.push('Missing native token configuration');
        if (!config.envVars || config.envVars.length === 0) issues.push('Missing environment variable names');

        return {
            valid: issues.length === 0,
            issues: issues,
            config: config
        };
    }
}

module.exports = ConfigManager;