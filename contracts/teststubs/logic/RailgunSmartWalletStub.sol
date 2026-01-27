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
}
