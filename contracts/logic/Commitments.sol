// SPDX-License-Identifier: UNLICENSED
// Based on code from MACI (https://github.com/appliedzkp/maci/blob/7f36a915244a6e8f98bacfe255f8bd44193e7919/contracts/sol/IncrementalMerkleTree.sol)
pragma solidity ^0.8.7;
pragma abicoder v2;

// OpenZeppelin v4
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { SNARK_SCALAR_FIELD } from "./Globals.sol";

import { PoseidonT3 } from "./Poseidon.sol";

/**
 * @title Commitments
 * @author Railgun Contributors
 * @notice Batch Incremental Merkle Tree for commitments
 * @dev Publicly accessible functions to be put in RailgunLogic
 * Relevant external contract calls should be in those functions, not here
 * 
 * Root history: Sliding window of 600 roots
 */
contract Commitments is Initializable {
  // NOTE: The order of instantiation MUST stay the same across upgrades
  // add new variables to the bottom of the list and decrement the __gap
  // variable at the end of this file
  // See https://docs.openzeppelin.com/learn/upgrading-smart-contracts#upgrading

  // Commitment nullifiers (nullifier -> seen)
  mapping(bytes32 => bool) public nullifiers;

  // The tree depth (16 levels = 2^16 = 65,536 UTXOs)
  uint256 internal constant TREE_DEPTH = 16;

  // Tree zero value
  bytes32 public constant ZERO_VALUE = bytes32(uint256(keccak256("Railgun")) % SNARK_SCALAR_FIELD);

  // Next leaf index (number of inserted leaves in the tree)
  uint256 public nextLeafIndex;

  // The Merkle root
  bytes32 public merkleRoot;

  // The Merkle path to the leftmost leaf upon initialization. It *should
  // not* be modified after it has been set by the initialize function.
  // Caching these values is essential to efficient appends.
  bytes32[TREE_DEPTH] public zeros;

  // Right-most elements at each level
  // Used for efficient updates of the merkle tree
  bytes32[TREE_DEPTH] private filledSubTrees;

  // ============ Root History (Sliding Window) ============
  // Maximum number of roots to keep in history (sliding window)
  uint32 public constant ROOT_HISTORY_SIZE = 600;

  // Current root index in the sliding window
  uint32 public currentRootIndex;

  // Root history: index -> root mapping
  mapping(uint32 => bytes32) public roots;

  /**
   * @notice Calculates initial values for Merkle Tree
   * @dev OpenZeppelin initializer ensures this can only be called once
   */
  function initializeCommitments() internal onlyInitializing {
    /*
    To initialize the Merkle tree, we need to calculate the Merkle root
    assuming that each leaf is the zero value.
    H(H(a,b), H(c,d))
      /          \
    H(a,b)     H(c,d)
    /   \       /  \
    a    b     c    d
    `zeros` and `filledSubTrees` will come in handy later when we do
    inserts or updates. e.g when we insert a value in index 1, we will
    need to look up values from those arrays to recalculate the Merkle
    root.
    */

    // Calculate zero values
    zeros[0] = ZERO_VALUE;

    // Store the current zero value for the level we just calculated it for
    bytes32 currentZero = ZERO_VALUE;

    // Loop through each level
    for (uint256 i = 0; i < TREE_DEPTH; i += 1) {
      // Push it to zeros array
      zeros[i] = currentZero;

      // Set filled subtrees to a value so users don't pay storage allocation costs
      filledSubTrees[i] = currentZero;

      // Calculate the zero value for this level
      currentZero = hashLeftRight(currentZero, currentZero);
    }

    // Set merkle root and add to history
    merkleRoot = currentZero;
    roots[0] = currentZero;
    currentRootIndex = 0;
  }

  /**
   * @notice Hash 2 uint256 values
   * @param _left - Left side of hash
   * @param _right - Right side of hash
   * @return hash result
   */
  function hashLeftRight(bytes32 _left, bytes32 _right) public pure returns (bytes32) {
    return PoseidonT3.poseidon([_left, _right]);
  }

  /**
   * @notice Insert leaves into the merkle tree
   * @dev Note: this function INTENTIONALLY causes side effects to save on gas.
   * _leafHashes and _count should never be reused.
   * @param _leafHashes - array of leaf hashes to be added to the merkle tree
   */
  function insertLeaves(bytes32[] memory _leafHashes) internal {
    /*
    Loop through leafHashes at each level, if the leaf is on the left (index is even)
    then hash with zeros value and update subtree on this level, if the leaf is on the
    right (index is odd) then hash with subtree value. After calculating each hash
    push to relevant spot on leafHashes array. For gas efficiency we reuse the same
    array and use the count variable to loop to the right index each time.

    Example of updating a tree of depth 4 with elements 13, 14, and 15
    [1,7,15]    {1}                    1
                                       |
    [3,7,15]    {1}          2-------------------3
                             |                   |
    [6,7,15]    {2}     4---------5         6---------7
                       / \       / \       / \       / \
    [13,14,15]  {3}  08   09   10   11   12   13   14   15
    [] = leafHashes array
    {} = count variable
    */

    // Get initial count
    uint256 count = _leafHashes.length;

    // If 0 leaves are passed in no-op
    if (count == 0) {
      return;
    }

    // Check if tree can contain new leaves (32 levels = 2^32 capacity)
    require(
      (nextLeafIndex + count) <= (2 ** TREE_DEPTH),
      "Commitments: Tree capacity exceeded"
    );

    // Current index is the index at each level to insert the hash
    uint256 levelInsertionIndex = nextLeafIndex;

    // Update nextLeafIndex
    nextLeafIndex += count;

    // Variables for starting point at next tree level
    uint256 nextLevelHashIndex;
    uint256 nextLevelStartIndex;

    // Loop through each level of the merkle tree and update
    for (uint256 level = 0; level < TREE_DEPTH; level += 1) {
      // Calculate the index to start at for the next level
      // >> is equivalent to / 2 rounded down
      nextLevelStartIndex = levelInsertionIndex >> 1;

      uint256 insertionElement = 0;

      // If we're on the right, hash and increment to get on the left
      if (levelInsertionIndex % 2 == 1) {
        // Calculate index to insert hash into leafHashes[]
        // >> is equivalent to / 2 rounded down
        nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;

        // Calculate the hash for the next level
        _leafHashes[nextLevelHashIndex] = hashLeftRight(
          filledSubTrees[level],
          _leafHashes[insertionElement]
        );

        // Increment
        insertionElement += 1;
        levelInsertionIndex += 1;
      }

      // We'll always be on the left side now
      for (insertionElement; insertionElement < count; insertionElement += 2) {
        bytes32 right;

        // Calculate right value
        if (insertionElement < count - 1) {
          right = _leafHashes[insertionElement + 1];
        } else {
          right = zeros[level];
        }

        // If we've created a new subtree at this level, update
        if (insertionElement == count - 1 || insertionElement == count - 2) {
          filledSubTrees[level] = _leafHashes[insertionElement];
        }

        // Calculate index to insert hash into leafHashes[]
        // >> is equivalent to / 2 rounded down
        nextLevelHashIndex = (levelInsertionIndex >> 1) - nextLevelStartIndex;

        // Calculate the hash for the next level
        _leafHashes[nextLevelHashIndex] = hashLeftRight(_leafHashes[insertionElement], right);

        // Increment level insertion index
        levelInsertionIndex += 2;
      }

      // Get starting levelInsertionIndex value for next level
      levelInsertionIndex = nextLevelStartIndex;

      // Get count of elements for next level
      count = nextLevelHashIndex + 1;
    }

    // Update the Merkle tree root
    merkleRoot = _leafHashes[0];
    _addRootToHistory(merkleRoot);
  }

  /**
   * @notice Add root to history using sliding window
   * @param _root - Merkle root to add
   * @dev Uses (currentRootIndex + 1) % ROOT_HISTORY_SIZE to roll over and overwrite old roots
   */
  function _addRootToHistory(bytes32 _root) internal {
    currentRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
    roots[currentRootIndex] = _root;
  }

  /**
   * @notice Check if a root exists in history
   * @param _root - Merkle root to check
   * @param _rootIndex - Root index for O(1) lookup (0-599)
   * @return exists - Whether the root exists at the given index
   * @dev Performs O(1) lookup. Allows using any historical root.
   *      If roots[_rootIndex] == _root, the root exists (even if later overwritten).
   */
  function isKnownRoot(bytes32 _root, uint32 _rootIndex) public view returns (bool) {
    if (_root == bytes32(0)) {
      return false;
    }

    // Direct lookup: if roots[_rootIndex] matches _root, the root exists
    // This allows using any historical root, even if the slot was later overwritten
    return roots[_rootIndex] == _root;
  }

  /**
   * @notice Get the starting index for new commitments
   * @param _newCommitments - number of new commitments to be inserted
   * @return startingIndex - The starting leaf index for new commitments
   * @dev Returns the current nextLeafIndex. Will revert if tree capacity is exceeded.
   */
  function getStartingIndex(uint256 _newCommitments) public view returns (uint256) {
    require(
      (nextLeafIndex + _newCommitments) <= (2 ** TREE_DEPTH),
      "Commitments: Tree capacity exceeded"
    );
    return nextLeafIndex;
  }

  /**
   * @notice Get the current root index (for informational purposes)
   * @return index - The current root index in the sliding window
   */
  function getCurrentRootIndex() public view returns (uint32) {
    return currentRootIndex;
  }

  uint256[10] private __gap;
}
