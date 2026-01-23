// Utility Functions

export function formatAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatMPK(mpk) {
  if (!mpk || mpk.length < 40) return mpk;
  return `${mpk.slice(0, 20)}...${mpk.slice(-12)}`;
}

export function formatBalance(balance, decimals = 18) {
  if (!window.ethers) {
    console.error('ethers is not defined');
    return '0.0000';
  }
  const formatted = ethers.utils.formatUnits(balance, decimals);
  return parseFloat(formatted).toFixed(4);
}

export function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ensureEthers() {
  if (typeof ethers === 'undefined') {
    throw new Error('ethers.js library is not loaded. Please refresh the page.');
  }
  return ethers;
}

export function validateAmount(amountStr) {
  if (!amountStr || !/^\d+\.?\d*$/.test(amountStr)) {
    throw new Error('Invalid amount format');
  }
  const amount = parseFloat(amountStr);
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }
  if (amount > 1e18) {
    throw new Error('Amount too large');
  }
  return amountStr;
}

export function getMetaMaskProvider() {
  if (!window.ethereum) {
    return null;
  }

  let provider = null;
  
  if (window.ethereum.providers?.length) {
    provider = window.ethereum.providers.find(p => p.isMetaMask);
    if (!provider) {
      console.warn('⚠️ MetaMask not found in providers array');
      provider = window.ethereum.providers[0];
    }
  } else if (window.ethereum.isMetaMask) {
    provider = window.ethereum;
  } else {
    console.warn('⚠️ window.ethereum exists but isMetaMask is false');
    provider = window.ethereum;
  }
  
  if (provider && typeof provider.request !== 'function') {
    console.error('❌ Provider does not have request method');
    return null;
  }
  
  return provider;
}

// Wait for library to load
export function waitForLibrary(libraryName, maxWait = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof window[libraryName] !== 'undefined') {
      resolve(window[libraryName]);
      return;
    }
    
    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (typeof window[libraryName] !== 'undefined') {
        clearInterval(checkInterval);
        resolve(window[libraryName]);
      } else if (Date.now() - startTime > maxWait) {
        clearInterval(checkInterval);
        reject(new Error(`${libraryName} failed to load`));
      }
    }, 100);
  });
}

// LocalStorage helpers with error handling
export const storage = {
  get(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
      console.warn(`Failed to read from localStorage: ${key}`, e);
      return defaultValue;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        console.error('localStorage quota exceeded');
        // Clean old data
        this.cleanup(key);
      }
      console.warn(`Failed to write to localStorage: ${key}`, e);
      return false;
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn(`Failed to remove from localStorage: ${key}`, e);
    }
  },

  cleanup(currentKey) {
    // Remove old transactions to free space
    try {
      const allKeys = Object.keys(localStorage);
      const txKeys = allKeys.filter(k => k.includes('railgun-') && k !== currentKey);
      txKeys.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.warn('Failed to cleanup localStorage', e);
    }
  }
};

// Debounce function
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Copy to clipboard with fallback
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(textArea);
      return true;
    } catch (e) {
      document.body.removeChild(textArea);
      return false;
    }
  }
}
