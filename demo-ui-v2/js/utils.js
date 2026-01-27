// 工具函数

// 确保 ethers 库已加载
export function ensureEthers() {
  if (typeof ethers === 'undefined') {
    throw new Error('ethers 库未加载');
  }
  return ethers;
}

// 获取 MetaMask provider
export function getMetaMaskProvider() {
  if (typeof window.ethereum === 'undefined') {
    return null;
  }
  
  if (window.ethereum.providers?.length > 0) {
    return window.ethereum.providers.find(p => p.isMetaMask) || window.ethereum;
  }
  
  return window.ethereum;
}

// 格式化地址（缩短显示）
export function formatAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 格式化 MPK（缩短显示）
export function formatMPK(mpk) {
  if (!mpk) return '';
  return `${mpk.slice(0, 18)}...${mpk.slice(-8)}`;
}

// 格式化余额
export function formatBalance(balance, decimals = 2) {
  const num = parseFloat(balance);
  if (isNaN(num)) return '0.00';
  return num.toFixed(decimals);
}

// 验证金额
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

// 获取时间差描述
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

// 本地存储工具
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
      console.warn('存储失败:', error);
    }
  },
  
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn('删除失败:', error);
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
