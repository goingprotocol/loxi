#!/bin/bash
# ==============================================================================
# Loxi Node Runner (Modular Monolith)
# -----------------------------------
# Runs the unified 'loxi node' command which spawns:
# 1. Orchestrator (Port 3005)
# 2. Logistics Manager (Connected to local Orchestrator)
# ==============================================================================

BINARY="protocol/target/release/loxi"
PUBLIC_DIR="protocol/crates/logistics/loxi-logistics/public"
ENV_FILE="protocol/crates/loxi-orchestrator/.env"

# Load orchestrator env vars
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
elif [ -n "$RSA_PRIVATE_KEY" ] && [ -n "$RSA_PUBLIC_KEY" ]; then
    echo "ℹ️  $ENV_FILE not found; using RSA_PRIVATE_KEY/RSA_PUBLIC_KEY from environment."
else
    echo "⚠️  $ENV_FILE not found and RSA_PRIVATE_KEY/RSA_PUBLIC_KEY not set in environment."
    echo "   Generate keys with: bash scripts/run_node.sh --setup"
    echo "   See: cp $ENV_FILE.example $ENV_FILE  (then fill in your RSA keys)"
    exit 1
fi

# Fall back to cargo run if release binary isn't built yet
if [ ! -f "$BINARY" ]; then
    if ! command -v cargo &> /dev/null; then
        echo "Error: no release binary and cargo not found."
        exit 1
    fi
    echo "Release binary not found, building first (this may take a few minutes)..."
    cargo build --manifest-path protocol/Cargo.toml -p loxi-cli --release
fi

echo "Starting Loxi Node. Artifacts: $PUBLIC_DIR"
"$BINARY" node --port 3005 --dist "$PUBLIC_DIR"
