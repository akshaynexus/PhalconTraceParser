const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

/**
 * ABI and Function Signature Manager
 * Handles ABI loading, function signature lookups, and contract interaction utilities
 */
class AbiManager {
    constructor(fourByteApi = null, etherfaceApi = null) {
        this.fourByteApi = fourByteApi;
        this.etherfaceApi = etherfaceApi;
        this.knownContracts = new Map();
        this.signatureCache = new Map();

        this._loadKnownContracts();
    }

    /**
     * Load known contract ABIs from files
     * @private
     */
    _loadKnownContracts() {
        // Define known contracts and their ABI file paths
        const knownContractsConfig = {
            '0x796f1793599d7b6aca6a87516546ddf8e5f3aa9d': {
                name: 'kiloexperpview',
                abiFile: 'kiloexperpview.json'
            }
            // Add more known contracts here
        };

        for (const [address, config] of Object.entries(knownContractsConfig)) {
            try {
                const abiPath = path.join(__dirname, '..', 'abis', config.abiFile);
                if (fs.existsSync(abiPath)) {
                    const abiData = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
                    this.knownContracts.set(address.toLowerCase(), {
                        name: config.name,
                        abi: abiData
                    });
                    console.log(`Loaded ABI for ${config.name} contract`);
                }
            } catch (error) {
                console.warn(`Failed to load ABI for ${config.name}: ${error.message}`);
            }
        }
    }

    /**
     * Load contract ABI for known contracts
     * @param {string} address - Contract address
     * @returns {Array|null} Contract ABI or null
     */
    loadContractABI(address) {
        const lowerAddr = address.toLowerCase();
        const contractInfo = this.knownContracts.get(lowerAddr);

        if (contractInfo) {
            console.log(`Using known ABI for ${contractInfo.name} contract`);
            return contractInfo.abi;
        }

        return null;
    }

    /**
     * Calculate function selector from signature
     * @param {string} signature - Function signature (e.g., "transfer(address,uint256)")
     * @returns {string} 4-byte function selector
     */
    getFunctionSelector(signature) {
        const { ethers } = require('ethers');
        return ethers.id(signature).slice(0, 10);
    }

    /**
     * Lookup function signature with fallback from 4byte to Etherface
     * @param {string} selector - 4-byte hex selector
     * @returns {Promise<Object|null>} Function signature info or null
     */
    async lookupFunctionSignatureWithFallback(selector) {
        // Check cache first
        if (this.signatureCache.has(selector)) {
            return this.signatureCache.get(selector);
        }

        let result = null;

        // Try 4byte API first
        if (this.fourByteApi) {
            try {
                const fourByteResult = await this.fourByteApi.lookupFunctionSignature(selector);
                if (fourByteResult) {
                    console.log(`Found signature for ${selector} in 4byte.directory`);
                    result = fourByteResult;
                }
            } catch (error) {
                console.warn(`4byte API failed for ${selector}: ${error.message}`);
            }
        }

        // Fallback to Etherface API if 4byte failed
        if (!result && this.etherfaceApi) {
            try {
                const etherfaceResult = await this.etherfaceApi.lookupFunctionSignature(selector);
                if (etherfaceResult) {
                    console.log(`Found signature for ${selector} in Etherface (fallback)`);
                    result = etherfaceResult;
                }
            } catch (error) {
                console.warn(`Etherface API failed for ${selector}: ${error.message}`);
            }
        }

        // Cache the result (including null)
        this.signatureCache.set(selector, result);
        return result;
    }

    /**
     * Decode function call using ABI or API fallback
     * @param {string} address - Contract address
     * @param {string} callData - Call data hex string
     * @param {Array|null} abi - Contract ABI (optional)
     * @returns {Promise<Object|null>} Decoded function call or null
     */
    async decodeFunctionCall(address, callData, abi = null) {
        if (!callData || callData.length < 10) return null;

        const selector = callData.slice(0, 10);

        // First try local ABI if available
        if (abi) {
            const functions = abi.filter(item => item.type === 'function');
            for (const func of functions) {
                try {
                    const funcInterface = new ethers.Interface([func]);
                    const funcSelector = funcInterface.getFunction(func.name).selector;

                    if (funcSelector === selector) {
                        const decoded = funcInterface.decodeFunctionData(func.name, callData);
                        return {
                            name: func.name,
                            signature: `${func.name}(${func.inputs.map(i => i.type).join(',')})`,
                            inputs: func.inputs,
                            decodedData: decoded
                        };
                    }
                } catch (error) {
                    // Continue to next function
                }
            }
        }

        // Fallback to API lookup
        try {
            const apiResult = await this.lookupFunctionSignatureWithFallback(selector);
            if (apiResult) {
                // Convert API result to our format
                const inputs = apiResult.parameters.map((param, index) => ({
                    type: param,
                    name: `param${index}`
                }));

                return {
                    name: apiResult.functionName,
                    signature: apiResult.textSignature,
                    inputs: inputs,
                    selector: selector
                };
            }
        } catch (error) {
            console.warn(`API lookup failed for ${selector}: ${error.message}`);
        }

        return null;
    }

    /**
     * Generate meaningful interface name based on function signatures
     * @param {string} address - Contract address
     * @param {Array<string>} signatures - Function signatures
     * @returns {string} Interface name
     */
    generateInterfaceName(address, signatures) {
        if (!signatures || signatures.length === 0) {
            return `IContract${address.slice(-6)}`;
        }

        // Extract function names from signatures
        const functionNames = signatures
            .map(sig => sig.split('(')[0])
            .filter(name => name && name !== 'unknown')
            .slice(0, 5); // Limit to first 5 for analysis

        if (functionNames.length === 0) {
            return `IContract${address.slice(-6)}`;
        }

        // Check for known patterns and generate appropriate names
        const namePatterns = {
            // DeFi patterns
            vault: ['deposit', 'withdraw', 'totalAssets', 'totalSupply'],
            pool: ['swap', 'mint', 'burn', 'getReserves'],
            router: ['swapExactTokensForTokens', 'addLiquidity', 'removeLiquidity'],
            factory: ['createPair', 'getPair', 'allPairs'],

            // Token patterns
            token: ['transfer', 'approve', 'balanceOf', 'totalSupply'],

            // Lending patterns
            lending: ['borrow', 'repay', 'liquidate', 'collateral'],

            // Governance patterns
            governance: ['propose', 'vote', 'execute', 'delegate'],

            // NFT patterns
            nft: ['mint', 'tokenURI', 'ownerOf', 'setApprovalForAll']
        };

        // Find best matching pattern
        let bestMatch = '';
        let bestScore = 0;

        for (const [pattern, keywords] of Object.entries(namePatterns)) {
            const score = keywords.reduce((acc, keyword) => {
                return acc + (functionNames.some(func =>
                    func.toLowerCase().includes(keyword.toLowerCase())) ? 1 : 0);
            }, 0);

            if (score > bestScore) {
                bestScore = score;
                bestMatch = pattern;
            }
        }

        if (bestMatch && bestScore >= 2) {
            return `I${bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1)}`;
        }

        // Fallback: use most common function name
        const primaryFunction = functionNames[0];
        return `I${primaryFunction.charAt(0).toUpperCase() + primaryFunction.slice(1)}Contract`;
    }

    /**
     * Fix interface signature for Solidity compatibility
     * @param {string} signature - Function signature
     * @param {Set} structDefinitions - Set to collect struct definitions
     * @returns {string} Fixed signature
     */
    fixInterfaceSignature(signature, structDefinitions = new Set()) {
        // Handle complex tuple types by converting them to structs
        let fixedSignature = signature;

        // Find tuple parameters and replace with struct names
        const tupleRegex = /\(([^)]+)\)/g;
        let match;
        let structIndex = 0;

        while ((match = tupleRegex.exec(signature)) !== null) {
            const tupleContent = match[1];

            // Only convert complex tuples (with multiple fields)
            if (tupleContent.includes(',')) {
                const structName = `Param${structIndex}Struct`;
                const structFields = this.parseParameterTypes(tupleContent);

                // Create struct definition
                const structDef = `struct ${structName} {\n${
                    structFields.map((field, idx) => `        ${field} field${idx};`).join('\n')
                }\n    }`;

                structDefinitions.add(structDef);

                // Replace tuple with struct name
                fixedSignature = fixedSignature.replace(match[0], structName);
                structIndex++;
            }
        }

        return fixedSignature;
    }

    /**
     * Parse parameter types, handling nested structures
     * @param {string} paramStr - Parameter string from function signature
     * @returns {Array<string>} Array of parameter types
     */
    parseParameterTypes(paramStr) {
        const params = [];
        let current = '';
        let depth = 0;

        for (let i = 0; i < paramStr.length; i++) {
            const char = paramStr[i];

            if (char === '(') {
                depth++;
                current += char;
            } else if (char === ')') {
                depth--;
                current += char;
            } else if (char === ',' && depth === 0) {
                if (current.trim()) {
                    params.push(current.trim());
                }
                current = '';
            } else {
                current += char;
            }
        }

        if (current.trim()) {
            params.push(current.trim());
        }

        return params;
    }

    /**
     * Create Solidity interface from function signature
     * @param {Object} signature - Signature object
     * @returns {string|null} Solidity function declaration
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
     * @param {Object} signature - Signature object
     * @param {string} callData - Raw call data
     * @returns {Array<string>} Array of parameter placeholders
     */
    generateParameterPlaceholders(signature, callData) {
        if (!signature || !signature.parameters.length) {
            return [];
        }

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
     * Add known contract ABI
     * @param {string} address - Contract address
     * @param {string} name - Contract name
     * @param {Array} abi - Contract ABI
     */
    addKnownContract(address, name, abi) {
        this.knownContracts.set(address.toLowerCase(), { name, abi });
        console.log(`Added ABI for ${name} contract at ${address}`);
    }

    /**
     * Get all known contracts
     * @returns {Map} Map of address to contract info
     */
    getKnownContracts() {
        return new Map(this.knownContracts);
    }

    /**
     * Clear signature cache
     */
    clearCache() {
        this.signatureCache.clear();
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        return {
            knownContracts: this.knownContracts.size,
            signatureCache: this.signatureCache.size,
            cachedSignatures: Array.from(this.signatureCache.keys())
        };
    }

    /**
     * Validate function signature format
     * @param {string} signature - Function signature to validate
     * @returns {Object} Validation result
     */
    validateSignature(signature) {
        try {
            const funcRegex = /^([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)$/;
            const match = signature.match(funcRegex);

            if (!match) {
                return {
                    valid: false,
                    error: 'Invalid function signature format'
                };
            }

            const [, functionName, params] = match;

            // Validate function name
            if (!functionName || functionName.length === 0) {
                return {
                    valid: false,
                    error: 'Empty function name'
                };
            }

            // Parse and validate parameters
            const paramTypes = params ? this.parseParameterTypes(params) : [];

            return {
                valid: true,
                functionName,
                parameters: paramTypes,
                selector: this.getFunctionSelector(signature)
            };

        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }
}

module.exports = AbiManager;