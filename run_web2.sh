#!/bin/bash

set -e  # 出错时退出

# 清理函数 - 退出时停止服务
cleanup() {
    echo ""
    echo "🛑 正在关闭服务..."
    echo "  - 停止 Hardhat 节点 (端口 8545)..."
    lsof -ti :8545 | xargs kill 2>/dev/null || true
    echo "  - 停止 Web 服务器 (端口 3001)..."
    lsof -ti :3001 | xargs kill 2>/dev/null || true
    echo "✅ 所有服务已停止"
    exit 0
}

# 捕获 Ctrl+C
trap cleanup SIGINT SIGTERM

echo "🔒 隐私钱包 v2 - 快速启动"
echo "===================================="
echo ""

# 加载 .env 文件
if [ -f .env ]; then
    echo "📄 从 .env 加载环境变量..."
    export $(grep -v '^#' .env | xargs)
    echo ""
fi

# 判断模式
if [ "$LOCAL" = "true" ]; then
    echo "🏠 模式: 本地 (使用 Hardhat 网络)"
    echo ""
    IS_LOCAL=true
else
    echo "🌐 模式: 在线 (使用配置的网络)"
    if [ -n "$RPC_URL" ]; then
        echo "   网络: $RPC_URL"
    fi
    echo ""
    IS_LOCAL=false
fi

# 准备环境
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"

echo "📦 设置 Node.js..."
nvm install 22

echo "📦 安装依赖..."
yarn install
echo ""

# 本地模式：启动 Hardhat 节点并部署
if [ "$IS_LOCAL" = "true" ]; then
    # 启动 Hardhat 节点
    echo "🚂 启动 Hardhat 节点..."
    nohup yarn run node > node.log 2>&1 &

    # 等待节点启动
    echo "⏳ 等待 Hardhat 节点启动..."
    for i in {1..30}; do
        if nc -z localhost 8545 2>/dev/null || (echo > /dev/tcp/localhost/8545) 2>/dev/null; then
            echo "✅ Hardhat 节点已就绪"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ Hardhat 节点启动失败"
            exit 1
        fi
        sleep 1
    done
    echo ""

    # 部署合约
    echo "📝 部署合约..."
    npx hardhat deploy:test --network localhost
    echo ""
else
    # 在线模式：检查 deployments.json
    if [ ! -f deployments.json ]; then
        echo "❌ 错误: 未找到 deployments.json"
        echo ""
        echo "   需要先部署合约:"
        echo "   1. 在 .env 中配置 DEPLOYER_PRIVATE_KEY, RPC_URL, CHAIN_ID"
        echo "   2. 运行: npm run deploy"
        echo ""
        exit 1
    fi
    echo "✅ 已找到 deployments.json"
    echo ""
fi

# 复制 deployments.json 到 demo-ui-v2（如果不存在）
if [ -f deployments.json ]; then
    cp deployments.json demo-ui-v2/deployments.json 2>/dev/null || true
fi

# 构建浏览器 bundle
echo "🔨 构建浏览器 bundle..."
npm run build:browser

# 复制 bundle 到 demo-ui-v2
cp demo-ui/railgun-wallet-bundle.js demo-ui-v2/railgun-wallet-bundle.js
cp demo-ui/railgun-wallet-bundle.js.map demo-ui-v2/railgun-wallet-bundle.js.map 2>/dev/null || true
echo ""

# 启动 Web 服务器
echo "🌐 启动 Web 服务器..."
echo ""
echo "===================================="
echo "✅ v2 已就绪!"
echo "===================================="
echo ""
echo "  → http://localhost:3001"
if [ "$IS_LOCAL" = "true" ]; then
    echo "  → 使用本地 Hardhat 网络"
else
    echo "  → 已连接到: $RPC_URL"
    echo ""
    echo "⚠️  重要:"
    echo "  - 确保 MetaMask 已切换到正确的网络"
    echo "  - 交易将消耗真实的 gas 费用"
fi
echo ""
echo "按 Ctrl+C 停止所有服务"
echo ""

# 延迟打开浏览器
(sleep 2 && open http://localhost:3001) &

# 启动 Web 服务器（阻塞）
node ./demo-ui-v2/server.js
