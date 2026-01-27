#!/bin/bash
#
# Build a single circuit for circuits-v2 project
# Compiles a specific circuit and generates its zkey
#
# Usage: ./build_circuit.sh [circuit_name]
# Example: ./build_circuit.sh 02x03
#
# Environment variables:
#   USE_LOCAL_CIRCOM - Set to "true" to use ./bin/circom, otherwise uses system circom
#   LOCAL_CIRCUITS_PATH - Path to circuits-v2 directory (required)
#

set -e

CIRCUIT_NAME="${1:-02x03}"

# Parse circuit name to get nullifiers and commitments
NULLIFIERS="${CIRCUIT_NAME%x*}"
COMMITMENTS="${CIRCUIT_NAME#*x}"

# Remove leading zeros for arithmetic
NULLIFIERS=$((10#$NULLIFIERS))
COMMITMENTS=$((10#$COMMITMENTS))

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check LOCAL_CIRCUITS_PATH is set
if [ -z "$LOCAL_CIRCUITS_PATH" ]; then
    log_error "LOCAL_CIRCUITS_PATH is not set. Please set it in your .env file."
    exit 1
fi

if [ ! -d "$LOCAL_CIRCUITS_PATH" ]; then
    log_error "LOCAL_CIRCUITS_PATH does not exist: $LOCAL_CIRCUITS_PATH"
    exit 1
fi

cd "$LOCAL_CIRCUITS_PATH"

# Configure circom path based on USE_LOCAL_CIRCOM
if [ "$USE_LOCAL_CIRCOM" = "true" ]; then
    if [ -x "./bin/circom" ]; then
        CIRCOM_BIN="./bin/circom"
        log_info "Using local circom: $CIRCOM_BIN"
    else
        log_warn "./bin/circom not found, falling back to system circom"
        CIRCOM_BIN="circom"
    fi
else
    CIRCOM_BIN="circom"
    log_info "Using system circom"
fi

# Verify circom is available
if ! command -v "$CIRCOM_BIN" &> /dev/null && [ ! -x "$CIRCOM_BIN" ]; then
    log_error "circom not found. Install via 'cargo install circom' or set USE_LOCAL_CIRCOM=true"
    exit 1
fi

log_info "Building circuit: ${CIRCUIT_NAME} (${NULLIFIERS} nullifiers, ${COMMITMENTS} commitments)"

# Create directories
mkdir -p src/generated
mkdir -p build
mkdir -p zkeys
mkdir -p bin

# Step 1: Generate the circuit file
log_info "Generating ${CIRCUIT_NAME}.circom..."
cat > "src/generated/${CIRCUIT_NAME}.circom" << EOF
pragma circom 2.0.6;
include "../library/joinsplit.circom";

component main{public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = JoinSplit(${NULLIFIERS}, ${COMMITMENTS}, 16);
EOF

# Step 2: Compile with circom
log_info "Compiling circuit with circom..."
"$CIRCOM_BIN" "src/generated/${CIRCUIT_NAME}.circom" --r1cs --wasm --sym -o build

# Show circuit info
log_info "Circuit constraint info:"
npx snarkjs r1cs info "build/${CIRCUIT_NAME}.r1cs"

# Step 3: Download powers of tau if not exists
POT_FILE="bin/pot.ptau"
if [ ! -f "$POT_FILE" ]; then
    log_info "Downloading powers of tau (this may take a while)..."
    curl -L -o "$POT_FILE" https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau
else
    log_info "Powers of tau already exists: $POT_FILE"
fi

# Step 4: Generate zkey
log_info "Generating zkey (this may take a moment)..."
npx snarkjs groth16 setup "build/${CIRCUIT_NAME}.r1cs" "$POT_FILE" "zkeys/${CIRCUIT_NAME}.zkey"

# Step 5: Export verification key
log_info "Exporting verification key..."
npx snarkjs zkey export verificationkey "zkeys/${CIRCUIT_NAME}.zkey" "zkeys/${CIRCUIT_NAME}.vkey.json"

log_info "Circuit build complete!"
log_info "Output files:"
log_info "  - ${LOCAL_CIRCUITS_PATH}/build/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
log_info "  - ${LOCAL_CIRCUITS_PATH}/build/${CIRCUIT_NAME}.r1cs"
log_info "  - ${LOCAL_CIRCUITS_PATH}/zkeys/${CIRCUIT_NAME}.zkey"
log_info "  - ${LOCAL_CIRCUITS_PATH}/zkeys/${CIRCUIT_NAME}.vkey.json"
