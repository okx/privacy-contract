// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SourceRegistry — v8.1 Source Compliance
 *
 * Manages the set of clean source primes and the cleanSourceRoot.
 *
 * Design rationale (v8.1 §4.1.1):
 *   - Registration is append-only (auditability requirement).
 *   - The clean set is NOT append-only: blacklisting removes elements.
 *   - Therefore cleanSourceRoot is recomputed from (registered - blacklisted)
 *     on every mutation (register or blacklist).
 *   - The root is a canonical hash of the sorted clean set, matching the
 *     circuit-side BuildSourceDescriptor.
 *   - Rich events enable off-chain witness generation without full state replay.
 *
 * Key functions:
 *   - registerSourcePrime: append a new clean source, recompute root
 *   - addSourceToBlacklist: remove from clean set, increment policyEpoch, recompute root
 *   - currentCleanSourceRoot: root of all currently clean sources
 *   - currentPolicyEpoch: increments on blacklist/disallow events
 *   - currentRegistrySeq: append-only registration counter
 */
contract SourceRegistry is Ownable {
    // ============================================================
    // Constants
    // ============================================================

    uint256 constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @dev Empty root sentinel for an empty clean set
    bytes32 constant EMPTY_ROOT = bytes32(0);

    // ============================================================
    // State
    // ============================================================

    /// @notice Policy epoch — incremented on blacklist/disallow actions
    uint64 public policyEpoch;

    /// @notice Append-only registration counter
    uint64 public registrySeq;

    /// @notice Whether a source prime is currently clean (registered AND not blacklisted)
    mapping(bytes32 => bool) public isCleanSource;

    /// @notice Whether a source prime has ever been registered (append-only log)
    mapping(bytes32 => bool) public isRegistered;

    /// @notice Ordered array of currently clean source primes.
    ///         Maintained in sorted order for deterministic root computation.
    bytes32[] internal _cleanSources;

    /// @notice Index+1 of a clean source in _cleanSources (0 = not present)
    mapping(bytes32 => uint256) internal _cleanIndex;

    /// @notice Current root of the clean source set.
    ///         Recomputed on every mutation from the sorted _cleanSources array.
    bytes32 public cleanSourceRoot;

    // ============================================================
    // Append-only registration log (for auditability / replay)
    // ============================================================

    /// @notice Chronological list of all ever-registered source primes
    bytes32[] public registrationLog;

    // ============================================================
    // Events — designed for off-chain witness generation
    // ============================================================

    /// @notice Emitted when a new source is registered (append-only log entry)
    event SourceRegistered(
        bytes32 indexed pSrc,
        uint64 seq,
        bytes32 newCleanSourceRoot,
        uint256 cleanSetSize
    );

    /// @notice Emitted when a source is blacklisted (removed from clean set)
    event SourceBlacklisted(
        bytes32 indexed pSrc,
        uint64 newEpoch,
        bytes32 newCleanSourceRoot,
        uint256 cleanSetSize
    );

    /// @notice Emitted on every policy epoch change
    event PolicyEpochIncremented(uint64 newEpoch);

    /// @notice Emitted after every clean root recomputation (snapshot for witness builders)
    event CleanSourceRootUpdated(
        bytes32 newRoot,
        uint256 cleanSetSize,
        uint64 epoch,
        uint64 seq
    );

    // ============================================================
    // Constructor
    // ============================================================

    constructor() {
        cleanSourceRoot = EMPTY_ROOT;
    }

    // ============================================================
    // Registration
    // ============================================================

    /**
     * @notice Register a new source prime as clean.
     * @param pSrc The source prime identifier (field element as bytes32)
     */
    function registerSourcePrime(bytes32 pSrc) external {
        require(!isRegistered[pSrc], "SourceRegistry: already registered");
        require(uint256(pSrc) < SNARK_FIELD, "SourceRegistry: exceeds field");
        require(pSrc != bytes32(0), "SourceRegistry: zero source");

        isRegistered[pSrc] = true;
        isCleanSource[pSrc] = true;

        // Append to registration log (immutable)
        registrationLog.push(pSrc);

        // Insert into sorted clean set
        _insertCleanSorted(pSrc);

        // Recompute root from current clean set
        _recomputeCleanRoot();

        registrySeq++;
        emit SourceRegistered(pSrc, registrySeq, cleanSourceRoot, _cleanSources.length);
    }

    /**
     * @notice Blacklist a source prime — removes from clean set.
     * @dev Increments policyEpoch. The clean root is recomputed without the
     *      blacklisted element. Registration log is NOT modified.
     * @param pSrc The source prime to blacklist
     */
    function addSourceToBlacklist(bytes32 pSrc) external onlyOwner {
        require(isRegistered[pSrc], "SourceRegistry: not registered");
        require(isCleanSource[pSrc], "SourceRegistry: already blacklisted");

        isCleanSource[pSrc] = false;

        // Remove from sorted clean set
        _removeClean(pSrc);

        // Recompute root
        _recomputeCleanRoot();

        policyEpoch++;
        emit SourceBlacklisted(pSrc, policyEpoch, cleanSourceRoot, _cleanSources.length);
        emit PolicyEpochIncremented(policyEpoch);
    }

    // ============================================================
    // View functions
    // ============================================================

    function currentCleanSourceRoot() external view returns (bytes32) {
        return cleanSourceRoot;
    }

    function currentPolicyEpoch() external view returns (uint64) {
        return policyEpoch;
    }

    function currentRegistrySeq() external view returns (uint64) {
        return registrySeq;
    }

    /// @notice Number of currently clean sources
    function cleanSourceCount() external view returns (uint256) {
        return _cleanSources.length;
    }

    /// @notice Total ever-registered sources
    function totalRegistered() external view returns (uint256) {
        return registrationLog.length;
    }

    // ============================================================
    // Witness generation queries
    // ============================================================

    /**
     * @notice Get the full sorted list of currently clean source primes.
     * @dev Used by off-chain witness generators to build Merkle proofs.
     *      For large sets, use getCleanSourcesRange() instead.
     */
    function getCleanSources() external view returns (bytes32[] memory) {
        return _cleanSources;
    }

    /**
     * @notice Get a range of clean source primes (pagination for large sets).
     * @param offset Start index
     * @param limit  Max number of elements to return
     */
    function getCleanSourcesRange(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory sources, uint256 total) {
        total = _cleanSources.length;
        if (offset >= total) {
            return (new bytes32[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;
        sources = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            sources[i] = _cleanSources[offset + i];
        }
    }

    /**
     * @notice Get the full registration log (append-only, for replay/audit).
     */
    function getRegistrationLog() external view returns (bytes32[] memory) {
        return registrationLog;
    }

    /**
     * @notice Check if a source is in the current clean set and get its index.
     * @return inCleanSet True if currently clean
     * @return index      Index in the sorted clean array (only valid if inCleanSet)
     */
    function getCleanSourceStatus(bytes32 pSrc) external view returns (
        bool inCleanSet,
        uint256 index
    ) {
        uint256 idx1 = _cleanIndex[pSrc];
        if (idx1 > 0) {
            return (true, idx1 - 1);
        }
        return (false, 0);
    }

    // ============================================================
    // Policy epoch management (callable by sibling registries)
    // ============================================================

    /**
     * @notice Increment policy epoch from an authorized sibling (e.g., ModuleRegistry).
     * @dev In production, use AccessControl roles instead of onlyOwner.
     */
    function incrementPolicyEpoch() external onlyOwner {
        policyEpoch++;
        emit PolicyEpochIncremented(policyEpoch);
    }

    // ============================================================
    // Internal: Sorted clean set management
    // ============================================================

    /**
     * @dev Insert pSrc into _cleanSources maintaining sorted order.
     *      Uses binary search to find insertion point, then shifts elements.
     *      Gas cost: O(n) for shift, but clean set mutations are governance ops.
     */
    function _insertCleanSorted(bytes32 pSrc) internal {
        uint256 len = _cleanSources.length;
        uint256 pos = _binarySearchInsertPos(pSrc, len);

        // Append a dummy element to extend array
        _cleanSources.push(bytes32(0));

        // Shift elements right from pos to len-1
        for (uint256 i = len; i > pos; i--) {
            _cleanSources[i] = _cleanSources[i - 1];
            _cleanIndex[_cleanSources[i]] = i + 1; // 1-indexed
        }

        _cleanSources[pos] = pSrc;
        _cleanIndex[pSrc] = pos + 1; // 1-indexed
    }

    /**
     * @dev Remove pSrc from _cleanSources maintaining sorted order.
     *      Shifts elements left to fill gap.
     */
    function _removeClean(bytes32 pSrc) internal {
        uint256 idx1 = _cleanIndex[pSrc];
        require(idx1 > 0, "SourceRegistry: not in clean set");
        uint256 idx = idx1 - 1;
        uint256 lastIdx = _cleanSources.length - 1;

        // Shift left
        for (uint256 i = idx; i < lastIdx; i++) {
            _cleanSources[i] = _cleanSources[i + 1];
            _cleanIndex[_cleanSources[i]] = i + 1; // 1-indexed
        }

        _cleanSources.pop();
        delete _cleanIndex[pSrc];
    }

    /**
     * @dev Binary search for insertion position in sorted array.
     */
    function _binarySearchInsertPos(bytes32 val, uint256 len) internal view returns (uint256) {
        if (len == 0) return 0;
        uint256 lo = 0;
        uint256 hi = len;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (uint256(_cleanSources[mid]) < uint256(val)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    // ============================================================
    // Internal: Clean root computation
    // ============================================================

    /**
     * @dev Recompute cleanSourceRoot from the current sorted _cleanSources array.
     *
     *      This computes a canonical hash of the clean set. In production,
     *      this MUST match the circuit-side BuildSourceDescriptor:
     *        - Binary append frontier with count-binding bag-fold root
     *        - Poseidon hashing with proper DST_SRC_LEAF/NODE/BAG/ROOT
     *
     *      For reference implementation, we use keccak256-based hashing.
     *      The production deployment MUST replace _hashLeaf, _hashNode,
     *      _hashBag, _hashRoot with Poseidon variants matching circuit DSTs.
     */
    function _recomputeCleanRoot() internal {
        uint256 count = _cleanSources.length;

        if (count == 0) {
            cleanSourceRoot = EMPTY_ROOT;
            emit CleanSourceRootUpdated(EMPTY_ROOT, 0, policyEpoch, registrySeq);
            return;
        }

        // Build using binary append frontier algorithm (matching BuildSourceDescriptor)
        // Frontier slots for depth up to 64
        bytes32[64] memory frontier;
        bool[64] memory occupied;

        for (uint256 leafIdx = 0; leafIdx < count; leafIdx++) {
            bytes32 cur = _hashLeaf(_cleanSources[leafIdx]);
            uint256 c = leafIdx;
            for (uint256 h = 0; h < 64; h++) {
                bool bit = (c & 1) == 1;
                if (bit && occupied[h]) {
                    cur = _hashNode(frontier[h], cur);
                    occupied[h] = false;
                } else if (!bit) {
                    frontier[h] = cur;
                    occupied[h] = true;
                    break;
                }
                c >>= 1;
            }
        }

        // Finalize: bag-fold the frontier
        bytes32 bag = bytes32(0);
        bool bagInitialized = false;
        for (uint256 h = 0; h < 64; h++) {
            bool bit = (count & (uint256(1) << h)) != 0;
            if (bit && occupied[h]) {
                if (!bagInitialized) {
                    bag = frontier[h];
                    bagInitialized = true;
                } else {
                    bag = _hashBag(frontier[h], bag);
                }
            }
        }

        cleanSourceRoot = _hashRoot(count, bag);
        emit CleanSourceRootUpdated(cleanSourceRoot, count, policyEpoch, registrySeq);
    }

    /**
     * @dev Leaf hash. Production: Poseidon(DST_SRC_LEAF_V3, s)
     */
    function _hashLeaf(bytes32 s) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("DST_SRC_LEAF_V3", s));
    }

    /**
     * @dev Node hash. Production: Poseidon(DST_SRC_NODE_V3, x, y)
     */
    function _hashNode(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("DST_SRC_NODE_V3", left, right));
    }

    /**
     * @dev Bag hash. Production: Poseidon(DST_SRC_BAG_V1, x, y)
     */
    function _hashBag(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("DST_SRC_BAG_V1", x, y));
    }

    /**
     * @dev Root hash. Production: Poseidon(DST_SRC_ROOT_V1, count, bag)
     */
    function _hashRoot(uint256 count, bytes32 bag) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("DST_SRC_ROOT_V1", count, bag));
    }
}
