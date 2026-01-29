// UI Text Constants
export const TX_TYPES = {
  SHIELD: 'shield',
  UNSHIELD: 'unshield',
  TRANSFER: 'transfer',
  TRANSFER_OUT: 'transfer-out',
  ERC20: 'erc20'
};

export const TX_LABELS = {
  PUBLIC_TO_PRIVATE: 'Public to Private',
  PRIVATE_TO_PUBLIC: 'Private to Public',
  PRIVATE_TRANSFER: 'Private Transfer',
  TRANSFER_OUT: 'Transfer Out',
  PUBLIC_TRANSFER: 'Public Transfer'
};

export const TX_ICONS = {
  [TX_TYPES.SHIELD]: '🔐',       // Public to Private
  [TX_TYPES.UNSHIELD]: '💳',      // Private to Public
  [TX_TYPES.TRANSFER]: '🔄',      // Private Transfer
  [TX_TYPES.TRANSFER_OUT]: '💸', // Transfer Out
  [TX_TYPES.ERC20]: '📝'          // Public Transfer
};

export const BUTTON_STATES = {
  PREPARING: 'Preparing...',
  BROADCASTING: 'Broadcasting...',
  CONFIRMING: 'Confirming...',
  UPDATING: 'Updating balances...',
  SIGNING: 'Sign to confirm...'
};
