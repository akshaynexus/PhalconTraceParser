import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import ConfigManager from '../../lib/configManager.js';

describe('ConfigManager', () => {
    let tempConfigPath;
    let configManager;

    beforeEach(() => {
        // Create temporary config file
        tempConfigPath = path.join(__dirname, '../fixtures/test-config.json');
        const testConfig = {
            chains: {
                ethereum: {
                    name: 'Ethereum',
                    chainId: 1,
                    rpcUrls: ['https://eth.llamarpc.com'],
                    explorerApi: {
                        baseUrl: 'https://api.etherscan.io/api',
                        apiKeyEnv: 'ETHERSCAN_API_KEY'
                    },
                    nativeToken: { symbol: 'ETH', decimals: 18 },
                    envVars: ['RPC_URL']
                },
                testchain: {
                    name: 'TestChain',
                    chainId: 999,
                    rpcUrls: ['https://test.rpc.com'],
                    explorerApi: {
                        baseUrl: 'https://api.testscan.com/api',
                        apiKeyEnv: 'TEST_API_KEY'
                    },
                    nativeToken: { symbol: 'TEST', decimals: 18 },
                    envVars: ['TEST_RPC_URL']
                }
            },
            defaultChain: 'ethereum',
            version: '1.0.0'
        };
        writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2));
    });

    afterEach(() => {
        // Clean up temp files
        if (existsSync(tempConfigPath)) {
            unlinkSync(tempConfigPath);
        }
        // Clear environment variables
        delete process.env.RPC_URL;
        delete process.env.TEST_RPC_URL;
        delete process.env.ETHERSCAN_API_KEY;
    });

    test('should initialize with valid config', () => {
        configManager = new ConfigManager(tempConfigPath);

        expect(configManager.isLoaded()).toBe(true);
        expect(configManager.getSupportedChains()).toEqual(['ethereum', 'testchain']);
    });

    test('should handle missing config file with fallback', () => {
        const invalidPath = path.join(__dirname, 'nonexistent.json');
        configManager = new ConfigManager(invalidPath);

        expect(configManager.isLoaded()).toBe(true);
        expect(configManager.getSupportedChains()).toEqual(['ethereum']);

        const ethConfig = configManager.getChainConfig('ethereum');
        expect(ethConfig.name).toBe('Ethereum');
        expect(ethConfig.chainId).toBe(1);
    });

    test('should get chain config correctly', () => {
        configManager = new ConfigManager(tempConfigPath);

        const ethConfig = configManager.getChainConfig('ethereum');
        expect(ethConfig.name).toBe('Ethereum');
        expect(ethConfig.chainId).toBe(1);
        expect(ethConfig.rpcUrls).toEqual(['https://eth.llamarpc.com']);

        const testConfig = configManager.getChainConfig('testchain');
        expect(testConfig.name).toBe('TestChain');
        expect(testConfig.chainId).toBe(999);
    });

    test('should handle case insensitive chain names', () => {
        configManager = new ConfigManager(tempConfigPath);

        const ethConfig1 = configManager.getChainConfig('ethereum');
        const ethConfig2 = configManager.getChainConfig('ETHEREUM');
        const ethConfig3 = configManager.getChainConfig('Ethereum');

        expect(ethConfig1).toEqual(ethConfig2);
        expect(ethConfig2).toEqual(ethConfig3);
    });

    test('should return default chain for unknown chains', () => {
        configManager = new ConfigManager(tempConfigPath);

        const unknownConfig = configManager.getChainConfig('unknown');
        const ethConfig = configManager.getChainConfig('ethereum');

        expect(unknownConfig).toEqual(ethConfig);
    });

    test('should generate explorer API URLs correctly', () => {
        configManager = new ConfigManager(tempConfigPath);

        const url = configManager.getExplorerApiUrl('ethereum', 'token', 'tokeninfo', {
            contractaddress: '0x123'
        });

        expect(url).toContain('https://api.etherscan.io/api');
        expect(url).toContain('module=token');
        expect(url).toContain('action=tokeninfo');
        expect(url).toContain('contractaddress=0x123');
        expect(url).toContain('apikey=');
    });

    test('should get RPC URL from environment variables first', () => {
        configManager = new ConfigManager(tempConfigPath);

        // Test without env var
        const defaultUrl = configManager.getRpcUrl('ethereum');
        expect(defaultUrl).toBe('https://eth.llamarpc.com');

        // Set env var and test
        process.env.RPC_URL = 'https://custom.rpc.com';
        const customUrl = configManager.getRpcUrl('ethereum');
        expect(customUrl).toBe('https://custom.rpc.com');
    });

    test('should detect chain from RPC URL', () => {
        configManager = new ConfigManager(tempConfigPath);

        // Test known URLs
        expect(configManager.detectChainFromRpc('https://eth.llamarpc.com')).toBe('ethereum');
        expect(configManager.detectChainFromRpc('https://mainnet.base.org')).toBe('base');

        // Test chain ID detection
        expect(configManager.detectChainFromRpc('https://custom.rpc/999')).toBe('testchain');

        // Test unknown URL defaults to ethereum
        expect(configManager.detectChainFromRpc('https://unknown.rpc.com')).toBe('ethereum');
    });

    test('should validate chain configuration', () => {
        configManager = new ConfigManager(tempConfigPath);

        const ethValidation = configManager.validateChainConfig('ethereum');
        expect(ethValidation.valid).toBe(true);
        expect(ethValidation.issues).toEqual([]);

        // Test with minimal config that would be invalid
        configManager.chainConfigs.invalid = { name: 'Invalid' };
        const invalidValidation = configManager.validateChainConfig('invalid');
        expect(invalidValidation.valid).toBe(false);
        expect(invalidValidation.issues.length).toBeGreaterThan(0);
    });

    test('should reload configuration', () => {
        configManager = new ConfigManager(tempConfigPath);

        const initialChains = configManager.getSupportedChains();
        expect(initialChains).toEqual(['ethereum', 'testchain']);

        // Modify config file
        const newConfig = {
            chains: {
                ethereum: {
                    name: 'Ethereum',
                    chainId: 1,
                    rpcUrls: ['https://eth.llamarpc.com'],
                    explorerApi: { baseUrl: 'https://api.etherscan.io/api', apiKeyEnv: 'ETHERSCAN_API_KEY' },
                    nativeToken: { symbol: 'ETH', decimals: 18 },
                    envVars: ['RPC_URL']
                },
                newchain: {
                    name: 'NewChain',
                    chainId: 1000,
                    rpcUrls: ['https://new.rpc.com'],
                    explorerApi: { baseUrl: 'https://api.newscan.com/api', apiKeyEnv: 'NEW_API_KEY' },
                    nativeToken: { symbol: 'NEW', decimals: 18 },
                    envVars: ['NEW_RPC_URL']
                }
            },
            defaultChain: 'ethereum'
        };
        writeFileSync(tempConfigPath, JSON.stringify(newConfig, null, 2));

        const reloadResult = configManager.reloadConfig();
        expect(reloadResult.success).toBe(true);
        expect(reloadResult.chainsLoaded).toBe(2);

        const newChains = configManager.getSupportedChains();
        expect(newChains).toEqual(['ethereum', 'newchain']);
    });

    test('should get raw configuration and all chain configs', () => {
        configManager = new ConfigManager(tempConfigPath);

        const rawConfig = configManager.getRawConfig();
        expect(rawConfig.version).toBe('1.0.0');
        expect(rawConfig.defaultChain).toBe('ethereum');

        const allConfigs = configManager.getAllChainConfigs();
        expect(Object.keys(allConfigs)).toEqual(['ethereum', 'testchain']);
        expect(allConfigs.ethereum.name).toBe('Ethereum');
        expect(allConfigs.testchain.name).toBe('TestChain');
    });
});