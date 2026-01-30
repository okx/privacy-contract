#!/bin/bash
#
# Setup script for rapidsnark prover server
# This script clones, builds, and sets up the rapidsnark server for proof generation
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env file first (before setting defaults)
if [ -f "${SCRIPT_DIR}/.env" ]; then
    export $(grep -v '^#' "${SCRIPT_DIR}/.env" | xargs)
fi

# Use RAPIDSNARK_DIR from .env, or default to tmp/rapidsnark
RAPIDSNARK_DIR="${RAPIDSNARK_DIR:-${SCRIPT_DIR}/tmp/rapidsnark}"
RAPIDSNARK_REPO="https://github.com/okx/rapidsnark.git"
RAPIDSNARK_BRANCH="cliff/dev/railgun_circuit"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============ Dependency Checks ============
check_dependencies() {
    log_info "Checking dependencies..."

    local missing_deps=()

    # Check brew (macOS)
    if [[ "$(uname)" == "Darwin" ]]; then
        if ! command -v brew &> /dev/null; then
            log_error "Homebrew is required. Install from https://brew.sh"
            exit 1
        fi
    fi

    # Check git
    if ! command -v git &> /dev/null; then
        missing_deps+=("git")
    fi

    # Check cmake
    if ! command -v cmake &> /dev/null; then
        missing_deps+=("cmake")
    fi

    # Check node/npm
    if ! command -v node &> /dev/null; then
        missing_deps+=("node")
    fi

    if ! command -v npm &> /dev/null; then
        missing_deps+=("npm")
    fi

    # Check circom (use CIRCOM_BIN_PATH from .env)
    if [ -n "$CIRCOM_BIN_PATH" ] && [ -f "$CIRCOM_BIN_PATH" ]; then
        log_info "Using circom from CIRCOM_BIN_PATH: $CIRCOM_BIN_PATH"
    elif command -v circom &> /dev/null; then
        log_info "Using circom from PATH: $(which circom)"
    else
        log_error "circom not found. Set CIRCOM_BIN_PATH in .env or install circom to PATH."
        exit 1
    fi

    # Check platform-specific dependencies
    if [[ "$(uname)" == "Darwin" ]]; then
        # macOS dependencies
        if ! brew list gmp &> /dev/null; then
            missing_deps+=("gmp")
        fi
        if ! brew list libomp &> /dev/null; then
            missing_deps+=("libomp")
        fi
        if ! brew list nasm &> /dev/null; then
            missing_deps+=("nasm")
        fi
        if ! brew list libevent &> /dev/null; then
            missing_deps+=("libevent")
        fi

        if [ ${#missing_deps[@]} -ne 0 ]; then
            log_warn "Missing dependencies: ${missing_deps[*]}"
            log_info "Installing missing dependencies via brew..."
            brew install "${missing_deps[@]}"
        fi
    else
        # Linux dependencies
        log_info "Please ensure these packages are installed:"
        log_info "  sudo apt-get install build-essential cmake libgmp-dev libsodium-dev nasm curl m4"
    fi

    log_info "All dependencies satisfied!"
}

# ============ Clone Repository ============
clone_repo() {
    if [ -d "$RAPIDSNARK_DIR" ]; then
        log_warn "rapidsnark directory already exists at $RAPIDSNARK_DIR"
        read -p "Delete and re-clone? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$RAPIDSNARK_DIR"
        else
            log_info "Using existing directory"
            cd "$RAPIDSNARK_DIR"
            git fetch origin
            git checkout "$RAPIDSNARK_BRANCH"
            git pull origin "$RAPIDSNARK_BRANCH"
            return
        fi
    fi

    log_info "Cloning rapidsnark repository..."
    git clone -b "$RAPIDSNARK_BRANCH" "$RAPIDSNARK_REPO" "$RAPIDSNARK_DIR"
    cd "$RAPIDSNARK_DIR"

    log_info "Initializing submodules..."
    git submodule update --init
}

# ============ Build Pistache ============
build_pistache() {
    log_info "Building pistache library..."
    cd "$RAPIDSNARK_DIR"

    ./build_pistache.sh
}

# ============ Build Prover Server ============
build_prover_server() {
    log_info "Building prover server..."
    cd "$RAPIDSNARK_DIR"

    if [ -f "/usr/local/bin/proverServer" ]; then
        log_warn "proverServer already installed at /usr/local/bin/proverServer"
        read -p "Rebuild? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            return
        fi
    fi

    make prover-server

    log_info "Installing proverServer to /usr/local/bin..."
    sudo cp "${RAPIDSNARK_DIR}/package/bin/proverServer" /usr/local/bin/

    log_info "Prover server installed at /usr/local/bin/proverServer"
}

# ============ Build Circuit ============
build_circuit() {
    log_info "Building circuit (witness generator)..."
    cd "$RAPIDSNARK_DIR"

    # Install npm dependencies (needed for snarkjs in witness generator)
    log_info "Installing npm dependencies..."
    npm install

    # Call rapidsnark's build_circuit.sh (uses LOCAL_CIRCUITS_PATH and CIRCOM_BIN_PATH from env)
    ./build_circuit.sh
}

# ============ Setup ZKey ============
setup_zkey() {
    log_info "Setting up zkey..."

    # Verify LOCAL_CIRCUITS_PATH is set
    if [ -z "$LOCAL_CIRCUITS_PATH" ]; then
        log_error "LOCAL_CIRCUITS_PATH is not set. Please set it in .env file."
        exit 1
    fi

    if [ ! -d "$LOCAL_CIRCUITS_PATH" ]; then
        log_error "LOCAL_CIRCUITS_PATH does not exist: $LOCAL_CIRCUITS_PATH"
        exit 1
    fi

    # Link zkey from LOCAL_CIRCUITS_PATH
    log_info "Linking zkey from $LOCAL_CIRCUITS_PATH..."
    mkdir -p "${RAPIDSNARK_DIR}/zkeys"

    if [ -f "${LOCAL_CIRCUITS_PATH}/zkeys/02x03.zkey" ]; then
        ln -sf "${LOCAL_CIRCUITS_PATH}/zkeys/02x03.zkey" "${RAPIDSNARK_DIR}/zkeys/02x03.zkey"
        log_info "Linked 02x03.zkey"
    else
        log_error "zkey not found at ${LOCAL_CIRCUITS_PATH}/zkeys/02x03.zkey"
        exit 1
    fi

    if [ -f "${LOCAL_CIRCUITS_PATH}/zkeys/02x03.vkey.json" ]; then
        ln -sf "${LOCAL_CIRCUITS_PATH}/zkeys/02x03.vkey.json" "${RAPIDSNARK_DIR}/zkeys/02x03.vkey.json"
        log_info "Linked 02x03.vkey.json"
    fi

    log_info "zkey setup complete!"
}

# ============ Launch Server ============
launch_server() {
    log_info "Launching prover server..."
    cd "$RAPIDSNARK_DIR"

    if [ ! -f "/usr/local/bin/proverServer" ]; then
        log_error "proverServer not found at /usr/local/bin/proverServer"
        log_error "Please run build first: $0 build"
        exit 1
    fi

    if [ ! -f "zkeys/02x03.zkey" ]; then
        log_error "zkey not found at $RAPIDSNARK_DIR/zkeys/02x03.zkey"
        log_error "Please run build first: $0 build"
        exit 1
    fi

    # Set library path for dynamic libraries
    if [[ "$(uname)" == "Darwin" ]] && [[ "$(uname -m)" == "arm64" ]]; then
        export DYLD_LIBRARY_PATH="${RAPIDSNARK_DIR}/build_prover_server_macos_arm64/src:${DYLD_LIBRARY_PATH}"
    elif [[ "$(uname)" == "Darwin" ]]; then
        export DYLD_LIBRARY_PATH="${RAPIDSNARK_DIR}/build_prover_server_macos_x86_64/src:${DYLD_LIBRARY_PATH}"
    else
        export LD_LIBRARY_PATH="${RAPIDSNARK_DIR}/build_prover_server_linux_x86_64/src:${LD_LIBRARY_PATH}"
    fi

    log_info "Starting proverServer on port 8080..."
    log_info "Press Ctrl+C to stop"
    echo ""
    /usr/local/bin/proverServer 8080 zkeys/02x03.zkey
}

# ============ Print Usage ============
print_usage() {
    echo ""
    echo "=========================================="
    echo -e "${GREEN}Rapidsnark Server Setup Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "To start the prover server:"
    echo ""
    echo "  $0 launch"
    echo ""
    echo "Or manually:"
    echo ""
    echo "  cd $RAPIDSNARK_DIR"
    echo "  /usr/local/bin/proverServer 8080 zkeys/02x03.zkey"
    echo ""
    echo "Configure privacy-contract .env:"
    echo ""
    echo "  USE_RAPIDSNARK=true"
    echo "  RAPIDSNARK_MODE=server"
    echo "  RAPIDSNARK_SERVER_URL=http://localhost:8080"
    echo "  RAPIDSNARK_CIRCUIT=02x03"
    echo "  USE_LOCAL_CIRCUITS=true"
    echo "  LOCAL_CIRCUITS_PATH=$LOCAL_CIRCUITS_PATH"
    echo ""
    echo "Then redeploy contracts and run demo:"
    echo ""
    echo "  npx hardhat deploy:test --network localhost"
    echo "  npx hardhat run scripts/demo.ts --network localhost"
    echo ""
}

# ============ Print Help ============
print_help() {
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  setup     Run full setup (clone, build, configure)"
    echo "  launch    Launch the prover server"
    echo "  build     Build only (pistache, prover server, witness generator, link zkey)"
    echo "  help      Show this help message"
    echo ""
    echo "If no command is given, 'build' is run by default."
}

# ============ Main ============
main() {
    local cmd="${1:-build}"

    case "$cmd" in
        setup)
            echo "=========================================="
            echo "Rapidsnark Server Setup"
            echo "=========================================="
            echo ""
            check_dependencies
            clone_repo
            ;;
        build)
            echo "=========================================="
            echo "Rapidsnark Server Build"
            echo "=========================================="
            echo ""
            build_pistache
            build_prover_server
            build_circuit
            setup_zkey
            ;;
        launch)
            launch_server
            ;;
        help|--help|-h)
            print_help
            ;;
        *)
            log_error "Unknown command: $cmd"
            print_help
            exit 1
            ;;
    esac
}

# Run main
main "$@"
