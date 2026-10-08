// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DemoYieldVenue, IERC20Min} from "../src/DemoYieldVenue.sol";
import {MockToken} from "./CollateralVault.t.sol";

contract DemoYieldVenueTest is Test {
    MockToken usd;
    DemoYieldVenue venue;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address keykard = address(0xCAFE);

    function setUp() public {
        usd = new MockToken();
        venue = new DemoYieldVenue(IERC20Min(address(usd)), 6, "KEYKARD Demo Yield", "kdYIELD");
        for (uint256 i; i < 3; i++) {
            address a = [alice, bob, keykard][i];
            usd.mint(a, 1_000e6);
            vm.prank(a);
            usd.approve(address(venue), type(uint256).max);
        }
    }

    function test_depositRedeemRoundTrip() public {
        vm.prank(alice);
        uint256 shares = venue.deposit(100e6, alice);
        assertEq(venue.balanceOf(alice), shares);
        assertEq(venue.totalAssets(), 100e6);
        vm.prank(alice);
        uint256 back = venue.redeem(shares, alice, alice);
        assertEq(back, 100e6);
        assertEq(usd.balanceOf(alice), 1_000e6);
    }

    function test_donationRaisesShareValue() public {
        vm.prank(alice);
        uint256 shares = venue.deposit(100e6, alice);
        vm.prank(keykard);
        venue.donate(5e6);
        // alice owns all shares, so (almost) all of the yield (1 wei-ish lost to the virtual share)
        assertApproxEqAbs(venue.convertToAssets(shares), 105e6, 1);
        vm.prank(bob);
        uint256 bobShares = venue.deposit(105e6, bob);
        assertApproxEqRel(bobShares, shares, 1e12); // bob pays the new price (within 0.0001%)
        vm.prank(alice);
        uint256 aliceOut = venue.redeem(shares, alice, alice);
        assertApproxEqAbs(aliceOut, 105e6, 1);
    }

    function test_withdrawExactAssetsRoundsSharesUp() public {
        vm.prank(alice);
        venue.deposit(100e6, alice);
        vm.prank(keykard);
        venue.donate(3e6);
        vm.prank(alice);
        uint256 burned = venue.withdraw(50e6, alice, alice);
        assertGe(venue.convertToAssets(burned), 50e6 - 1);
        assertEq(usd.balanceOf(alice), 950e6);
    }

    function test_spenderNeedsAllowance() public {
        vm.prank(alice);
        uint256 shares = venue.deposit(10e6, alice);
        vm.prank(bob);
        vm.expectRevert(bytes("allowance"));
        venue.redeem(shares, bob, alice);
        vm.prank(alice);
        venue.approve(bob, shares);
        vm.prank(bob);
        venue.redeem(shares, bob, alice);
        assertEq(usd.balanceOf(bob), 1_010e6);
    }

    function test_firstDepositorDonationAttackFails() public {
        vm.prank(alice);
        venue.deposit(1, alice);
        vm.prank(alice);
        venue.donate(100e6);
        vm.prank(bob);
        uint256 s = venue.deposit(50e6, bob);
        assertGt(s, 0);
    }

    function test_cannotRedeemMoreThanOwned() public {
        vm.prank(alice);
        uint256 shares = venue.deposit(10e6, alice);
        vm.prank(alice);
        vm.expectRevert(bytes("balance"));
        venue.redeem(shares + 1, alice, alice);
    }
}
