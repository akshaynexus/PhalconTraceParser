const { ethers } = require('ethers');

/**
 * Trace Parser Module
 * Handles parsing of transaction traces, extracting calls, and analyzing callback patterns
 */
class TraceParser {
    constructor(configManager, rpcManager, tokenManager, abiManager) {
        this.configManager = configManager;
        this.rpcManager = rpcManager;
        this.tokenManager = tokenManager;
        this.abiManager = abiManager;
    }

    /**
     * Extract transaction hash from trace data
     * @param {Object} traceData - Trace data object
     * @returns {string|null} Transaction hash or null
     */
    extractTransactionHashFromTrace(traceData) {
        if (!traceData || !traceData.dataMap) return null;

        // Look for transaction hash in trace entries
        for (const [id, entry] of Object.entries(traceData.dataMap)) {
            if (entry.transactionHash) {
                console.log(`Found transaction hash in trace: ${entry.transactionHash}`);
                return entry.transactionHash;
            }

            // Check in nested data
            if (entry.result && entry.result.transactionHash) {
                console.log(`Found transaction hash in result: ${entry.result.transactionHash}`);
                return entry.result.transactionHash;
            }
        }

        console.log('No transaction hash found in trace data');
        return null;
    }

    /**
     * Detect different callback types based on method name and context
     * @param {string} methodName - Method name
     * @param {string} contractAddress - Contract address
     * @param {string} callData - Call data
     * @returns {string} Callback type
     */
    detectCallbackType(methodName, contractAddress, callData) {
        const method = methodName.toLowerCase();

        // Aave/DeFi flash loan callbacks
        if (method.includes('flashloan') || method.includes('executeOperation')) {
            return 'aave_flashloan';
        }

        // Balancer flash loan callbacks
        if (method.includes('receiveFlashLoan')) {
            return 'balancer_flashloan';
        }

        // dYdX flash loan callbacks
        if (method.includes('callFunction')) {
            return 'dydx_flashloan';
        }

        // Morpho Blue callbacks
        if (method.includes('onMorphoFlashLoan') || method.includes('morpho')) {
            return 'morpho_blue_callback';
        }

        // Uniswap V3 callbacks
        if (method.includes('uniswapV3SwapCallback')) {
            return 'uniswap_v3_swap';
        }
        if (method.includes('uniswapV3FlashCallback')) {
            return 'uniswap_v3_flash';
        }

        // Generic flash loan callback
        if (method.includes('callback') && (method.includes('flash') || method.includes('loan'))) {
            return 'generic_flashloan';
        }

        return 'unknown_callback';
    }

    /**
     * Extract calls within flashloan range that should be in callback
     * @param {Object} dataMap - Trace data map
     * @param {number} startId - Start ID of range
     * @param {number} endId - End ID of range
     * @param {string} mainAddress - Main address
     * @param {Map} contracts - Contracts map
     * @param {Map} addressRegistry - Address registry
     * @param {Map} addressCounter - Address counter
     * @returns {Promise<Array>} Array of calls in callback
     */
    async extractCallsInFlashloanRange(dataMap, startId, endId, mainAddress, contracts, addressRegistry, addressCounter) {
        const callsInCallback = [];

        // Look for calls from the main address that happen within the flashloan range
        for (let id = startId + 1; id < endId; id++) {
            const entry = dataMap[id];
            if (!entry) continue;

            // Look for invocations from main address
            // Handle both plural and singular forms
            const invocations = entry.invocations || (entry.invocation ? [entry.invocation] : []);

            for (const invocation of invocations) {
                // Check both 'from' and 'fromAddress' fields
                const fromAddr = invocation.from || invocation.fromAddress;
                if (fromAddr && fromAddr.toLowerCase() === mainAddress.toLowerCase()) {
                    let methodName = 'unknown';
                    let signature = 'unknown()';
                    let params = [];

                    // Try to decode the method call
                    if (invocation.decodedMethod && invocation.decodedMethod.name) {
                        methodName = invocation.decodedMethod.name;
                        signature = invocation.decodedMethod.signature || `${methodName}()`;
                        params = invocation.decodedMethod.callParams || [];
                    } else if (invocation.selector) {
                        // Try to decode using ABI first
                        const abi = this.abiManager.loadContractABI(invocation.to);
                        const decodedCall = abi && invocation.callData
                            ? await this.abiManager.decodeFunctionCall(invocation.to, invocation.callData, abi)
                            : null;

                        if (decodedCall) {
                            // Successfully decoded using ABI
                            methodName = decodedCall.name;
                            signature = decodedCall.signature;

                            // Convert ABI inputs to our parameter format
                            if (decodedCall.decodedData && decodedCall.inputs) {
                                params = decodedCall.inputs.map((input, index) => ({
                                    type: input.type,
                                    name: input.name || `param${index}`,
                                    value: decodedCall.decodedData[index]?.toString() || 'unknown'
                                }));
                            } else {
                                // Fallback to raw call data
                                params = [{
                                    type: 'bytes',
                                    value: invocation.callData
                                }];
                            }
                        } else {
                            // Try API with fallback if we have a selector but no ABI match
                            let apiDecoded = false;
                            if (invocation.selector) {
                                try {
                                    const apiResult = await this.abiManager.lookupFunctionSignatureWithFallback(invocation.selector);
                                    if (apiResult) {
                                        methodName = apiResult.functionName;
                                        signature = apiResult.textSignature;

                                        // Try to decode parameters using the API result
                                        if (invocation.callData && invocation.callData.length > 10) {
                                            try {
                                                const paramData = '0x' + invocation.callData.slice(10);
                                                const decodedParams = ethers.AbiCoder.defaultAbiCoder().decode(
                                                    apiResult.parameters,
                                                    paramData
                                                );

                                                // Convert to our parameter format
                                                params = apiResult.parameters.map((paramType, index) => ({
                                                    type: paramType,
                                                    name: `param${index}`,
                                                    value: decodedParams[index]?.toString() || 'unknown'
                                                }));

                                                // Even if parameter decoding fails, we still have the function signature
                                                apiDecoded = true;
                                                console.log(`Successfully decoded ${methodName} with ${params.length} parameters using API`);

                                                // Special handling for known KiloEx functions
                                                if (methodName === 'decreasePosition' || methodName === 'increasePosition') {
                                                    try {
                                                        // KiloEx position functions have complex struct parameters
                                                        if (params.length >= 2) {
                                                            // Try to parse the struct parameter (usually first parameter)
                                                            const structParam = decodedParams[0];
                                                            if (structParam && typeof structParam === 'object') {
                                                                // Format as struct call
                                                                const structFields = Object.keys(structParam)
                                                                    .filter(key => !key.match(/^\d+$/)) // Filter out numeric indices
                                                                    .map(key => `${key}: ${structParam[key]}`);

                                                                params[0].value = `{ ${structFields.join(', ')} }`;
                                                            }
                                                        }
                                                    } catch (structError) {
                                                        console.warn(`Failed to parse struct parameter for ${methodName}: ${structError.message}`);
                                                        // Keep original decoded parameters
                                                    }
                                                } else {
                                                    // Generic parsing for other functions
                                                    params.forEach((param, index) => {
                                                        try {
                                                            const rawValue = decodedParams[index];
                                                            if (rawValue !== undefined) {
                                                                // Handle different data types
                                                                if (typeof rawValue === 'bigint') {
                                                                    param.value = rawValue.toString();
                                                                } else if (Array.isArray(rawValue)) {
                                                                    param.value = `[${rawValue.join(', ')}]`;
                                                                } else if (typeof rawValue === 'object' && rawValue !== null) {
                                                                    // Handle struct-like objects
                                                                    param.value = JSON.stringify(rawValue);
                                                                } else {
                                                                    param.value = rawValue.toString();
                                                                }
                                                            }
                                                        } catch (paramError) {
                                                            console.warn(`Failed to format parameter ${index}: ${paramError.message}`);
                                                        }
                                                    });
                                                }
                                            } catch (decodeError) {
                                                console.warn(`Failed to decode parameters for ${methodName}: ${decodeError.message}`);
                                                params = [{ type: 'bytes', value: invocation.callData }];
                                            }

                                            // Mark as decoded so we use the proper function name and interface
                                            invocation.decodedMethod = {
                                                name: methodName,
                                                signature: signature,
                                                callParams: params
                                            };
                                        }
                                    }
                                } catch (apiError) {
                                    console.warn(`API lookup failed for ${invocation.selector}: ${apiError.message}`);
                                }
                            }

                            if (!apiDecoded) {
                                // Ultimate fallback - use selector as method name
                                if (invocation.selector) {
                                    methodName = `method_${invocation.selector.slice(2)}`;
                                    signature = `${methodName}()`;
                                }
                                params = invocation.callData ? [{ type: 'bytes', value: invocation.callData }] : [];
                            }
                        }
                    }

                    // Register address and update interface
                    const addressVar = this._registerAddress(invocation.to, addressRegistry, addressCounter);
                    this._updateContractInterface(invocation.to, signature, contracts);

                    callsInCallback.push({
                        to: invocation.to,
                        addressVar: addressVar,
                        methodName: methodName,
                        signature: signature,
                        params: params,
                        value: invocation.value || '0',
                        gasUsed: invocation.gasUsed || 'unknown',
                        callData: invocation.callData
                    });
                }
            }
        }

        return callsInCallback;
    }

    /**
     * Extract callback data from flashloan calldata
     * @param {string} callData - Flashloan call data
     * @param {Object} dataMap - Trace data map
     * @param {number} callId - Call ID
     * @param {string} mainAddress - Main address
     * @returns {Object|null} Callback data or null
     */
    extractCallbackData(callData, dataMap, callId, mainAddress) {
        // Look for subsequent calls that represent the callback execution
        const callbackCalls = [];

        // Search for calls in the next few entries that come from main address
        for (let searchId = callId + 1; searchId <= callId + 100; searchId++) {
            const entry = dataMap[searchId];
            if (!entry || !entry.invocations) continue;

            // Handle both plural and singular forms
            const invocations = entry.invocations || (entry.invocation ? [entry.invocation] : []);
            const relevantCalls = invocations.filter(inv => {
                const fromAddr = inv.from || inv.fromAddress;
                return fromAddr && fromAddr.toLowerCase() === mainAddress.toLowerCase();
            });

            callbackCalls.push(...relevantCalls);

            // Stop if we find a clear end pattern or too many calls
            if (callbackCalls.length > 20) break;
        }

        if (callbackCalls.length === 0) return null;

        return {
            type: 'flashloan_callback',
            calls: callbackCalls,
            startId: callId + 1,
            endId: callId + Math.min(100, callbackCalls.length + 10)
        };
    }

    /**
     * Generate callback functions with actual implementations
     * @param {Map} callbacks - Map of callback data
     * @param {Map} contracts - Contracts map
     * @param {Map} addressRegistry - Address registry
     * @param {string} mainAddress - Main address
     * @returns {string} Generated callback functions
     */
    generateCallbackFunctions(callbacks, contracts, addressRegistry, mainAddress) {
        let functions = '';

        for (const [callbackType, callbackData] of callbacks.entries()) {
            if (callbackType === 'aave_flashloan' || callbackType === 'generic_flashloan') {
                functions += `    // Flash loan callback function\n`;
                functions += `    function executeOperation(\n`;
                functions += `        address[] calldata assets,\n`;
                functions += `        uint256[] calldata amounts,\n`;
                functions += `        uint256[] calldata premiums,\n`;
                functions += `        address initiator,\n`;
                functions += `        bytes calldata params\n`;
                functions += `    ) external override returns (bool) {\n`;

                if (callbackData && callbackData.length > 0) {
                    functions += `        // Callback implementation based on trace\n\n`;

                    for (const call of callbackData) {
                        const addressVar = addressRegistry.get(call.to) || `address(${call.to})`;
                        const formattedParams = this._formatCallParameters(call.params, addressRegistry, mainAddress);

                        functions += `        // Call ${call.methodName}\n`;
                        if (call.value && call.value !== '0') {
                            functions += `        ${addressVar}.call{value: ${call.value}}(\n`;
                            functions += `            abi.encodeWithSignature("${call.signature}", ${formattedParams})\n`;
                            functions += `        );\n\n`;
                        } else {
                            functions += `        I${this._getInterfaceName(call.to, contracts)}.${call.methodName}(${formattedParams});\n\n`;
                        }
                    }
                } else {
                    functions += `        // TODO: Implement callback logic based on your requirements\n\n`;
                }

                functions += `        return true;\n`;
                functions += `    }\n\n`;

            } else if (callbackType === 'morpho_blue_callback') {
                functions += `    // Morpho Blue callback function\n`;
                functions += `    function onMorphoFlashLoan(\n`;
                functions += `        uint256 assets,\n`;
                functions += `        bytes calldata data\n`;
                functions += `    ) external {\n`;

                if (callbackData && callbackData.length > 0) {
                    functions += `        // Callback implementation based on trace\n\n`;

                    for (const call of callbackData) {
                        const addressVar = addressRegistry.get(call.to) || `address(${call.to})`;
                        const formattedParams = this._formatCallParameters(call.params, addressRegistry, mainAddress);

                        functions += `        // Call ${call.methodName}\n`;
                        functions += `        I${this._getInterfaceName(call.to, contracts)}.${call.methodName}(${formattedParams});\n\n`;
                    }
                }

                functions += `    }\n\n`;

            } else if (callbackType === 'uniswap_v3_swap') {
                functions += `    // Uniswap V3 swap callback function\n`;
                functions += `    function uniswapV3SwapCallback(\n`;
                functions += `        int256 amount0Delta,\n`;
                functions += `        int256 amount1Delta,\n`;
                functions += `        bytes calldata data\n`;
                functions += `    ) external {\n`;

                if (callbackData && callbackData.length > 0) {
                    functions += `        // Callback implementation based on trace\n\n`;

                    for (const call of callbackData) {
                        const addressVar = addressRegistry.get(call.to) || `address(${call.to})`;
                        const formattedParams = this._formatCallParameters(call.params, addressRegistry, mainAddress);

                        functions += `        // Call ${call.methodName}\n`;
                        functions += `        I${this._getInterfaceName(call.to, contracts)}.${call.methodName}(${formattedParams});\n\n`;
                    }
                }

                functions += `    }\n\n`;

            } else if (callbackType === 'uniswap_v3_flash') {
                functions += `    // Uniswap V3 flash callback function\n`;
                functions += `    function uniswapV3FlashCallback(\n`;
                functions += `        uint256 fee0,\n`;
                functions += `        uint256 fee1,\n`;
                functions += `        bytes calldata data\n`;
                functions += `    ) external {\n`;

                if (callbackData && callbackData.length > 0) {
                    functions += `        // Callback implementation based on trace\n\n`;

                    for (const call of callbackData) {
                        const addressVar = addressRegistry.get(call.to) || `address(${call.to})`;
                        const formattedParams = this._formatCallParameters(call.params, addressRegistry, mainAddress);

                        functions += `        // Call ${call.methodName}\n`;
                        functions += `        I${this._getInterfaceName(call.to, contracts)}.${call.methodName}(${formattedParams});\n\n`;
                    }
                }

                functions += `    }\n\n`;
            }
        }

        return functions;
    }

    /**
     * Convert address to checksum format
     * @param {string} address - Address to convert
     * @returns {string} Checksum address
     */
    toChecksumAddress(address) {
        if (!address || !address.startsWith('0x') || address.length !== 42) {
            return address;
        }

        const addr = address.toLowerCase().substring(2);
        const hash = ethers.keccak256(ethers.toUtf8Bytes(addr)).substring(2);
        let result = '0x';

        for (let i = 0; i < addr.length; i++) {
            if (parseInt(hash[i], 16) >= 8) {
                result += addr[i].toUpperCase();
            } else {
                result += addr[i];
            }
        }

        return result;
    }

    /**
     * Format parameter values for function calls with struct awareness
     * @param {Array} params - Parameters array
     * @param {Map} addressRegistry - Address registry
     * @param {string} mainAddress - Main address
     * @param {string} paramType - Parameter type
     * @param {string} structName - Struct name if applicable
     * @returns {string} Formatted parameter value
     */
    formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName) {
        if (!param || param.value === undefined) return '""';

        const value = param.value;

        // Handle addresses
        if (param.type === 'address' || (typeof value === 'string' && value.match(/^0x[a-fA-F0-9]{40}$/))) {
            const addr = value.toLowerCase();
            if (addr === mainAddress.toLowerCase()) {
                return 'address(this)';
            }
            const registeredVar = addressRegistry.get(addr);
            return registeredVar || this.toChecksumAddress(value);
        }

        // Handle numeric values
        if (param.type?.includes('uint') || param.type?.includes('int')) {
            return value.toString();
        }

        // Handle boolean values
        if (param.type === 'bool') {
            return value.toString().toLowerCase();
        }

        // Handle bytes and strings
        if (param.type === 'bytes' || param.type === 'string') {
            if (typeof value === 'string' && value.startsWith('0x')) {
                return `hex"${value.slice(2)}"`;
            }
            return `"${value}"`;
        }

        // Handle arrays
        if (param.type?.includes('[]')) {
            if (Array.isArray(value)) {
                const formattedElements = value.map(v =>
                    this.formatParameterValueForCall({ value: v, type: param.type.replace('[]', '') }, addressRegistry, mainAddress)
                );
                return `[${formattedElements.join(', ')}]`;
            }
        }

        // Handle structs
        if (structName && typeof value === 'object') {
            const structFields = Object.entries(value)
                .filter(([key]) => !key.match(/^\d+$/))
                .map(([key, val]) => `${val}`)
                .join(', ');
            return `${structName}(${structFields})`;
        }

        // Default formatting
        return `"${value}"`;
    }

    /**
     * Register address in registry and return variable name
     * @param {string} address - Address to register
     * @param {Map} addressRegistry - Address registry
     * @param {Map} addressCounter - Address counter
     * @returns {string} Variable name
     * @private
     */
    _registerAddress(address, addressRegistry, addressCounter) {
        const lowerAddr = address.toLowerCase();

        if (!addressRegistry.has(lowerAddr)) {
            let counter = addressCounter.get('total') || 0;
            counter++;
            addressCounter.set('total', counter);

            const varName = `addr${counter}`;
            addressRegistry.set(lowerAddr, varName);
        }

        return addressRegistry.get(lowerAddr);
    }

    /**
     * Update contract interface with new signature
     * @param {string} address - Contract address
     * @param {string} signature - Function signature
     * @param {Map} contracts - Contracts map
     * @private
     */
    _updateContractInterface(address, signature, contracts) {
        if (!contracts.has(address)) {
            contracts.set(address, new Set());
        }
        contracts.get(address).add(signature);
    }

    /**
     * Format call parameters for Solidity code
     * @param {Array} params - Parameters array
     * @param {Map} addressRegistry - Address registry
     * @param {string} mainAddress - Main address
     * @returns {string} Formatted parameters
     * @private
     */
    _formatCallParameters(params, addressRegistry, mainAddress) {
        if (!params || params.length === 0) return '';

        return params.map(param =>
            this.formatParameterValueForCall(param, addressRegistry, mainAddress)
        ).join(', ');
    }

    /**
     * Get interface name for contract
     * @param {string} address - Contract address
     * @param {Map} contracts - Contracts map
     * @returns {string} Interface name
     * @private
     */
    _getInterfaceName(address, contracts) {
        const signatures = contracts.get(address);
        if (signatures) {
            return this.abiManager.generateInterfaceName(address, Array.from(signatures));
        }
        return `Contract${address.slice(-6)}`;
    }
}

module.exports = TraceParser;