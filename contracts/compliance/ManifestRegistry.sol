// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ManifestRegistry — v8.1 Module Manifest Allow-State
 *
 * Manages the registration, metadata, and revocation of module manifests
 * for typed external calls (TypedCall).
 *
 * Design (v8.1 §4.1.3):
 *   - isAllowedManifest is a REAL-TIME execution policy check
 *   - Revocation is IMMEDIATE — no delay, no grace period
 *   - Manifest metadata must match what the proof encodes in execBinding
 *   - getManifestMetadata returns the flat tuple per spec §4.1.3
 *
 * Normative requirements:
 *   1. Every TypedCall proof must check isAllowedManifest(moduleManifestHash) = true
 *   2. Proof metadata must equal getManifestMetadata(moduleManifestHash)
 *   3. LineageFlowMatrix and TagTreeByOutputBucket must be from allowed manifest
 *   4. Revoking a manifest immediately prohibits future typed execution
 */
contract ManifestRegistry is Ownable {
    // ============================================================
    // Types
    // ============================================================

    struct ManifestMetadata {
        bool isExact;                        // Exact vs Boundary module
        bytes32 routeShapeHash;              // Execution route shape
        bytes32 runtimeSchemaHash;           // Runtime args schema
        bytes32 reachableTokenBinding;       // Superset of tokens that may appear
        bytes32 declaredTokenBinding;        // Tokens that will be swept back
        bytes32 targetCodeHashVector;        // Code hashes of target contracts
        bytes32 callbackPolicyHash;          // Callback restriction policy
        bytes32 flowMatrixHash;              // LineageFlowMatrix commitment
        bytes32 tagTreeDigestByOutputBucket; // Tag tree for boundary modules
    }

    struct ManifestEntry {
        bool exists;
        bool allowed;
        uint64 registeredAt;
        uint64 revokedAt;
        ManifestMetadata metadata;
    }

    // ============================================================
    // State
    // ============================================================

    /// @notice Manifest entries by hash
    mapping(bytes32 => ManifestEntry) internal _manifests;

    /// @notice Total registered manifests
    uint256 public manifestCount;

    /// @notice List of all manifest hashes (for enumeration / witness generation)
    bytes32[] internal _manifestHashes;

    // ============================================================
    // Events — designed for off-chain witness generation
    // ============================================================

    event ManifestRegistered(
        bytes32 indexed manifestHash,
        bool isExact,
        uint64 registeredAt
    );

    event ManifestRevoked(
        bytes32 indexed manifestHash,
        uint64 revokedAt
    );

    // ============================================================
    // Registration
    // ============================================================

    /**
     * @notice Register a new module manifest with its metadata.
     * @param manifestHash The canonical hash of the manifest
     * @param metadata The manifest metadata struct
     */
    function registerModuleManifest(
        bytes32 manifestHash,
        ManifestMetadata calldata metadata
    ) external onlyOwner {
        require(!_manifests[manifestHash].exists, "ManifestRegistry: already exists");
        require(manifestHash != bytes32(0), "ManifestRegistry: zero hash");

        _manifests[manifestHash] = ManifestEntry({
            exists: true,
            allowed: true,
            registeredAt: uint64(block.timestamp),
            revokedAt: 0,
            metadata: metadata
        });

        _manifestHashes.push(manifestHash);
        manifestCount++;
        emit ManifestRegistered(manifestHash, metadata.isExact, uint64(block.timestamp));
    }

    /**
     * @notice Revoke a manifest — IMMEDIATELY prevents future typed executions.
     * @dev No delay, no grace period. This is a hard security boundary.
     *      Per spec §4.1.3 requirement 4: revoking must immediately prohibit
     *      future typed execution under this manifest, even if note-side ModSet
     *      is otherwise policy-allowed.
     * @param manifestHash The manifest to revoke
     */
    function revokeManifest(bytes32 manifestHash) external onlyOwner {
        ManifestEntry storage entry = _manifests[manifestHash];
        require(entry.exists, "ManifestRegistry: not found");
        require(entry.allowed, "ManifestRegistry: already revoked");

        // IMMEDIATE revocation — takes effect in this same block
        entry.allowed = false;
        entry.revokedAt = uint64(block.timestamp);

        emit ManifestRevoked(manifestHash, entry.revokedAt);
    }

    // ============================================================
    // View functions — spec §4.1.3 interface
    // ============================================================

    /**
     * @notice Check if a manifest is currently allowed. REAL-TIME check.
     * @dev This MUST be called at verification time for every TypedCall proof.
     *      Per spec §4.1.3 requirement 1.
     */
    function isAllowedManifest(bytes32 manifestHash) external view returns (bool) {
        ManifestEntry storage entry = _manifests[manifestHash];
        return entry.exists && entry.allowed;
    }

    /**
     * @notice Get manifest metadata in the flat tuple format per spec §4.1.3.
     * @dev Reverts if manifest doesn't exist.
     *      Per spec §4.1.3 requirement 2: proof metadata must equal this.
     */
    function getManifestMetadata(bytes32 manifestHash)
        external
        view
        returns (
            bool isExact,
            bytes32 routeShapeHash,
            bytes32 runtimeSchemaHash,
            bytes32 reachableTokenBinding,
            bytes32 declaredTokenBinding,
            bytes32 targetCodeHashVector,
            bytes32 callbackPolicyHash,
            bytes32 flowMatrixHash,
            bytes32 tagTreeDigestByOutputBucket
        )
    {
        ManifestEntry storage entry = _manifests[manifestHash];
        require(entry.exists, "ManifestRegistry: not found");
        ManifestMetadata storage m = entry.metadata;
        return (
            m.isExact,
            m.routeShapeHash,
            m.runtimeSchemaHash,
            m.reachableTokenBinding,
            m.declaredTokenBinding,
            m.targetCodeHashVector,
            m.callbackPolicyHash,
            m.flowMatrixHash,
            m.tagTreeDigestByOutputBucket
        );
    }

    /**
     * @notice Get manifest metadata as a struct (convenience for internal callers).
     */
    function getManifestMetadataStruct(bytes32 manifestHash)
        external
        view
        returns (ManifestMetadata memory)
    {
        ManifestEntry storage entry = _manifests[manifestHash];
        require(entry.exists, "ManifestRegistry: not found");
        return entry.metadata;
    }

    /**
     * @notice Get manifest registration status.
     */
    function getManifestStatus(bytes32 manifestHash)
        external
        view
        returns (
            bool exists,
            bool allowed,
            uint64 registeredAt,
            uint64 revokedAt
        )
    {
        ManifestEntry storage entry = _manifests[manifestHash];
        return (entry.exists, entry.allowed, entry.registeredAt, entry.revokedAt);
    }

    // ============================================================
    // Witness generation queries
    // ============================================================

    /**
     * @notice Get all manifest hashes (for enumeration).
     */
    function getAllManifestHashes() external view returns (bytes32[] memory) {
        return _manifestHashes;
    }

    /**
     * @notice Compute the metadata digest used in execBinding verification.
     * @dev This is the canonical digest that the SNARK proof's execBinding
     *      must incorporate. The verifier computes this on-chain and checks
     *      consistency with the proof.
     */
    function computeManifestMetadataDigest(bytes32 manifestHash)
        external
        view
        returns (bytes32)
    {
        ManifestEntry storage entry = _manifests[manifestHash];
        require(entry.exists, "ManifestRegistry: not found");
        ManifestMetadata storage m = entry.metadata;

        return keccak256(abi.encodePacked(
            m.isExact,
            m.routeShapeHash,
            m.runtimeSchemaHash,
            m.reachableTokenBinding,
            m.declaredTokenBinding,
            m.targetCodeHashVector,
            m.callbackPolicyHash,
            m.flowMatrixHash,
            m.tagTreeDigestByOutputBucket
        ));
    }
}
