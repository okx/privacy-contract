#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVER_SERVER_PID=""

# Copy .env.demo to .env if .env does not exist
[ ! -f ".env" ] && cp .env.example .env
# Export all variables from .env
set -a
source .env
set +a

# Setup rapidsnark based on mode
setup_rapidsnark() {
    if [ "$USE_RAPIDSNARK" != "true" ]; then
        echo "Rapidsnark disabled (USE_RAPIDSNARK != true)"
        return
    fi

    case "$RAPIDSNARK_MODE" in
        server)
            setup_rapidsnark_server
            ;;
        local|"")
            setup_rapidsnark_local
            ;;
        *)
            echo "Unknown RAPIDSNARK_MODE: $RAPIDSNARK_MODE (expected: server or local)"
            exit 1
            ;;
    esac
}

# Setup rapidsnark in server mode
setup_rapidsnark_server() {
    echo "Rapidsnark mode: server"

    # Extract host and port from RAPIDSNARK_SERVER_URL
    SERVER_URL="${RAPIDSNARK_SERVER_URL:-http://localhost:8080}"

    # Check if server is already running
    if curl -s "${SERVER_URL}/status" > /dev/null 2>&1; then
        echo "Rapidsnark server already running at ${SERVER_URL}"
        return
    fi

    echo "Rapidsnark server not running at ${SERVER_URL}"

    RAPIDSNARK_DIR="${SCRIPT_DIR}/tmp/rapidsnark"

    # Check if rapidsnark repo exists
    if [ ! -d "$RAPIDSNARK_DIR" ]; then
        echo "rapidsnark not found at $RAPIDSNARK_DIR. Running setup..."
        "${SCRIPT_DIR}/setup_rapidsnark_server.sh" setup
    fi

    # Check if proverServer is installed
    if [ ! -x "/usr/local/bin/proverServer" ]; then
        echo "proverServer not installed. Running build..."
        "${SCRIPT_DIR}/setup_rapidsnark_server.sh" build
    fi

    # Check if zkey exists
    ZKEY_FILE="${RAPIDSNARK_DIR}/zkeys/${RAPIDSNARK_CIRCUIT:-02x03}.zkey"
    if [ ! -f "$ZKEY_FILE" ]; then
        echo "zkey not found at $ZKEY_FILE. Running build..."
        "${SCRIPT_DIR}/setup_rapidsnark_server.sh" build
    fi

    # Start server in background
    echo "Starting rapidsnark server in background..."
    "${SCRIPT_DIR}/setup_rapidsnark_server.sh" launch &
    PROVER_SERVER_PID=$!

    # Wait for server to be ready
    echo "Waiting for server to start..."
    for i in {1..30}; do
        if curl -s "${SERVER_URL}/status" > /dev/null 2>&1; then
            echo "Rapidsnark server ready at ${SERVER_URL}"
            return
        fi
        sleep 1
    done

    echo "Warning: Server may not be ready yet, continuing anyway..."
}

# Setup rapidsnark in local/standalone mode
setup_rapidsnark_local() {
    echo "Rapidsnark mode: local (standalone)"

    # Use RAPIDSNARK_BIN_PATH from env, default to /usr/local/bin/rapidsnark
    local rapidsnark_bin="${RAPIDSNARK_BIN_PATH:-/usr/local/bin/rapidsnark}"

    if [ ! -x "$rapidsnark_bin" ]; then
        echo "rapidsnark not found at $rapidsnark_bin, installing..."
        ./install_rapidsnark.sh
    else
        echo "rapidsnark already installed: $rapidsnark_bin"
    fi
}

# Setup rapidsnark
setup_rapidsnark

# Build local circuits if enabled
if [ "$USE_LOCAL_CIRCUITS" = "true" ]; then
    if [ -n "$LOCAL_CIRCUITS_PATH" ] && [ -d "$LOCAL_CIRCUITS_PATH" ]; then
        pushd "$LOCAL_CIRCUITS_PATH" > /dev/null
        npm install
        "${SCRIPT_DIR}/build_circuit.sh"
        popd > /dev/null
    elif [ -d "${SCRIPT_DIR}/tmp/rapidsnark" ]; then
        echo "Using local circuits from ${SCRIPT_DIR}/tmp/rapidsnark"
    fi
fi

yarn install

#1. start hardhat node (local ethereum node)
# Kill any existing process on port 8645
lsof -ti :8645 | xargs kill 2>/dev/null || true
npx hardhat node --port 8645 > hardhat-node.log 2>&1 &
HARDHAT_PID=$!

# Auto cleanup when script exits
cleanup() {
    kill $HARDHAT_PID 2>/dev/null || true
    if [ -n "$PROVER_SERVER_PID" ]; then
        kill $PROVER_SERVER_PID 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for hardhat node to be ready
echo "Waiting for Hardhat node to start..."
for i in {1..30}; do
    if curl -s -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       http://127.0.0.1:8645 > /dev/null 2>&1; then
        echo "Hardhat node ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Error: Hardhat node failed to start after 30 seconds"
        echo "Check hardhat-node.log for details"
        exit 1
    fi
    sleep 1
done

#2. deploy railgun contracts
npx hardhat deploy:test --network localhost

#3. run a railgun demo
npx hardhat run scripts/demo.ts --network localhost
