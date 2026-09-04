// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title VistaBloxIpoEscrow
 * @dev Non-custodial, per-property IPO contribution escrow (AD-256). One
 * shared, parameterized contract for the whole platform, one campaign per
 * PIV token ID -- the same addressing shape AD-163 already uses for the
 * ERC-1155 token contract, for the same reason: a new property does not
 * require deploying or re-auditing a new contract.
 *
 * No party -- not VistaBlox, not the original owner, not any single signer
 * -- holds discretionary withdrawal power over escrowed funds. Release is
 * purely programmatic and permissionless once a campaign resolves:
 *  - Successful: the full raised balance sweeps to the PIV's own treasury
 *    address (withdrawRaised). Minting each contributor's proportional
 *    ERC-1155 share happens off-chain, backend-orchestrated against the
 *    on-chain Contributed/contributionOf record, the same MINTER_ROLE-gated
 *    path every other mint already uses on VistaBloxProperty -- not an
 *    on-chain fan-out loop here, which would be gas-unsafe for an unbounded
 *    contributor count.
 *  - Failed: each contributor independently and permissionlessly withdraws
 *    their own contribution back to their own wallet (withdraw). No
 *    VistaBlox action, approval, or discretion is required or possible.
 *
 * Deadline enforcement is block-timestamp-based: campaigns run on the order
 * of days to weeks, so validator timestamp drift (seconds) is immaterial.
 */
contract VistaBloxIpoEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CAMPAIGN_MANAGER_ROLE = keccak256("CAMPAIGN_MANAGER_ROLE");

    enum CampaignState {
        NotOpened,
        Open,
        Successful,
        Failed
    }

    struct Campaign {
        uint256 targetAmount;
        uint256 totalRaised;
        uint256 deadline;
        address treasury;
        CampaignState state;
        bool swept;
    }

    IERC20 public immutable EURC;

    mapping(uint256 tokenId => Campaign) private _campaigns;
    mapping(uint256 tokenId => mapping(address contributor => uint256)) private _contributions;
    // Enumerable per-campaign contributor list, so the backend can read back
    // exactly who to mint for on success without scanning historical event
    // logs (which would need a stored deployment block and is subject to RPC
    // block-range limits). Bounded by the same economics as the campaign
    // itself, not by anything unbounded -- safe to grow and safe to read
    // back in one view call.
    mapping(uint256 tokenId => address[]) private _contributorsList;
    mapping(uint256 tokenId => mapping(address contributor => bool)) private _hasContributed;

    event CampaignOpened(
        uint256 indexed tokenId, uint256 targetAmount, uint256 deadline, address treasury, address indexed actor
    );
    event TreasuryUpdated(uint256 indexed tokenId, address indexed newTreasury, address indexed actor);
    event DeadlineExtended(uint256 indexed tokenId, uint256 newDeadline, address indexed actor);
    event Contributed(uint256 indexed tokenId, address indexed contributor, uint256 amount, uint256 newTotalRaised);
    event CampaignFinalized(uint256 indexed tokenId, bool successful, uint256 totalRaised);
    event RaisedWithdrawn(uint256 indexed tokenId, address indexed treasury, uint256 amount);
    event ContributionWithdrawn(uint256 indexed tokenId, address indexed contributor, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidDeadline();
    error CampaignAlreadyOpened(uint256 tokenId);
    error CampaignNotOpen(uint256 tokenId);
    error DeadlineNotReached(uint256 tokenId);
    error DeadlineAlreadyPassed(uint256 tokenId);
    error TargetExceeded(uint256 tokenId, uint256 attempted, uint256 remaining);
    error CampaignNotSuccessful(uint256 tokenId);
    error CampaignNotFailed(uint256 tokenId);
    error AlreadySwept(uint256 tokenId);
    error NoContribution(uint256 tokenId, address contributor);

    constructor(address eurc_) {
        if (eurc_ == address(0)) revert ZeroAddress();
        EURC = IERC20(eurc_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @dev Opens a property's IPO contribution window. Restricted to
    /// CAMPAIGN_MANAGER_ROLE (the backend, at the same moment the off-chain
    /// Piv/Offering pair opens).
    function openCampaign(uint256 tokenId, uint256 targetAmount, uint256 deadline, address treasury)
        external
        onlyRole(CAMPAIGN_MANAGER_ROLE)
    {
        if (_campaigns[tokenId].state != CampaignState.NotOpened) revert CampaignAlreadyOpened(tokenId);
        if (targetAmount == 0) revert ZeroAmount();
        if (treasury == address(0)) revert ZeroAddress();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        _campaigns[tokenId] = Campaign({
            targetAmount: targetAmount,
            totalRaised: 0,
            deadline: deadline,
            treasury: treasury,
            state: CampaignState.Open,
            swept: false
        });

        emit CampaignOpened(tokenId, targetAmount, deadline, treasury, msg.sender);
    }

    /// @dev Corrects the destination treasury address (e.g. once the PIV's
    /// governed multisig is actually deployed) any time before the campaign
    /// resolves. Restricted to CAMPAIGN_MANAGER_ROLE.
    function updateTreasury(uint256 tokenId, address newTreasury) external onlyRole(CAMPAIGN_MANAGER_ROLE) {
        Campaign storage campaign = _campaigns[tokenId];
        if (campaign.state != CampaignState.Open) revert CampaignNotOpen(tokenId);
        if (newTreasury == address(0)) revert ZeroAddress();
        campaign.treasury = newTreasury;
        emit TreasuryUpdated(tokenId, newTreasury, msg.sender);
    }

    /// @dev Reflects a founder decision to extend rather than close an
    /// underfunded campaign. Only before the campaign resolves. Restricted
    /// to CAMPAIGN_MANAGER_ROLE.
    function extendDeadline(uint256 tokenId, uint256 newDeadline) external onlyRole(CAMPAIGN_MANAGER_ROLE) {
        Campaign storage campaign = _campaigns[tokenId];
        if (campaign.state != CampaignState.Open) revert CampaignNotOpen(tokenId);
        if (newDeadline <= block.timestamp) revert InvalidDeadline();
        campaign.deadline = newDeadline;
        emit DeadlineExtended(tokenId, newDeadline, msg.sender);
    }

    /// @dev Investor-initiated, self-signed contribution -- the same shape
    /// as ON_CHAIN_SETTLEMENT.md's Customer-Initiated Transfer Flow. Pulls
    /// EURC from the caller, who must have already approved this contract.
    /// Reverts rather than partial-filling if amount would exceed the
    /// campaign's target.
    function contribute(uint256 tokenId, uint256 amount) external nonReentrant whenNotPaused {
        Campaign storage campaign = _campaigns[tokenId];
        if (campaign.state != CampaignState.Open) revert CampaignNotOpen(tokenId);
        if (block.timestamp >= campaign.deadline) revert DeadlineAlreadyPassed(tokenId);
        if (amount == 0) revert ZeroAmount();

        uint256 remaining = campaign.targetAmount - campaign.totalRaised;
        if (amount > remaining) revert TargetExceeded(tokenId, amount, remaining);

        campaign.totalRaised += amount;
        _contributions[tokenId][msg.sender] += amount;
        if (!_hasContributed[tokenId][msg.sender]) {
            _hasContributed[tokenId][msg.sender] = true;
            _contributorsList[tokenId].push(msg.sender);
        }

        EURC.safeTransferFrom(msg.sender, address(this), amount);

        emit Contributed(tokenId, msg.sender, amount, campaign.totalRaised);
    }

    /// @dev Permissionlessly resolves a campaign once its deadline has
    /// passed: Successful if the target was reached, Failed otherwise.
    /// Terminal -- no party can alter the outcome once set.
    function finalize(uint256 tokenId) external whenNotPaused {
        Campaign storage campaign = _campaigns[tokenId];
        if (campaign.state != CampaignState.Open) revert CampaignNotOpen(tokenId);
        if (block.timestamp < campaign.deadline) revert DeadlineNotReached(tokenId);

        bool successful = campaign.totalRaised >= campaign.targetAmount;
        campaign.state = successful ? CampaignState.Successful : CampaignState.Failed;

        emit CampaignFinalized(tokenId, successful, campaign.totalRaised);
    }

    /// @dev Permissionlessly sweeps the full raised balance to the PIV
    /// treasury once a campaign succeeds. The destination and amount are
    /// already fixed by contract state, so triggering this carries no
    /// discretion regardless of who calls it. Callable once.
    function withdrawRaised(uint256 tokenId) external nonReentrant whenNotPaused {
        Campaign storage campaign = _campaigns[tokenId];
        if (campaign.state != CampaignState.Successful) revert CampaignNotSuccessful(tokenId);
        if (campaign.swept) revert AlreadySwept(tokenId);

        campaign.swept = true;
        uint256 amount = campaign.totalRaised;

        EURC.safeTransfer(campaign.treasury, amount);

        emit RaisedWithdrawn(tokenId, campaign.treasury, amount);
    }

    /// @dev Independent, permissionless refund of the caller's own
    /// contribution once a campaign fails. No VistaBlox action, approval, or
    /// discretion is required or possible.
    function withdraw(uint256 tokenId) external nonReentrant whenNotPaused {
        Campaign storage campaign = _campaigns[tokenId];
        if (campaign.state != CampaignState.Failed) revert CampaignNotFailed(tokenId);

        uint256 amount = _contributions[tokenId][msg.sender];
        if (amount == 0) revert NoContribution(tokenId, msg.sender);

        _contributions[tokenId][msg.sender] = 0;

        EURC.safeTransfer(msg.sender, amount);

        emit ContributionWithdrawn(tokenId, msg.sender, amount);
    }

    function contributionOf(uint256 tokenId, address contributor) external view returns (uint256) {
        return _contributions[tokenId][contributor];
    }

    /// @dev Every distinct address that has ever contributed to this
    /// campaign, in first-contribution order. A withdrawn (failed-campaign)
    /// contribution still appears here, now at contributionOf == 0 -- this
    /// is a historical contributor list, not a "currently owed" list.
    function contributorsOf(uint256 tokenId) external view returns (address[] memory) {
        return _contributorsList[tokenId];
    }

    function campaignOf(uint256 tokenId)
        external
        view
        returns (
            uint256 targetAmount,
            uint256 totalRaised,
            uint256 deadline,
            address treasury,
            CampaignState state,
            bool swept
        )
    {
        Campaign storage campaign = _campaigns[tokenId];
        return (
            campaign.targetAmount,
            campaign.totalRaised,
            campaign.deadline,
            campaign.treasury,
            campaign.state,
            campaign.swept
        );
    }

    /// @dev Platform-wide emergency halt across every campaign. Restricted
    /// to DEFAULT_ADMIN_ROLE.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
