const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const FourByteAPI = require('./fourByteApi');
const EtherfaceAPI = require('./etherfaceApi');

// Standard ERC20 ABI for fetching token info
const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)'
];

// Uniswap V2 Pair ABI for fetching pair info
const UNISWAP_V2_PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)'
];

// Helper function to detect chain from RPC URL
function detectChainFromRpc(rpcUrl) {
    const url = rpcUrl.toLowerCase();
    if (url.includes('base') || url.includes('8453')) {
        return 'base';
    }
    return 'ethereum';
}

// Helper function to get default RPC URL for chain
function getDefaultRpcUrl(chain = 'ethereum') {
    const rpcUrls = {
        ethereum: 'https://eth.llamarpc.com',
        base: 'https://mainnet.base.org'
    };
    return rpcUrls[chain] || rpcUrls.ethereum;
}

// Load ABI for known contracts
function loadContractABI(address) {
    const lowerAddr = address.toLowerCase();
    
    // Check if this is a known contract
    let contractName = null;
    if (lowerAddr === '0x796f1793599d7b6aca6a87516546ddf8e5f3aa9d') {
        contractName = 'kiloexperpview';
    }
    
    if (!contractName) return null;
    
    try {
        const abiPath = path.join(__dirname, 'abis', `${contractName}abi.json`);
        if (fs.existsSync(abiPath)) {
            const abiContent = fs.readFileSync(abiPath, 'utf8');
            return JSON.parse(abiContent);
        }
    } catch (error) {
        console.log(`Could not load ABI for ${contractName}: ${error.message}`);
    }
    return null;
}

// Calculate function selector from signature
function getFunctionSelector(signature) {
    return '0x' + crypto.createHash('keccak256').update(signature).digest('hex').slice(0, 8);
}

// Lookup function signature with fallback from 4byte to Etherface
async function lookupFunctionSignatureWithFallback(selector, fourByteApi, etherfaceApi) {
    // Try 4byte API first
    if (fourByteApi) {
        try {
            const fourByteResult = await fourByteApi.lookupFunctionSignature(selector);
            if (fourByteResult) {
                console.log(`Found signature for ${selector} in 4byte.directory`);
                return fourByteResult;
            }
        } catch (error) {
            console.warn(`4byte API failed for ${selector}: ${error.message}`);
        }
    }

    // Fallback to Etherface API
    if (etherfaceApi) {
        try {
            const etherfaceResult = await etherfaceApi.lookupFunctionSignature(selector);
            if (etherfaceResult) {
                console.log(`Found signature for ${selector} in Etherface (fallback)`);
                return etherfaceResult;
            }
        } catch (error) {
            console.warn(`Etherface API failed for ${selector}: ${error.message}`);
        }
    }

    return null;
}

// Decode function call using ABI or 4byte API with Etherface fallback
async function decodeFunctionCall(address, callData, abi, fourByteApi = null, etherfaceApi = null) {
    if (!callData || callData.length < 10) return null;
    
    const selector = callData.slice(0, 10);
    
    // First try local ABI if available
    if (abi) {
        const functions = abi.filter(item => item.type === 'function');
        for (const func of functions) {
            const signature = `${func.name}(${func.inputs.map(input => input.type).join(',')})`;
            const funcSelector = getFunctionSelector(signature);
            
            if (funcSelector === selector) {
                return {
                    name: func.name,
                    signature: signature,
                    inputs: func.inputs,
                    paramData: callData.slice(10) // Remove selector
                };
            }
        }
    }
    
    // Fallback to 4byte API with Etherface fallback
    if (fourByteApi || etherfaceApi) {
        try {
            const apiResult = await lookupFunctionSignatureWithFallback(selector, fourByteApi, etherfaceApi);
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
                    paramData: callData.slice(10), // Remove selector
                    source: '4byte.directory'
                };
            }
        } catch (error) {
            console.warn(`4byte API lookup failed for ${selector}: ${error.message}`);
        }
    }
    
    return null;
}

// Helper function to fetch transaction details
async function fetchTransactionDetails(txHash, rpcUrl = 'https://eth.llamarpc.com') {
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const tx = await provider.getTransaction(txHash);
        if (tx) {
            return {
                blockNumber: tx.blockNumber,
                from: tx.from,
                to: tx.to
            };
        }
    } catch (error) {
        console.warn(`Could not fetch transaction details: ${error.message}`);
    }
    return null;
}

// Helper function to fetch token information
async function fetchTokenInfo(address, rpcUrl = 'https://eth.llamarpc.com') {
    const chain = detectChainFromRpc(rpcUrl);
    
    // Try Basescan API for Base chain (optional, falls back to RPC)
    if (chain === 'base') {
        const basescanInfo = await fetchTokenInfoFromBasescan(address);
        if (basescanInfo) {
            return basescanInfo;
        }
    }
    
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        
        // First try as Uniswap V2 Pair
        const pairContract = new ethers.Contract(address, UNISWAP_V2_PAIR_ABI, provider);
        try {
            const [token0, token1, pairSymbol] = await Promise.all([
                pairContract.token0(),
                pairContract.token1(),
                pairContract.symbol().catch(() => null)
            ]);
            
            // Fetch token symbols for token0 and token1
            const [token0Info, token1Info] = await Promise.all([
                fetchERC20Info(token0, rpcUrl),
                fetchERC20Info(token1, rpcUrl)
            ]);
            
            if (token0Info && token1Info) {
                const pairName = `${token0Info.symbol}_${token1Info.symbol}`;
                return { 
                    name: `${token0Info.symbol}/${token1Info.symbol} LP`,
                    symbol: pairName,
                    isPair: true,
                    token0: token0Info,
                    token1: token1Info
                };
            }
        } catch (error) {
            // Not a Uniswap V2 pair, continue with regular ERC20
        }
        
        // Try as regular ERC20 token
        const info = await fetchERC20Info(address, rpcUrl);
        if (info) {
            return info;
        }
        
    } catch (error) {
        // RPC failed or not a token
    }
    return null;
}

// Helper function to fetch token info from Basescan API
async function fetchTokenInfoFromBasescan(address) {
    try {
        const apiKey = process.env.BASESCAN_API_KEY || 'YourApiKeyToken';
        const basescanApiUrl = `https://api.basescan.org/api?module=token&action=tokeninfo&contractaddress=${address}&apikey=${apiKey}`;
        
        // Note: In production, you would need a real Basescan API key
        // For now, we'll just use RPC calls since API might not be available
        console.log(`Would fetch from Basescan: ${basescanApiUrl}`);
        
        // TODO: Implement actual HTTP request to Basescan API
        // const response = await fetch(basescanApiUrl);
        // const data = await response.json();
        // if (data.status === '1' && data.result) {
        //     return {
        //         name: data.result.name,
        //         symbol: data.result.symbol
        //     };
        // }
        
        return null;
    } catch (error) {
        console.warn(`Basescan API request failed: ${error.message}`);
        return null;
    }
}

// Helper function to fetch basic ERC20 info
async function fetchERC20Info(address, rpcUrl = 'https://eth.llamarpc.com') {
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const contract = new ethers.Contract(address, ERC20_ABI, provider);
        
        const [name, symbol] = await Promise.all([
            contract.name().catch(() => null),
            contract.symbol().catch(() => null)
        ]);
        
        if (symbol) {
            return { name, symbol };
        }
    } catch (error) {
        // Not an ERC20 token or RPC failed
    }
    return null;
}

// Helper function to generate meaningful address variable names
function generateAddressVariableName(address, signatures, tokenInfo = null) {
    const lowerAddr = address.toLowerCase();
    
    // Known contract mappings based on common DeFi addresses
    const knownContracts = {
        // Ethereum Mainnet - Major Stablecoins
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
        '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
        '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
        '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 'USDe',
        '0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32': 'sFRAX',
        
        // Ethereum Mainnet - Native & Wrapped Assets
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
        '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
        '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'wstETH',
        '0xae78736cd615f374d3085123a210448e74fc6393': 'rETH',
        
        // Ethereum Mainnet - Major DeFi Tokens
        '0xc00e94cb662c3520282e6f5717214004a7f26888': 'COMP',
        '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'UNI',
        '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'AAVE',
        '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2': 'SUSHI',
        '0xd533a949740bb3306d119cc777fa900ba034cd52': 'CRV',
        '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b': 'CVX',
        '0x5a98fcbea516cf06857215779fd812ca3bef1b32': 'LDO',
        
        // Ethereum Mainnet - Protocol Contracts
        '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb': 'MORPHO_BLUE',
        '0xba12222222228d8ba445958a75a0704d566bf2c8': 'BALANCER_VAULT',
        '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': 'AAVE_POOL',
        '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'UNISWAP_V3_ROUTER',
        '0xe592427a0aece92de3edee1f18e0157c05861564': 'UNISWAP_V3_ROUTER_V1',
        
        // Base Chain - Stablecoins
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', // Base USDC
        '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',  // Base DAI
        
        // Base Chain - Native & Wrapped Assets
        '0x4200000000000000000000000000000000000006': 'WETH', // Base WETH
        '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH', // Coinbase ETH
        '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': 'weETH', // Wrapped eETH
        '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': 'wstETH', // Base wstETH
        
        // Base Chain - Protocol Contracts
        '0x2626664c2603336e57b271c5c0b26f421741e481': 'UNISWAP_V3_ROUTER', // Base Uniswap V3 Router
        '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': 'UNISWAP_V3_FACTORY', // Base Uniswap V3 Factory
        
        // Base Chain - Aerodrome DEX
        '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'AERODROME_ROUTER',
        '0x420dd381b31aef6683db6b902084cb0ffece40da': 'AERODROME_FACTORY',
        
        // Base Chain - Other DeFi
        '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO', // Aerodrome token
        '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC', // USD Base Coin
        '0xb79dd08ea68a908a97220c76d19a6aa9cbde4376': 'USD_PLUS', // USD+
        
        // KiloPerp Protocol
        '0x796f1793599d7b6aca6a87516546ddf8e5f3aa9d': 'KILOPERPVIEW' // KiloPerpView contract
    };
    
    if (knownContracts[lowerAddr]) {
        return knownContracts[lowerAddr];
    }
    
    // Use token symbol if available (sanitize for Solidity)
    if (tokenInfo && tokenInfo.symbol) {
        return tokenInfo.symbol.toUpperCase()
            .replace(/[^A-Z0-9_]/g, '_')  // Replace invalid chars with underscore
            .replace(/_+/g, '_')          // Collapse multiple underscores
            .replace(/^_|_$/g, '');       // Remove leading/trailing underscores
    }
    
    // Generate name based on function signatures
    if (signatures && signatures.size > 0) {
        const sigArray = Array.from(signatures);
        if (sigArray.some(sig => sig.includes('flashLoan'))) {
            return `FLASHLOAN_PROVIDER_${address.slice(2, 8).toUpperCase()}`;
        }
        if (sigArray.some(sig => sig.includes('swap'))) {
            return `DEX_${address.slice(2, 8).toUpperCase()}`;
        }
        if (sigArray.some(sig => sig.includes('deposit') || sig.includes('withdraw'))) {
            return `LENDING_${address.slice(2, 8).toUpperCase()}`;
        }
        if (sigArray.some(sig => sig.includes('stake') || sig.includes('unstake'))) {
            return `STAKING_${address.slice(2, 8).toUpperCase()}`;
        }
        if (sigArray.some(sig => sig.includes('mint') || sig.includes('burn'))) {
            return `TOKEN_${address.slice(2, 8).toUpperCase()}`;
        }
    }
    
    return `CONTRACT_${address.slice(2, 8).toUpperCase()}`;
}

// Helper function to generate meaningful interface names
function generateInterfaceName(address, signatures) {
    const lowerAddr = address.toLowerCase();
    
    // Known interface mappings
    const knownInterfaces = {
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'IERC20',
        '0x6b175474e89094c44da98b954eedeac495271d0f': 'IERC20',
        '0xdac17f958d2ee523a2206206994597c13d831ec7': 'IERC20',
        '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': 'IUniswapV3Pool'
    };
    
    if (knownInterfaces[lowerAddr]) {
        return knownInterfaces[lowerAddr];
    }
    
    // Generate interface name based on function signatures
    if (signatures && signatures.size > 0) {
        const sigArray = Array.from(signatures);
        
        // Check for specialized contract types first
        if (sigArray.some(sig => sig.includes('flashLoan'))) {
            return `IFlashLoanProvider`;
        }
        if (sigArray.some(sig => sig.includes('swap') && (sig.includes('int256') || sig.includes('uint160')))) {
            return `IUniswapV3Pool`;  // V3 pools have swap(address,bool,int256,uint160,bytes)
        }
        if (sigArray.some(sig => sig.includes('swap'))) {
            return `IDEXRouter`;  // Generic DEX router
        }
        if (sigArray.some(sig => sig.includes('deposit') && sig.includes('borrow'))) {
            return `ILendingPool`;
        }
        if (sigArray.some(sig => sig.includes('exchange'))) {
            return `ICurvePool`;
        }
        if (sigArray.some(sig => sig.includes('bond'))) {
            return `IBondingContract`;
        }
        
        // Check for contracts that have specialized functions beyond ERC20
        const hasSpecializedFunctions = sigArray.some(sig => 
            sig.includes('stake') || 
            sig.includes('unstake') ||
            sig.includes('deposit') ||
            sig.includes('withdraw') ||
            sig.includes('mint') ||
            sig.includes('burn') ||
            sig.includes('borrow') ||
            sig.includes('repay') ||
            sig.includes('swap') ||
            sig.includes('exchange')
        );
        
        // If it only has basic ERC20 functions (approve, transfer, balanceOf), use IERC20
        const onlyBasicERC20 = sigArray.every(sig => 
            sig.includes('approve') || 
            sig.includes('transfer') || 
            sig.includes('balanceOf') ||
            sig.includes('allowance') ||
            sig.includes('totalSupply')
        );
        
        if (onlyBasicERC20 || (!hasSpecializedFunctions && sigArray.some(sig => sig.includes('approve') || sig.includes('transfer')))) {
            return `IERC20`;
        }
        
        // For contracts with specialized functions, create specific interfaces
        if (sigArray.some(sig => sig.includes('stake'))) {
            return `IStaking`;
        }
        if (sigArray.some(sig => sig.includes('deposit') && !sig.includes('borrow'))) {
            return `IVault`;
        }
        if (sigArray.some(sig => sig.includes('mint') && !sig.includes('bond'))) {
            return `IMintable`;
        }
        if (sigArray.some(sig => sig.includes('borrowAsset'))) {
            return `IBorrowing`;
        }
    }
    
    return `I${address.slice(2, 8)}`;
}

// Helper function to detect different callback types
function detectCallbackType(methodName, contractAddress, callData) {
    const lowerAddr = contractAddress.toLowerCase();
    
    // Morpho Blue flashloan
    if (lowerAddr === '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb') {
        if (methodName === 'flashLoan') {
            return { type: 'morpho', callback: 'onMorphoFlashLoan' };
        }
    }
    
    // Balancer V2 Vault flashloan
    if (lowerAddr === '0xba12222222228d8ba445958a75a0704d566bf2c8') {
        if (methodName === 'flashLoan') {
            return { type: 'balancer', callback: 'receiveFlashLoan' };
        }
    }
    
    // Uniswap V3 flash callback - this is the key addition!
    if (methodName === 'uniswapV3FlashCallback') {
        return { type: 'uniswapV3Flash', callback: 'uniswapV3FlashCallback' };
    }
    
    // Uniswap V3 pools (detect by known pool addresses or interface)
    const knownV3Pools = [
        '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // USDC/WETH
        // Add more known pools as needed
    ];
    
    if (methodName === 'swap' && knownV3Pools.includes(lowerAddr)) {
        return { type: 'uniswapV3', callback: 'uniswapV3SwapCallback' };
    }
    
    // Curve exchange callback
    if (methodName === 'exchange') {
        return { type: 'curve', callback: null };
    }
    
    return null;
}

// Helper function to extract calls within flashloan range that should be in callback
async function extractCallsInFlashloanRange(dataMap, startId, endId, mainAddress, contracts, addressRegistry, addressCounter, fourByteApi, etherfaceApi) {
    const callsInCallback = [];
    
    // Look for calls from the main address that happen within the flashloan range
    for (let id = startId + 1; id < endId; id++) {
        const key = id.toString();
        if (dataMap[key] && dataMap[key].invocation) {
            const invocation = dataMap[key].invocation;
            
            // Only include calls that are from the main address within the flashloan callback
            const fromAddress = invocation.fromAddress || '';
            const isFromMainAddress = fromAddress && 
                fromAddress.toLowerCase() === mainAddress.toLowerCase();
            const hasCallData = invocation.callData && invocation.callData !== "0x" && invocation.callData.length > 2;
            const isCallOperation = invocation.operation === "CALL" || 
                                   invocation.operation === "STATICCALL";
            
            if (isFromMainAddress && hasCallData && invocation.address && isCallOperation) {
                // Get method information
                let methodName = 'unknown';
                let signature = 'unknown()';
                let params = [];
                
                if (invocation.decodedMethod && invocation.decodedMethod.name) {
                    methodName = invocation.decodedMethod.name;
                    signature = invocation.decodedMethod.signature || `${methodName}()`;
                    params = invocation.decodedMethod.callParams || [];
                } else if (invocation.selector) {
                    // Try to decode using ABI first
                    const abi = invocation.to ? loadContractABI(invocation.to) : null;
                    const decodedCall = abi && invocation.callData ? await decodeFunctionCall(invocation.to, invocation.callData, abi, fourByteApi, etherfaceApi) : null;
                    
                    if (decodedCall) {
                        // Successfully decoded using ABI
                        methodName = decodedCall.name;
                        signature = decodedCall.signature;
                        
                        // Convert ABI inputs to our parameter format
                        try {
                            const decodedParams = ethers.AbiCoder.defaultAbiCoder().decode(
                                decodedCall.inputs.map(input => input.type),
                                '0x' + decodedCall.paramData
                            );
                            
                            params = decodedCall.inputs.map((input, index) => ({
                                type: input.type,
                                value: decodedParams[index]
                            }));
                        } catch (error) {
                            console.log(`Failed to decode parameters for ${decodedCall.name}: ${error.message}`);
                            // Fallback to raw call
                            methodName = `method_${invocation.selector}`;
                            signature = `${methodName}(bytes)`;
                            params = [{
                                type: 'bytes',
                                value: invocation.callData
                            }];
                        }
                    } else {
                        // Try 4byte API with Etherface fallback if we have a selector but no ABI match
                        let apiDecoded = false;
                        if ((fourByteApi || etherfaceApi) && invocation.selector) {
                            try {
                                const apiResult = await lookupFunctionSignatureWithFallback(invocation.selector, fourByteApi, etherfaceApi);
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
                                            
                                            params = apiResult.parameters.map((param, index) => ({
                                                type: param,
                                                value: decodedParams[index]
                                            }));
                                            apiDecoded = true;
                                            console.log(`✅ 4byte API decoded: ${methodName} from selector ${invocation.selector}`);
                                        } catch (error) {
                                            console.log(`Failed to decode parameters for ${apiResult.functionName}: ${error.message}`);
                                            // Even if parameter decoding fails, we still have the function signature
                                            // Try to extract raw parameter values from calldata
                                            if (invocation.callData && invocation.callData.length > 10) {
                                                // Extract raw parameter data (remove 0x and selector)
                                                const rawParamData = invocation.callData.slice(10);
                                                
                                                // Intelligent parameter parsing for KiloEx and other protocols
                                                // Analyze the actual data patterns to infer real types
                                                const paramCount = apiResult.parameters.length;
                                                const expectedDataLength = paramCount * 64;
                                                const paddedData = rawParamData.padEnd(expectedDataLength, '0');
                                                
                                                params = [];
                                                
                                                // Special handling for known KiloEx functions
                                                if (methodName === 'createIncreasePosition' && paramCount === 7) {
                                                    // KiloEx createIncreasePosition likely has structure like:
                                                    // (marketId, collateralAmount, positionSize, isLong, acceptablePrice, executionFee, referralCode)
                                                    const values = [];
                                                    for (let i = 0; i < 7; i++) {
                                                        const hexValue = paddedData.slice(i * 64, (i + 1) * 64);
                                                        values.push(BigInt('0x' + hexValue));
                                                    }
                                                    
                                                    params = [
                                                        { type: 'uint256', value: values[0].toString() }, // marketId or productId
                                                        { type: 'uint256', value: values[1].toString() }, // collateralAmount 
                                                        { type: 'uint256', value: values[2].toString() }, // positionSize
                                                        { type: 'bool', value: values[3] > 0n }, // isLong (true for long, false for short)
                                                        { type: 'uint256', value: values[4].toString() }, // acceptablePrice
                                                        { type: 'uint256', value: values[5].toString() }, // executionFee
                                                        { type: 'bytes32', value: '0x' + paddedData.slice(6 * 64, 7 * 64) } // referralCode
                                                    ];
                                                } else if (methodName === 'createDecreasePosition' && paramCount === 5) {
                                                    // KiloEx createDecreasePosition likely has structure like:
                                                    // (marketId, collateralDelta, positionDelta, isLong, acceptablePrice)
                                                    const values = [];
                                                    for (let i = 0; i < 5; i++) {
                                                        const hexValue = paddedData.slice(i * 64, (i + 1) * 64);
                                                        values.push(BigInt('0x' + hexValue));
                                                    }
                                                    
                                                    params = [
                                                        { type: 'uint256', value: values[0].toString() }, // marketId or productId
                                                        { type: 'uint256', value: values[1].toString() }, // collateralDelta
                                                        { type: 'bool', value: values[2] > 0n }, // isLong 
                                                        { type: 'uint256', value: values[3].toString() }, // sizeDelta
                                                        { type: 'uint256', value: values[4].toString() } // acceptablePrice
                                                    ];
                                                } else {
                                                    // Generic parsing for other functions
                                                    params = apiResult.parameters.map((paramType, index) => {
                                                        const start = index * 64;
                                                        const end = start + 64;
                                                        const hexValue = paddedData.slice(start, end);
                                                        
                                                        let value;
                                                        if (paramType === 'bool') {
                                                            value = hexValue === '0'.repeat(63) + '1';
                                                        } else if (paramType === 'address') {
                                                            value = '0x' + hexValue.slice(24);
                                                        } else if (paramType.startsWith('bytes')) {
                                                            value = '0x' + hexValue;
                                                        } else if (paramType.startsWith('uint') || paramType.startsWith('int')) {
                                                            value = BigInt('0x' + hexValue).toString();
                                                        } else {
                                                            value = '0x' + hexValue;
                                                        }
                                                        
                                                        return { type: paramType, value: value };
                                                    });
                                                }
                                                
                                                // Update signature to reflect our inferred parameter types
                                                if (params.length > 0) {
                                                    const paramTypes = params.map(p => p.type).join(',');
                                                    signature = `${methodName}(${paramTypes})`;
                                                }
                                            }
                                            // Mark as decoded so we use the proper function name and interface
                                            apiDecoded = true;
                                        }
                                    }
                                }
                            } catch (error) {
                                console.warn(`4byte API lookup failed for ${invocation.selector}: ${error.message}`);
                            }
                        }
                        
                        if (!apiDecoded) {
                            // Final fallback: Prioritize selector field over callData for Phalcon traces
                            methodName = `method_${invocation.selector}`;
                            // For raw method calls, use the full callData as bytes parameter
                            if (invocation.callData && invocation.callData.length > 2) {
                                signature = `${methodName}(bytes)`;
                                // Create a parameter for the raw call data
                                params = [{
                                    type: 'bytes',
                                    value: invocation.callData
                                }];
                            } else {
                                signature = `${methodName}()`;
                            }
                        }
                    }
                } else if (invocation.callData && invocation.callData.length >= 10) {
                    const methodSig = invocation.callData.substring(0, 10);
                    methodName = `method_${methodSig}`;
                    // For raw method calls, use the full callData as bytes parameter  
                    signature = `${methodName}(bytes)`;
                    params = [{
                        type: 'bytes',
                        value: invocation.callData
                    }];
                }
                
                const contractAddress = invocation.address;
                
                // Track contract interfaces for callback calls too
                if (!contracts.has(contractAddress)) {
                    contracts.set(contractAddress, new Set());
                }
                contracts.get(contractAddress).add(signature);
                
                // Track repeated addresses for callback calls too
                if (!addressCounter.has(contractAddress)) {
                    addressCounter.set(contractAddress, 0);
                }
                addressCounter.set(contractAddress, addressCounter.get(contractAddress) + 1);
                
                callsInCallback.push({
                    id: invocation.id,
                    contractAddress,
                    methodName,
                    signature,
                    params,
                    callData: invocation.callData,
                    fromAddress: invocation.fromAddress,
                    isFromMainAddress: true
                });
                
                console.log(`  -> Callback call: ${methodName} to ${contractAddress}`);
            }
        }
    }
    
    return callsInCallback;
}

// Helper function to extract callback data from flashloan calldata
function extractCallbackData(callData, dataMap, callId, mainAddress) {
    // Find the end of this flashloan call by looking for events or next main call
    let endId = parseInt(callId) + 100; // Default range
    const sortedKeys = Object.keys(dataMap).map(k => parseInt(k)).sort((a, b) => a - b);
    
    // Find actual end by looking for next main address call or end of trace
    for (const key of sortedKeys) {
        if (key > callId) {
            const entry = dataMap[key.toString()];
            if (entry && entry.invocation) {
                const fromAddress = entry.invocation.fromAddress || '';
                if (fromAddress && fromAddress.toLowerCase() === mainAddress.toLowerCase()) {
                    endId = key;
                    break;
                }
            }
        }
    }
    
    const callsInCallback = findCallsInTimeframe(dataMap, callId, endId, mainAddress);
    
    if (callData.length > 200 && callData.includes('cb00000')) {
        return {
            type: 'flashloan',
            data: callData.substring(callData.indexOf('cb00000')),
            calls: callsInCallback
        };
    }
    
    return callsInCallback.length > 0 ? {
        type: 'flashloan',
        data: callData,
        calls: callsInCallback
    } : null;
}

// Helper function to generate callback functions with actual implementations
function generateCallbackFunctions(callbacks, contracts, addressRegistry, mainAddress) {
    let functions = '\n';
    
    callbacks.forEach((callbackData, type) => {
        if (type === 'flashLoanCallback' && callbackData.calls && callbackData.calls.length > 0) {
            functions += `    // Flash loan callback function\n`;
            functions += `    function receiveFlashLoan(\n`;
            functions += `        address[] memory tokens,\n`;
            functions += `        uint256[] memory amounts,\n`;
            functions += `        uint256[] memory feeAmounts,\n`;
            functions += `        bytes memory userData\n`;
            functions += `    ) external {\n`;
            functions += `        // Callback implementation based on trace\n`;
            
            // Generate the actual calls from the callback
            callbackData.calls.forEach(call => {
                const interfaceName = generateInterfaceName(call.contractAddress, contracts.get(call.contractAddress));
                const addressVar = addressRegistry.get(call.contractAddress) || call.contractAddress;
                
                // Parse signature to get parameter types and match with struct names
                const signatureParts = call.signature ? call.signature.match(/^(\w+)\((.*)\)$/) : null;
                let paramTypes = [];
                let structNames = [];
                
                if (signatureParts && signatureParts[2]) {
                    paramTypes = parseParameterTypes(signatureParts[2]);
                    
                    // For each parameter type, check if it's a struct
                    structNames = paramTypes.map((paramType, index) => {
                        if (paramType.trim().startsWith('(') && paramType.trim().endsWith(')')) {
                            // This is a tuple type - generate struct name
                            return `${call.methodName.charAt(0).toUpperCase() + call.methodName.slice(1)}Param${index}`;
                        }
                        return null;
                    });
                }
                
                // Format parameters using struct-aware helper function
                const paramValues = call.params.map((param, index) => {
                    const paramType = paramTypes[index] || '';
                    const structName = structNames[index];
                    return formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName);
                }).join(', ');
                
                functions += `        // From: ${call.fromAddress}\n`;
                
                // Check if this is an unknown method selector that needs low-level call
                if (call.methodName.startsWith('method_0x') && call.params.length === 1 && call.params[0].type === 'bytes') {
                    // Use raw calldata directly for unknown selectors (calldata already includes selector)
                    const formattedCallData = formatParameterValue(call.params[0], addressRegistry, mainAddress);
                    functions += `        (bool success, ) = ${addressVar}.call(${formattedCallData});\n`;
                    functions += `        require(success, "Call failed");\n`;
                } else {
                    functions += `        ${interfaceName}(${addressVar}).${call.methodName}(${paramValues});\n`;
                }
            });
            
            functions += `        \n`;
            functions += `        // Repay flashloan\n`;
            functions += `        // Note: Implement actual repayment logic based on your flashloan provider\n`;
            functions += `        // For Balancer, transfer tokens + fees back to vault\n`;
            functions += `    }\n\n`;
        }
        
        // Add other callback types
        if (type === 'morphoCallback' && callbackData.calls && callbackData.calls.length > 0) {
            functions += `    // Morpho Blue callback function\n`;
            functions += `    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {\n`;
            functions += `        // Callback implementation based on trace\n`;
            
            // Generate the actual calls from the callback
            callbackData.calls.forEach(call => {
                const interfaceName = generateInterfaceName(call.contractAddress, contracts.get(call.contractAddress));
                const addressVar = addressRegistry.get(call.contractAddress) || call.contractAddress;
                
                // Parse signature to get parameter types and match with struct names
                const signatureParts = call.signature ? call.signature.match(/^(\w+)\((.*)\)$/) : null;
                let paramTypes = [];
                let structNames = [];
                
                if (signatureParts && signatureParts[2]) {
                    paramTypes = parseParameterTypes(signatureParts[2]);
                    
                    // For each parameter type, check if it's a struct
                    structNames = paramTypes.map((paramType, index) => {
                        if (paramType.trim().startsWith('(') && paramType.trim().endsWith(')')) {
                            // This is a tuple type - generate struct name
                            return `${call.methodName.charAt(0).toUpperCase() + call.methodName.slice(1)}Param${index}`;
                        }
                        return null;
                    });
                }
                
                // Format parameters using struct-aware helper function
                const paramValues = call.params.map((param, index) => {
                    const paramType = paramTypes[index] || '';
                    const structName = structNames[index];
                    return formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName);
                }).join(', ');
                
                functions += `        // From: ${call.fromAddress}\n`;
                
                // Check if this is an unknown method selector that needs low-level call
                if (call.methodName.startsWith('method_0x') && call.params.length === 1 && call.params[0].type === 'bytes') {
                    // Use raw calldata directly for unknown selectors (calldata already includes selector)
                    const formattedCallData = formatParameterValue(call.params[0], addressRegistry, mainAddress);
                    functions += `        (bool success, ) = ${addressVar}.call(${formattedCallData});\n`;
                    functions += `        require(success, "Call failed");\n`;
                } else {
                    functions += `        ${interfaceName}(${addressVar}).${call.methodName}(${paramValues});\n`;
                }
            });
            
            functions += `        \n`;
            functions += `        // Repay flashloan\n`;
            functions += `        // Note: Implement actual repayment logic based on your flashloan provider\n`;
            functions += `        // For Morpho Blue, tokens are automatically repaid\n`;
            functions += `    }\n\n`;
        }
        
        if (type === 'uniswapV3Callback' && callbackData.calls && callbackData.calls.length > 0) {
            functions += `    // Uniswap V3 swap callback function\n`;
            functions += `    function uniswapV3SwapCallback(\n`;
            functions += `        int256 amount0Delta,\n`;
            functions += `        int256 amount1Delta,\n`;
            functions += `        bytes calldata data\n`;
            functions += `    ) external {\n`;
            functions += `        // Payment logic: transfer the required token amount back to the pool\n`;
            
            // Generate the actual calls from the callback
            callbackData.calls.forEach(call => {
                const interfaceName = generateInterfaceName(call.contractAddress, contracts.get(call.contractAddress));
                const addressVar = addressRegistry.get(call.contractAddress) || call.contractAddress;
                
                // Parse signature to get parameter types and match with struct names
                const signatureParts = call.signature ? call.signature.match(/^(\w+)\((.*)\)$/) : null;
                let paramTypes = [];
                let structNames = [];
                
                if (signatureParts && signatureParts[2]) {
                    paramTypes = parseParameterTypes(signatureParts[2]);
                    
                    // For each parameter type, check if it's a struct
                    structNames = paramTypes.map((paramType, index) => {
                        if (paramType.trim().startsWith('(') && paramType.trim().endsWith(')')) {
                            // This is a tuple type - generate struct name
                            return `${call.methodName.charAt(0).toUpperCase() + call.methodName.slice(1)}Param${index}`;
                        }
                        return null;
                    });
                }
                
                // Format parameters using struct-aware helper function
                const paramValues = call.params.map((param, index) => {
                    const paramType = paramTypes[index] || '';
                    const structName = structNames[index];
                    return formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName);
                }).join(', ');
                
                functions += `        // From: ${call.fromAddress}\n`;
                
                // Check if this is an unknown method selector that needs low-level call
                if (call.methodName.startsWith('method_0x') && call.params.length === 1 && call.params[0].type === 'bytes') {
                    // Use raw calldata directly for unknown selectors (calldata already includes selector)
                    const formattedCallData = formatParameterValue(call.params[0], addressRegistry, mainAddress);
                    functions += `        (bool success, ) = ${addressVar}.call(${formattedCallData});\n`;
                    functions += `        require(success, "Call failed");\n`;
                } else {
                    functions += `        ${interfaceName}(${addressVar}).${call.methodName}(${paramValues});\n`;
                }
            });
            
            functions += `    }\n\n`;
        }
        
        if (type === 'uniswapV3FlashCallback' && callbackData.calls && callbackData.calls.length > 0) {
            functions += `    // Uniswap V3 flash callback function\n`;
            functions += `    function uniswapV3FlashCallback(\n`;
            functions += `        uint256 fee0,\n`;
            functions += `        uint256 fee1,\n`;
            functions += `        bytes calldata data\n`;
            functions += `    ) external {\n`;
            functions += `        // Flash callback implementation based on trace\n`;
            
            // Generate the actual calls from the callback
            callbackData.calls.forEach(call => {
                const interfaceName = generateInterfaceName(call.contractAddress, contracts.get(call.contractAddress));
                const addressVar = addressRegistry.get(call.contractAddress) || call.contractAddress;
                
                // Parse signature to get parameter types and match with struct names
                const signatureParts = call.signature ? call.signature.match(/^(\w+)\((.*)\)$/) : null;
                let paramTypes = [];
                let structNames = [];
                
                if (signatureParts && signatureParts[2]) {
                    paramTypes = parseParameterTypes(signatureParts[2]);
                    
                    // For each parameter type, check if it's a struct
                    structNames = paramTypes.map((paramType, index) => {
                        if (paramType.trim().startsWith('(') && paramType.trim().endsWith(')')) {
                            // This is a tuple type - generate struct name
                            return `${call.methodName.charAt(0).toUpperCase() + call.methodName.slice(1)}Param${index}`;
                        }
                        return null;
                    });
                }
                
                // Format parameters using struct-aware helper function
                const paramValues = call.params.map((param, index) => {
                    const paramType = paramTypes[index] || '';
                    const structName = structNames[index];
                    return formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName);
                }).join(', ');
                
                functions += `        // From: ${call.fromAddress}\n`;
                
                // Check if this is an unknown method selector that needs low-level call
                if (call.methodName.startsWith('method_0x') && call.params.length === 1 && call.params[0].type === 'bytes') {
                    // Use raw calldata directly for unknown selectors (calldata already includes selector)
                    const formattedCallData = formatParameterValue(call.params[0], addressRegistry, mainAddress);
                    functions += `        (bool success, ) = ${addressVar}.call(${formattedCallData});\n`;
                    functions += `        require(success, "Call failed");\n`;
                } else {
                    functions += `        ${interfaceName}(${addressVar}).${call.methodName}(${paramValues});\n`;
                }
            });
            
            functions += `        \n`;
            functions += `        // Repay flash loan fees\n`;
            functions += `        // Note: Transfer fee amounts back to the pool\n`;
            functions += `    }\n\n`;
        }
    });
    
    return functions;
}

function toChecksumAddress(address) {
    // Use ethers for proper checksum address
    const { ethers } = require('ethers');
    try {
        return ethers.getAddress(address.toLowerCase());
    } catch (error) {
        console.warn(`Invalid address: ${address}, returning as-is`);
        return address;
    }
}

// Helper function to format parameter values for function calls with struct awareness
function formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName) {
    if (!param || !param.hasOwnProperty('value')) {
        console.log('Missing param or value:', param);
        return '""'; // Handle missing param or value
    }
    
    const value = param.value;
    const type = param.type || paramType || 'unknown';
    
    // Handle null/undefined values
    if (value == null) {
        return '""';
    }
    
    // Handle tuple/struct types - format as struct constructor if structName provided
    if (type.startsWith('(') && type.endsWith(')') && Array.isArray(value)) {
        const tupleValues = value.map(field => {
            if (field && typeof field === 'object' && field.type && field.hasOwnProperty('value')) {
                // Recursively format each field in the tuple
                return formatParameterValue(field, addressRegistry, mainAddress);
            } else if (typeof field === 'object' && field !== null) {
                // Fallback for unexpected object structure
                return `"${JSON.stringify(field).replace(/"/g, '\\"')}"`;
            } else {
                // Fallback for primitive values
                return `"${field.toString()}"`;
            }
        });
        
        // If we have a struct name, create proper struct constructor
        if (structName) {
            return `${structName}(${tupleValues.join(', ')})`;
        }
        
        return `(${tupleValues.join(', ')})`;
    }
    
    // For non-tuple parameters, use the original formatting logic
    return formatParameterValue(param, addressRegistry, mainAddress);
}

// Helper function to format parameter values for Solidity
function formatParameterValue(param, addressRegistry, mainAddress) {
    if (!param || !param.hasOwnProperty('value')) {
        console.log('Missing param or value:', param);
        return '""'; // Handle missing param or value
    }
    
    const value = param.value;
    const type = param.type || 'unknown';
    
    // Debug: uncomment to see parameter processing
    // console.log(`formatParameterValue called with type: ${type}, value:`, value);
    
    // Handle null/undefined values
    if (value == null) {
        return '""';
    }
    
    // FIRST: Handle tuple/struct types - this must come before other conditions
    if (type.startsWith('(') && type.endsWith(')') && Array.isArray(value)) {
        const tupleValues = value.map(field => {
            if (field && typeof field === 'object' && field.type && field.hasOwnProperty('value')) {
                // Recursively format each field in the tuple
                return formatParameterValue(field, addressRegistry, mainAddress);
            } else if (typeof field === 'object' && field !== null) {
                // Fallback for unexpected object structure
                return `"${JSON.stringify(field).replace(/"/g, '\\"')}"`;
            } else {
                // Fallback for primitive values
                return `"${field.toString()}"`;
            }
        });
        return `(${tupleValues.join(', ')})`;
    }
    
    if (type === 'address') {
        const addr = value.toString();
        // Check if it's the main address (with null check)
        if (addr && mainAddress && addr.toLowerCase() === mainAddress.toLowerCase()) {
            return 'address(this)';
        }
        const varName = addressRegistry.get(addr);
        return varName ? varName : `address(${toChecksumAddress(addr)})`;
    } else if (type.includes('uint')) {
        // Check if it's the max uint256 value and replace with type(uint256).max
        const cleanValue = value.toString().replace(/,/g, '');
        if (cleanValue === '115792089237316195423570985008687907853269984665640564039457584007913129639935') {
            return 'type(uint256).max';
        }
        return cleanValue;
    } else if (type === 'bool') {
        return value.toString().toLowerCase();
    } else if (type === 'address[]') {
        // Handle array parameters properly
        let addresses = [];
        if (Array.isArray(value)) {
            addresses = value;
        } else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
            try {
                addresses = JSON.parse(value);
            } catch (e) {
                addresses = [value];
            }
        } else if (typeof value === 'object' && value !== null) {
            // Handle object case - convert object values to array
            addresses = Object.values(value).filter(v => v != null);
        } else {
            addresses = [value];
        }
        
        return `[${addresses.map(addr => {
            if (typeof addr === 'object' && addr !== null) {
                // Handle nested objects
                return `"${JSON.stringify(addr).replace(/"/g, '\\"')}"`;
            }
            const addrStr = addr.toString();
            const varName = addressRegistry.get(addrStr);
            return varName ? varName : `address(${toChecksumAddress(addrStr)})`;
        }).join(', ')}]`;
    } else if (type.includes('[]')) {
        // Handle other array types
        let arrayValues = [];
        if (Array.isArray(value)) {
            arrayValues = value;
        } else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
            try {
                arrayValues = JSON.parse(value);
            } catch (e) {
                arrayValues = [value];
            }
        } else if (typeof value === 'object' && value !== null) {
            // Handle object case - convert object values to array
            arrayValues = Object.values(value).filter(v => v != null);
        } else {
            arrayValues = [value];
        }
        
        return `[${arrayValues.map(val => {
            if (typeof val === 'object' && val !== null) {
                return `"${JSON.stringify(val).replace(/"/g, '\\"')}"`;
            }
            return `"${val.toString()}"`;
        }).join(', ')}]`;
    } else if (type === 'bytes' || type.startsWith('bytes')) {
        const bytesValue = value.toString();
        return `hex"${bytesValue.replace('0x', '')}"`;
    } else if (type.includes('int') && !type.includes('uint')) {
        // Handle signed integers (remove commas, no quotes)
        return value.toString().replace(/,/g, '');
    } else {
        // For strings and other types
        if (typeof value === 'object' && value !== null) {
            return `"${JSON.stringify(value).replace(/"/g, '\\"')}"`;
        }
        return `"${value.toString()}"`;
    }
}

function fixInterfaceSignature(signature, structDefinitions = new Set()) {
    // Add external visibility and fix data location for bytes parameters
    const parts = signature.match(/^(\w+)\((.*)\)$/);
    if (!parts) return { signature: `${signature} external`, structs: [] };
    
    const [, funcName, paramStr] = parts;
    
    if (!paramStr.trim()) {
        return { signature: `${funcName}() external`, structs: [] };
    }
    
    const structsNeeded = [];
    
    // Split parameters carefully to handle nested tuples
    const params = parseParameterTypes(paramStr).map((param, paramIndex) => {
        const trimmed = param.trim();
        
        // Handle tuple types - create struct definitions
        if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
            // Extract tuple components
            const tupleContent = trimmed.slice(1, -1); // Remove outer parentheses
            const tupleParams = parseParameterTypes(tupleContent);
            
            // Create a struct name based on the function name and parameter index
            const structName = `${funcName.charAt(0).toUpperCase() + funcName.slice(1)}Param${paramIndex}`;
            
            // Generate struct definition
            const structFields = tupleParams.map((tupleParam, index) => {
                const cleanParam = tupleParam.trim();
                if (cleanParam === 'address') return `        address param${index};`;
                if (cleanParam === 'uint256') return `        uint256 param${index};`;
                if (cleanParam === 'bytes') return `        bytes param${index};`;
                if (cleanParam.startsWith('bytes') && cleanParam !== 'bytes') return `        ${cleanParam} param${index};`;
                return `        ${cleanParam} param${index};`;
            });
            
            const structDef = `    struct ${structName} {\n${structFields.join('\n')}\n    }`;
            
            if (!structDefinitions.has(structName)) {
                structsNeeded.push(structDef);
                structDefinitions.add(structName);
            }
            
            return `${structName} calldata`;
        }
        
        // Handle bytes parameters
        if (trimmed === 'bytes' || trimmed.startsWith('bytes[')) {
            return `${trimmed} calldata`;
        }
        
        return trimmed;
    });
    
    return { 
        signature: `${funcName}(${params.join(', ')}) external`,
        structs: structsNeeded
    };
}

// Helper function to parse parameter types, handling nested structures
function parseParameterTypes(paramStr) {
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

async function generateFoundryTest(traceData, mainAddress, blockNumber = null, rpcUrl = 'https://eth.llamarpc.com') {
    const chain = detectChainFromRpc(rpcUrl);
    const { dataMap } = traceData;
    
    if (!mainAddress) {
        // Fallback to finding from root transaction if not provided
        const rootKey = Object.keys(dataMap).find(key => key === '0' || key === 'root');
        if (rootKey && dataMap[rootKey].invocation) {
            mainAddress = dataMap[rootKey].invocation.from;
        }
    }
    
    if (!mainAddress) {
        throw new Error('Could not determine main address from trace and none provided');
    }
    
    // Initialize 4byte API for function signature lookups
    const fourByteApi = new FourByteAPI();
    const etherfaceApi = new EtherfaceAPI();
    console.log('Initialized 4byte.directory API and Etherface API for function signature lookups');
    
    const contracts = new Map();
    const methodCalls = [];
    const addressRegistry = new Map(); // Track repeated addresses
    const addressCounter = new Map(); // Count address usage
    
    console.log(`Filtering for calls from address: ${mainAddress}`);
    console.log(`Total entries in dataMap: ${Object.keys(dataMap).length}`);
    
    // Debug: log the structure of the first few entries
    const firstFew = Object.entries(dataMap).slice(0, 3);
    firstFew.forEach(([key, value], index) => {
        console.log(`Entry ${index}: key=${key}, hasInvocation=${!!value.invocation}`);
        if (value.invocation) {
            console.log(`  from: ${value.invocation.from}`);
            console.log(`  to: ${value.invocation.to}`);
            console.log(`  type: ${value.invocation.type}`);
            console.log(`  operation: ${value.invocation.operation}`);
            console.log(`  hasDecodedMethod: ${!!value.invocation.decodedMethod}`);
            console.log(`  hasDecodedMethodName: ${!!value.invocation.decodedMethod?.name}`);
        }
    });
    
    // First pass: Find all callback-triggering calls and their ranges
    const callbackRanges = [];
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value.invocation) {
            const invocation = value.invocation;
            const fromAddress = invocation.fromAddress || '';
            const toAddress = invocation.address || '';
            const isFromMainAddress = fromAddress && 
                fromAddress.toLowerCase() === mainAddress.toLowerCase();
            const isToMainAddress = toAddress && 
                toAddress.toLowerCase() === mainAddress.toLowerCase();
            
            // Detect flashloan calls (outgoing from main address)
            if (isFromMainAddress && invocation.decodedMethod && 
                invocation.decodedMethod.name === 'flashLoan') {
                
                // Find the end of this flashloan by looking for the end of the transaction
                // The flashloan callback contains ALL the operations until the end of the trace
                let endId = parseInt(key) + 1000; // Default large range
                const sortedKeys = Object.keys(dataMap).map(k => parseInt(k)).sort((a, b) => a - b);
                
                // Find the very end of the trace - flashloan callback runs until transaction ends
                for (const nextKey of sortedKeys) {
                    if (nextKey > parseInt(key)) {
                        endId = Math.max(endId, nextKey);
                    }
                }
                
                // Set a more reasonable end - look for a large gap or the end of meaningful calls
                endId = Math.min(endId, parseInt(key) + 500); // Limit range for performance
                
                callbackRanges.push({
                    type: 'flashloan',
                    startId: parseInt(key),
                    endId: endId,
                    contractAddress: invocation.address,
                    callData: invocation.callData,
                    methodName: 'flashLoan',
                    signature: invocation.decodedMethod.signature || 'flashLoan(address,uint256,bytes)',
                    params: invocation.decodedMethod.callParams || []
                });
                
                console.log(`Found flashloan from ${invocation.fromAddress} to ${invocation.address} (range: ${key}-${endId})`);
            }
            
            // Detect Uniswap V3 flash callback calls (incoming to main address)
            if (isToMainAddress && invocation.decodedMethod && 
                invocation.decodedMethod.name === 'uniswapV3FlashCallback') {
                
                // Find the end of this callback by looking for the return
                let endId = parseInt(key) + 200; // Default range for flash callbacks
                const sortedKeys = Object.keys(dataMap).map(k => parseInt(k)).sort((a, b) => a - b);
                
                // Look for the end of the callback - typically shorter than flashloans
                for (const nextKey of sortedKeys) {
                    if (nextKey > parseInt(key) && nextKey <= parseInt(key) + 500) {
                        // Look for the end of calls from main address within reasonable range
                        const nextEntry = dataMap[nextKey.toString()];
                        if (nextEntry && nextEntry.invocation) {
                            const nextFrom = nextEntry.invocation.fromAddress || '';
                            const isNextFromMain = nextFrom.toLowerCase() === mainAddress.toLowerCase();
                            
                            // If we find calls from main address, extend the range
                            if (isNextFromMain) {
                                endId = Math.max(endId, nextKey + 10);
                            }
                        }
                    }
                }
                
                callbackRanges.push({
                    type: 'uniswapV3Flash',
                    startId: parseInt(key),
                    endId: endId,
                    contractAddress: invocation.fromAddress, // The contract calling our callback
                    callData: invocation.callData,
                    methodName: 'uniswapV3FlashCallback',
                    signature: invocation.decodedMethod.signature || 'uniswapV3FlashCallback(uint256,uint256,bytes)',
                    params: invocation.decodedMethod.callParams || []
                });
                
                console.log(`Found uniswapV3FlashCallback from ${invocation.fromAddress} to ${invocation.address} (range: ${key}-${endId})`);
            }
            
            // Detect Uniswap V3 swap calls that trigger callbacks
            if (isFromMainAddress && invocation.decodedMethod && 
                invocation.decodedMethod.name === 'swap') {
                
                const callbackType = detectCallbackType(invocation.decodedMethod.name, invocation.address, invocation.callData);
                if (callbackType && callbackType.type === 'uniswapV3') {
                    
                    // Find the callback range - Uniswap callbacks are typically very short
                    let endId = parseInt(key) + 10; // Small range for swap callbacks
                    const sortedKeys = Object.keys(dataMap).map(k => parseInt(k)).sort((a, b) => a - b);
                    
                    // Look for the actual callback call (usually comes right after the swap)
                    for (const nextKey of sortedKeys) {
                        if (nextKey > parseInt(key) && nextKey <= parseInt(key) + 20) {
                            const nextEntry = dataMap[nextKey.toString()];
                            if (nextEntry && nextEntry.invocation && 
                                nextEntry.invocation.decodedMethod &&
                                nextEntry.invocation.decodedMethod.name === 'uniswapV3SwapCallback') {
                                endId = nextKey + 5; // Callback + a few calls inside it
                                break;
                            }
                        }
                    }
                    
                    callbackRanges.push({
                        type: 'uniswapV3',
                        startId: parseInt(key),
                        endId: endId,
                        contractAddress: invocation.address,
                        callData: invocation.callData,
                        methodName: 'swap',
                        signature: invocation.decodedMethod.signature || 'swap(address,bool,int256,uint160,bytes)',
                        params: invocation.decodedMethod.callParams || []
                    });
                    
                    console.log(`Found Uniswap V3 swap from ${invocation.fromAddress} to ${invocation.address} (range: ${key}-${endId})`);
                }
            }
        }
    });
    
    // Process all invocations - separate main calls from callback calls
    for (const [key, value] of Object.entries(dataMap)) {
        if (value.invocation) {
            const invocation = value.invocation;
            const callId = parseInt(key);
            
            // Check if this call is within any callback range
            const isInCallbackRange = callbackRanges.some(range => 
                callId > range.startId && callId < range.endId);
            const callbackRange = callbackRanges.find(range => 
                callId > range.startId && callId < range.endId);
            
            const fromAddress = invocation.fromAddress || '';
            const isDirectFromMainAddress = fromAddress && 
                fromAddress.toLowerCase() === mainAddress.toLowerCase();
            const hasCallData = invocation.callData && invocation.callData !== "0x" && invocation.callData.length > 2;
            const isCallOperation = invocation.operation === "CALL" || invocation.operation === "STATICCALL";
            
            // Only include MAIN LEVEL calls (not inside callback ranges and not callback trigger calls)
            const isFlashloanCall = invocation.decodedMethod && invocation.decodedMethod.name === 'flashLoan';
            
            // Check if this call is inside any flashloan callback range
            const isCallInFlashloanRange = callbackRanges.some(range => 
                range.type === 'flashloan' && callId > range.startId && callId < range.endId);
            
            
            if (isDirectFromMainAddress && hasCallData && invocation.address && 
                isCallOperation && !isInCallbackRange && !isFlashloanCall && !isCallInFlashloanRange) {
                
                console.log(`Found DIRECT call from ${invocation.fromAddress} to ${invocation.address} (operation: ${invocation.operation})`);
                
                // Try to get method name from decoded method or fallback to selector
                let methodName = 'unknown';
                let signature = 'unknown()';
                let params = [];
                
                if (invocation.decodedMethod && invocation.decodedMethod.name) {
                    methodName = invocation.decodedMethod.name;
                    signature = invocation.decodedMethod.signature || `${methodName}()`;
                    params = invocation.decodedMethod.callParams || [];
                } else if (invocation.selector) {
                    // Try to decode using ABI first
                    const abi = invocation.to ? loadContractABI(invocation.to) : null;
                    const decodedCall = abi && invocation.callData ? await decodeFunctionCall(invocation.to, invocation.callData, abi, fourByteApi, etherfaceApi) : null;
                    
                    if (decodedCall) {
                        // Successfully decoded using ABI
                        methodName = decodedCall.name;
                        signature = decodedCall.signature;
                        
                        // Convert ABI inputs to our parameter format
                        try {
                            const decodedParams = ethers.AbiCoder.defaultAbiCoder().decode(
                                decodedCall.inputs.map(input => input.type),
                                '0x' + decodedCall.paramData
                            );
                            
                            params = decodedCall.inputs.map((input, index) => ({
                                type: input.type,
                                value: decodedParams[index]
                            }));
                        } catch (error) {
                            console.log(`Failed to decode parameters for ${decodedCall.name}: ${error.message}`);
                            // Fallback to raw call
                            methodName = `method_${invocation.selector}`;
                            signature = `${methodName}(bytes)`;
                            params = [{
                                type: 'bytes',
                                value: invocation.callData
                            }];
                        }
                    } else {
                        // Try 4byte API with Etherface fallback if we have a selector but no ABI match
                        let apiDecoded = false;
                        if ((fourByteApi || etherfaceApi) && invocation.selector) {
                            try {
                                const apiResult = await lookupFunctionSignatureWithFallback(invocation.selector, fourByteApi, etherfaceApi);
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
                                            
                                            params = apiResult.parameters.map((param, index) => ({
                                                type: param,
                                                value: decodedParams[index]
                                            }));
                                            apiDecoded = true;
                                            console.log(`✅ 4byte API decoded: ${methodName} from selector ${invocation.selector}`);
                                        } catch (error) {
                                            console.log(`Failed to decode parameters for ${apiResult.functionName}: ${error.message}`);
                                            // Even if parameter decoding fails, we still have the function signature
                                            // Try to extract raw parameter values from calldata
                                            if (invocation.callData && invocation.callData.length > 10) {
                                                // Extract raw parameter data (remove 0x and selector)
                                                const rawParamData = invocation.callData.slice(10);
                                                
                                                // Intelligent parameter parsing for KiloEx and other protocols
                                                // Analyze the actual data patterns to infer real types
                                                const paramCount = apiResult.parameters.length;
                                                const expectedDataLength = paramCount * 64;
                                                const paddedData = rawParamData.padEnd(expectedDataLength, '0');
                                                
                                                params = [];
                                                
                                                // Special handling for known KiloEx functions
                                                if (methodName === 'createIncreasePosition' && paramCount === 7) {
                                                    // KiloEx createIncreasePosition likely has structure like:
                                                    // (marketId, collateralAmount, positionSize, isLong, acceptablePrice, executionFee, referralCode)
                                                    const values = [];
                                                    for (let i = 0; i < 7; i++) {
                                                        const hexValue = paddedData.slice(i * 64, (i + 1) * 64);
                                                        values.push(BigInt('0x' + hexValue));
                                                    }
                                                    
                                                    params = [
                                                        { type: 'uint256', value: values[0].toString() }, // marketId or productId
                                                        { type: 'uint256', value: values[1].toString() }, // collateralAmount 
                                                        { type: 'uint256', value: values[2].toString() }, // positionSize
                                                        { type: 'bool', value: values[3] > 0n }, // isLong (true for long, false for short)
                                                        { type: 'uint256', value: values[4].toString() }, // acceptablePrice
                                                        { type: 'uint256', value: values[5].toString() }, // executionFee
                                                        { type: 'bytes32', value: '0x' + paddedData.slice(6 * 64, 7 * 64) } // referralCode
                                                    ];
                                                } else if (methodName === 'createDecreasePosition' && paramCount === 5) {
                                                    // KiloEx createDecreasePosition likely has structure like:
                                                    // (marketId, collateralDelta, positionDelta, isLong, acceptablePrice)
                                                    const values = [];
                                                    for (let i = 0; i < 5; i++) {
                                                        const hexValue = paddedData.slice(i * 64, (i + 1) * 64);
                                                        values.push(BigInt('0x' + hexValue));
                                                    }
                                                    
                                                    params = [
                                                        { type: 'uint256', value: values[0].toString() }, // marketId or productId
                                                        { type: 'uint256', value: values[1].toString() }, // collateralDelta
                                                        { type: 'bool', value: values[2] > 0n }, // isLong 
                                                        { type: 'uint256', value: values[3].toString() }, // sizeDelta
                                                        { type: 'uint256', value: values[4].toString() } // acceptablePrice
                                                    ];
                                                } else {
                                                    // Generic parsing for other functions
                                                    params = apiResult.parameters.map((paramType, index) => {
                                                        const start = index * 64;
                                                        const end = start + 64;
                                                        const hexValue = paddedData.slice(start, end);
                                                        
                                                        let value;
                                                        if (paramType === 'bool') {
                                                            value = hexValue === '0'.repeat(63) + '1';
                                                        } else if (paramType === 'address') {
                                                            value = '0x' + hexValue.slice(24);
                                                        } else if (paramType.startsWith('bytes')) {
                                                            value = '0x' + hexValue;
                                                        } else if (paramType.startsWith('uint') || paramType.startsWith('int')) {
                                                            value = BigInt('0x' + hexValue).toString();
                                                        } else {
                                                            value = '0x' + hexValue;
                                                        }
                                                        
                                                        return { type: paramType, value: value };
                                                    });
                                                }
                                                
                                                // Update signature to reflect our inferred parameter types
                                                if (params.length > 0) {
                                                    const paramTypes = params.map(p => p.type).join(',');
                                                    signature = `${methodName}(${paramTypes})`;
                                                }
                                            }
                                            // Mark as decoded so we use the proper function name and interface
                                            apiDecoded = true;
                                        }
                                    }
                                }
                            } catch (error) {
                                console.warn(`4byte API lookup failed for ${invocation.selector}: ${error.message}`);
                            }
                        }
                        
                        if (!apiDecoded) {
                            // Final fallback: Prioritize selector field over callData for Phalcon traces
                            methodName = `method_${invocation.selector}`;
                            // For raw method calls, use the full callData as bytes parameter
                            if (invocation.callData && invocation.callData.length > 2) {
                                signature = `${methodName}(bytes)`;
                                // Create a parameter for the raw call data
                                params = [{
                                    type: 'bytes',
                                    value: invocation.callData
                                }];
                            } else {
                                signature = `${methodName}()`;
                            }
                        }
                    }
                } else if (invocation.callData && invocation.callData.length >= 10) {
                    const methodSig = invocation.callData.substring(0, 10);
                    methodName = `method_${methodSig}`;
                    // For raw method calls, use the full callData as bytes parameter  
                    signature = `${methodName}(bytes)`;
                    params = [{
                        type: 'bytes',
                        value: invocation.callData
                    }];
                }
                
                const contractAddress = invocation.address;
                
                // Track repeated addresses
                if (!addressCounter.has(contractAddress)) {
                    addressCounter.set(contractAddress, 0);
                }
                addressCounter.set(contractAddress, addressCounter.get(contractAddress) + 1);
                
                // Track contract interfaces
                if (!contracts.has(contractAddress)) {
                    contracts.set(contractAddress, new Set());
                }
                contracts.get(contractAddress).add(signature);
                
                // Store method call with proper parameter formatting
                methodCalls.push({
                    contractAddress,
                    methodName,
                    signature,
                    params,
                    callData: invocation.callData,
                    callId: invocation.id || key
                });
            }
        }
    }
    
    // Add flashloan calls to main method calls (but not Uniswap V3 swaps)
    callbackRanges.forEach(flashloan => {
        // Only process flashloan calls, not Uniswap V3 swaps
        if (flashloan.type !== 'flashloan') {
            return;
        }
        const contractAddress = flashloan.contractAddress;
        
        // Track repeated addresses
        if (!addressCounter.has(contractAddress)) {
            addressCounter.set(contractAddress, 0);
        }
        addressCounter.set(contractAddress, addressCounter.get(contractAddress) + 1);
        
        // Track contract interfaces
        if (!contracts.has(contractAddress)) {
            contracts.set(contractAddress, new Set());
        }
        contracts.get(contractAddress).add(flashloan.signature);
        
        // Store flashloan call
        methodCalls.push({
            contractAddress,
            methodName: flashloan.methodName,
            signature: flashloan.signature,
            params: flashloan.params,
            callData: flashloan.callData,
            callId: flashloan.startId,
            isFlashloan: true,
            flashloanRange: { startId: flashloan.startId, endId: flashloan.endId }
        });
    });
    
    console.log(`Found ${methodCalls.length} calls to include`);
    
    // First pass: Process callbacks to collect all addresses and interfaces
    let callbacks = new Map();
    
    // Process callback ranges to extract calls within them  
    for (const range of callbackRanges) {
        const callbackData = await extractCallsInFlashloanRange(dataMap, range.startId, range.endId, mainAddress, contracts, addressRegistry, addressCounter, fourByteApi, etherfaceApi);
        if (callbackData && callbackData.length > 0) {
            if (range.type === 'flashloan') {
                // Determine flashloan callback type based on contract address
                const callbackType = detectCallbackType(range.methodName, range.contractAddress, range.callData);
                if (callbackType && callbackType.type === 'morpho') {
                    callbacks.set('morphoCallback', { calls: callbackData });
                } else {
                    callbacks.set('flashLoanCallback', { calls: callbackData });
                }
            } else if (range.type === 'uniswapV3') {
                // Add Uniswap V3 swap callback
                callbacks.set('uniswapV3Callback', { calls: callbackData });
                console.log(`  -> Added Uniswap V3 callback with ${callbackData.length} calls`);
            } else if (range.type === 'uniswapV3Flash') {
                // Add Uniswap V3 flash callback
                callbacks.set('uniswapV3FlashCallback', { calls: callbackData });
                console.log(`  -> Added Uniswap V3 flash callback with ${callbackData.length} calls`);
            }
        }
    }
    
    // Create address variables for all used addresses (known assets + frequently used)
    const knownAssets = {
        // Ethereum Mainnet - Major Stablecoins
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
        '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
        '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
        '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 'USDe',
        '0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32': 'sFRAX',
        
        // Ethereum Mainnet - Native & Wrapped Assets
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
        '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
        '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'wstETH',
        '0xae78736cd615f374d3085123a210448e74fc6393': 'rETH',
        
        // Ethereum Mainnet - Major DeFi Tokens
        '0xc00e94cb662c3520282e6f5717214004a7f26888': 'COMP',
        '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'UNI',
        '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': 'AAVE',
        '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2': 'SUSHI',
        '0xd533a949740bb3306d119cc777fa900ba034cd52': 'CRV',
        '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b': 'CVX',
        '0x5a98fcbea516cf06857215779fd812ca3bef1b32': 'LDO',
        
        // Ethereum Mainnet - Protocol Contracts
        '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb': 'MORPHO_BLUE',
        '0xba12222222228d8ba445958a75a0704d566bf2c8': 'BALANCER_VAULT',
        '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': 'AAVE_POOL',
        '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'UNISWAP_V3_ROUTER',
        '0xe592427a0aece92de3edee1f18e0157c05861564': 'UNISWAP_V3_ROUTER_V1',
        
        // Base Chain - Stablecoins
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', // Base USDC
        '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',  // Base DAI
        
        // Base Chain - Native & Wrapped Assets
        '0x4200000000000000000000000000000000000006': 'WETH', // Base WETH
        '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH', // Coinbase ETH
        '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': 'weETH', // Wrapped eETH
        '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': 'wstETH', // Base wstETH
        
        // Base Chain - Protocol Contracts
        '0x2626664c2603336e57b271c5c0b26f421741e481': 'UNISWAP_V3_ROUTER', // Base Uniswap V3 Router
        '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': 'UNISWAP_V3_FACTORY', // Base Uniswap V3 Factory
        
        // Base Chain - Aerodrome DEX
        '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'AERODROME_ROUTER',
        '0x420dd381b31aef6683db6b902084cb0ffece40da': 'AERODROME_FACTORY',
        
        // Base Chain - Other DeFi
        '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO', // Aerodrome token
        '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC', // USD Base Coin
        '0xb79dd08ea68a908a97220c76d19a6aa9cbde4376': 'USD_PLUS', // USD+
        
        // KiloPerp Protocol
        '0x796f1793599d7b6aca6a87516546ddf8e5f3aa9d': 'KILOPERPVIEW' // KiloPerpView contract
    };
    
    // Fetch token information for all used addresses
    console.log('Fetching token information...');
    const tokenInfoMap = new Map();
    const allUsedAddresses = new Set([...addressCounter.keys()]);
    
    // Batch fetch token info with limited concurrency to avoid rate limiting
    const addressArray = Array.from(allUsedAddresses);
    const batchSize = 5;
    for (let i = 0; i < addressArray.length; i += batchSize) {
        const batch = addressArray.slice(i, i + batchSize);
        const promises = batch.map(async (address) => {
            const info = await fetchTokenInfo(address, rpcUrl);
            if (info) {
                tokenInfoMap.set(address, info);
                console.log(`  Found token: ${address} -> ${info.symbol} (${info.name})`);
            }
            return { address, info };
        });
        
        await Promise.all(promises);
        
        // Small delay between batches to be nice to the RPC
        if (i + batchSize < addressArray.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // First, add all known assets that are used in the trace
    allUsedAddresses.forEach(address => {
        const lowerAddr = address.toLowerCase();
        if (knownAssets[lowerAddr]) {
            addressRegistry.set(address, knownAssets[lowerAddr]);
        }
    });
    
    // Then add frequently used addresses (≥2 uses) that aren't already in registry
    const frequentAddresses = Array.from(addressCounter.entries())
        .filter(([address, count]) => count >= 2 && !addressRegistry.has(address))
        .map(([address, _]) => address);
    
    // Also add all addresses that have token information (even single-use)
    const tokenAddresses = Array.from(tokenInfoMap.keys())
        .filter(address => !addressRegistry.has(address));
    
    const addressesToAdd = [...new Set([...frequentAddresses, ...tokenAddresses])];
    
    addressesToAdd.forEach(address => {
        const tokenInfo = tokenInfoMap.get(address);
        const varName = generateAddressVariableName(address, contracts.get(address), tokenInfo);
        addressRegistry.set(address, varName);
    });
    
    // Generate address variables section
    let addressVariables = '';
    if (addressRegistry.size > 0) {
        addressVariables = '    // Contract addresses\n';
        
        // Sort known assets first, then others
        const sortedAddresses = Array.from(addressRegistry.entries()).sort(([addrA, nameA], [addrB, nameB]) => {
            const lowerA = addrA.toLowerCase();
            const lowerB = addrB.toLowerCase();
            const isKnownA = knownAssets[lowerA];
            const isKnownB = knownAssets[lowerB];
            
            // Known assets first
            if (isKnownA && !isKnownB) return -1;
            if (!isKnownA && isKnownB) return 1;
            
            // Then sort alphabetically by name
            return nameA.localeCompare(nameB);
        });
        
        sortedAddresses.forEach(([address, varName]) => {
            const checksummedAddress = toChecksumAddress(address);
            addressVariables += `    address constant ${varName} = ${checksummedAddress};\n`;
        });
        addressVariables += '\n';
    }
    
    // Generate interfaces with better naming and consolidation (after processing callbacks)
    let interfaces = '';
    const interfaceMap = new Map(); // Map interface names to their signatures
    
    // Group contracts by their interface names
    contracts.forEach((signatures, address) => {
        const interfaceName = generateInterfaceName(address, signatures);
        if (!interfaceMap.has(interfaceName)) {
            interfaceMap.set(interfaceName, new Set());
        }
        signatures.forEach(sig => interfaceMap.get(interfaceName).add(sig));
    });
    
    // Generate consolidated interfaces with struct support
    const globalStructDefinitions = new Set();
    const allStructs = [];
    
    interfaceMap.forEach((signatures, interfaceName) => {
        // Filter out unknown method selectors since we use low-level calls for them
        const validSignatures = Array.from(signatures).filter(signature => 
            !signature.startsWith('method_0x') || !signature.includes('(bytes)')
        );
        
        if (validSignatures.length > 0) {
            interfaces += `interface ${interfaceName} {\n`;
            
            validSignatures.forEach(signature => {
                // Fix signature to add visibility and proper data location specifiers
                const result = fixInterfaceSignature(signature, globalStructDefinitions);
                allStructs.push(...result.structs);
                interfaces += `    function ${result.signature};\n`;
            });
            
            interfaces += '}\n\n';
        }
    });
    
    // If we have structs, add them before the interfaces
    if (allStructs.length > 0) {
        const structsSection = allStructs.join('\n\n') + '\n\n';
        interfaces = structsSection + interfaces;
    }
    
    // Generate test calls with proper parameter handling
    let testCalls = '';
    
    methodCalls.forEach(({ contractAddress, methodName, signature, params, callData, callId, isFlashloan, flashloanRange }) => {
        const interfaceName = generateInterfaceName(contractAddress, contracts.get(contractAddress));
        const addressVar = addressRegistry.get(contractAddress) || contractAddress;
        
        // Parse signature to get parameter types and match with struct names
        const signatureParts = signature.match(/^(\w+)\((.*)\)$/);
        let paramTypes = [];
        let structNames = [];
        
        if (signatureParts && signatureParts[2]) {
            paramTypes = parseParameterTypes(signatureParts[2]);
            
            // For each parameter type, check if it's a struct
            structNames = paramTypes.map((paramType, index) => {
                if (paramType.trim().startsWith('(') && paramType.trim().endsWith(')')) {
                    // This is a tuple type - generate struct name
                    return `${methodName.charAt(0).toUpperCase() + methodName.slice(1)}Param${index}`;
                }
                return null;
            });
        }
        
        // Check if this is an unknown method selector that needs low-level call
        if (methodName.startsWith('method_0x') && params.length === 1 && params[0].type === 'bytes') {
            // Use raw calldata directly for unknown selectors (calldata already includes selector)
            const formattedCallData = formatParameterValue(params[0], addressRegistry, mainAddress);
            testCalls += `        // Call data: ${callData}\n`;
            testCalls += `        (bool success, ) = ${addressVar}.call(${formattedCallData});\n`;
            testCalls += `        require(success, "Call failed");\n\n`;
        } else {
            // Format parameters using struct-aware helper function
            const paramValues = params.map((param, index) => {
                const paramType = paramTypes[index] || '';
                const structName = structNames[index];
                return formatParameterValueForCall(param, addressRegistry, mainAddress, paramType, structName);
            }).join(', ');
            
            // Add comment with original call data for debugging
            testCalls += `        // Call data: ${callData}\n`;
            testCalls += `        ${interfaceName}(${addressVar}).${methodName}(${paramValues});\n\n`;
        }
    });
    
    // Generate callback functions if any
    let callbackFunctions = '';
    if (callbacks.size > 0) {
        callbackFunctions = generateCallbackFunctions(callbacks, contracts, addressRegistry, mainAddress);
    }
    
    return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

${interfaces}
contract TraceReproductionTest is Test {
${addressVariables}    
    function setUp() public {
        // Fork ${chain} at the specified block${blockNumber ? `
        vm.createSelectFork("${chain === 'base' ? 'base' : 'mainnet'}", ${blockNumber - 1});` : `
        vm.createSelectFork("${chain === 'base' ? 'base' : 'mainnet'}");`}
        
        // Give some ETH to this contract
        vm.deal(address(this), 1 ether);
    }
    
    function testReproduceTrace() public {
${testCalls}    }
    
    function testPriceCalls() public view {
        // Add any price/view calls here
    }
${callbackFunctions}}`;
}

function generatePackageJson() {
    return `{
  "name": "trace-reproduction",
  "version": "1.0.0",
  "description": "Foundry test to reproduce Ethereum transaction flow from trace.json",
  "scripts": {
    "test": "forge test -vvv",
    "test:trace": "forge test --match-test testReproduceTrace -vvv",
    "test:price": "forge test --match-test testPriceCalls -vvv",
    "generate": "node index.js"
  },
  "keywords": ["foundry", "ethereum", "testing", "trace"],
  "author": "",
  "license": "ISC"
}`;
}

function generateFoundryToml() {
    return `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
rpc_endpoints = { mainnet = "\${RPC_URL}", arbitrum = "\${ARBITRUM_RPC_URL}", base = "\${BASE_RPC_URL}" }

[fmt]
line_length = 120
tab_width = 4`;
}

function generateEnvExample() {
    return `RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
BASE_RPC_URL=https://mainnet.base.org
BASESCAN_API_KEY=YourBasescanApiKey
CHAIN=ethereum`;
}

function generateReadme() {
    return `# Trace Reproduction Test

This Foundry test reproduces the main calls from the provided trace.json file. It uses the actual contract addresses and method calls made by the specified main address in the trace.

## Supported Chains

- **Ethereum Mainnet**: Default chain with full DeFi protocol support
- **Base Chain**: Optimized for Base ecosystem with Aerodrome DEX and Base-native tokens

## Setup

1. Install dependencies:
\`\`\`bash
bun install
\`\`\`

2. Copy \`.env.example\` to \`.env\` and fill in your RPC URLs:
\`\`\`bash
cp .env.example .env
\`\`\`

3. Set your target chain (optional):
\`\`\`bash
# For Ethereum (default)
export CHAIN=ethereum

# For Base chain
export CHAIN=base
export BASE_RPC_URL=https://mainnet.base.org
\`\`\`

4. Generate the test with manual address:
\`\`\`bash
# Using command line argument
node index.js trace.json 0x1234...5678

# Using environment variable
export MAIN_ADDRESS=0x1234...5678
node index.js trace.json

# Let it auto-detect from trace
node index.js trace.json
\`\`\`

5. Run the test:
\`\`\`bash
# Run on Ethereum mainnet
forge test --match-test testReproduceTrace -vvv --fork-url \$RPC_URL

# Run on Base chain
forge test --match-test testReproduceTrace -vvv --fork-url \$BASE_RPC_URL
\`\`\`

## Test Structure

- \`testReproduceTrace()\`: Reproduces the exact calls made by the main address in the trace
- \`testPriceCalls()\`: Placeholder for additional price/view calls

## Base Chain Features

- Support for Base-native tokens (USDC, DAI, WETH, cbETH, etc.)
- Aerodrome DEX integration
- Uniswap V3 on Base
- Basescan API integration (when API key provided)`;
}

// Function to extract potential transaction hash from trace data
function extractTransactionHashFromTrace(traceData) {
    // Look for 64-character hex strings that might be transaction hashes
    // Transaction hashes typically start with letters/numbers and aren't all zeros
    const traceString = JSON.stringify(traceData);
    const hexMatches = traceString.match(/0x[a-fA-F0-9]{64}/g);
    
    if (hexMatches && hexMatches.length > 0) {
        // Filter out values that are likely not transaction hashes
        const potentialTxHashes = hexMatches.filter(hash => {
            // Skip if it's all zeros or starts with many zeros (likely data, not tx hash)
            return !hash.match(/^0x0{40,}/) && !hash.match(/^0x0+[1-9]/) && hash.match(/[a-fA-F]/);
        });
        
        if (potentialTxHashes.length > 0) {
            return potentialTxHashes[0];
        }
    }
    
    return null;
}

async function main() {
    const tracePath = process.argv[2] || 'trace.json';
    let mainAddress = process.argv[3] || process.env.MAIN_ADDRESS || '0xd649A0876453Fc7626569B28E364262192874E18';
    let blockNumber = process.argv[4] || process.env.BLOCK_NUMBER || null;
    let txHash = process.argv[5] || process.env.TX_HASH || null;
    
    if (blockNumber) {
        blockNumber = parseInt(blockNumber);
    }
    
    if (!fs.existsSync(tracePath)) {
        console.error(`Error: ${tracePath} not found`);
        console.error('Usage: node index.js [path/to/trace.json] [main_address] [block_number] [tx_hash]');
        console.error('Or set MAIN_ADDRESS, BLOCK_NUMBER, and TX_HASH environment variables');
        console.error('');
        console.error('For accurate block forking, provide the transaction hash from which this trace was generated.');
        console.error('Example: node index.js trace.json 0x1234... 20000000 0xabcd1234...');
        process.exit(1);
    }
    
    try {
        const traceData = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
        
        // Try to extract transaction hash from trace if not provided
        if (!txHash) {
            txHash = extractTransactionHashFromTrace(traceData);
            if (txHash) {
                console.log(`Extracted potential transaction hash from trace: ${txHash}`);
            } else {
                console.log('No transaction hash found in trace data. For more accurate block number, provide transaction hash as 5th argument.');
            }
        }
        
        // Detect chain and set appropriate RPC URL
        let rpcUrl = process.env.RPC_URL || 'https://eth.llamarpc.com';
        
        // Try to fetch transaction details if tx hash is available
        let txDetails = null;
        if (txHash) {
            console.log(`Fetching transaction details for ${txHash}...`);
            txDetails = await fetchTransactionDetails(txHash, rpcUrl);
            if (txDetails) {
                if (!mainAddress || mainAddress === '0xd649A0876453Fc7626569B28E364262192874E18') {
                    mainAddress = txDetails.from;
                    console.log(`Using transaction sender as main address: ${mainAddress}`);
                }
                if (!blockNumber) {
                    blockNumber = txDetails.blockNumber;
                    console.log(`Using transaction block number: ${blockNumber}`);
                }
            }
        }
        
        // If no block number is available, try to get a recent block for this trace
        if (!blockNumber) {
            try {
                const { ethers } = require('ethers');
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                const currentBlock = await provider.getBlockNumber();
                // Use a recent block (current - 1 for latest possible state)
                blockNumber = currentBlock - 1;
                console.log(`Using recent block number for forking: ${blockNumber}`);
            } catch (error) {
                console.log('Could not fetch current block number, using default forking');
                blockNumber = null;
            }
        }
        
        // Check if we should use Base chain
        if (process.env.BASE_RPC_URL || process.env.CHAIN === 'base') {
            rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
        }
        
        // Generate Foundry test
        const testContent = await generateFoundryTest(traceData, mainAddress, blockNumber, rpcUrl);
        fs.writeFileSync('test/TraceReproduction.t.sol', testContent);
        
        // Generate package.json
        const packageJson = generatePackageJson();
        fs.writeFileSync('package.json', packageJson);
        
        // Generate foundry.toml
        const foundryToml = generateFoundryToml();
        fs.writeFileSync('foundry.toml', foundryToml);
        
        // Generate .env.example
        const envExample = generateEnvExample();
        fs.writeFileSync('.env.example', envExample);
        
        // Generate README.md
        const readme = generateReadme();
        fs.writeFileSync('README.md', readme);
        
        console.log('✅ Generated Foundry test and configuration files');
        console.log(`   - Main address: ${mainAddress}`);
        
        // Count calls for debugging
        let callCount = 0;
        Object.entries(traceData.dataMap).forEach(([key, value]) => {
            if (value.invocation) {
                const invocation = value.invocation;
                const from = invocation.from || invocation.fromAddress || '';
                
                if (from && from.toLowerCase() === mainAddress.toLowerCase()) {
                    callCount++;
                }
            }
        });
        console.log(`   - Found ${callCount} calls to include`);
        
    } catch (error) {
        console.error('Error processing trace:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}

module.exports = { generateFoundryTest };
