// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LineBook} from "../src/LineBook.sol";
import {CollateralVault, ITIP20} from "../src/CollateralVault.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        require(balanceOf[f] >= a, "bal");
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract CollateralVaultTest is Test {
    LineBook book;
    MockToken usd;
    CollateralVault vault;
    address owner = makeAddr("owner");
    address servicer = makeAddr("servicer");
    address borrower = makeAddr("borrower");
    address treasury = makeAddr("treasury");
    uint256 id;

    function setUp() public {
        vm.warp(1_800_000_000);
        book = new LineBook(owner, servicer);
        usd = new MockToken();
        vault = new CollateralVault(owner, servicer, ITIP20(address(usd)), book);
        vm.prank(servicer);
        id = book.openLine(borrower, makeAddr("credit"), borrower, address(0), address(usd), 120e6, 120e6, 0, 30 days, uint64(block.timestamp + 180 days));
        usd.mint(borrower, 100e6);
        vm.startPrank(borrower);
        usd.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vm.stopPrank();
    }

    function test_depositAndWithdrawUnlocked() public {
        assertEq(vault.deposited(borrower), 100e6);
        vm.prank(borrower);
        vault.withdraw(40e6);
        assertEq(usd.balanceOf(borrower), 40e6);
        assertEq(vault.available(borrower), 60e6);
    }

    function test_lockedCannotBeWithdrawn() public {
        vm.prank(servicer);
        vault.lock(borrower, 100e6);
        vm.prank(borrower);
        vm.expectRevert(CollateralVault.Insufficient.selector);
        vault.withdraw(1);
        vm.prank(servicer);
        vault.release(borrower, 100e6);
        vm.prank(borrower);
        vault.withdraw(100e6);
        assertEq(usd.balanceOf(borrower), 100e6);
    }

    function test_cannotLockMoreThanDeposited() public {
        vm.prank(servicer);
        vm.expectRevert(CollateralVault.Insufficient.selector);
        vault.lock(borrower, 100e6 + 1);
    }

    function test_seizeOnlyAfterDefault() public {
        vm.prank(servicer);
        vault.lock(borrower, 100e6);
        vm.prank(servicer);
        vm.expectRevert(CollateralVault.NotDefaulted.selector);
        vault.seize(id, 30e6, treasury);
        vm.startPrank(servicer);
        book.recordMissed(id);
        book.recordDefault(id);
        vault.seize(id, 30e6, treasury);
        vm.stopPrank();
        assertEq(usd.balanceOf(treasury), 30e6);
        assertEq(vault.locked(borrower), 70e6);
        assertEq(vault.deposited(borrower), 70e6);
    }

    function test_seizeNeverMoreThanLocked() public {
        vm.startPrank(servicer);
        vault.lock(borrower, 50e6);
        book.recordDefault(id);
        vm.expectRevert(CollateralVault.Insufficient.selector);
        vault.seize(id, 50e6 + 1, treasury);
        vm.stopPrank();
    }

    function test_onlyServicerLocksAndSeizes() public {
        vm.expectRevert(CollateralVault.NotServicer.selector);
        vault.lock(borrower, 1);
        vm.prank(borrower);
        vm.expectRevert(CollateralVault.NotServicer.selector);
        vault.seize(id, 1, borrower);
    }
}
