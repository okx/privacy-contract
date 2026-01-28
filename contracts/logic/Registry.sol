// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

/**
 * @title Registry
 * @notice Registry for storing user MPK (Master Public Key) and viewing public key
 * @dev Maps EOA address to (MPK, viewingPublicKey) for privacy transfers
 */
contract Registry {
    struct UserInfo {
        bytes32 mpk;
        bytes32 viewingPublicKey;
    }

    mapping(address => UserInfo) public users;

    /**
     * @notice Register MPK and viewing public key for the caller
     * @param mpk Master Public Key (32 bytes)
     * @param viewingPublicKey Viewing public key (32 bytes, ed25519 public key)
     */
    function register(bytes32 mpk, bytes32 viewingPublicKey) external {
        users[tx.origin] = UserInfo({
            mpk: mpk,
            viewingPublicKey: viewingPublicKey
        });
    }

    /**
     * @notice Get user info by EOA address
     * @param user EOA address to query
     * @return mpk Master Public Key
     * @return viewingPublicKey Viewing public key
     */
    function getUserInfo(address user) external view returns (bytes32 mpk, bytes32 viewingPublicKey) {
        UserInfo memory info = users[user];
        return (info.mpk, info.viewingPublicKey);
    }
}
