// Browser bundle entry point
// This file re-exports the necessary modules for browser use

// Use browser-logic versions (already have crypto replaced)
export * from '../browser-logic/note';
export * from '../browser-logic/transaction';
export * from '../global/bytes';
export * from '../global/constants';

// Export RailgunWalletBrowser for browser usage
export { RailgunWalletBrowser } from './railgun-wallet-browser';

// Note: Wallet and MerkleTree are not exported as they depend on Node.js-specific types
// (TransactionResponse, RailgunLogic from typechain-types)
// For browser usage, use RailgunWalletBrowser API instead
