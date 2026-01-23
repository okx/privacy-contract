#!/bin/bash

echo "🚂 Starting Railgun Privacy Wallet Demo..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    echo "Please install Node.js from https://nodejs.org"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo ""

# Check if in correct directory
if [ ! -f "index.html" ]; then
    echo "⚠️  Please run this script from the demo-ui directory"
    echo "Usage: cd demo-ui && ./start.sh"
    exit 1
fi

echo "🚀 Starting development server with broadcast..."
echo ""
echo "Features:"
echo "  → Web UI at http://localhost:3000"
echo "  → Broadcast API (transactions broadcast via server)"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Start our custom server with broadcast support
node server.js
