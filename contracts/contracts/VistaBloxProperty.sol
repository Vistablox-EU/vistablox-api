// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Pausable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title VistaBloxProperty
 * @dev Single shared ERC-1155 contract for VistaBlox fractional property
 * ownership; one token ID per PIV (AD-163). Per-token-ID pause and holder
 * authorization are custom logic layered on top of the standard
 * ERC1155Pausable/ERC1155Supply extensions. See
 * Docs/Backend/05-Blockchain-Web3/SMART_CONTRACT_SPEC.md for the approved
 * design and CONTRACT_ABI_REFERENCE.md for the method surface this
 * contract implements.
 *
 * Phase 1 has no open transfer lane: standard safeTransferFrom and
 * safeBatchTransferFrom always revert. The only ways a token ID's balances
 * move are mint, burn, and forceTransfer, each gated by its own role and
 * each still subject to per-token pause and destination holder-authorization
 * checks via the shared _update override.
 */
contract VistaBloxProperty is ERC1155, ERC1155Pausable, ERC1155Supply, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TRANSFER_AGENT_ROLE = keccak256("TRANSFER_AGENT_ROLE");
    bytes32 public constant DOCUMENT_ROLE = keccak256("DOCUMENT_ROLE");

    mapping(uint256 tokenId => bool) private _tokenPaused;
    mapping(uint256 tokenId => mapping(address holder => bool)) private _authorizedHolders;
    mapping(uint256 tokenId => bytes32) private _documentHash;
    mapping(uint256 tokenId => string) private _documentUri;

    event TokenPaused(uint256 indexed tokenId, address indexed actor);
    event TokenUnpaused(uint256 indexed tokenId, address indexed actor);
    event HolderAuthorized(uint256 indexed tokenId, address indexed holder, address indexed actor);
    event HolderDeauthorized(uint256 indexed tokenId, address indexed holder, address indexed actor);
    event ForcedTransfer(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes32 reasonCode,
        address actor
    );
    event DocumentHashSet(uint256 indexed tokenId, bytes32 documentHash, string documentUri, address indexed actor);

    error TransferLaneClosed();
    error TokenIsPaused(uint256 tokenId);
    error HolderNotAuthorized(uint256 tokenId, address holder);

    constructor(string memory uri_) ERC1155(uri_) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @dev Controlled issuance for one PIV's token ID. Restricted to MINTER_ROLE.
    /// The recipient must already be authorized for tokenId (see authorizeHolder).
    function mint(address to, uint256 tokenId, uint256 amount, bytes memory data)
        public
        onlyRole(MINTER_ROLE)
    {
        _mint(to, tokenId, amount, data);
    }

    /// @dev Controlled reduction for one PIV's token ID. Restricted to BURNER_ROLE.
    function burn(address from, uint256 tokenId, uint256 amount) public onlyRole(BURNER_ROLE) {
        _burn(from, tokenId, amount);
    }

    /// @dev Emergency halt scoped to one PIV; does not affect any other
    /// token ID. Restricted to PAUSER_ROLE.
    function pauseToken(uint256 tokenId) public onlyRole(PAUSER_ROLE) {
        _tokenPaused[tokenId] = true;
        emit TokenPaused(tokenId, msg.sender);
    }

    /// @dev Resume one PIV after incident resolution. Restricted to PAUSER_ROLE.
    function unpauseToken(uint256 tokenId) public onlyRole(PAUSER_ROLE) {
        _tokenPaused[tokenId] = false;
        emit TokenUnpaused(tokenId, msg.sender);
    }

    function isTokenPaused(uint256 tokenId) public view returns (bool) {
        return _tokenPaused[tokenId];
    }

    /// @dev Contract-wide emergency halt across every PIV at once. Restricted
    /// to DEFAULT_ADMIN_ROLE, not the routine PAUSER_ROLE -- reserved for an
    /// incident in the shared contract's own logic, not a single property
    /// (AD-163).
    function pause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @dev Allow a registered self-custodied address (AD-240) to hold one
    /// PIV's token ID. Authorization for one token ID does not carry over to
    /// another. Restricted to TRANSFER_AGENT_ROLE.
    function authorizeHolder(address holder, uint256 tokenId) public onlyRole(TRANSFER_AGENT_ROLE) {
        _authorizedHolders[tokenId][holder] = true;
        emit HolderAuthorized(tokenId, holder, msg.sender);
    }

    /// @dev Remove holder authorization for one PIV's token ID. Restricted to
    /// TRANSFER_AGENT_ROLE.
    function deauthorizeHolder(address holder, uint256 tokenId) public onlyRole(TRANSFER_AGENT_ROLE) {
        _authorizedHolders[tokenId][holder] = false;
        emit HolderDeauthorized(tokenId, holder, msg.sender);
    }

    function isHolderAuthorized(address holder, uint256 tokenId) public view returns (bool) {
        return _authorizedHolders[tokenId][holder];
    }

    /// @dev Controlled administrative move under legal or operational
    /// authority (e.g. lost-device migration once the new address is
    /// authorized). The destination must already be authorized for tokenId,
    /// same as every other path that credits a holder -- there is no
    /// unauthorized-destination exception for this path. Restricted to
    /// TRANSFER_AGENT_ROLE.
    function forceTransfer(address from, address to, uint256 tokenId, uint256 amount, bytes32 reasonCode)
        public
        onlyRole(TRANSFER_AGENT_ROLE)
    {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        _update(from, to, ids, amounts);
        emit ForcedTransfer(tokenId, from, to, amount, reasonCode, msg.sender);
    }

    /// @dev Bind one PIV's token ID to its active governing-document
    /// reference. Restricted to DOCUMENT_ROLE.
    function setDocumentHash(uint256 tokenId, bytes32 documentHash, string memory documentUri)
        public
        onlyRole(DOCUMENT_ROLE)
    {
        _documentHash[tokenId] = documentHash;
        _documentUri[tokenId] = documentUri;
        emit DocumentHashSet(tokenId, documentHash, documentUri, msg.sender);
    }

    function documentHashOf(uint256 tokenId) public view returns (bytes32) {
        return _documentHash[tokenId];
    }

    function documentUriOf(uint256 tokenId) public view returns (string memory) {
        return _documentUri[tokenId];
    }

    /// @dev Phase 1 is closed by default (SMART_CONTRACT_SPEC.md): standard
    /// transfers always revert regardless of caller or destination
    /// authorization. Tokens only move via mint, burn, or forceTransfer.
    function safeTransferFrom(address, address, uint256, uint256, bytes memory) public virtual override {
        revert TransferLaneClosed();
    }

    function safeBatchTransferFrom(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        virtual
        override
    {
        revert TransferLaneClosed();
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Pausable, ERC1155Supply)
    {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (_tokenPaused[id]) revert TokenIsPaused(id);
            if (to != address(0) && !_authorizedHolders[id][to]) {
                revert HolderNotAuthorized(id, to);
            }
        }
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
