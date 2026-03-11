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
 * @notice Batch Incremental Merkle Tree for commitments (Multi-tree with sliding window)
 * @dev Publicly accessible functions to be put in RailgunLogic
 * Relevant external contract calls should be in those functions, not here
 * 
 * Root history design:
 * - Active tree: Sliding window of ROOT_HISTORY_SIZE roots
 * - Finalized trees: Only store the final root (space efficient)
 */
contract Commitments is Initializable {
  // NOTE: The order of instantiation MUST stay the same across upgrades
  // add new variables to the bottom of the list and decrement the __gap
  // variable at the end of this file
  // See https://docs.openzeppelin.com/learn/upgrading-smart-contracts#upgrading

  // Commitment nullifiers (treeNumber -> nullifier -> seen)
  mapping(uint256 => mapping(bytes32 => bool)) public nullifiers;

  // The tree depth (24 levels = 2^24 = 16,777,216 UTXOs per tree)
  uint256 internal constant TREE_DEPTH = 24;

  // Tree zero value
  bytes32 public constant ZERO_VALUE = bytes32(uint256(keccak256("Railgun")) % SNARK_SCALAR_FIELD);

  // Next leaf index (number of inserted leaves in the current tree)
  uint256 public nextLeafIndex;

  // The Merkle root of current active tree
  bytes32 public merkleRoot;

  // Whether the root has been updated after addLeaves
  bool public isRootUpdated;

  // Current tree number
  uint256 public treeNumber;

  // Store new tree root to quickly migrate to a new tree
  bytes32 private newTreeRoot;

  // The Merkle path to the leftmost leaf upon initialization. It *should
  // not* be modified after it has been set by the initialize function.
  // Caching these values is essential to efficient appends.
  bytes32[TREE_DEPTH] public zeros;

  // Right-most elements at each level
  // Used for efficient updates of the merkle tree
  bytes32[TREE_DEPTH] private filledSubTrees;

  // ============ Root History (Hybrid Design) ============
  // Maximum number of roots to keep in history for active tree (sliding window)
  uint32 public constant ROOT_HISTORY_SIZE = 100;

  // Current root index in the sliding window (for active tree)
  uint32 public currentRootIndex;

  // Active tree root history: index -> root (sliding window)
  mapping(uint32 => bytes32) public activeTreeRoots;

  // Finalized trees: treeNumber -> final root (only store the last root)
  mapping(uint256 => bytes32) public finalizedTreeRoots;

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

    // Set merkle root and store root to quickly retrieve later
    newTreeRoot = merkleRoot = currentZero;
    activeTreeRoots[0] = currentZero;
    currentRootIndex = 0;
    isRootUpdated = true;
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

    // Create new tree if current one can't contain new leaves
    // We insert all new commitment into a new tree to ensure they can be spent in the same transaction
    if ((nextLeafIndex + count) > (2 ** TREE_DEPTH)) {
      newTree();
    }

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
   * @notice Add leaves and update filledSubTrees without calculating root
   * @dev Updates filledSubTrees (branch nodes) similar to Polygon's _branch array
   * This allows updateRoot to calculate root from filledSubTrees without needing leaves
   * @param _leafHashes - array of leaf hashes to be added
   */
  function addLeaves(bytes32[] memory _leafHashes) internal {
    uint256 count = _leafHashes.length;

    // If 0 leaves are passed in no-op
    if (count == 0) {
      return;
    }

    // Create new tree if current one can't contain new leaves
    if ((nextLeafIndex + count) > (2 ** TREE_DEPTH)) {
      newTree();
    }

    // Update filledSubTrees at each level (similar to Polygon's _branch update)
    for (uint256 height = 0; height < TREE_DEPTH; height++) {
      uint256 index = 0;
      if ((nextLeafIndex >> height) & 1 == 1) { //odd
        _leafHashes[index] = hashLeftRight(filledSubTrees[height], _leafHashes[index]);
        index++;
      }
      while (index < count) {
        if (index + 1 == count) {
          filledSubTrees[height] = _leafHashes[index];
          break;
        }
        _leafHashes[(index+1)/2] = hashLeftRight(_leafHashes[index], _leafHashes[index + 1]);
        index += 2;
      }

      // Calculate count for next level
      // If current level is odd and count is odd: count = count / 2 + 1
      // Otherwise: count = count / 2
      if ((nextLeafIndex >> height) & 1 == 1 && (count & 1 == 1)) {
        count = count / 2 + 1;
      } else {
        count = count / 2;
      }

      if (count == 0) {
        break;
      }
    }

    // Update nextLeafIndex
    nextLeafIndex += _leafHashes.length;
    isRootUpdated = false;
  }

  /**
   * @notice Calculate and update root from filledSubTrees (similar to Polygon's getRoot)
   * @dev Uses filledSubTrees and nextLeafIndex to calculate root, no need for leaf hashes
   * This is similar to Polygon's getRoot() which calculates root from _branch and depositCount
   */
  function updateRoot() public {
    if (isRootUpdated) {
      return;
    }
    // Update root and history
    merkleRoot = getRoot();
    _addRootToHistory(merkleRoot);
    isRootUpdated = true;
  }

  /**
   * @notice Calculate root from filledSubTrees (similar to Polygon's getRoot)
   * @dev Uses filledSubTrees and nextLeafIndex; no leaf hashes needed
   */
  function getRoot() public view returns (bytes32) {
    if (nextLeafIndex == 0) {
      return merkleRoot;
    }

    bytes32 node = zeros[0];
    uint256 size = nextLeafIndex;

    // Calculate root from filledSubTrees (similar to Polygon's getRoot)
    for (uint256 height = 0; height < TREE_DEPTH; height++) {
      if (((size >> height) & 1) == 1) {
        // Use filledSubTree (branch node) at this level
        node = hashLeftRight(filledSubTrees[height], node);
      } else if (node == zeros[height]) {
        // Use zero hash at this level
        node = zeros[height + 1];
      } else {
        node = hashLeftRight(node, zeros[height]);
      }
    }
    return node;
  }

  /**
   * @notice Creates new merkle tree
   * @dev Called when current tree is full. Saves final root to finalizedTreeRoots.
   */
  function newTree() internal {
    // If root hasn't been updated (lazy update pending), calculate the actual root
    // Otherwise use the stored merkleRoot
    bytes32 finalRoot = isRootUpdated ? merkleRoot : getRoot();
    
    // Save the final root of the current tree to finalized storage
    finalizedTreeRoots[treeNumber] = finalRoot;

    // Restore merkleRoot to newTreeRoot (empty tree root)
    merkleRoot = newTreeRoot;

    // Existing values in filledSubtrees will never be used so overwriting them is unnecessary

    // Reset next leaf index to 0
    nextLeafIndex = 0;

    // Reset sliding window for new tree
    currentRootIndex = 0;
    activeTreeRoots[0] = newTreeRoot;

    // Increment tree number
    treeNumber += 1;

    // Mark root as updated (new tree starts fresh)
    isRootUpdated = true;
  }

  /**
   * @notice Add root to history using sliding window (for active tree only)
   * @param _root - Merkle root to add
   * @dev Uses (currentRootIndex + 1) % ROOT_HISTORY_SIZE to roll over and overwrite old roots
   */
  function _addRootToHistory(bytes32 _root) internal {
    currentRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
    activeTreeRoots[currentRootIndex] = _root;
  }

  /**
   * @notice Check if a root exists at specific index (for transaction verification, O(1))
   * @param _treeNumber - Tree number
   * @param _root - Merkle root to check
   * @param _rootIndex - Root index for O(1) lookup (0-99 for active tree)
   * @return exists - Whether the root exists
   * @dev O(1) lookup. For finalized trees, _rootIndex is ignored.
   */
  function isKnownRoot(
    uint256 _treeNumber,
    bytes32 _root, 
    uint32 _rootIndex
  ) public view returns (bool) {
    if (_root == bytes32(0)) return false;
    
    if (_treeNumber < treeNumber) {
      // Finalized tree: only check final root (_rootIndex ignored)
      return finalizedTreeRoots[_treeNumber] == _root;
    } else if (_treeNumber == treeNumber) {
      // Active tree: O(1) direct lookup
      return activeTreeRoots[_rootIndex] == _root;
    }
    return false;
  }

  /**
   * @notice Find if a root exists and return its index (for external read-only queries)
   * @param _treeNumber - Tree number
   * @param _root - Merkle root to find
   * @return exists - Whether the root was found
   * @return rootIndex - The index if found (0 for finalized trees, valid index for active tree)
   * @dev For finalized trees: O(1). For active tree: O(ROOT_HISTORY_SIZE) scan.
   */
  function findRoot(
    uint256 _treeNumber,
    bytes32 _root
  ) public view returns (bool exists, uint32 rootIndex) {
    if (_root == bytes32(0)) return (false, 0);
    
    if (_treeNumber < treeNumber) {
      // Finalized tree: O(1) check final root, index is meaningless so return 0
      return (finalizedTreeRoots[_treeNumber] == _root, 0);
    } else if (_treeNumber == treeNumber) {
      // Active tree: scan sliding window to find index
      for (uint32 i = 0; i < ROOT_HISTORY_SIZE; i++) {
        if (activeTreeRoots[i] == _root) {
          return (true, i);
        }
      }
    }
    return (false, 0);
  }

  /**
   * @notice Gets tree number that new commitments will get inserted to
   * @param _newCommitments - number of new commitments
   * @return treeNum - Tree number for insertion
   * @return startingIndex - Starting leaf index
   */
  function getInsertionTreeNumberAndStartingIndex(
    uint256 _newCommitments
  ) public view returns (uint256, uint256) {
    // New tree will be created if current one can't contain new leaves
    if ((nextLeafIndex + _newCommitments) > (2 ** TREE_DEPTH)) return (treeNumber + 1, 0);

    // Else return current state
    return (treeNumber, nextLeafIndex);
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
