// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { RailgunSmartWallet, Commitments } from "../../logic/RailgunSmartWallet.sol";

contract RailgunSmartWalletStub is RailgunSmartWallet {
  function newTreeStub() external {
    Commitments.newTree();
  }

  function setMerkleRoot(uint32 _rootIndex, bytes32 _root) external {
    // For testing: set root at the specified index in active tree
    Commitments.activeTreeRoots[_rootIndex] = _root;
  }

  function setFinalizedTreeRoot(uint256 _treeNumber, bytes32 _root) external {
    // For testing: set finalized tree root
    Commitments.finalizedTreeRoots[_treeNumber] = _root;
  }

  function setNullifier(uint256 _treeNumber, bytes32 _nullifier, bool _setting) external {
    // For testing: set nullifier status for a specific tree
    Commitments.nullifiers[_treeNumber][_nullifier] = _setting;
  }
}
