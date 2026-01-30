#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVER_SERVER_PID=""
PROVER_SERVER_CONTAINER=""

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
        docker)
            setup_rapidsnark_docker
            ;;
        remote)
            setup_rapidsnark_remote
            ;;
        local|"")
            setup_rapidsnark_local
            ;;
        *)
            echo "Unknown RAPIDSNARK_MODE: $RAPIDSNARK_MODE (expected: server, docker, remote, or local)"
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

    RAPIDSNARK_DIR="${RAPIDSNARK_DIR:-${SCRIPT_DIR}/tmp/rapidsnark}"

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

# Setup rapidsnark in docker mode
setup_rapidsnark_docker() {
    echo "Rapidsnark mode: docker"

    if ! command -v docker > /dev/null 2>&1; then
        echo "docker not found. Please install Docker and ensure it is running."
        exit 1
    fi

    local server_port="${RAPIDSNARK_DOCKER_PORT:-8080}"
    local server_url="${RAPIDSNARK_SERVER_URL:-http://localhost:${server_port}}"
    local image_name="${RAPIDSNARK_DOCKER_IMAGE:-rapidsnark-prover:local}"
    local container_name="${RAPIDSNARK_DOCKER_CONTAINER:-rapidsnark-prover}"
    local circuit="${RAPIDSNARK_CIRCUIT:-02x03}"

    local zkey_dir=""
    if [ -n "$RAPIDSNARK_DOCKER_ZKEY_DIR" ] && [ -d "$RAPIDSNARK_DOCKER_ZKEY_DIR" ]; then
        zkey_dir="$RAPIDSNARK_DOCKER_ZKEY_DIR"
    elif [ -n "$LOCAL_CIRCUITS_PATH" ] && [ -d "${LOCAL_CIRCUITS_PATH}/zkeys" ]; then
        zkey_dir="${LOCAL_CIRCUITS_PATH}/zkeys"
    elif [ -n "$RAPIDSNARK_DIR" ] && [ -d "${RAPIDSNARK_DIR}/zkeys" ]; then
        zkey_dir="${RAPIDSNARK_DIR}/zkeys"
    fi

    if [ -z "$zkey_dir" ]; then
        echo "zkey directory not found. Set RAPIDSNARK_DOCKER_ZKEY_DIR or LOCAL_CIRCUITS_PATH."
        exit 1
    fi

    if [ ! -f "${zkey_dir}/${circuit}.zkey" ]; then
        echo "zkey not found at ${zkey_dir}/${circuit}.zkey"
        exit 1
    fi

    # Build image if missing or explicitly requested
    if ! docker image inspect "$image_name" > /dev/null 2>&1 || [ "$RAPIDSNARK_DOCKER_BUILD" = "true" ]; then
        echo "Building docker image ${image_name}..."
        docker build -t "$image_name" -f "${SCRIPT_DIR}/Dockerfile.rapidsnark" "${SCRIPT_DIR}"
    fi

    # If container already running, reuse it
    if docker ps --filter "name=^/${container_name}$" --format '{{.Names}}' | grep -q "^${container_name}$"; then
        echo "Rapidsnark docker container already running: ${container_name}"
        return
    fi

    # Remove stopped container if exists
    if docker ps -a --filter "name=^/${container_name}$" --format '{{.Names}}' | grep -q "^${container_name}$"; then
        docker rm "${container_name}" > /dev/null
    fi

    echo "Starting rapidsnark docker container..."
    docker run -d \
        --name "${container_name}" \
        -p "${server_port}:8080" \
        -e "RAPIDSNARK_CIRCUIT=${circuit}" \
        -v "${zkey_dir}:/data/zkeys:ro" \
        "${image_name}" > /dev/null
    PROVER_SERVER_CONTAINER="${container_name}"

    # Wait for server to be ready
    echo "Waiting for server to start..."
    for i in {1..30}; do
        if curl -s "${server_url}/status" > /dev/null 2>&1; then
            echo "Rapidsnark server ready at ${server_url}"
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

# Setup rapidsnark in remote mode (download pre-built binary to local directory)
setup_rapidsnark_remote() {
    echo "Rapidsnark mode: remote (download pre-built binary)"

    local VERSION="${RAPIDSNARK_REMOTE_VERSION:-v0.0.8}"
    local RAPIDSNARK_BIN="${RAPIDSNARK_BIN_PATH:-/usr/local/bin/rapidsnark}"
    local INSTALL_DIR=$(dirname "$RAPIDSNARK_BIN")

    # Check if already downloaded
    if [ -x "$RAPIDSNARK_BIN" ]; then
        echo "rapidsnark already downloaded: $RAPIDSNARK_BIN"
        return
    fi

    echo "Downloading rapidsnark ${VERSION}..."

    # Detect architecture and OS
    local ARCH=$(uname -m)
    local OS=$(uname -s)
    local DOWNLOAD_URL=""
    local ZIP_NAME=""

    echo "Architecture: $ARCH, OS: $OS"

    if [[ "$OS" == "Darwin" ]]; then
        if [[ "$ARCH" == "arm64" ]]; then
            DOWNLOAD_URL="https://github.com/iden3/rapidsnark/releases/download/${VERSION}/rapidsnark-macOS-arm64-${VERSION}.zip"
            ZIP_NAME="rapidsnark-macOS-arm64-${VERSION}.zip"
        else
            DOWNLOAD_URL="https://github.com/iden3/rapidsnark/releases/download/${VERSION}/rapidsnark-macOS-x86_64-${VERSION}.zip"
            ZIP_NAME="rapidsnark-macOS-x86_64-${VERSION}.zip"
        fi
    elif [[ "$OS" == "Linux" ]]; then
        if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
            DOWNLOAD_URL="https://github.com/iden3/rapidsnark/releases/download/${VERSION}/rapidsnark-linux-arm64-${VERSION}.zip"
            ZIP_NAME="rapidsnark-linux-arm64-${VERSION}.zip"
        else
            DOWNLOAD_URL="https://github.com/iden3/rapidsnark/releases/download/${VERSION}/rapidsnark-linux-x86_64-${VERSION}.zip"
            ZIP_NAME="rapidsnark-linux-x86_64-${VERSION}.zip"
        fi
    else
        echo "Unsupported OS: $OS"
        exit 1
    fi

    echo "Download URL: $DOWNLOAD_URL"

    # Download to temp directory
    local TMP_DIR=$(mktemp -d)

    echo "Downloading to temp directory..."
    curl -L -o "${TMP_DIR}/${ZIP_NAME}" "$DOWNLOAD_URL"

    echo "Extracting..."
    unzip -q "${TMP_DIR}/${ZIP_NAME}" -d "$TMP_DIR"

    # Find the prover binary
    local PROVER_BIN=$(find "$TMP_DIR" -name "prover" -type f | head -1)
    if [ -z "$PROVER_BIN" ]; then
        echo "prover binary not found in archive"
        rm -rf "$TMP_DIR"
        exit 1
    fi

    # Install to target directory
    echo "Installing to $RAPIDSNARK_BIN..."
    if [ -w "$INSTALL_DIR" ]; then
        cp "$PROVER_BIN" "$RAPIDSNARK_BIN"
        chmod +x "$RAPIDSNARK_BIN"
    else
        echo "(requires sudo)"
        sudo cp "$PROVER_BIN" "$RAPIDSNARK_BIN"
        sudo chmod +x "$RAPIDSNARK_BIN"
    fi

    # Cleanup
    rm -rf "$TMP_DIR"

    if [ -x "$RAPIDSNARK_BIN" ]; then
        echo "rapidsnark downloaded successfully to $RAPIDSNARK_BIN"
    else
        echo "Download failed"
        exit 1
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
    elif [ -n "$RAPIDSNARK_DIR" ] && [ -d "$RAPIDSNARK_DIR" ]; then
        echo "Using local circuits from ${RAPIDSNARK_DIR}"
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
    if [ -n "$PROVER_SERVER_CONTAINER" ]; then
        docker stop "$PROVER_SERVER_CONTAINER" > /dev/null 2>&1 || true
        docker rm "$PROVER_SERVER_CONTAINER" > /dev/null 2>&1 || true
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
