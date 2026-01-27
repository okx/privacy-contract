// Utility Functions

// Ensure ethers library is loaded
export function ensureEthers() {
  if (typeof ethers === 'undefined') {
    throw new Error('ethers library not loaded');
  }
  return ethers;
}

// Get MetaMask provider
export function getMetaMaskProvider() {
  if (typeof window.ethereum === 'undefined') {
    return null;
  }
  
  if (window.ethereum.providers?.length > 0) {
    return window.ethereum.providers.find(p => p.isMetaMask) || window.ethereum;
  }
  
  return window.ethereum;
}

// Format address (shortened display)
export function formatAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Format MPK (shortened display)
export function formatMPK(mpk) {
  if (!mpk) return '';
  return `${mpk.slice(0, 18)}...${mpk.slice(-8)}`;
}

// Format balance
export function formatBalance(balance, decimals = 2) {
  const num = parseFloat(balance);
  if (isNaN(num)) return '0.00';
  return num.toFixed(decimals);
}

// Validate amount
export function validateAmount(amount) {
  if (!amount || amount.trim() === '') {
    throw new Error('请输入金额');
  }
  
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    throw new Error('请输入有效的正数金额');
  }
  
  return true;
}

// Get time ago description
export function getTimeAgo(timestamp) {
  if (!timestamp) return '';
  
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

// Local Storage Utility
export const storage = {
  get(key, defaultValue = null) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('Storage failed:', error);
    }
  },
  
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn('Delete failed:', error);
    }
  },
  
  clearAll() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('railgun')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  }
};

// Toast 通知
export function showToast(type, title, message, duration = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close">×</button>
  `;
  
  container.appendChild(toast);
  
  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => toast.remove());
  
  if (duration > 0) {
    setTimeout(() => toast.remove(), duration);
  }
}
