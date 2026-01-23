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

# Prepare environment
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"

echo "📦 Setting up Node.js..."
nvm install 22

echo "📦 Installing dependencies..."
yarn install
echo ""

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
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Start web server (this will block)
npx serve ./demo-ui -p 3000