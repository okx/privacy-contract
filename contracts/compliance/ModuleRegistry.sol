// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SourceRegistry } from "./SourceRegistry.sol";

/**
 * @title ModuleRegistry — v8.1 Module Policy Accumulator
 *
 * Manages the set of allowed module primes and the module policy accumulator.
 * Shares policyEpoch with SourceRegistry — disallowing a module increments it.
 *
 * Design (v8.1 §4.1.2):
 *   - modulePolicyAccumulator is a canonical hash of the sorted allowed set
 *   - epochPrime is a product-based accumulator of epoch-relevant primes
 *     (domain-separated from source/module primes per §4.5.1)
 *   - Rich events support off-chain witness generation
 *   - registrySeq tracks module-side registration sequence
 */
contract ModuleRegistry is Ownable {
    // ============================================================
    // Constants
    // ============================================================

    uint256 constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ============================================================
    // State
    // ============================================================

    /// @notice Reference to SourceRegistry for shared policyEpoch
    SourceRegistry public immutable sourceRegistry;

    /// @notice Whether a module prime is currently allowed
    mapping(bytes32 => bool) public isAllowedModule;

    /// @notice Whether a module prime has ever been registered
    mapping(bytes32 => bool) public isRegistered;

    /// @notice Hash-based accumulator of all currently allowed module primes.
    ///         Computed as canonical hash of sorted allowed set.
    bytes32 public modulePolicyAccumulator;

    /// @notice Count of currently allowed modules
    uint256 public allowedModuleCount;

    /// @notice Sorted list of currently allowed module primes
    bytes32[] internal _allowedModules;

    /// @notice Index+1 of a module in _allowedModules (0 = not present)
    mapping(bytes32 => uint256) internal _moduleIndex;

    /// @notice Module-side registration sequence counter
    uint64 public registrySeq;

    /// @notice Epoch prime accumulator (product of epoch-relevant primes, mod SNARK_FIELD)
    ///         Domain-separated from source/module primes per §4.5.1
    bytes32 public epochPrime;

    // ============================================================
    // Append-only registration log
    // ============================================================

    bytes32[] public registrationLog;

    // ============================================================
    // Events — designed for off-chain witness generation
    // ============================================================

    event ModuleRegistered(
        bytes32 indexed pMod,
        uint64 seq,
        bytes32 newAccumulator,
        uint256 allowedCount
    );

    event ModuleDisallowed(
        bytes32 indexed pMod,
        uint64 epoch,
        bytes32 newAccumulator,
        uint256 allowedCount
    );

    event ModulePolicyAccumulatorUpdated(
        bytes32 newAccumulator,
        uint256 allowedCount,
        uint64 epoch,
        uint64 seq
    );

    event EpochPrimeUpdated(bytes32 newEpochPrime, uint64 epoch);

    // ============================================================
    // Constructor
    // ============================================================

    constructor(SourceRegistry _sourceRegistry) {
        sourceRegistry = _sourceRegistry;
        modulePolicyAccumulator = bytes32(0);
        epochPrime = bytes32(uint256(1)); // multiplicative identity
    }

    // ============================================================
    // Registration
    // ============================================================

    /**
     * @notice Register a new module prime as allowed.
     * @param pMod The module prime identifier
     */
    function registerModulePrime(bytes32 pMod) external {
        require(!isRegistered[pMod], "ModuleRegistry: already registered");
        require(uint256(pMod) < SNARK_FIELD, "ModuleRegistry: exceeds field");
        require(pMod != bytes32(0), "ModuleRegistry: zero module");

        isRegistered[pMod] = true;
        isAllowedModule[pMod] = true;

        // Append to registration log (immutable)
        registrationLog.push(pMod);

        // Insert into sorted allowed set
        _insertAllowedSorted(pMod);
        allowedModuleCount++;

        // Recompute accumulator
        _recomputeAccumulator();

        registrySeq++;
        emit ModuleRegistered(pMod, registrySeq, modulePolicyAccumulator, allowedModuleCount);
    }

    /**
     * @notice Disallow a module prime — increments policyEpoch.
     * @param pMod The module prime to disallow
     */
    function disallowModulePrime(bytes32 pMod) external onlyOwner {
        require(isRegistered[pMod], "ModuleRegistry: not registered");
        require(isAllowedModule[pMod], "ModuleRegistry: already disallowed");

        isAllowedModule[pMod] = false;

        // Remove from sorted allowed set
        _removeAllowed(pMod);
        allowedModuleCount--;

        // Recompute accumulator
        _recomputeAccumulator();

        // Update epoch prime for the new epoch
        _updateEpochPrime();

        // Increment shared policyEpoch via SourceRegistry
        sourceRegistry.incrementPolicyEpoch();

        uint64 epoch = sourceRegistry.policyEpoch();
        emit ModuleDisallowed(pMod, epoch, modulePolicyAccumulator, allowedModuleCount);
    }

    // ============================================================
    // View functions
    // ============================================================

    function currentModulePolicyAccumulator() external view returns (bytes32) {
        return modulePolicyAccumulator;
    }

    function currentEpochPrime() external view returns (bytes32) {
        return epochPrime;
    }

    function currentRegistrySeq() external view returns (uint64) {
        return registrySeq;
    }

    // ============================================================
    // Witness generation queries
    // ============================================================

    /**
     * @notice Get the full sorted list of currently allowed module primes.
     */
    function getAllowedModules() external view returns (bytes32[] memory) {
        return _allowedModules;
    }

    /**
     * @notice Get a range of allowed modules (pagination for large sets).
     */
    function getAllowedModulesRange(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory modules, uint256 total) {
        total = _allowedModules.length;
        if (offset >= total) {
            return (new bytes32[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;
        modules = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            modules[i] = _allowedModules[offset + i];
        }
    }

    /**
     * @notice Get the full registration log.
     */
    function getRegistrationLog() external view returns (bytes32[] memory) {
        return registrationLog;
    }

    /**
     * @notice Check if a module is in the current allowed set and get its index.
     */
    function getAllowedModuleStatus(bytes32 pMod) external view returns (
        bool inAllowedSet,
        uint256 index
    ) {
        uint256 idx1 = _moduleIndex[pMod];
        if (idx1 > 0) {
            return (true, idx1 - 1);
        }
        return (false, 0);
    }

    // ============================================================
    // Internal: Sorted allowed set management
    // ============================================================

    function _insertAllowedSorted(bytes32 pMod) internal {
        uint256 len = _allowedModules.length;
        uint256 pos = _binarySearchInsertPos(pMod, len);

        _allowedModules.push(bytes32(0));
        for (uint256 i = len; i > pos; i--) {
            _allowedModules[i] = _allowedModules[i - 1];
            _moduleIndex[_allowedModules[i]] = i + 1;
        }

        _allowedModules[pos] = pMod;
        _moduleIndex[pMod] = pos + 1;
    }

    function _removeAllowed(bytes32 pMod) internal {
        uint256 idx1 = _moduleIndex[pMod];
        require(idx1 > 0, "ModuleRegistry: not in allowed set");
        uint256 idx = idx1 - 1;
        uint256 lastIdx = _allowedModules.length - 1;

        for (uint256 i = idx; i < lastIdx; i++) {
            _allowedModules[i] = _allowedModules[i + 1];
            _moduleIndex[_allowedModules[i]] = i + 1;
        }

        _allowedModules.pop();
        delete _moduleIndex[pMod];
    }

    function _binarySearchInsertPos(bytes32 val, uint256 len) internal view returns (uint256) {
        if (len == 0) return 0;
        uint256 lo = 0;
        uint256 hi = len;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (uint256(_allowedModules[mid]) < uint256(val)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    // ============================================================
    // Internal: Accumulator computation
    // ============================================================

    /**
     * @dev Recompute the hash-based accumulator from sorted allowed set.
     *      Production: should match circuit-side module accumulator computation.
     */
    function _recomputeAccumulator() internal {
        uint256 count = _allowedModules.length;
        if (count == 0) {
            modulePolicyAccumulator = bytes32(0);
        } else {
            bytes32 acc = bytes32(0);
            for (uint256 i = 0; i < count; i++) {
                acc = keccak256(abi.encodePacked(acc, _allowedModules[i]));
            }
            modulePolicyAccumulator = acc;
        }

        uint64 epoch = sourceRegistry.policyEpoch();
        emit ModulePolicyAccumulatorUpdated(
            modulePolicyAccumulator,
            count,
            epoch,
            registrySeq
        );
    }

    /**
     * @dev Update epoch prime for the new policy epoch.
     *      epochPrime = H(DST_EPOCH_PRIME, current_epoch + 1)
     *      Domain-separated from source/module primes per §4.5.1.
     */
    function _updateEpochPrime() internal {
        uint64 nextEpoch = sourceRegistry.policyEpoch() + 1; // will be incremented after
        epochPrime = keccak256(abi.encodePacked("DST_EPOCH_PRIME_V1", nextEpoch));
        emit EpochPrimeUpdated(epochPrime, nextEpoch);
    }
}
