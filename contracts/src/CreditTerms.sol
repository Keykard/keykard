// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LineBook} from "./LineBook.sol";

/// @title CreditTerms
/// @notice KEYKARD's published pricing for missed payments, and the public record of every charge.
/// @dev On time costs nothing. When a bill is missed the line pays one late fee per missed bill, plus penalty
///      interest once per period on the overdue amount. Every charge is computed HERE from the published terms
///      (the servicer only reports the overdue amount), only for lines the public credit file (LineBook) shows as
///      Grace, Frozen or Defaulted, and the total is capped at `capBps` of the largest overdue amount.
///      Like LineBook, this contract records; money moves through the borrower's own capped auto-pay key.
contract CreditTerms {
    enum Kind {
        LateFee,
        PenaltyInterest
    }

    uint16 public constant MAX_PENALTY_BPS = 1_000; // 10% per period, hard ceiling on what the owner can publish
    uint16 public constant MAX_CAP_BPS = 5_000; // total charges can never exceed 50% of the overdue amount

    address public owner;
    address public servicer;
    LineBook public immutable lineBook;

    uint128 public lateFee; // token base units, once per missed bill
    uint16 public penaltyBpsPerPeriod; // on the overdue amount, once per line period
    uint16 public capBps; // total charges per line <= capBps of the largest overdue amount

    mapping(uint256 lineId => uint128) public charged; // total ever charged
    mapping(uint256 lineId => uint128) public capOf; // ceiling for `charged`
    mapping(uint256 lineId => uint32) public lateFeesCharged; // never more than LineBook's missedCount
    mapping(uint256 lineId => uint64) public lastPenaltyAt;

    event OwnerChanged(address indexed previous, address indexed next);
    event ServicerChanged(address indexed previous, address indexed next);
    event TermsSet(uint128 lateFee, uint16 penaltyBpsPerPeriod, uint16 capBps);
    event CapRaised(uint256 indexed lineId, uint128 overdue, uint128 cap);
    event Charged(uint256 indexed lineId, Kind kind, uint128 amount, uint128 overdue, uint128 totalCharged);
    event FeesRepaid(uint256 indexed lineId, bytes32 indexed txHash, uint128 amount);

    error NotOwner();
    error NotServicer();
    error ZeroAddress();
    error BadTerms();
    error NotOverdue();
    error NothingToCharge();
    error TooSoon();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyServicer() {
        if (msg.sender != servicer) revert NotServicer();
        _;
    }

    constructor(address owner_, address servicer_, LineBook lineBook_, uint128 lateFee_, uint16 penaltyBps_, uint16 capBps_) {
        if (owner_ == address(0) || servicer_ == address(0) || address(lineBook_) == address(0)) revert ZeroAddress();
        owner = owner_;
        servicer = servicer_;
        lineBook = lineBook_;
        emit OwnerChanged(address(0), owner_);
        emit ServicerChanged(address(0), servicer_);
        _setTerms(lateFee_, penaltyBps_, capBps_);
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

    /// New terms apply to charges made after the change; past charges are untouched.
    function setTerms(uint128 lateFee_, uint16 penaltyBps_, uint16 capBps_) external onlyOwner {
        _setTerms(lateFee_, penaltyBps_, capBps_);
    }

    /// Fee for a missed bill. At most one per missed bill recorded on LineBook.
    function chargeLateFee(uint256 lineId, uint128 overdue) external onlyServicer returns (uint128 amount) {
        LineBook.Line memory l = _overdueLine(lineId, overdue);
        if (lateFeesCharged[lineId] >= l.missedCount) revert NothingToCharge();
        lateFeesCharged[lineId] += 1;
        amount = _charge(lineId, Kind.LateFee, lateFee, overdue);
    }

    /// Penalty interest on the overdue amount, at most once per line period.
    function chargePenalty(uint256 lineId, uint128 overdue) external onlyServicer returns (uint128 amount) {
        LineBook.Line memory l = _overdueLine(lineId, overdue);
        uint64 last = lastPenaltyAt[lineId];
        if (last != 0 && block.timestamp < uint256(last) + l.period) revert TooSoon();
        lastPenaltyAt[lineId] = uint64(block.timestamp);
        amount = _charge(lineId, Kind.PenaltyInterest, uint128((uint256(overdue) * penaltyBpsPerPeriod) / 10_000), overdue);
    }

    /// Fees collected (receipt for the public file; the money moved in `txHash`).
    function recordFeesRepaid(uint256 lineId, bytes32 txHash, uint128 amount) external onlyServicer {
        if (amount == 0) revert NothingToCharge();
        emit FeesRepaid(lineId, txHash, amount);
    }

    /// What the next penalty would be for `overdue`, after the cap. For apps showing terms before borrowing.
    function quotePenalty(uint256 lineId, uint128 overdue) external view returns (uint128) {
        uint128 cap = _capFor(lineId, overdue);
        uint128 raw = uint128((uint256(overdue) * penaltyBpsPerPeriod) / 10_000);
        uint128 room = cap > charged[lineId] ? cap - charged[lineId] : 0;
        return raw < room ? raw : room;
    }

    function _overdueLine(uint256 lineId, uint128 overdue) internal view returns (LineBook.Line memory l) {
        l = lineBook.lines(lineId);
        bool overdueStatus =
            l.status == LineBook.Status.Grace || l.status == LineBook.Status.Frozen || l.status == LineBook.Status.Defaulted;
        if (!overdueStatus || overdue == 0) revert NotOverdue();
    }

    function _capFor(uint256 lineId, uint128 overdue) internal view returns (uint128) {
        uint128 c = uint128((uint256(overdue) * capBps) / 10_000);
        return c > capOf[lineId] ? c : capOf[lineId];
    }

    function _charge(uint256 lineId, Kind kind, uint128 want, uint128 overdue) internal returns (uint128 amount) {
        uint128 cap = _capFor(lineId, overdue);
        if (cap > capOf[lineId]) {
            capOf[lineId] = cap;
            emit CapRaised(lineId, overdue, cap);
        }
        uint128 room = cap > charged[lineId] ? cap - charged[lineId] : 0;
        amount = want < room ? want : room;
        if (amount == 0) revert NothingToCharge();
        charged[lineId] += amount;
        emit Charged(lineId, kind, amount, overdue, charged[lineId]);
    }

    function _setTerms(uint128 lateFee_, uint16 penaltyBps_, uint16 capBps_) internal {
        if (penaltyBps_ > MAX_PENALTY_BPS || capBps_ > MAX_CAP_BPS) revert BadTerms();
        lateFee = lateFee_;
        penaltyBpsPerPeriod = penaltyBps_;
        capBps = capBps_;
        emit TermsSet(lateFee_, penaltyBps_, capBps_);
    }
}
