// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title LegacyProtocol
/// @notice A settlement vault that cannot settle itself. An external keeper must
///         call `performUpkeep` once each epoch elapses. If nobody does so within
///         `settlementWindow`, the epoch is missed and the protocol is degraded —
///         which is exactly the gap a keeper migration must never open.
///
/// @dev Role preimages are namespaced, mirroring production practice
///      (Lido: `keccak256("BridgingManager.DEPOSITS_ENABLER_ROLE")`). Hashing the
///      identifier alone will NOT reproduce these hashes; the string literal must
///      be read out of this source. That is deliberate — it exercises the same
///      resolution path as the real mainnet fixtures.
contract LegacyProtocol is AccessControl {
    /// @notice Permits `performUpkeep`. This is the role a keeper migration moves.
    bytes32 public constant KEEPER_ROLE =
        keccak256("LegacyProtocol.KEEPER_ROLE");

    /// @notice Permits emergency pause. Held by governance, expected to sit unused
    ///         for the life of the protocol. Never having fired is NOT evidence
    ///         that it is safe to drop.
    bytes32 public constant GUARDIAN_ROLE =
        keccak256("LegacyProtocol.GUARDIAN_ROLE");

    uint256 public immutable epochDuration;
    /// @notice Grace period after an epoch elapses before the settlement counts as missed.
    uint256 public immutable settlementWindow;

    uint256 public nextSettlementAt;
    uint256 public epoch;
    uint256 public totalSettled;
    uint256 public missedSettlements;
    bool public paused;

    event Settled(uint256 indexed epoch, uint256 at, address indexed by, bool late);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error ProtocolPaused();
    error NotDue(uint256 nowTs, uint256 dueAt);

    constructor(
        address admin,
        address keeper,
        address guardian,
        uint256 _epochDuration,
        uint256 _settlementWindow
    ) {
        epochDuration = _epochDuration;
        settlementWindow = _settlementWindow;
        nextSettlementAt = block.timestamp + _epochDuration;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Chainlink-Automation-compatible probe. Free to call, changes nothing.
    ///         This is the ground truth the shadow run compares against.
    function checkUpkeep(bytes calldata)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        upkeepNeeded = !paused && block.timestamp >= nextSettlementAt;
        performData = "";
    }

    /// @notice The job itself. Guarded — only a KEEPER_ROLE holder may settle.
    function performUpkeep(bytes calldata) external onlyRole(KEEPER_ROLE) {
        if (paused) revert ProtocolPaused();
        if (block.timestamp < nextSettlementAt) {
            revert NotDue(block.timestamp, nextSettlementAt);
        }

        bool late = block.timestamp > nextSettlementAt + settlementWindow;
        if (late) missedSettlements += 1;

        epoch += 1;
        totalSettled += 1;
        nextSettlementAt = block.timestamp + epochDuration;

        emit Settled(epoch, block.timestamp, msg.sender, late);
    }

    /// @notice True while the protocol is unattended: due, unpaused, and past its
    ///         grace period. The migration's `BLOCKS UNPROTECTED` counter reads this.
    function isUnprotected() external view returns (bool) {
        return !paused && block.timestamp > nextSettlementAt + settlementWindow;
    }

    function secondsUntilDue() external view returns (uint256) {
        return block.timestamp >= nextSettlementAt ? 0 : nextSettlementAt - block.timestamp;
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
