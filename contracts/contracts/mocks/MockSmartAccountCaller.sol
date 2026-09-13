// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockSmartAccountCaller
 * @dev Test-only stand-in for Coinbase's real `CoinbaseSmartWallet`
 * (https://github.com/coinbase/smart-wallet/blob/main/src/CoinbaseSmartWallet.sol),
 * used to verify VistaBloxWalletRegistry.smartAccount.test.js's claim that
 * VistaBloxWalletRegistry needs no changes to support ERC-4337 smart-account
 * wallets.
 *
 * `execute` has exactly the shape (and exactly the msg.sender-forwarding
 * behavior under ordinary Solidity call semantics) of
 * `CoinbaseSmartWallet.execute(address target, uint256 value, bytes calldata data)`:
 * when this contract calls out to another contract, that contract sees
 * this contract's own address as msg.sender, never the EOA that originally
 * sent the transaction to this contract.
 *
 * Deliberately does not model the real CoinbaseSmartWallet's owner/signature
 * validation (it is `onlyEntryPointOrOwner`-gated and driven by a
 * WebAuthn/ERC-1271 owner check via an ERC-4337 UserOperation); that
 * validation is out of scope here. This mock exists solely to exercise the
 * msg.sender-forwarding call shape, not to model account-abstraction auth.
 * Never deployed anywhere but the local Hardhat test network.
 */
contract MockSmartAccountCaller {
    function execute(address target, uint256 value, bytes calldata data) external {
        (bool success, bytes memory result) = target.call{value: value}(data);
        require(success, string(result));
    }
}
