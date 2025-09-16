import { describe, test, expect, beforeEach } from 'bun:test';
import TraceParser from '../../lib/traceParser.js';
import ConfigManager from '../../lib/configManager.js';
import RpcManager from '../../lib/rpcManager.js';
import TokenManager from '../../lib/tokenManager.js';
import AbiManager from '../../lib/abiManager.js';

describe('TraceParser - Full Coverage', () => {
    let traceParser;
    let configManager;
    let rpcManager;
    let tokenManager;
    let abiManager;

    beforeEach(() => {
        configManager = new ConfigManager();
        rpcManager = new RpcManager(configManager);
        tokenManager = new TokenManager(configManager, rpcManager);
        abiManager = new AbiManager();
        traceParser = new TraceParser(configManager, rpcManager, tokenManager, abiManager);
    });

    describe('extractTransactionHashFromTrace', () => {
        test('should extract hash from result field', () => {
            const traceData = {
                dataMap: {
                    '0': {
                        result: {
                            transactionHash: '0xabc123'
                        }
                    }
                }
            };
            const hash = traceParser.extractTransactionHashFromTrace(traceData);
            expect(hash).toBe('0xabc123');
        });

        test('should return null for empty dataMap', () => {
            const hash = traceParser.extractTransactionHashFromTrace({ dataMap: {} });
            expect(hash).toBe(null);
        });
    });

    describe('detectCallbackType', () => {
        test('should detect all callback types', () => {
            expect(traceParser.detectCallbackType('executeOperation', '', '')).toBe('aave_flashloan');
            expect(traceParser.detectCallbackType('receiveFlashLoan', '', '')).toBe('balancer_flashloan');
            expect(traceParser.detectCallbackType('callFunction', '', '')).toBe('dydx_flashloan');
            expect(traceParser.detectCallbackType('onMorphoFlashLoan', '', '')).toBe('morpho_blue_callback');
            expect(traceParser.detectCallbackType('morphoCallback', '', '')).toBe('morpho_blue_callback');
            expect(traceParser.detectCallbackType('uniswapV3SwapCallback', '', '')).toBe('uniswap_v3_swap');
            expect(traceParser.detectCallbackType('uniswapV3FlashCallback', '', '')).toBe('uniswap_v3_flash');
            expect(traceParser.detectCallbackType('flashCallback', '', '')).toBe('generic_flashloan');
            expect(traceParser.detectCallbackType('loanCallback', '', '')).toBe('generic_flashloan');
        });
    });

    describe('extractCallsInFlashloanRange', () => {
        test('should extract calls with invocations array', async () => {
            const dataMap = {
                '1': {
                    invocations: [
                        {
                            from: '0x1234567890123456789012345678901234567890',
                            to: '0xaaaa567890123456789012345678901234567890',
                            selector: '0xa9059cbb',
                            callData: '0xa9059cbb0000000000000000000000001234567890123456789012345678901234567890',
                            value: '1000000000000000000',
                            gasUsed: '21000'
                        }
                    ]
                }
            };

            const mainAddress = '0x1234567890123456789012345678901234567890';
            const contracts = new Map();
            const addressRegistry = new Map();
            const addressCounter = new Map();

            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, mainAddress, contracts, addressRegistry, addressCounter
            );

            expect(calls.length).toBe(1);
            expect(calls[0].to).toBe('0xaaaa567890123456789012345678901234567890');
            expect(calls[0].value).toBe('1000000000000000000');
            expect(calls[0].gasUsed).toBe('21000');
        });

        test('should handle fromAddress field', async () => {
            const dataMap = {
                '1': {
                    invocations: [{
                        fromAddress: '0x1234567890123456789012345678901234567890',
                        to: '0xbbbb567890123456789012345678901234567890',
                        callData: '0x12345678'
                    }]
                }
            };

            const mainAddress = '0x1234567890123456789012345678901234567890';
            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, mainAddress, new Map(), new Map(), new Map()
            );

            expect(calls.length).toBe(1);
        });

        test('should decode method with ABI', async () => {
            // Mock ABI manager methods
            abiManager.loadContractABI = (address) => [{
                name: 'transfer',
                type: 'function',
                inputs: [
                    { name: 'recipient', type: 'address' },
                    { name: 'amount', type: 'uint256' }
                ]
            }];

            abiManager.decodeFunctionCall = async (to, callData, abi) => ({
                name: 'transfer',
                signature: 'transfer(address,uint256)',
                decodedData: ['0x9999999999999999999999999999999999999999', '1000'],
                inputs: [
                    { name: 'recipient', type: 'address' },
                    { name: 'amount', type: 'uint256' }
                ]
            });

            const dataMap = {
                '1': {
                    invocations: [{
                        from: '0x1234567890123456789012345678901234567890',
                        to: '0xcccc567890123456789012345678901234567890',
                        selector: '0xa9059cbb',
                        callData: '0xa9059cbb00000000000000000000000099999999999999999999999999999999999999990000000000000000000000000000000000000000000000000000000000003e8'
                    }]
                }
            };

            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, '0x1234567890123456789012345678901234567890',
                new Map(), new Map(), new Map()
            );

            expect(calls[0].methodName).toBe('transfer');
            expect(calls[0].params.length).toBe(2);
            expect(calls[0].params[0].name).toBe('recipient');
        });

        test('should handle API fallback for method decoding', async () => {
            abiManager.loadContractABI = () => null;
            abiManager.lookupFunctionSignatureWithFallback = async (selector) => ({
                functionName: 'specialFunction',
                textSignature: 'specialFunction(uint256,address)',
                parameters: ['uint256', 'address']
            });

            const dataMap = {
                '1': {
                    invocations: [{
                        from: '0x1234567890123456789012345678901234567890',
                        to: '0xdddd567890123456789012345678901234567890',
                        selector: '0x12345678',
                        callData: '0x123456780000000000000000000000000000000000000000000000000000000000000064000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                    }]
                }
            };

            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, '0x1234567890123456789012345678901234567890',
                new Map(), new Map(), new Map()
            );

            expect(calls[0].methodName).toBe('specialFunction');
            expect(calls[0].signature).toBe('specialFunction(uint256,address)');
        });

        test('should handle KiloEx position functions', async () => {
            abiManager.loadContractABI = () => null;
            abiManager.lookupFunctionSignatureWithFallback = async () => ({
                functionName: 'decreasePosition',
                textSignature: 'decreasePosition((address,uint256,uint256,uint256,bool),address)',
                parameters: ['(address,uint256,uint256,uint256,bool)', 'address']
            });

            const dataMap = {
                '1': {
                    invocations: [{
                        from: '0x1234567890123456789012345678901234567890',
                        to: '0xffff567890123456789012345678901234567890',
                        selector: '0xabcdef12',
                        callData: '0xabcdef12' + '0'.repeat(256)
                    }]
                }
            };

            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, '0x1234567890123456789012345678901234567890',
                new Map(), new Map(), new Map()
            );

            expect(calls[0].methodName).toBe('decreasePosition');
        });

        test('should handle missing selector', async () => {
            const dataMap = {
                '1': {
                    invocations: [{
                        from: '0x1234567890123456789012345678901234567890',
                        to: '0xaaaa567890123456789012345678901234567890'
                    }]
                }
            };

            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, '0x1234567890123456789012345678901234567890',
                new Map(), new Map(), new Map()
            );

            expect(calls[0].methodName).toBe('unknown');
        });

        test('should skip non-main address calls', async () => {
            const dataMap = {
                '1': {
                    invocations: [{
                        from: '0x9999999999999999999999999999999999999999',
                        to: '0xaaaa567890123456789012345678901234567890'
                    }]
                }
            };

            const calls = await traceParser.extractCallsInFlashloanRange(
                dataMap, 0, 2, '0x1234567890123456789012345678901234567890',
                new Map(), new Map(), new Map()
            );

            expect(calls.length).toBe(0);
        });
    });

    describe('extractCallbackData', () => {
        test('should extract callback calls from dataMap', () => {
            const dataMap = {
                '11': {
                    invocations: [
                        {
                            from: '0x1234567890123456789012345678901234567890',
                            to: '0xaaaa567890123456789012345678901234567890'
                        }
                    ]
                },
                '12': {
                    invocations: [
                        {
                            from: '0x1234567890123456789012345678901234567890',
                            to: '0xbbbb567890123456789012345678901234567890'
                        }
                    ]
                }
            };

            const callbackData = traceParser.extractCallbackData(
                '0xdata', dataMap, 10, '0x1234567890123456789012345678901234567890'
            );

            expect(callbackData).toBeTruthy();
            expect(callbackData.type).toBe('flashloan_callback');
            expect(callbackData.calls.length).toBe(2);
        });

        test('should handle singular invocation field', () => {
            const dataMap = {
                '11': {
                    invocation: {
                        fromAddress: '0x1234567890123456789012345678901234567890',
                        to: '0xcccc567890123456789012345678901234567890'
                    }
                }
            };

            const callbackData = traceParser.extractCallbackData(
                '0xdata', dataMap, 10, '0x1234567890123456789012345678901234567890'
            );

            expect(callbackData).toBeTruthy();
            expect(callbackData.calls.length).toBe(1);
        });

        test('should return null when no callback calls found', () => {
            const dataMap = {
                '11': {
                    invocations: [{
                        from: '0x9999999999999999999999999999999999999999',
                        to: '0xaaaa567890123456789012345678901234567890'
                    }]
                }
            };

            const callbackData = traceParser.extractCallbackData(
                '0xdata', dataMap, 10, '0x1234567890123456789012345678901234567890'
            );

            expect(callbackData).toBe(null);
        });

        test('should limit callback calls to 20', () => {
            const dataMap = {};
            for (let i = 11; i < 50; i++) {
                dataMap[i] = {
                    invocations: [{
                        from: '0x1234567890123456789012345678901234567890',
                        to: `0x${'a'.repeat(40)}`
                    }]
                };
            }

            const callbackData = traceParser.extractCallbackData(
                '0xdata', dataMap, 10, '0x1234567890123456789012345678901234567890'
            );

            expect(callbackData.calls.length).toBeLessThanOrEqual(20);
        });
    });

    describe('generateCallbackFunctions', () => {
        test('should generate aave flashloan callback', () => {
            const callbacks = new Map();
            callbacks.set('aave_flashloan', [{
                to: '0xaaaa567890123456789012345678901234567890',
                methodName: 'transfer',
                signature: 'transfer(address,uint256)',
                params: [],
                value: '0'
            }]);

            const contracts = new Map();
            contracts.set('0xaaaa567890123456789012345678901234567890', new Set(['transfer(address,uint256)']));

            const addressRegistry = new Map();
            addressRegistry.set('0xaaaa567890123456789012345678901234567890', 'tokenAddr');

            const code = traceParser.generateCallbackFunctions(
                callbacks, contracts, addressRegistry, '0x1111111111111111111111111111111111111111'
            );

            expect(code).toContain('executeOperation');
            expect(code).toContain('transfer');
        });

        test('should generate generic flashloan callback', () => {
            const callbacks = new Map();
            callbacks.set('generic_flashloan', [{
                to: '0xbbbb567890123456789012345678901234567890',
                methodName: 'approve',
                signature: 'approve(address,uint256)',
                params: [],
                value: '1000000000000000000'
            }]);

            const code = traceParser.generateCallbackFunctions(
                callbacks, new Map(), new Map(), '0x1111111111111111111111111111111111111111'
            );

            expect(code).toContain('executeOperation');
            expect(code).toContain('value: 1000000000000000000');
        });

        test('should generate morpho blue callback', () => {
            const callbacks = new Map();
            callbacks.set('morpho_blue_callback', [{
                to: '0xcccc567890123456789012345678901234567890',
                methodName: 'repay',
                signature: 'repay(uint256)',
                params: []
            }]);

            const code = traceParser.generateCallbackFunctions(
                callbacks, new Map(), new Map(), '0x1111111111111111111111111111111111111111'
            );

            expect(code).toContain('onMorphoFlashLoan');
            expect(code).toContain('repay');
        });

        test('should generate uniswap v3 swap callback', () => {
            const callbacks = new Map();
            callbacks.set('uniswap_v3_swap', [{
                to: '0xdddd567890123456789012345678901234567890',
                methodName: 'swap',
                signature: 'swap(uint256,uint256)',
                params: []
            }]);

            const code = traceParser.generateCallbackFunctions(
                callbacks, new Map(), new Map(), '0x1111111111111111111111111111111111111111'
            );

            expect(code).toContain('uniswapV3SwapCallback');
            expect(code).toContain('amount0Delta');
        });

        test('should generate uniswap v3 flash callback', () => {
            const callbacks = new Map();
            callbacks.set('uniswap_v3_flash', [{
                to: '0xeeee567890123456789012345678901234567890',
                methodName: 'flash',
                signature: 'flash(uint256)',
                params: []
            }]);

            const code = traceParser.generateCallbackFunctions(
                callbacks, new Map(), new Map(), '0x1111111111111111111111111111111111111111'
            );

            expect(code).toContain('uniswapV3FlashCallback');
            expect(code).toContain('fee0');
        });

        test('should handle empty callback data', () => {
            const callbacks = new Map();
            callbacks.set('aave_flashloan', null);

            const code = traceParser.generateCallbackFunctions(
                callbacks, new Map(), new Map(), '0x1111111111111111111111111111111111111111'
            );

            expect(code).toContain('TODO: Implement callback logic');
        });
    });

    describe('toChecksumAddress', () => {
        test('should convert to checksum address', () => {
            const address = '0x742d35cc6634c0532925a3b844bc9e7595f0b0d0';
            const checksum = traceParser.toChecksumAddress(address);
            expect(checksum).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f0b0D0');
        });

        test('should handle invalid addresses', () => {
            expect(traceParser.toChecksumAddress(null)).toBe(null);
            expect(traceParser.toChecksumAddress('not-an-address')).toBe('not-an-address');
            expect(traceParser.toChecksumAddress('0x123')).toBe('0x123');
        });
    });

    describe('formatParameterValueForCall', () => {
        test('should format struct parameters', () => {
            const structParam = {
                type: 'tuple',
                value: {
                    token: '0xaaaa567890123456789012345678901234567890',
                    amount: '1000',
                    '0': '0xaaaa567890123456789012345678901234567890',
                    '1': '1000'
                }
            };

            const formatted = traceParser.formatParameterValueForCall(
                structParam, new Map(), '0x0000000000000000000000000000000000000000',
                'tuple', 'Position'
            );

            expect(formatted).toContain('Position');
            expect(formatted).toContain('1000');
        });

        test('should format array with mixed types', () => {
            const arrayParam = {
                type: 'address[]',
                value: [
                    '0xaaaa567890123456789012345678901234567890',
                    '0xbbbb567890123456789012345678901234567890'
                ]
            };

            const formatted = traceParser.formatParameterValueForCall(
                arrayParam, new Map(), '0x0000000000000000000000000000000000000000'
            );

            expect(formatted).toContain('[');
            expect(formatted).toContain(']');
            expect(formatted).toContain('0xAAAA567890123456789012345678901234567890');
        });

        test('should handle string type without 0x prefix', () => {
            const stringParam = {
                type: 'string',
                value: 'Hello World'
            };

            const formatted = traceParser.formatParameterValueForCall(
                stringParam, new Map(), '0x0000000000000000000000000000000000000000'
            );

            expect(formatted).toBe('"Hello World"');
        });

        test('should handle empty value', () => {
            const emptyParam = {
                type: 'uint256'
            };

            const formatted = traceParser.formatParameterValueForCall(
                emptyParam, new Map(), '0x0000000000000000000000000000000000000000'
            );

            expect(formatted).toBe('""');
        });
    });

    describe('private methods', () => {
        test('should register addresses correctly', () => {
            const addressRegistry = new Map();
            const addressCounter = new Map();

            const var1 = traceParser._registerAddress(
                '0xaaaa567890123456789012345678901234567890',
                addressRegistry, addressCounter
            );

            const var2 = traceParser._registerAddress(
                '0xAAAA567890123456789012345678901234567890', // same address, different case
                addressRegistry, addressCounter
            );

            expect(var1).toBe('addr1');
            expect(var2).toBe('addr1'); // should return same variable
            expect(addressCounter.get('total')).toBe(1);
        });

        test('should update contract interface', () => {
            const contracts = new Map();

            traceParser._updateContractInterface(
                '0xaaaa567890123456789012345678901234567890',
                'transfer(address,uint256)',
                contracts
            );

            traceParser._updateContractInterface(
                '0xaaaa567890123456789012345678901234567890',
                'approve(address,uint256)',
                contracts
            );

            const signatures = contracts.get('0xaaaa567890123456789012345678901234567890');
            expect(signatures.size).toBe(2);
            expect(signatures.has('transfer(address,uint256)')).toBe(true);
            expect(signatures.has('approve(address,uint256)')).toBe(true);
        });

        test('should format call parameters', () => {
            const params = [
                { type: 'address', value: '0xaaaa567890123456789012345678901234567890' },
                { type: 'uint256', value: '1000' }
            ];

            const formatted = traceParser._formatCallParameters(
                params, new Map(), '0x0000000000000000000000000000000000000000'
            );

            expect(formatted).toContain('0xAAAA567890123456789012345678901234567890');
            expect(formatted).toContain('1000');
        });

        test('should handle empty parameters', () => {
            const formatted = traceParser._formatCallParameters(
                [], new Map(), '0x0000000000000000000000000000000000000000'
            );

            expect(formatted).toBe('');
        });

        test('should get interface name from contracts', () => {
            const contracts = new Map();
            contracts.set('0xaaaa567890123456789012345678901234567890', new Set(['transfer(address,uint256)']));

            abiManager.generateInterfaceName = (address, signatures) => 'Token';

            const name = traceParser._getInterfaceName(
                '0xaaaa567890123456789012345678901234567890',
                contracts
            );

            expect(name).toBe('Token');
        });

        test('should generate default interface name', () => {
            const name = traceParser._getInterfaceName(
                '0xaaaa567890123456789012345678901234567890',
                new Map()
            );

            expect(name).toBe('Contract567890');
        });
    });
});