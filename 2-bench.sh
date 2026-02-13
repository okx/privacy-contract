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

# ===== Read config =====
BROADCASTER_COUNT=${BENCH_BROADCASTER_COUNT:-1}
RATE_LIMIT=${BENCH_RATE_LIMIT:-0}

# ===== Print config =====
echo ""
echo "Chain: ${LOCAL_RPC_URL:-http://127.0.0.1:8123}"
echo ""
echo "Config:"
echo "  BENCH_USERS=${BENCH_USERS:-4}"
echo "  BENCH_TOTAL_UOP=${BENCH_TOTAL_UOP:-20}"
echo "  BENCH_BATCH_COUNT=${BENCH_BATCH_COUNT:-1}"
echo "  BENCH_BROADCASTER_COUNT=${BROADCASTER_COUNT}"
echo "  BENCH_RATE_LIMIT=${RATE_LIMIT}"
echo ""

# ===== Clean old result files =====
rm -f bench-result*.out bench-result-d*.json .bench-hashes.tmp
echo "Old result files cleared."

# ===== Run benchmark =====
RESULT_FILE="bench-result.out"

# ===== Launch broadcaster(s) =====
echo ""
echo "--- Benchmark: ${BROADCASTER_COUNT} broadcaster(s) ---"
echo ""

# Create barrier directory
BARRIER_DIR=".bench-barrier-$$"
mkdir -p "$BARRIER_DIR"

PIDS=()
RESULT_FILES=()

# Launch broadcaster processes
for i in $(seq 0 $((BROADCASTER_COUNT - 1))); do
    D_RESULT="bench-result_d${i}.out"
    RESULT_FILES+=("$D_RESULT")

    BENCH_BROADCASTER_INDEX=$i \
    BENCH_BROADCASTER_COUNT=$BROADCASTER_COUNT \
    BENCH_RATE_LIMIT=${RATE_LIMIT} \
    BARRIER_DIR=$BARRIER_DIR \
    npx hardhat run scripts/bench-submit.ts --network localhost > "$D_RESULT" 2>&1 &

    PIDS+=($!)
    echo "  Launched broadcaster $i (PID: $!) -> $D_RESULT"
done

echo ""
echo "Waiting for all broadcasters to be ready..."

# Wait for all ready signals (max 5 minutes)
READY_TIMEOUT=300
READY_COUNT=0
for t in $(seq 1 $READY_TIMEOUT); do
    READY_COUNT=0
    for i in $(seq 0 $((BROADCASTER_COUNT - 1))); do
        if [ -f "$BARRIER_DIR/ready_d${i}" ]; then
            READY_COUNT=$((READY_COUNT + 1))
        fi
    done
    if [ "$READY_COUNT" -eq "$BROADCASTER_COUNT" ]; then
        break
    fi
    sleep 1
done

if [ "$READY_COUNT" -ne "$BROADCASTER_COUNT" ]; then
    echo "ERROR: Only $READY_COUNT/$BROADCASTER_COUNT broadcasters ready after timeout."
    echo "Killing all processes..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    rm -rf "$BARRIER_DIR"
    exit 1
fi

echo "All $BROADCASTER_COUNT broadcaster(s) ready. Sending go signal!"
touch "$BARRIER_DIR/go"

# Wait for all processes to finish
echo ""
echo "Waiting for all broadcasters to complete..."
ALL_OK=true
for i in "${!PIDS[@]}"; do
    if ! wait "${PIDS[$i]}"; then
        echo "  ERROR: Broadcaster $i (PID: ${PIDS[$i]}) failed!"
        ALL_OK=false
    else
        echo "  Broadcaster $i complete."
    fi
done

# Clean up barrier directory
rm -rf "$BARRIER_DIR"

if [ "$ALL_OK" != "true" ]; then
    echo ""
    echo "Some broadcasters failed. Check individual log files:"
    for f in "${RESULT_FILES[@]}"; do
        echo "  $f"
    done
    exit 1
fi

# Show per-process logs
echo ""
echo "--- Per-process logs ---"
for i in $(seq 0 $((BROADCASTER_COUNT - 1))); do
    echo ""
    echo "=== Broadcaster $i ==="
    cat "bench-result_d${i}.out"
done

# Run aggregation report
echo ""
echo "--- Aggregating results ---"
echo ""

BENCH_BROADCASTER_COUNT=$BROADCASTER_COUNT \
npx hardhat run scripts/bench-report.ts --network localhost 2>&1 | tee "$RESULT_FILE"

# Append transaction hashes to result file (not shown in console)
if [ -f ".bench-hashes.tmp" ]; then
    cat .bench-hashes.tmp >> "$RESULT_FILE"
    rm -f .bench-hashes.tmp
fi

# Append per-process logs to result file
for i in $(seq 0 $((BROADCASTER_COUNT - 1))); do
    echo "" >> "$RESULT_FILE"
    echo "=== Broadcaster $i Log ===" >> "$RESULT_FILE"
    cat "bench-result_d${i}.out" >> "$RESULT_FILE"
done

echo ""
echo "============================================"
echo "  Benchmark Complete!"
echo "  Results: $RESULT_FILE"
echo "  Proofs: bench-proofs.json (reusable)"
echo "============================================"
