#!/bin/bash
set -e

echo "============================================"
echo "  Privacy Transact Benchmark - Setup"
echo "  (One-time: deploy contracts only)"
echo "============================================"

# ===== Load .env =====
[ ! -f ".env" ] && cp .env.example .env
set -a
source .env
set +a

# ===== Validate config =====
if [ -z "$PRIVATE_KEY" ]; then
    echo "ERROR: PRIVATE_KEY not set in .env"
    exit 1
fi
if [ -z "$LOCAL_RPC_URL" ]; then
    echo "ERROR: LOCAL_RPC_URL not set in .env"
    exit 1
fi
echo "Chain: $LOCAL_RPC_URL"

# ===== Auto-install rapidsnark if needed =====
if [ "$USE_RAPIDSNARK" = "true" ]; then
    if [ ! -x "/usr/local/bin/rapidsnark" ]; then
        echo "rapidsnark not found, installing..."
        ./install_rapidsnark.sh
    else
        echo "rapidsnark: OK"
    fi
fi

# ===== Install dependencies =====
echo ""
echo "--- Installing dependencies ---"
yarn install

# ===== Handle circuit artifacts =====
LOCAL_CIRCUITS_PATH="${LOCAL_CIRCUITS_PATH:-../circuits-v2}"
LOCAL_TGZ="$LOCAL_CIRCUITS_PATH/export/package/railgun-circuit-test-artifacts-0.0.1.tgz"
LOCAL_PKG_DIR=".local-circuits-package"

if [ "$USE_LOCAL_CIRCUITS" = "true" ]; then
    if [ ! -f "$LOCAL_TGZ" ]; then
        echo "Local tgz not found: $LOCAL_TGZ"
        echo "Run: cd $LOCAL_CIRCUITS_PATH && npm run export"
        exit 1
    fi
    echo "Linking LOCAL circuit artifacts..."
    rm -rf "$LOCAL_PKG_DIR"
    mkdir -p "$LOCAL_PKG_DIR"
    tar -xzf "$LOCAL_TGZ" -C "$LOCAL_PKG_DIR" --strip-components=1
    pushd "$LOCAL_PKG_DIR" > /dev/null
    yarn unlink 2>/dev/null || true
    yarn link
    popd > /dev/null
    yarn link railgun-circuit-test-artifacts
else
    echo "Using REMOTE circuit artifacts"
fi

# ===== Clean old benchmark artifacts =====
rm -f bench-tree.json bench-proofs.json bench-result*.out bench-result-d*.json

# ===== Deploy contracts =====
echo ""
echo "--- Deploying contracts ---"
npx hardhat deploy:test --network localhost

# ===== Generate proofs =====
echo ""
echo "--- Generating wallets, shields, and proofs ---"
npx hardhat run scripts/bench-setup.ts --network localhost

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "  Contracts deployed -> deployments.json"
echo "  Proofs generated  -> bench-proofs.json"
echo "  Tree state saved  -> bench-tree.json"
echo "  Now run: ./2-bench.sh"
echo "============================================"
