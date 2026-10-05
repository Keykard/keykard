// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LineBook} from "../src/LineBook.sol";
import {CreditTerms} from "../src/CreditTerms.sol";

contract CreditTermsTest is Test {
    LineBook book;
    CreditTerms terms;
    address owner = makeAddr("owner");
    address servicer = makeAddr("servicer");
    address borrower = makeAddr("borrower");
    address token = makeAddr("usdc");
    uint256 id;

    function setUp() public {
        vm.warp(1_800_000_000);
        book = new LineBook(owner, servicer);
        // $1 late fee, 2% per period, total capped at 25% of the overdue amount
        terms = new CreditTerms(owner, servicer, book, 1e6, 200, 2_500);
        vm.prank(servicer);
        id = book.openLine(borrower, makeAddr("credit"), borrower, address(0), token, 20e6, 20e6, 0, 30 days, uint64(block.timestamp + 180 days));
    }

    function _miss() internal {
        vm.prank(servicer);
        book.recordMissed(id);
    }

    function test_noChargesWhileActive() public {
        vm.prank(servicer);
        vm.expectRevert(CreditTerms.NotOverdue.selector);
        terms.chargeLateFee(id, 20e6);
        vm.prank(servicer);
        vm.expectRevert(CreditTerms.NotOverdue.selector);
        terms.chargePenalty(id, 20e6);
    }

    function test_lateFeeOncePerMissedBill() public {
        _miss();
        vm.prank(servicer);
        assertEq(terms.chargeLateFee(id, 20e6), 1e6);
        vm.prank(servicer);
        vm.expectRevert(CreditTerms.NothingToCharge.selector);
        terms.chargeLateFee(id, 20e6);
        assertEq(terms.charged(id), 1e6);
        assertEq(terms.capOf(id), 5e6);
    }

    function test_penaltyOncePerPeriod() public {
        _miss();
        vm.prank(servicer);
        assertEq(terms.chargePenalty(id, 20e6), 0.4e6); // 2% of $20
        vm.prank(servicer);
        vm.expectRevert(CreditTerms.TooSoon.selector);
        terms.chargePenalty(id, 20e6);
        vm.warp(block.timestamp + 30 days);
        vm.prank(servicer);
        assertEq(terms.chargePenalty(id, 20e6), 0.4e6);
    }

    function test_capHoldsAcrossDefault() public {
        _miss();
        vm.prank(servicer);
        terms.chargeLateFee(id, 20e6); // 1.0
        for (uint256 i = 0; i < 9; i++) {
            vm.prank(servicer);
            terms.chargePenalty(id, 20e6); // 0.4 each: 3.6 more = 4.6
            vm.warp(block.timestamp + 30 days);
        }
        vm.prank(servicer);
        book.recordDefault(id);
        vm.prank(servicer);
        assertEq(terms.chargePenalty(id, 20e6), 0.4e6); // reaches exactly the $5 cap
        vm.warp(block.timestamp + 30 days);
        vm.prank(servicer);
        vm.expectRevert(CreditTerms.NothingToCharge.selector);
        terms.chargePenalty(id, 20e6);
        assertEq(terms.charged(id), 5e6);
    }

    function test_onlyServicerCharges() public {
        _miss();
        vm.expectRevert(CreditTerms.NotServicer.selector);
        terms.chargeLateFee(id, 20e6);
    }

    function test_termsBounded() public {
        vm.prank(owner);
        vm.expectRevert(CreditTerms.BadTerms.selector);
        terms.setTerms(1e6, 1_001, 2_500);
        vm.prank(owner);
        vm.expectRevert(CreditTerms.BadTerms.selector);
        terms.setTerms(1e6, 200, 5_001);
        vm.expectRevert(CreditTerms.NotOwner.selector);
        terms.setTerms(0, 0, 0);
    }

    function test_quote() public {
        assertEq(terms.quotePenalty(id, 20e6), 0.4e6);
    }
}
