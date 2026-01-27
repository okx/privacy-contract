#!/bin/bash

set -e  # Exit on error

# Cleanup function - stop services on exit
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    echo "  - Stopping Hardhat node (port 8545)..."
    lsof -ti :8545 | xargs kill 2>/dev/null || true
    echo "  - Stopping Web server (port 3001)..."
    lsof -ti :3001 | xargs kill 2>/dev/null || true
    echo "✅ All services stopped"
    exit 0
}

# Catch Ctrl+C
trap cleanup SIGINT SIGTERM

echo "🔒 Privacy Wallet v2 - Quick Start"
echo "===================================="
echo ""

# Load .env file
if [ -f .env ]; then
    echo "📄 Loading environment variables from .env..."
    export $(grep -v '^#' .env | xargs)
    echo ""
fi

# Determine mode
if [ "$LOCAL" = "true" ]; then
    echo "🏠 Mode: Local (using Hardhat network)"
    echo ""
    IS_LOCAL=true
else
    echo "🌐 Mode: Online (using configured network)"
    if [ -n "$RPC_URL" ]; then
        echo "   Network: $RPC_URL"
    fi
    echo ""
    IS_LOCAL=false
fi

# Setup environment
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"

echo "📦 Setting up Node.js..."
nvm install 22

echo "📦 Installing dependencies..."
yarn install
echo ""

# Local mode: Start Hardhat node and deploy
if [ "$IS_LOCAL" = "true" ]; then
    # Start Hardhat node
    echo "🚂 Starting Hardhat node..."
    nohup yarn run node > node.log 2>&1 &

    # Wait for node to start
    echo "⏳ Waiting for Hardhat node to start..."
    for i in {1..30}; do
        if nc -z localhost 8545 2>/dev/null || (echo > /dev/tcp/localhost/8545) 2>/dev/null; then
            echo "✅ Hardhat node is ready"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ Hardhat node failed to start"
            exit 1
        fi
        sleep 1
    done
    echo ""

    # Deploy contracts
    echo "📝 Deploying contracts..."
    npx hardhat deploy:test --network localhost
    echo ""
else
    # Online mode: Check deployments.json
    if [ ! -f deployments.json ]; then
        echo "❌ Error: deployments.json not found"
        echo ""
        echo "   Need to deploy contracts first:"
        echo "   1. Configure DEPLOYER_PRIVATE_KEY, RPC_URL, CHAIN_ID in .env"
        echo "   2. Run: npm run deploy"
        echo ""
        exit 1
    fi
    echo "✅ Found deployments.json"
    echo ""
fi

# Copy deployments.json to demo-ui-v2 (if exists)
if [ -f deployments.json ]; then
    cp deployments.json demo-ui-v2/deployments.json 2>/dev/null || true
fi

# Build browser bundle
echo "🔨 Building browser bundle..."
npm run build:browser

# Copy bundle to demo-ui-v2
cp demo-ui/railgun-wallet-bundle.js demo-ui-v2/railgun-wallet-bundle.js
cp demo-ui/railgun-wallet-bundle.js.map demo-ui-v2/railgun-wallet-bundle.js.map 2>/dev/null || true
echo ""

# Start Web server
echo "🌐 Starting Web server..."
echo ""
echo "===================================="
echo "✅ v2 is ready!"
echo "===================================="
echo ""
echo "  → http://localhost:3001"
if [ "$IS_LOCAL" = "true" ]; then
    echo "  → Using local Hardhat network"
else
    echo "  → Connected to: $RPC_URL"
    echo ""
    echo "⚠️  Important:"
    echo "  - Make sure MetaMask is on the correct network"
    echo "  - Transactions will consume real gas fees"
fi
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Delayed browser open
(sleep 2 && open http://localhost:3001) &

# Start Web server (blocking)
node ./demo-ui-v2/server.js
