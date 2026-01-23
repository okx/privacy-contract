// Toast Notification Component

class ToastManager {
  constructor() {
    this.container = null;
    this.init();
  }

  init() {
    // Create container if not exists
    if (!document.querySelector('.toast-container')) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    } else {
      this.container = document.querySelector('.toast-container');
    }
  }

  show(options) {
    const {
      type = 'info',  // 'success', 'error', 'warning', 'info'
      title,
      message,
      duration = 5000,
      closable = true
    } = options;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    toast.innerHTML = `
      <div class="toast-icon">${icons[type]}</div>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${title}</div>` : ''}
        <div class="toast-message">${message}</div>
      </div>
      ${closable ? '<button class="toast-close">×</button>' : ''}
    `;

    this.container.appendChild(toast);

    // Close button
    if (closable) {
      const closeBtn = toast.querySelector('.toast-close');
      closeBtn.addEventListener('click', () => this.remove(toast));
    }

    // Auto remove after duration
    if (duration > 0) {
      setTimeout(() => this.remove(toast), duration);
    }

    return toast;
  }

  remove(toast) {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }

  success(message, title = 'Success') {
    return this.show({ type: 'success', title, message });
  }

  error(message, title = 'Error') {
    return this.show({ type: 'error', title, message, duration: 7000 });
  }

  warning(message, title = 'Warning') {
    return this.show({ type: 'warning', title, message });
  }

  info(message, title = 'Info') {
    return this.show({ type: 'info', title, message });
  }

  // Transaction-specific toasts
  txPending(txHash, message = 'Transaction submitted') {
    return this.show({
      type: 'info',
      title: 'Transaction Pending',
      message: `${message}<br><small style="font-family: monospace; font-size: 11px;">${txHash.slice(0, 10)}...${txHash.slice(-8)}</small>`,
      duration: 0,  // Don't auto-close
      closable: true
    });
  }

  txSuccess(message = 'Transaction confirmed') {
    return this.show({
      type: 'success',
      title: 'Transaction Success',
      message,
      duration: 5000
    });
  }

  txFailed(error) {
    let message = 'Transaction failed';
    if (error?.reason) {
      message = error.reason;
    } else if (error?.message) {
      message = error.message;
    }
    
    return this.show({
      type: 'error',
      title: 'Transaction Failed',
      message,
      duration: 8000
    });
  }
}

// Add slideOut animation
const style = document.createElement('style');
style.textContent = `
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

export const toast = new ToastManager();
