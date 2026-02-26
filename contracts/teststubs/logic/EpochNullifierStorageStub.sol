// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { EpochNullifierStorage } from "../../logic/EpochNullifierStorage.sol";

/**
 * @title EpochNullifierStorageStub
 * @notice Test stub that exposes internal functions of EpochNullifierStorage
 */
contract EpochNullifierStorageStub is EpochNullifierStorage {
    /**
     * @notice Public wrapper for _nullifyInEpoch for testing
     */
    function nullifyInEpoch(uint256 _epoch, bytes32[] memory _nullifiers) external {
        _nullifyInEpoch(_epoch, _nullifiers);
    }

    /**
     * @notice Batch check: returns spent status for multiple nullifiers in an epoch
     */
    function batchIsNullified(
        uint256 _epoch,
        bytes32[] memory _nullifiers
    ) external view returns (bool[] memory) {
        bool[] memory results = new bool[](_nullifiers.length);
        for (uint256 i = 0; i < _nullifiers.length; i++) {
            results[i] = epochNullifiers[_epoch][_nullifiers[i]];
        }
        return results;
    }
}
