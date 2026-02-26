// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

/**
 * @title EpochNullifierStorage
 * @notice Epoch-based nullifier storage for evolving nullifiers.
 * @dev Instead of a flat mapping(bytes32 => bool) that grows O(N) forever,
 * this uses a double mapping(uint256 => mapping(bytes32 => bool)) keyed by epoch.
 * The contract only needs to maintain data for the current epoch, while
 * cross-epoch double-spend prevention is handled by recursive ZK proofs.
 *
 * Key design:
 * - EPOCH_LENGTH: number of blocks per epoch (default 7200 ~= 1 day on Ethereum)
 * - EPOCH_GRACE_PERIOD: blocks after epoch boundary where previous epoch nullifiers
 *   are still accepted (for in-flight transactions)
 * - getCurrentEpoch(): returns block.number / EPOCH_LENGTH
 * - nullifyInEpoch(): records nullifiers within the current epoch
 */
contract EpochNullifierStorage {
    // Epoch length in blocks (~1 day on Ethereum mainnet at 12s blocks)
    uint256 public constant EPOCH_LENGTH = 7200;

    // Grace period in blocks (~2 hours) where previous epoch's nullifiers still accepted
    uint256 public constant EPOCH_GRACE_PERIOD = 600;

    // epoch => nullifier => spent
    mapping(uint256 => mapping(bytes32 => bool)) public epochNullifiers;

    // Events
    event NullifiedEpoch(uint256 indexed epoch, bytes32[] nullifiers);

    /**
     * @notice Get the current epoch based on block number
     * @return epoch The current epoch number
     */
    function getCurrentEpoch() public view returns (uint256) {
        return block.number / EPOCH_LENGTH;
    }

    /**
     * @notice Check if the current block is within the grace period of a new epoch
     * @dev Grace period = first EPOCH_GRACE_PERIOD blocks of each epoch
     * @return inGrace Whether we're in the grace period
     */
    function isInGracePeriod() public view returns (bool) {
        return (block.number % EPOCH_LENGTH) < EPOCH_GRACE_PERIOD;
    }

    /**
     * @notice Record nullifiers for a given epoch with double-spend protection
     * @dev The epoch must be either the current epoch, or the previous epoch
     *      if we're within the grace period.
     * @param _epoch The epoch to nullify in
     * @param _nullifiers Array of nullifier hashes to record
     */
    function _nullifyInEpoch(uint256 _epoch, bytes32[] memory _nullifiers) internal {
        uint256 currentEpoch = getCurrentEpoch();

        // Epoch validation: must be current epoch, or previous epoch during grace period
        require(
            _epoch == currentEpoch ||
                (currentEpoch > 0 && _epoch == currentEpoch - 1 && isInGracePeriod()),
            "EpochNullifierStorage: invalid epoch"
        );

        // Double-spend check and recording
        for (uint256 i = 0; i < _nullifiers.length; i++) {
            bytes32 nullifier = _nullifiers[i];
            require(nullifier != bytes32(0), "EpochNullifierStorage: zero nullifier");
            require(
                !epochNullifiers[_epoch][nullifier],
                "EpochNullifierStorage: already nullified"
            );
            epochNullifiers[_epoch][nullifier] = true;
        }

        emit NullifiedEpoch(_epoch, _nullifiers);
    }

    /**
     * @notice Check if a nullifier has been spent in a given epoch
     * @param _epoch The epoch to check
     * @param _nullifier The nullifier to check
     * @return spent Whether the nullifier has been spent
     */
    function isNullifiedInEpoch(
        uint256 _epoch,
        bytes32 _nullifier
    ) public view returns (bool) {
        return epochNullifiers[_epoch][_nullifier];
    }
}
