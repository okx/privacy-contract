#!/bin/bash
set -e

echo "============================================"
echo "  Privacy Transact Benchmark"
echo "============================================"

# ===== Load .env =====
[ ! -f ".env" ] && cp .env.example .env
set -a
source .env
set +a

# ===== Check prerequisites =====
if [ ! -f "deployments.json" ]; then
    echo "ERROR: deployments.json not found. Run ./1-setup.sh first."
    exit 1
fi
if [ ! -f "bench-proofs.json" ]; then
    echo "ERROR: bench-proofs.json not found. Run ./1-setup.sh first."
    exit 1
fi

# ===== Print config =====
echo ""
echo "Chain: ${LOCAL_RPC_URL:-http://127.0.0.1:8123}"
echo ""
echo "Config:"
echo "  BENCH_WALLETS=${BENCH_WALLETS:-4}"
echo "  BENCH_TOTAL_TXS=${BENCH_TOTAL_TXS:-20}"
echo "  BENCH_TXS_PER_RELAY=${BENCH_TXS_PER_RELAY:-1}"
echo "  USE_RAPIDSNARK=${USE_RAPIDSNARK:-false}"
echo ""

# ===== Clean old result files =====
rm -f bench-result*.out
echo "Old result files cleared."

# ===== Run benchmark =====
RESULT_FILE="bench-result.out"

npx hardhat run scripts/bench-submit.ts --network localhost 2>&1 | tee "$RESULT_FILE"

# Append transaction hashes to result file (not shown in console)
if [ -f ".bench-hashes.tmp" ]; then
    cat .bench-hashes.tmp >> "$RESULT_FILE"
    rm -f .bench-hashes.tmp
fi

echo ""
echo "============================================"
echo "  Benchmark Complete!"
echo "  Results: $RESULT_FILE"
echo "  Proofs: bench-proofs.json (reusable)"
echo "============================================"
