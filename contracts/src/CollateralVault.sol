// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LineBook} from "./LineBook.sol";

interface ITIP20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title CollateralVault
/// @notice Holds stablecoin collateral for KEYKARD secured lines (1:1: deposit $100, get $100 more limit).
/// @dev The borrower deposits and withdraws their own money. While a secured line is live, the servicer locks
///      the deposit backing it, so it can't be withdrawn. KEYKARD can only TAKE locked collateral after the
///      public credit file (LineBook) shows the borrower's line as Defaulted, and never more than is locked.
contract CollateralVault {
    address public owner;
    address public servicer;
    ITIP20 public immutable token;
    LineBook public immutable lineBook;

    mapping(address borrower => uint256) public deposited;
    mapping(address borrower => uint256) public locked;

    event OwnerChanged(address indexed previous, address indexed next);
    event ServicerChanged(address indexed previous, address indexed next);
    event Deposited(address indexed borrower, uint256 amount, uint256 total);
    event Withdrawn(address indexed borrower, uint256 amount, uint256 total);
    event Locked(address indexed borrower, uint256 amount, uint256 totalLocked);
    event Released(address indexed borrower, uint256 amount, uint256 totalLocked);
    event Seized(uint256 indexed lineId, address indexed borrower, uint256 amount, address to);

    error NotOwner();
    error NotServicer();
    error ZeroAddress();
    error ZeroAmount();
    error Insufficient();
    error NotDefaulted();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyServicer() {
        if (msg.sender != servicer) revert NotServicer();
        _;
    }

    constructor(address owner_, address servicer_, ITIP20 token_, LineBook lineBook_) {
        if (owner_ == address(0) || servicer_ == address(0) || address(token_) == address(0) || address(lineBook_) == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        servicer = servicer_;
        token = token_;
        lineBook = lineBook_;
        emit OwnerChanged(address(0), owner_);
        emit ServicerChanged(address(0), servicer_);
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function setServicer(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit ServicerChanged(servicer, next);
        servicer = next;
    }

    /// Move your own stablecoins in (approve the vault first; KEYKARD's apps batch both in one transaction).
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _pull(msg.sender, amount);
        deposited[msg.sender] += amount;
        emit Deposited(msg.sender, amount, deposited[msg.sender]);
    }

    /// Anything not backing a live secured line can be withdrawn at any time.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (deposited[msg.sender] - locked[msg.sender] < amount) revert Insufficient();
        deposited[msg.sender] -= amount;
        _send(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, deposited[msg.sender]);
    }

    function available(address borrower) external view returns (uint256) {
        return deposited[borrower] - locked[borrower];
    }

    /// Back a secured line: the locked amount stays in the vault until released or (after a default) seized.
    function lock(address borrower, uint256 amount) external onlyServicer {
        if (amount == 0) revert ZeroAmount();
        if (deposited[borrower] - locked[borrower] < amount) revert Insufficient();
        locked[borrower] += amount;
        emit Locked(borrower, amount, locked[borrower]);
    }

    function release(address borrower, uint256 amount) external onlyServicer {
        if (amount == 0) revert ZeroAmount();
        if (locked[borrower] < amount) revert Insufficient();
        locked[borrower] -= amount;
        emit Released(borrower, amount, locked[borrower]);
    }

    /// Only for a line the public credit file shows as Defaulted, and only up to the borrower's locked collateral.
    function seize(uint256 lineId, uint256 amount, address to) external onlyServicer {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        LineBook.Line memory l = lineBook.lines(lineId);
        if (l.status != LineBook.Status.Defaulted) revert NotDefaulted();
        address borrower = l.borrower;
        if (locked[borrower] < amount) revert Insufficient();
        locked[borrower] -= amount;
        deposited[borrower] -= amount;
        _send(to, amount);
        emit Seized(lineId, borrower, amount, to);
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(ITIP20.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(ITIP20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
