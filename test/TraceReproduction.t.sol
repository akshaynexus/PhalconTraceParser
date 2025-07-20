// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

interface IPlugin {
    function approvePlugin(address _plugin) external;
}

interface IPriceFeed {
    function getPrice(address _token, bool _maximise, bool _includeAmmPrice, bool) external view returns (uint256);
    function getMinPrice(address _token) external view returns (uint256);
    function tokenToUsdMin(address _token, uint256 _tokenAmount) external view returns (uint256);
}

interface IOrderBook {
    function createIncreaseOrder(
        address[] calldata _path,
        uint256 _amountIn,
        address _indexToken,
        uint256 _minOut,
        uint256 _sizeDelta,
        address _collateralToken,
        bool _isLong,
        uint256 _triggerPrice,
        bool _triggerAboveThreshold,
        uint256 _executionFee,
        bool _shouldWrap
    ) external payable;
}

interface IWETH {
    function deposit() external payable;
}

contract TraceReproductionTest is Test {
    address constant MAIN_ADDRESS = 0x7d3bd50336f64b7a473c51f54e7f0bd6771cc355;
    address constant PLUGIN_CONTRACT = 0xabbc5f99639c9b6bcb58544ddf04efa6802f4064;
    address constant PRICE_FEED = 0x489ee077994b6658eafa855c308275ead8097c4a;
    address constant ORDER_BOOK = 0x09f77e8a13de9a35a7231028187e9fd5db8a2acb;
    address constant WETH = 0x82af49447d8a07e3bd95bd0d56f35241523fbab1;
    address constant PRICE_ORACLE = 0x2d68011bca022ed0e474264145f46cc4de96a002;
    
    IPlugin plugin = IPlugin(PLUGIN_CONTRACT);
    IPriceFeed priceFeed = IPriceFeed(PRICE_FEED);
    IOrderBook orderBook = IOrderBook(ORDER_BOOK);
    IWETH weth = IWETH(WETH);

    function setUp() public {
        // Fork mainnet or testnet where these contracts exist
        vm.createSelectFork(vm.envString("RPC_URL"));
        
        // Impersonate the main address
        vm.startPrank(MAIN_ADDRESS);
        
        // Give some ETH to the main address
        vm.deal(MAIN_ADDRESS, 1 ether);
    }

    function testReproduceTrace() public {
        // Step 1: Approve plugin
        plugin.approvePlugin(0x09f77e8a13de9a35a7231028187e9fd5db8a2acb);
        
        // Step 2: Get price information (simulate the calls)
        uint256 minPrice = priceFeed.getMinPrice(WETH);
        uint256 price = IPriceFeed(PRICE_ORACLE).getPrice(WETH, false, false, false);
        
        // Step 3: Create increase order
        address[] memory path = new address[](1);
        path[0] = WETH;
        
        orderBook.createIncreaseOrder{value: 0.1003 ether}(
            path,
            100_000_000_000_000_000, // 0.1 ETH
            WETH,
            0,
            531_064_000_000_000_000_000_000_000_000_000_000,
            WETH,
            true,
            1_500_000_000_000_000_000_000_000_000_000_000,
            true,
            300_000_000_000_000,
            true
        );
        
        // Step 4: Deposit WETH
        weth.deposit{value: 0.1003 ether}();
    }

    function testPriceCalls() public view {
        // Test the price oracle calls
        uint256 price = IPriceFeed(PRICE_ORACLE).getPrice(WETH, false, false, false);
        uint256 minPrice = priceFeed.getMinPrice(WETH);
        uint256 usdValue = priceFeed.tokenToUsdMin(WETH, 100_000_000_000_000_000);
        
        console.log("Price:", price);
        console.log("Min Price:", minPrice);
        console.log("USD Value:", usdValue);
    }
}
