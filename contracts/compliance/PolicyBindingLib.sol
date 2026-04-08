// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;

/**
 * @title PolicyBindingLib — v8.1 policyBinding computation (§4.2.6)
 *
 * Full formula:
 *   policyBinding = H_policy(
 *       DST_POLICY_BIND_V3,
 *       chainid,
 *       verifier_addr,
 *       policy_epoch,
 *       reg_seq_used,
 *       cleanSourceRoot[e,k],
 *       H_group(A_mod_policy[e,k]),
 *       q_epoch(e),
 *       sourcePolicyModeFlag,
 *       modulePolicyModeFlag
 *   )
 *
 * CRITICAL: policyBinding is NEVER trusted from the prover.
 *           The contract ALWAYS recomputes it from on-chain state.
 */
library PolicyBindingLib {
    bytes32 public constant DST_POLICY_BIND = keccak256("RAILGUN_POLICY_BIND_V3");

    /// @notice Policy mode flags
    uint8 public constant SOURCE_POLICY_MODE_CLEAN = 1;
    uint8 public constant MODULE_POLICY_MODE_SUBSET = 1;

    struct PolicyState {
        uint64 policyEpoch;
        uint64 regSeqUsed;
        bytes32 cleanSourceRoot;
        bytes32 modulePolicyAccumulator;
        bytes32 epochPrime;
        uint8 sourcePolicyModeFlag;
        uint8 modulePolicyModeFlag;
    }

    /**
     * @notice Compute policyBinding from full policy state.
     * @param verifierAddr The compliance verifier contract address
     * @param state        The current policy state from registries
     * @return policyBinding The computed binding value
     */
    function computePolicyBinding(
        address verifierAddr,
        PolicyState memory state
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            DST_POLICY_BIND,
            block.chainid,
            verifierAddr,
            state.policyEpoch,
            state.regSeqUsed,
            state.cleanSourceRoot,
            state.modulePolicyAccumulator,
            state.epochPrime,
            state.sourcePolicyModeFlag,
            state.modulePolicyModeFlag
        ));
    }

    /**
     * @notice Convenience: compute with individual parameters.
     */
    function computePolicyBinding(
        address verifierAddr,
        uint64 policyEpoch,
        uint64 regSeqUsed,
        bytes32 cleanSourceRoot,
        bytes32 modulePolicyAccumulator,
        bytes32 epochPrime,
        uint8 sourcePolicyModeFlag,
        uint8 modulePolicyModeFlag
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            DST_POLICY_BIND,
            block.chainid,
            verifierAddr,
            policyEpoch,
            regSeqUsed,
            cleanSourceRoot,
            modulePolicyAccumulator,
            epochPrime,
            sourcePolicyModeFlag,
            modulePolicyModeFlag
        ));
    }
}
