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

echo "🚀 Starting development server..."
echo ""
echo "Available at:"
echo "  → Local:   http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Use npx serve (no installation required)
npx serve . -p 3000
