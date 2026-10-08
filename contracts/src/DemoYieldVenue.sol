// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title DemoYieldVenue
/// @notice TESTNET ONLY. A minimal ERC-4626 vault over a stablecoin, used as the "venue" behind a Tempo Earn vault so
///         KEYKARD can demo collateral that earns. There is no real strategy: yield is simulated by sending the asset
///         to this contract (`donate`), which raises the value of every share. On mainnet the venue is a real Earn
///         vault (e.g. the gUSTB vault) instead of this contract.
/// @dev Like OpenZeppelin's ERC4626: shares carry 6 extra decimals and the price uses virtual shares (10**6) and a
///      virtual asset (+1), so an early donation can't round later deposits down to nothing.
contract DemoYieldVenue {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    IERC20Min public immutable assetToken;
    uint256 internal constant OFFSET = 1e6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event YieldAdded(address indexed from, uint256 assets);

    constructor(IERC20Min asset_, uint8 decimals_, string memory name_, string memory symbol_) {
        assetToken = asset_;
        decimals = decimals_ + 6;
        name = name_;
        symbol = symbol_;
    }

    // ---------------- ERC-20 ----------------

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spend(from, msg.sender, value);
        _move(from, to, value);
        return true;
    }

    // ---------------- ERC-4626 ----------------

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() public view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _mulDiv(assets, totalSupply + OFFSET, totalAssets() + 1, false);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _mulDiv(shares, totalAssets() + 1, totalSupply + OFFSET, false);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return convertToAssets(balanceOf[owner]);
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _mulDiv(shares, totalAssets() + 1, totalSupply + OFFSET, true);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _mulDiv(assets, totalSupply + OFFSET, totalAssets() + 1, true);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = previewDeposit(assets);
        require(shares > 0, "zero shares");
        _pull(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        assets = previewMint(shares);
        _pull(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = previewWithdraw(assets);
        _exit(assets, shares, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        assets = previewRedeem(shares);
        require(assets > 0, "zero assets");
        _exit(assets, shares, receiver, owner);
    }

    /// @notice Simulated yield (testnet): send the asset in without minting shares, so every share is worth more.
    function donate(uint256 assets) external {
        _pull(assets);
        emit YieldAdded(msg.sender, assets);
    }

    // ---------------- internals ----------------

    function _exit(uint256 assets, uint256 shares, address receiver, address owner) internal {
        if (msg.sender != owner) _spend(owner, msg.sender, shares);
        _burn(owner, shares);
        require(assetToken.transfer(receiver, assets), "transfer failed");
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function _pull(uint256 assets) internal {
        require(assetToken.transferFrom(msg.sender, address(this), assets), "transferFrom failed");
    }

    function _spend(address owner, address spender, uint256 value) internal {
        uint256 a = allowance[owner][spender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[owner][spender] = a - value;
        }
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _mulDiv(uint256 x, uint256 y, uint256 d, bool up) internal pure returns (uint256 r) {
        r = (x * y) / d;
        if (up && (x * y) % d != 0) r += 1;
    }
}
