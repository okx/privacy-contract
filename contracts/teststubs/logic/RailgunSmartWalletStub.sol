// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { RailgunSmartWallet, Commitments } from "../../logic/RailgunSmartWallet.sol";

contract RailgunSmartWalletStub is RailgunSmartWallet {
  function setMerkleRoot(uint32 _rootIndex, bytes32 _root) external {
    // For testing: set root at the specified index
    Commitments.roots[_rootIndex] = _root;
  }

  function setNullifier(bytes32 _nullifier, bool _setting) external {
    // For testing: set nullifier status
    Commitments.nullifiers[_nullifier] = _setting;
  }

  /**
   * @notice Reset bench state: clear nullifiers and restore merkle root
   * @param _nullifiers - nullifiers to clear (set to false)
   * @param _rootIndex - root index to restore
   * @param _root - root value to write at the given index
   */
  function debugResetBenchState(
    bytes32[] calldata _nullifiers,
    uint32 _rootIndex,
    bytes32 _root
  ) external {
    for (uint256 i = 0; i < _nullifiers.length; i++) {
      Commitments.nullifiers[_nullifiers[i]] = false;
    }
    Commitments.roots[_rootIndex] = _root;
  }
}
