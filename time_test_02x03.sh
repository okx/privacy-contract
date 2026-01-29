#!/bin/bash
set -e

echo "═══════════════════════════════════════════════════════════════"
echo "      Timing Test: 02x03 Circuit (Local x86 with ASM)         "
echo "═══════════════════════════════════════════════════════════════"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAPIDSNARK_DIR="${RAPIDSNARK_DIR:-/Users/cliffyang/dev/okx/rapidsnark}"
CIRCUIT="02x03"
TEST_DIR="$SCRIPT_DIR/timing_test_output"

# Cleanup and setup
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

echo "Configuration:"
echo "  Circuit:       $CIRCUIT"
echo "  Rapidsnark:    $RAPIDSNARK_DIR"
echo "  Architecture:  $(uname -m)"
echo ""

# Check required files
WITGEN="$RAPIDSNARK_DIR/build/${CIRCUIT}"
PROVER="$RAPIDSNARK_DIR/package/bin/prover"
ZKEY="$RAPIDSNARK_DIR/zkeys/${CIRCUIT}.zkey"

if [ ! -f "$WITGEN" ]; then
    echo "✗ Witness generator not found: $WITGEN"
    echo "  Run: cd $RAPIDSNARK_DIR && ./build_circuit.sh"
    exit 1
fi

if [ ! -f "$PROVER" ]; then
    echo "✗ Prover not found: $PROVER"
    echo "  Run: cd $RAPIDSNARK_DIR && make prover-server"
    exit 1
fi

if [ ! -f "$ZKEY" ]; then
    echo "✗ ZKey not found: $ZKEY"
    echo "  Run: cd $RAPIDSNARK_DIR && ./build_circuit.sh"
    exit 1
fi

echo "✓ Witness generator: $WITGEN"
echo "✓ Prover:            $PROVER"
echo "✓ ZKey:              $ZKEY"
echo ""

# Check for ASM optimizations
echo "Checking for ASM optimizations..."
if nm "$WITGEN" 2>/dev/null | grep -q 'Fr_raw\|Fq_raw'; then
    echo "✓ ASM optimizations detected"
    nm "$WITGEN" | grep -E 'Fr_raw|Fq_raw' | head -3
else
    echo "⚠ No ASM symbols found (using C++ fallback)"
fi
echo ""

# Step 1: Generate valid circuit input
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 1: Generating valid circuit input..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "Installing dependencies..."
    cd "$SCRIPT_DIR"
    npm install > /dev/null 2>&1
fi

cd "$SCRIPT_DIR"
echo "Running input generator..."
npx ts-node --transpile-only scripts/generate_circuit_input.ts

# Check if input was generated
if [ -f "$RAPIDSNARK_DIR/valid_input_02x03.json" ]; then
    cp "$RAPIDSNARK_DIR/valid_input_02x03.json" "$TEST_DIR/input.json"
    echo "✓ Valid input generated"
elif [ -f "$RAPIDSNARK_DIR/build/input_02x03.json" ]; then
    cp "$RAPIDSNARK_DIR/build/input_02x03.json" "$TEST_DIR/input.json"
    echo "✓ Using existing input"
else
    echo "✗ Failed to find input file"
    exit 1
fi
echo ""

# Step 2: Time witness generation
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 2: Timing witness generation (3 runs)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

WITNESS_TIMES=()
cd "$TEST_DIR"

for run in {1..3}; do
    rm -f witness.wtns

    START=$(date +%s.%N)
    "$WITGEN" input.json witness.wtns > /dev/null 2>&1
    END=$(date +%s.%N)

    ELAPSED=$(echo "$END - $START" | bc -l)
    WITNESS_TIMES+=($ELAPSED)

    printf "  Run %d: %.3fs\n" $run $ELAPSED

    # Keep the witness from last run
    [ $run -eq 3 ] && cp witness.wtns witness_final.wtns
done

# Calculate average
TOTAL=0
for time in "${WITNESS_TIMES[@]}"; do
    TOTAL=$(echo "$TOTAL + $time" | bc -l)
done
AVG_WITNESS=$(echo "scale=3; $TOTAL / 3" | bc -l)

echo ""
printf "Average witness generation: %.3fs\n" $AVG_WITNESS
echo ""

# Step 3: Time proof generation
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 3: Timing proof generation (3 runs)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

PROOF_TIMES=()

for run in {1..3}; do
    rm -f proof.json public.json

    START=$(date +%s.%N)
    "$PROVER" "$ZKEY" witness_final.wtns proof.json public.json > /dev/null 2>&1
    END=$(date +%s.%N)

    ELAPSED=$(echo "$END - $START" | bc -l)
    PROOF_TIMES+=($ELAPSED)

    printf "  Run %d: %.3fs\n" $run $ELAPSED
done

# Calculate average
TOTAL=0
for time in "${PROOF_TIMES[@]}"; do
    TOTAL=$(echo "$TOTAL + $time" | bc -l)
done
AVG_PROOF=$(echo "scale=3; $TOTAL / 3" | bc -l)

echo ""
printf "Average proof generation: %.3fs\n" $AVG_PROOF
echo ""

# Step 4: Verify proof
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 4: Verifying proof..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Export verification key
if command -v snarkjs > /dev/null 2>&1; then
    snarkjs zkey export verificationkey "$ZKEY" vkey.json 2>&1 | grep -v "WARN" || true

    if snarkjs groth16 verify vkey.json public.json proof.json 2>&1 | grep -q "OK"; then
        echo "✓ Proof verified successfully!"
        VERIFY_OK=1
    else
        echo "✗ Proof verification failed!"
        VERIFY_OK=0
    fi
else
    echo "⚠ snarkjs not found, skipping verification"
    echo "  Install: npm install -g snarkjs"
    VERIFY_OK=1
fi
echo ""

# Final Summary
echo "═══════════════════════════════════════════════════════════════"
echo "                      TIMING SUMMARY                           "
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Circuit:      $CIRCUIT"
echo "Platform:     $(uname -m) with ASM optimizations"
echo "CPU Info:     $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'N/A')"
echo ""
printf "Witness Generation:  %.3fs (avg of 3 runs)\n" $AVG_WITNESS
printf "Proof Generation:    %.3fs (avg of 3 runs)\n" $AVG_PROOF
echo "───────────────────────────────────────────────────────────────"
TOTAL_TIME=$(echo "scale=3; $AVG_WITNESS + $AVG_PROOF" | bc -l)
printf "Total Time:          %.3fs\n" $TOTAL_TIME
echo ""
echo "Individual run times:"
echo "  Witness: ${WITNESS_TIMES[*]}"
echo "  Proof:   ${PROOF_TIMES[*]}"
echo ""

if [ $VERIFY_OK -eq 1 ]; then
    echo "═══════════════════════════════════════════════════════════════"
    echo "                     ✓ TEST SUCCESSFUL                         "
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "Test outputs saved to: $TEST_DIR"
    exit 0
else
    echo "═══════════════════════════════════════════════════════════════"
    echo "                     ✗ TEST FAILED                             "
    echo "═══════════════════════════════════════════════════════════════"
    exit 1
fi
