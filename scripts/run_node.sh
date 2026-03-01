#!/bin/bash
# ==============================================================================
# Loxi Node Runner (Modular Monolith)
# -----------------------------------
# Runs the unified 'loxi node' command which spawns:
# 1. Orchestrator (Port 3005)
# 2. Logistics Manager (Connected to local Orchestrator)
# ==============================================================================

# Ensure cargo is available
if ! command -v cargo &> /dev/null; then
    echo "Error: Cargo not found. Please install Rust."
    exit 1
fi

# Default to internal public directory if not specified
PUBLIC_DIR="protocol/crates/logistics/loxi-logistics/public"
echo "Starting Loxi Node. Artifacts: $PUBLIC_DIR"
cargo run --manifest-path protocol/Cargo.toml -p loxi-cli -- node --port 3005 --dist "$PUBLIC_DIR"
