const https = require('https');

/**
 * Etherface.io API helper for function signature lookups
 * Used as fallback when 4byte.directory fails
 */
class EtherfaceAPI {
    constructor() {
        this.baseUrl = 'https://api.etherface.io/v1';
        this.cache = new Map(); // Cache to avoid duplicate API calls
    }

    /**
     * Make HTTP GET request to Etherface API
     * @param {string} path - API endpoint path
     * @returns {Promise<Object>} - Parsed JSON response
     */
    async makeRequest(path) {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}${path}`;

            https.get(url, (res) => {
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
            }).on('error', (error) => {
                reject(new Error(`HTTP request failed: ${error.message}`));
            });
        });
    }

    /**
     * Look up function signature by hex selector using hash endpoint
     * @param {string} hexSelector - 4-byte hex selector (e.g., "0x00a30f93")
     * @returns {Promise<Object|null>} - Function signature object or null if not found
     */
    async lookupFunctionSignature(hexSelector) {
        // Normalize selector format (remove 0x prefix for Etherface API)
        const cleanSelector = hexSelector.startsWith('0x') ? hexSelector.slice(2) : hexSelector;

        // Check cache first
        const cacheKey = `0x${cleanSelector}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            // Use hash endpoint to search for function signatures
            // kind=function, query=hash (8 chars), page=1
            const response = await this.makeRequest(`/signatures/hash/function/${cleanSelector}/1`);

            if (response.items && response.items.length > 0) {
                // Return the first result, formatted similar to 4byte API
                const signature = response.items[0];
                const result = {
                    selector: cacheKey,
                    textSignature: signature.text,
                    functionName: signature.text.split('(')[0],
                    parameters: this.parseParameters(signature.text)
                };

                // Cache the result
                this.cache.set(cacheKey, result);
                return result;
            }

            // Cache null result to avoid repeated failed lookups
            this.cache.set(cacheKey, null);
            return null;

        } catch (error) {
            console.warn(`Failed to lookup signature for ${cacheKey} via Etherface: ${error.message}`);
            return null;
        }
    }

    /**
     * Look up multiple function signatures in parallel
     * @param {string[]} hexSelectors - Array of 4-byte hex selectors
     * @returns {Promise<Map<string, Object|null>>} - Map of selector to signature object
     */
    async lookupMultipleSignatures(hexSelectors) {
        const promises = hexSelectors.map(selector =>
            this.lookupFunctionSignature(selector).then(result => [selector, result])
        );

        const results = await Promise.all(promises);
        return new Map(results);
    }

    /**
     * Parse function parameters from text signature
     * @param {string} textSignature - e.g., "transfer(address,uint256)"
     * @returns {string[]} - Array of parameter types
     */
    parseParameters(textSignature) {
        const paramMatch = textSignature.match(/\(([^)]*)\)/);
        if (!paramMatch || !paramMatch[1]) {
            return [];
        }

        const paramString = paramMatch[1].trim();
        if (!paramString) {
            return [];
        }

        return paramString.split(',').map(param => param.trim());
    }

    /**
     * Create Solidity interface from function signature
     * @param {Object} signature - Signature object from lookupFunctionSignature
     * @returns {string} - Solidity interface function declaration
     */
    createInterfaceFunction(signature) {
        if (!signature) return null;

        const params = signature.parameters.map((param, index) =>
            `${param} param${index}`
        ).join(', ');

        return `function ${signature.functionName}(${params}) external;`;
    }

    /**
     * Generate parameter placeholders for function call
     * @param {Object} signature - Signature object from lookupFunctionSignature
     * @param {string} callData - Raw call data to decode
     * @returns {string[]} - Array of parameter placeholders
     */
    generateParameterPlaceholders(signature, callData) {
        if (!signature || !signature.parameters.length) {
            return [];
        }

        // For now, return placeholder values - in a full implementation,
        // you'd decode the actual calldata using ethers.js
        return signature.parameters.map((param, index) => {
            switch (param) {
                case 'address':
                    return 'address(0x0)';
                case 'uint256':
                case 'uint':
                    return '0';
                case 'bool':
                    return 'false';
                case 'bytes32':
                    return 'bytes32(0)';
                case 'bytes':
                    return 'hex""';
                case 'string':
                    return '""';
                default:
                    if (param.includes('[]')) {
                        return '[]';
                    }
                    return `/* ${param} */ 0`;
            }
        });
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

module.exports = EtherfaceAPI;