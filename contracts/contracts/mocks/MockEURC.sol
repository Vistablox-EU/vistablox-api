// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockEURC
 * @dev Test/dev-only stand-in for Circle's real EURC, matching its 6-decimal
 * precision. Real EURC is used on mainnet and (where available) Base
 * Sepolia; this mock exists purely so the escrow contract can be exercised
 * against a real ERC-20 on the local simulated network and in CI, per
 * AD-165's testnet-development philosophy. Never deployed to mainnet.
 */
contract MockEURC is ERC20 {
    constructor() ERC20("Mock EURC", "mEURC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
