#!/bin/bash

set -e  # Exit on error

# Cleanup function - kills Hardhat node and web server on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down services..."
    echo "  - Stopping Hardhat node (port 8545)..."
    lsof -ti :8545 | xargs kill 2>/dev/null || true
    echo "  - Stopping web server (port 3000)..."
    lsof -ti :3000 | xargs kill 2>/dev/null || true
    echo "✅ All services stopped"
    exit 0
}

# Trap Ctrl+C to cleanup
trap cleanup SIGINT SIGTERM

echo "🚀 Privacy Wallet Demo - Quick Start"
echo "===================================="
echo ""

# Load .env file if it exists
if [ -f .env ]; then
    echo "📄 Loading environment variables from .env..."
    export $(grep -v '^#' .env | xargs)
    echo ""
fi

# Determine mode
if [ "$LOCAL" = "true" ]; then
    echo "🏠 Mode: LOCAL (using local Hardhat network)"
    echo ""
    IS_LOCAL=true
else
    echo "🌐 Mode: ONLINE (using configured network)"
    if [ -n "$RPC_URL" ]; then
        echo "   Network: $RPC_URL"
    fi
    echo ""
    IS_LOCAL=false
fi

# Prepare environment
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"

echo "📦 Setting up Node.js..."
nvm install 22

echo "📦 Installing dependencies..."
yarn install
echo ""

# Start Hardhat node and deploy (only in local mode)
if [ "$IS_LOCAL" = "true" ]; then
    # Start Hardhat node in background
    echo "🚂 Starting Hardhat node..."
    nohup yarn run node > node.log 2>&1 &

    # Wait for Hardhat node to start
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
    # Check if deployments.json exists for online mode
    if [ ! -f deployments.json ]; then
        echo "❌ Error: deployments.json not found"
        echo ""
        echo "   You need to deploy contracts first:"
        echo "   1. Configure DEPLOYER_PRIVATE_KEY, RPC_URL, CHAIN_ID in .env"
        echo "   2. Run: npm run deploy"
        echo ""
        exit 1
    fi
    echo "✅ Found deployments.json"
    echo ""
fi

# Build browser bundle
echo "🔨 Building browser bundle..."
npm run build:browser
echo ""

# Start web server
echo "🌐 Starting web server..."
echo ""
echo "===================================="
echo "✅ Demo is ready!"
echo "===================================="
echo ""
echo "  → http://localhost:3000"
if [ "$IS_LOCAL" = "true" ]; then
    echo "  → Using local Hardhat network"
else
    echo "  → Connected to: $RPC_URL"
    echo ""
    echo "⚠️  Important:"
    echo "  - Make sure MetaMask is on the correct network"
    echo "  - Transactions will cost real gas fees"
fi
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Open browser after server starts (delayed)
(sleep 2 && open http://localhost:3000) &

# Start web server with broadcast (this will block)
node ./demo-ui/server.js