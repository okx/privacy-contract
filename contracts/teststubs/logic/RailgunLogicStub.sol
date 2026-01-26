// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { CommitmentPreimage, CommitmentCiphertext, Transaction } from "../../logic/Globals.sol";
import { Commitments } from "../../logic/Commitments.sol";
import { RailgunLogic } from "../../logic/RailgunLogic.sol";

contract RailgunLogicStub is RailgunLogic {
  function doubleInit(
    address payable _treasury,
    uint120 _shieldFee,
    uint120 _unshieldFee,
    uint256 _nftFee,
    address _relayAdapt,
    address _owner
  ) external {
    RailgunLogic.initializeRailgunLogic(_treasury, _shieldFee, _unshieldFee, _nftFee, _relayAdapt, _owner);
  }

  function setMerkleRoot(uint32 _rootIndex, bytes32 _root) external {
    // For testing: set root at the specified index
    Commitments.roots[_rootIndex] = _root;
  }

  function setNullifier(bytes32 _nullifier, bool _setting) external {
    // For testing: set nullifier status
    Commitments.nullifiers[_nullifier] = _setting;
  }

  function transferTokenInStub(
    CommitmentPreimage calldata _note
  ) external returns (CommitmentPreimage memory, uint256) {
    return RailgunLogic.transferTokenIn(_note);
  }

  function transferTokenOutStub(CommitmentPreimage calldata _note) external {
    RailgunLogic.transferTokenOut(_note);
  }

  function accumulateAndNullifyTransactionStub(
    Transaction calldata _transaction,
    uint256 _initialArrayLengths,
    uint256 _commitmentsStartOffset
  ) external returns (uint256, bytes32[] memory, CommitmentCiphertext[] memory) {
    bytes32[] memory _commitments = new bytes32[](_initialArrayLengths);
    CommitmentCiphertext[] memory _ciphertext = new CommitmentCiphertext[](_initialArrayLengths);

    return (
      accumulateAndNullifyTransaction(
        _transaction,
        _commitments,
        _commitmentsStartOffset,
        _ciphertext
      ),
      _commitments,
      _ciphertext
    );
  }
}
