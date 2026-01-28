#!/bin/bash

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVER_SERVER_PID=""
PROVER_SERVER_CONTAINER=""

# Cleanup function - kills Hardhat node and web server on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down services..."
    echo "  - Stopping Hardhat node (port 8545)..."
    lsof -ti :8545 | xargs kill 2>/dev/null || true
    echo "  - Stopping web server (port 3000)..."
    lsof -ti :3000 | xargs kill 2>/dev/null || true
    if [ -n "$PROVER_SERVER_PID" ]; then
        echo "  - Stopping rapidsnark server (pid ${PROVER_SERVER_PID})..."
        kill $PROVER_SERVER_PID 2>/dev/null || true
    fi
    if [ -n "$PROVER_SERVER_CONTAINER" ]; then
        echo "  - Stopping rapidsnark docker container (${PROVER_SERVER_CONTAINER})..."
        docker stop "$PROVER_SERVER_CONTAINER" > /dev/null 2>&1 || true
        docker rm "$PROVER_SERVER_CONTAINER" > /dev/null 2>&1 || true
    fi
    echo "✅ All services stopped"
    exit 0
}

# Trap Ctrl+C to cleanup
trap cleanup SIGINT SIGTERM

echo "🚀 Privacy Wallet Demo - Quick Start"
echo "===================================="
echo ""

# Load .env file if it exists
if [ -f .env ]; then
    echo "📄 Loading environment variables from .env..."
    export $(grep -v '^#' .env | xargs)
    echo ""
fi

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
            echo "Rapidsnark mode: remote (not supported in run_web.sh)"
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

    local server_url="${RAPIDSNARK_SERVER_URL:-http://localhost:8080}"

    if curl -s "${server_url}/status" > /dev/null 2>&1; then
        echo "Rapidsnark server already running at ${server_url}"
        return
    fi

    echo "Rapidsnark server not running at ${server_url}"
    "${SCRIPT_DIR}/setup_rapidsnark_server.sh" launch &
    PROVER_SERVER_PID=$!

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

    local rapidsnark_bin="${RAPIDSNARK_BIN_PATH:-/usr/local/bin/rapidsnark}"
    if [ ! -x "$rapidsnark_bin" ]; then
        echo "rapidsnark not found at $rapidsnark_bin, installing..."
        "${SCRIPT_DIR}/install_rapidsnark.sh"
    else
        echo "rapidsnark already installed: $rapidsnark_bin"
    fi
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

    # zkeys are now built inside the Docker image - no host mount needed

    if ! docker image inspect "$image_name" > /dev/null 2>&1 || [ "$RAPIDSNARK_DOCKER_BUILD" = "true" ]; then
        echo "Building docker image ${image_name}..."
        docker build \
            --build-arg RAPIDSNARK_CIRCUIT="${circuit}" \
            -t "$image_name" -f "${SCRIPT_DIR}/Dockerfile.rapidsnark" "${SCRIPT_DIR}"
    fi

    if docker ps --filter "name=^/${container_name}$" --format '{{.Names}}' | grep -q "^${container_name}$"; then
        echo "Rapidsnark docker container already running: ${container_name}"
        return
    fi

    if docker ps -a --filter "name=^/${container_name}$" --format '{{.Names}}' | grep -q "^${container_name}$"; then
        docker rm "${container_name}" > /dev/null
    fi

    echo "Starting rapidsnark docker container..."
    docker run -d \
        --name "${container_name}" \
        -p "${server_port}:8080" \
        -e "RAPIDSNARK_CIRCUIT=${circuit}" \
        "${image_name}" > /dev/null
    PROVER_SERVER_CONTAINER="${container_name}"

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

# Determine mode
if [ "$LOCAL" = "true" ]; then
    echo "🏠 Mode: LOCAL (using local Hardhat network)"
    echo ""
    IS_LOCAL=true
else
    echo "🌐 Mode: ONLINE (using configured network)"
    if [ -n "$RPC_URL" ]; then
        echo "   Network: $RPC_URL"
    fi
    echo ""
    IS_LOCAL=false
fi

# Prepare environment
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"

echo "📦 Setting up Node.js..."
nvm install 22

echo "📦 Installing dependencies..."
yarn install
echo ""

# Setup rapidsnark (optional)
setup_rapidsnark

# Start Hardhat node and deploy (only in local mode)
if [ "$IS_LOCAL" = "true" ]; then
    # Start Hardhat node in background
    echo "🚂 Starting Hardhat node..."
    nohup yarn run node > node.log 2>&1 &

    # Wait for Hardhat node to start
    echo "⏳ Waiting for Hardhat node to start..."
    for i in {1..30}; do
        if nc -z localhost 8545 2>/dev/null || (echo > /dev/tcp/localhost/8545) 2>/dev/null; then
            echo "✅ Hardhat node is ready"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "❌ Hardhat node failed to start"
            exit 1
        fi
        sleep 1
    done
    echo ""

    # Deploy contracts
    echo "📝 Deploying contracts..."
    npx hardhat deploy:test --network localhost
    echo ""
else
    # Check if deployments.json exists for online mode
    if [ ! -f deployments.json ]; then
        echo "❌ Error: deployments.json not found"
        echo ""
        echo "   You need to deploy contracts first:"
        echo "   1. Configure DEPLOYER_PRIVATE_KEY, RPC_URL, CHAIN_ID in .env"
        echo "   2. Run: npm run deploy"
        echo ""
        exit 1
    fi
    echo "✅ Found deployments.json"
    echo ""
fi

# Build browser bundle
echo "🔨 Building browser bundle..."
npm run build:browser
echo ""

# Start web server
echo "🌐 Starting web server..."
echo ""
echo "===================================="
echo "✅ Demo is ready!"
echo "===================================="
echo ""
echo "  → http://localhost:3000"
if [ "$IS_LOCAL" = "true" ]; then
    echo "  → Using local Hardhat network"
else
    echo "  → Connected to: $RPC_URL"
    echo ""
    echo "⚠️  Important:"
    echo "  - Make sure MetaMask is on the correct network"
    echo "  - Transactions will cost real gas fees"
fi
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Open browser after server starts (delayed)
(sleep 2 && open http://localhost:3000) &

# Start web server with broadcast (this will block)
node ./demo-ui/server.js
