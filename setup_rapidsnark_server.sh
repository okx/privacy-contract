#!/bin/bash
#
# Setup script for rapidsnark prover server
# This script clones, builds, and sets up the rapidsnark server for proof generation
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAPIDSNARK_DIR="${SCRIPT_DIR}/tmp/rapidsnark"
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

    # Check circom
    if ! command -v circom &> /dev/null; then
        log_warn "circom not found. Installing via cargo..."
        if ! command -v cargo &> /dev/null; then
            log_error "Rust/Cargo is required to install circom."
            log_error "Install from https://rustup.rs"
            exit 1
        fi
        log_info "Installing circom..."
        git clone https://github.com/iden3/circom.git /tmp/circom
        cd /tmp/circom
        cargo build --release
        cargo install --path circom
        cd -
        rm -rf /tmp/circom
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

    if [[ "$(uname)" == "Darwin" ]] && [[ "$(uname -m)" == "arm64" ]]; then
        # macOS ARM64 build
        mkdir -p build_prover_macos_arm64 && cd build_prover_macos_arm64
        cmake .. -DTARGET_PLATFORM=macos_arm64 \
                 -DBUILD_SERVER=ON \
                 -DLIB_EVENT_DIR=/opt/homebrew/opt/libevent/lib \
                 -DCMAKE_BUILD_TYPE=Release \
                 -DCMAKE_INSTALL_PREFIX=/usr/local \
                 -DUSE_OPENMP=ON \
                 -DLIB_OMP_PREFIX=/opt/homebrew/opt/libomp/ \
                 -DGMP_INCLUDE_DIR=/opt/homebrew/include \
                 -DGMP_LIB_DIR=/opt/homebrew/lib \
                 -DUSE_LOGGER=ON
        make -j$(sysctl -n hw.ncpu)
        sudo make install
        cd ..
    elif [[ "$(uname)" == "Darwin" ]]; then
        # macOS x86_64 build
        mkdir -p build_prover_macos_x86_64 && cd build_prover_macos_x86_64
        cmake .. -DTARGET_PLATFORM=macos_x86_64 \
                 -DBUILD_SERVER=ON \
                 -DCMAKE_BUILD_TYPE=Release \
                 -DCMAKE_INSTALL_PREFIX=/usr/local
        make -j$(sysctl -n hw.ncpu)
        sudo make install
        cd ..
    else
        # Linux build
        mkdir -p build_prover && cd build_prover
        cmake .. -DBUILD_SERVER=ON \
                 -DCMAKE_BUILD_TYPE=Release \
                 -DCMAKE_INSTALL_PREFIX=/usr/local
        make -j$(nproc)
        sudo make install
        cd ..
    fi

    log_info "Prover server installed at /usr/local/bin/proverServer"
}

# ============ Build Circuit ============
build_circuit() {
    log_info "Building circuit..."
    cd "$RAPIDSNARK_DIR"

    # Install npm dependencies
    log_info "Installing npm dependencies..."
    npm install

    # Build circuit
    ./build_circuit.sh
}

# ============ Setup ZKey ============
setup_zkey() {
    log_info "Setting up zkey..."
    cd "$RAPIDSNARK_DIR"

    # Check if zkey already exists
    if [ -f "zkeys/02x03.zkey" ]; then
        log_info "zkey already exists, verifying..."
        if npx snarkjs zkey verify build/02x03.r1cs zkeys/02x03.zkey 2>/dev/null; then
            log_info "Existing zkey is valid"
            return
        else
            log_warn "Existing zkey is invalid, regenerating..."
        fi
    fi

    mkdir -p zkeys

    # Download powers of tau if not exists
    if [ ! -f "powersOfTau28_hez_final_15.ptau" ]; then
        log_info "Downloading powers of tau..."
        curl -L -o powersOfTau28_hez_final_15.ptau \
            https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
    fi

    # Generate zkey
    log_info "Generating zkey (this may take a moment)..."
    npx snarkjs groth16 setup build/02x03.r1cs powersOfTau28_hez_final_15.ptau zkeys/02x03_new.zkey

    # Export verification key
    log_info "Exporting verification key..."
    npx snarkjs zkey export verificationkey zkeys/02x03_new.zkey zkeys/02x03.vkey.json

    # Replace old zkey
    if [ -f "zkeys/02x03.zkey" ]; then
        mv zkeys/02x03.zkey zkeys/02x03_old.zkey
    fi
    mv zkeys/02x03_new.zkey zkeys/02x03.zkey

    log_info "zkey setup complete!"
}

# ============ Launch Server ============
launch_server() {
    log_info "Launching prover server..."
    cd "$RAPIDSNARK_DIR"

    if [ ! -f "/usr/local/bin/proverServer" ]; then
        log_error "proverServer not found at /usr/local/bin/proverServer"
        log_error "Please run setup first: $0 setup"
        exit 1
    fi

    if [ ! -f "zkeys/02x03.zkey" ]; then
        log_error "zkey not found at $RAPIDSNARK_DIR/zkeys/02x03.zkey"
        log_error "Please run setup first: $0 setup"
        exit 1
    fi

    # Set library path for dynamic libraries
    if [[ "$(uname)" == "Darwin" ]] && [[ "$(uname -m)" == "arm64" ]]; then
        export DYLD_LIBRARY_PATH="${RAPIDSNARK_DIR}/build_prover_macos_arm64/src:${DYLD_LIBRARY_PATH}"
    elif [[ "$(uname)" == "Darwin" ]]; then
        export DYLD_LIBRARY_PATH="${RAPIDSNARK_DIR}/build_prover_macos_x86_64/src:${DYLD_LIBRARY_PATH}"
    else
        export LD_LIBRARY_PATH="${RAPIDSNARK_DIR}/build_prover/src:${LD_LIBRARY_PATH}"
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
    echo "  LOCAL_CIRCUITS_PATH=$RAPIDSNARK_DIR"
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
    echo "  build     Build only (pistache, prover server, circuit, zkey)"
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
