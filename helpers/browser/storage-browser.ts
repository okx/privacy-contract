/**
 * Browser storage implementation using localStorage
 */

import {
  IStorage,
  WalletData,
  Keys,
  UTXOData,
  ScanState,
  TransactionData,
  WalletStorage,
} from './types';
import { arrayToHexString, hexStringToArray } from '../global/bytes';

const STORAGE_KEY = 'railgun-wallet-data';

/**
 * Get storage data from localStorage
 */
function getStorage(): WalletStorage {
  const data = localStorage.getItem(STORAGE_KEY);
  if (!data) {
    return {
      registeredAccounts: [],
      wallets: {},
      transactions: {},
    };
  }
  try {
    return JSON.parse(data);
  } catch (e) {
    console.error('Failed to parse storage data:', e);
    return {
      registeredAccounts: [],
      wallets: {},
      transactions: {},
    };
  }
}

/**
 * Save storage data to localStorage
 */
function saveStorage(storage: WalletStorage): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
}

class BrowserStorage implements IStorage {
  // Wallet management
  async saveWallet(account: string, walletData: WalletData): Promise<void> {
    const storage = getStorage();
    storage.wallets[account.toLowerCase()] = walletData;
    saveStorage(storage);
  }

  async loadWallet(account: string): Promise<WalletData | null> {
    const storage = getStorage();
    return storage.wallets[account.toLowerCase()] || null;
  }

  async getAllWallets(): Promise<string[]> {
    const storage = getStorage();
    return Object.keys(storage.wallets);
  }

  async deleteWallet(account: string): Promise<void> {
    const storage = getStorage();
    delete storage.wallets[account.toLowerCase()];
    saveStorage(storage);
  }

  // Keys management
  async saveKeys(account: string, keys: Keys): Promise<void> {
    const storage = getStorage();
    const wallet = storage.wallets[account.toLowerCase()] || {
      spendingKey: '',
      viewingKey: '',
      createdAt: Date.now(),
      utxos: [],
      scanState: {
        contractAddress: '',
        chainId: 0,
        lastScannedBlock: 0,
        lastScannedTime: 0,
      },
      nullifiers: [],
    };

    wallet.spendingKey = keys.spendingKey;
    wallet.viewingKey = keys.viewingKey;
    wallet.createdAt = wallet.createdAt || Date.now();

    storage.wallets[account.toLowerCase()] = wallet;
    saveStorage(storage);
  }

  async loadKeys(account: string): Promise<Keys | null> {
    const wallet = await this.loadWallet(account);
    if (!wallet || !wallet.spendingKey || !wallet.viewingKey) {
      return null;
    }
    return {
      spendingKey: wallet.spendingKey,
      viewingKey: wallet.viewingKey,
    };
  }

  // UTXO management
  async addUTXO(account: string, utxo: UTXOData): Promise<void> {
    const storage = getStorage();
    const wallet = storage.wallets[account.toLowerCase()];
    if (!wallet) {
      throw new Error(`Wallet not found for account: ${account}`);
    }

    // Check if UTXO already exists (by npk + txHash)
    const existingIndex = wallet.utxos.findIndex(
      (u) => u.npk === utxo.npk && u.txHash === utxo.txHash,
    );
    if (existingIndex >= 0) {
      // Update existing UTXO
      wallet.utxos[existingIndex] = utxo;
    } else {
      // Add new UTXO
      wallet.utxos.push(utxo);
    }

    saveStorage(storage);
  }

  async removeUTXO(account: string, nullifier: string): Promise<void> {
    const storage = getStorage();
    const wallet = storage.wallets[account.toLowerCase()];
    if (!wallet) {
      return;
    }

    // Remove UTXO by finding its nullifier
    // Note: We need to calculate nullifier from UTXO, but for simplicity,
    // we'll use a different approach - mark as spent via nullifiers list
    // The actual removal should be done when we know which UTXO corresponds to the nullifier
    // For now, we'll just add to nullifiers list
    await this.addNullifier(account, nullifier, '');
  }

  async getUTXOs(account: string): Promise<UTXOData[]> {
    const wallet = await this.loadWallet(account);
    if (!wallet) {
      return [];
    }
    return wallet.utxos;
  }

  async getUTXOsByToken(
    account: string,
    tokenAddress: string,
    tokenType: number,
  ): Promise<UTXOData[]> {
    const utxos = await this.getUTXOs(account);
    return utxos.filter(
      (utxo) => utxo.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() && utxo.tokenType === tokenType,
    );
  }

  // Scan state
  async updateScanState(account: string, scanState: Partial<ScanState>): Promise<void> {
    const storage = getStorage();
    const wallet = storage.wallets[account.toLowerCase()];
    if (!wallet) {
      throw new Error(`Wallet not found for account: ${account}`);
    }

    wallet.scanState = {
      ...wallet.scanState,
      ...scanState,
    };

    saveStorage(storage);
  }

  async getScanState(account: string): Promise<ScanState | null> {
    const wallet = await this.loadWallet(account);
    if (!wallet) {
      return null;
    }
    return wallet.scanState;
  }

  // Transaction records
  async saveTransaction(txHash: string, tx: TransactionData): Promise<void> {
    const storage = getStorage();
    storage.transactions[txHash.toLowerCase()] = tx;
    saveStorage(storage);
  }

  async getTransaction(txHash: string): Promise<TransactionData | null> {
    const storage = getStorage();
    return storage.transactions[txHash.toLowerCase()] || null;
  }

  // Nullifiers
  async addNullifier(account: string, nullifier: string, txHash: string): Promise<void> {
    const storage = getStorage();
    const wallet = storage.wallets[account.toLowerCase()];
    if (!wallet) {
      throw new Error(`Wallet not found for account: ${account}`);
    }

    const nullifierLower = nullifier.toLowerCase();
    if (!wallet.nullifiers.includes(nullifierLower)) {
      wallet.nullifiers.push(nullifierLower);
      saveStorage(storage);
    }

    // Also save transaction if provided
    if (txHash) {
      await this.saveTransaction(txHash, {
        account,
        type: 'transfer', // Default type, should be determined from transaction
        blockNumber: 0, // Should be set from transaction
        blockHash: '',
        createdAt: Date.now(),
      });
    }
  }

  async isNullifierSpent(account: string, nullifier: string): Promise<boolean> {
    const wallet = await this.loadWallet(account);
    if (!wallet) {
      return false;
    }
    return wallet.nullifiers.includes(nullifier.toLowerCase());
  }

  // Registered accounts management
  async addRegisteredAccount(account: string): Promise<void> {
    const storage = getStorage();
    const accountLower = account.toLowerCase();
    if (!storage.registeredAccounts.includes(accountLower)) {
      storage.registeredAccounts.push(accountLower);
      saveStorage(storage);
    }
  }

  async getRegisteredAccounts(): Promise<string[]> {
    const storage = getStorage();
    return [...storage.registeredAccounts];
  }

  async removeRegisteredAccount(account: string): Promise<void> {
    const storage = getStorage();
    const accountLower = account.toLowerCase();
    storage.registeredAccounts = storage.registeredAccounts.filter((a) => a !== accountLower);
    saveStorage(storage);
  }

  async isAccountRegistered(account: string): Promise<boolean> {
    const storage = getStorage();
    return storage.registeredAccounts.includes(account.toLowerCase());
  }
}

// Export singleton instance and interface
export const browserStorage = new BrowserStorage();
export type { IStorage };
export default browserStorage;
