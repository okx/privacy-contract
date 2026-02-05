#!/bin/bash

# Parse arguments
FORCE_CLEAN=false
for arg in "$@"; do
    case $arg in
        --force) FORCE_CLEAN=true ;;
    esac
done

# Copy .env.demo to .env if .env does not exist
[ ! -f ".env" ] && cp .env.example .env
# Export all variables from .env
set -a
source .env
set +a

# Auto-install rapidsnark if USE_RAPIDSNARK=true and not installed
if [ "$USE_RAPIDSNARK" = "true" ]; then
    if [ ! -x "/usr/local/bin/rapidsnark" ]; then
        echo "⚡ USE_RAPIDSNARK=true but rapidsnark not found, installing..."
        ./install_rapidsnark.sh
    else
        echo "⚡ rapidsnark already installed: /usr/local/bin/rapidsnark"
    fi
fi

# Install dependencies first
yarn install

# Handle circuit artifacts based on USE_LOCAL_CIRCUITS (using yarn link/unlink)
LOCAL_CIRCUITS_PATH="${LOCAL_CIRCUITS_PATH:-../circuits-v2}"
LOCAL_TGZ="$LOCAL_CIRCUITS_PATH/export/package/railgun-circuit-test-artifacts-0.0.1.tgz"
LOCAL_PKG_DIR=".local-circuits-package"

if [ "$USE_LOCAL_CIRCUITS" = "true" ]; then
    if [ ! -f "$LOCAL_TGZ" ]; then
        echo "⚠️  Local tgz not found: $LOCAL_TGZ"
        echo "   Run: cd $LOCAL_CIRCUITS_PATH && npm run export"
        exit 1
    fi
    
    echo "📦 Linking LOCAL circuit artifacts..."
    
    # Clear rapidsnark cache only with --force (use when circuits change)
    if [ "$FORCE_CLEAN" = "true" ]; then
        CACHE_DIR="${TMPDIR:-/tmp}/rapidsnark-artifacts"
        echo "🗑️  Clearing rapidsnark cache (--force)"
        rm -rf "$CACHE_DIR" /tmp/rapidsnark-artifacts 2>/dev/null || true
    fi
    
    # Extract fresh copy from tgz
    rm -rf "$LOCAL_PKG_DIR"
    mkdir -p "$LOCAL_PKG_DIR"
    tar -xzf "$LOCAL_TGZ" -C "$LOCAL_PKG_DIR" --strip-components=1
    
    # Register package globally (unlink first to replace old registration)
    pushd "$LOCAL_PKG_DIR" > /dev/null
    yarn unlink 2>/dev/null || true
    yarn link
    popd > /dev/null
    
    # Link to this project
    yarn link railgun-circuit-test-artifacts
else
    echo "📦 Using REMOTE circuit artifacts from npm registry..."
    
    # Unlink local package if linked
    yarn unlink railgun-circuit-test-artifacts 2>/dev/null || true
    
    # Restore remote package
    yarn install --force --check-files
    
    # Cleanup extracted local package
    rm -rf "$LOCAL_PKG_DIR"
fi

#1. start anvil (local ethereum node)
# Kill any existing process on port 8545
lsof -ti :8545 | xargs kill 2>/dev/null || true
anvil > anvil.log 2>&1 &
ANVIL_PID=$!
# Auto cleanup anvil when script exits
trap "kill $ANVIL_PID 2>/dev/null" EXIT
sleep 3

#2. deploy railgun contracts
npx hardhat deploy:test --network localhost

#3. run a railgun demo
npx hardhat run scripts/demo.ts --network localhost
