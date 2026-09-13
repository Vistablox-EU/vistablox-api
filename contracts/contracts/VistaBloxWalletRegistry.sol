// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VistaBloxWalletRegistry
 * @dev The on-chain half of AD-241's wallet-provisioning flow
 * (ON_CHAIN_SETTLEMENT.md's Address Registration And Change, steps 5-8):
 * an investor's or owner's device, having generated a local signing key,
 * calls register() itself to prove control of the address on-chain.
 *
 * This contract deliberately holds no state and does no validation beyond
 * what Solidity's own msg.sender already guarantees. Interpreting the
 * one-time opaque commitment -- matching it to a pending registration,
 * checking it hasn't expired or already been consumed, linking the
 * address to a KYC-verified account -- is entirely the backend's job,
 * done by watching this contract's events, exactly as step 8 describes:
 * "VistaBlox independently observes the Base event." No party -- not
 * VistaBlox, not any admin role, nobody -- can call this on an investor's
 * behalf or register an address without that address's own signature;
 * there is no privileged role on this contract at all.
 *
 * Also used for a later address change (AD-241 step 10): this contract
 * does not distinguish first-time registration from a change. Which case
 * applies is determined off-chain, by whether the backend already has a
 * registered address for the requesting account.
 */
contract VistaBloxWalletRegistry {
    event WalletRegistered(address indexed wallet, bytes32 indexed commitment, uint256 timestamp);

    /// @dev Registers msg.sender against an opaque, backend-issued
    /// commitment. Anyone may call this for their own address at any
    /// time -- permissionless by design, matching the rest of this
    /// architecture's "no discretionary control" pattern. Repeated or
    /// stale commitments are the backend's concern to detect and ignore
    /// when reconciling events, not something this contract rejects.
    function register(bytes32 commitment) external {
        emit WalletRegistered(msg.sender, commitment, block.timestamp);
    }
}
