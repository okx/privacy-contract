/**
 * Browser-compatible wrapper for Railgun encryption logic
 * This file exports the Note class and encryption functions for browser use
 * 
 * Usage in HTML:
 * <script type="module">
 *   import { Note, encryptForShield } from './railgun-encryption-browser.js';
 * </script>
 */

// Re-export Note class and related types
// Note: This requires the backend code to be bundled for browser
// For now, we'll create a browser-compatible version

export { Note, TokenType } from '../helpers/logic/note';
export type { TokenData, ShieldRequest, ShieldCiphertext, CommitmentPreimage } from '../helpers/logic/note';
