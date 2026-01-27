// 应用入口
import { loadContractConfig, connectWallet, enablePrivacy, lookupMPK, walletState, setupProviderListeners, refreshBalances } from './wallet.js';
import { handleDeposit, handleWithdraw, handlePublicTransfer, handlePrivateTransfer } from './transactions.js';
import * as UI from './ui.js';
import { ensureEthers, showToast } from './utils.js';

// 初始化应用
async function init() {
  console.log('🔒 隐私钱包 v2 初始化中...');
  
  // 加载配置
  await loadContractConfig();
  
  // 设置 provider 监听器
  setupProviderListeners();
  
  // 绑定事件
  bindEvents();
  
  // 初始化 UI
  UI.updateAll(walletState);
  
  console.log('✅ 应用初始化完成');
}

// 绑定所有事件
function bindEvents() {
  // 连接钱包按钮
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      if (walletState.account) {
        showToast('info', '已连接', `当前地址: ${walletState.account}`);
      } else {
        connectWallet();
      }
    });
  }

  // 隐私开关
  const privacyToggle = document.getElementById('privacy-toggle');
  if (privacyToggle) {
    privacyToggle.addEventListener('change', async (e) => {
      if (e.target.checked && !walletState.isPrivacyEnabled) {
        const success = await enablePrivacy();
        if (!success) {
          e.target.checked = false;
        }
      } else if (!e.target.checked && walletState.isPrivacyEnabled) {
        e.target.checked = true;
        showToast('info', '无法禁用', '隐私交易一旦启用无法禁用');
      }
    });
  }

  // ========== 余额转换（方案G - Modal弹窗 + 单按钮设计）==========
  
  const convertModal = document.getElementById('convert-modal');
  const openModalBtn = document.getElementById('open-convert-modal');
  const closeModalBtn = document.getElementById('close-convert-modal');
  const convertAmountInput = document.getElementById('convert-amount');
  const swapDirectionBtn = document.getElementById('modal-swap-direction');
  const convertActionBtn = document.getElementById('convert-action-btn');
  
  // 转换方向状态：'deposit' (公开→隐私) 或 'withdraw' (隐私→公开)
  let convertDirection = 'deposit';
  
  // 打开 Modal
  if (openModalBtn) {
    openModalBtn.addEventListener('click', () => {
      if (convertModal) {
        convertModal.style.display = 'flex';
        convertDirection = 'deposit'; // 重置为默认方向
        
        // 清空输入框
        if (convertAmountInput) {
          convertAmountInput.value = '';
        }
        // 清除快捷按钮高亮
        document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
        
        UI.updateModalBalances(walletState, convertDirection);
        UI.updateConvertActionButton(convertDirection, walletState);
      }
    });
  }
  
  // 关闭 Modal（只有点击 X 按钮才关闭）
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
      if (convertModal) {
        convertModal.style.display = 'none';
      }
    });
  }
  
  // 点击箭头切换方向
  if (swapDirectionBtn) {
    swapDirectionBtn.addEventListener('click', () => {
      // 切换方向
      convertDirection = convertDirection === 'deposit' ? 'withdraw' : 'deposit';
      
      // 更新 UI（双向箭头不需要旋转动画）
      UI.updateModalBalances(walletState, convertDirection);
      UI.updateConvertActionButton(convertDirection, walletState);
      
      // 清除快捷按钮高亮
      document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
    });
  }
  
  // 单按钮执行转换
  if (convertActionBtn) {
    convertActionBtn.addEventListener('click', () => {
      const amount = convertAmountInput?.value || '';
      if (convertDirection === 'deposit') {
        handleDeposit(amount);
      } else {
        handleWithdraw(amount);
      }
    });
  }
  
  // 快捷按钮（25%, 50%, 75%, 最大）- 使用来源余额
  document.querySelectorAll('.modal-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const percent = parseInt(btn.dataset.percent);
      // 根据当前方向使用对应的"来源"余额
      const balance = convertDirection === 'deposit' 
        ? parseFloat(walletState.publicBalance) || 0
        : parseFloat(walletState.privateBalance) || 0;
      const amount = (balance * percent / 100).toFixed(2);
      if (convertAmountInput) {
        convertAmountInput.value = amount;
      }
      
      // 高亮当前选中的按钮
      document.querySelectorAll('.modal-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ========== 转账 - 滑动开关 ==========
  
  const transferAmountInput = document.getElementById('transfer-amount');
  const balanceToggleInput = document.getElementById('balance-toggle-input');
  
  // 滑动开关切换
  if (balanceToggleInput) {
    balanceToggleInput.addEventListener('change', async (e) => {
      const type = e.target.checked ? 'private' : 'public';
      UI.selectTransferType(type, walletState);
      
      // 切换余额类型时清空输入框
      if (transferAmountInput) {
        transferAmountInput.value = '';
      }
      // 清除快捷按钮高亮
      document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
      
      // 切换到隐私转账时，如果地址已存在，自动检查 MPK
      if (type === 'private') {
        const transferAddress = document.getElementById('transfer-address');
        const address = transferAddress?.value?.trim();
        if (address && address.length === 42) {
          UI.updateTransferRecipientStatus('checking', '检查中...');
          try {
            const userInfo = await lookupMPK(address);
            if (userInfo) {
              UI.updateTransferRecipientStatus('found', '已启用隐私交易');
            } else {
              UI.updateTransferRecipientStatus('not-found', '未启用隐私交易');
            }
          } catch (err) {
            UI.updateTransferRecipientStatus('not-found', '查询失败');
          }
        }
      }
    });
  }

  // ========== 转账 ==========
  
  // 转账地址输入（隐私转账时查询 MPK）
  const transferAddress = document.getElementById('transfer-address');
  let lookupTimeout = null;
  
  if (transferAddress) {
    transferAddress.addEventListener('input', (e) => {
      const address = e.target.value.trim();
      
      if (lookupTimeout) {
        clearTimeout(lookupTimeout);
      }
      
      // 如果是隐私转账，延迟查询 MPK
      if (UI.getTransferType() === 'private') {
        const ethersLib = ensureEthers();
        
        if (!address) {
          UI.updateTransferRecipientStatus(null, '等待输入地址...');
          return;
        }
        
        if (!ethersLib.utils.isAddress(address)) {
          if (address.length >= 42) {
            UI.updateTransferRecipientStatus('not-found', '地址格式无效');
          }
          return;
        }
        
        UI.updateTransferRecipientStatus(null, '查询中...');
        
        lookupTimeout = setTimeout(async () => {
          const userInfo = await lookupMPK(address);
          if (userInfo) {
            UI.updateTransferRecipientStatus('found', '已启用隐私交易');
          } else {
            UI.updateTransferRecipientStatus('not-found', '未启用隐私交易');
          }
        }, 500);
      }
    });
  }

  // 转账快捷百分比按钮
  document.querySelectorAll('.transfer-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const percent = parseInt(btn.dataset.percent);
      const currentBalance = parseFloat(UI.getCurrentBalance(walletState)) || 0;
      const amount = (currentBalance * percent / 100).toFixed(2);
      
      const transferAmountInput = document.getElementById('transfer-amount');
      if (transferAmountInput) {
        transferAmountInput.value = amount;
      }
      
      // 更新高亮状态
      document.querySelectorAll('.transfer-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // 转账提交按钮
  const transferBtn = document.getElementById('transfer-btn');
  if (transferBtn) {
    transferBtn.addEventListener('click', () => {
      const transferAddressInput = document.getElementById('transfer-address');
      const transferAmountInput = document.getElementById('transfer-amount');
      const address = transferAddressInput?.value?.trim() || '';
      const amount = transferAmountInput?.value || '';
      const transferType = UI.getTransferType();
      
      if (transferType === 'public') {
        handlePublicTransfer(address, amount);
      } else {
        handlePrivateTransfer(address, amount);
      }
    });
  }

  // 定期刷新余额
  setInterval(() => {
    if (walletState.account) {
      refreshBalances();
    }
  }, 30000);
}

// DOM 加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
