#!/bin/bash
set -e

# ==========================================
# LOXI DEV STARTUP SCRIPT
# ==========================================

# 1. Check for Dependencies
if ! command -v wasm-pack &> /dev/null; then
    echo "❌ Error: wasm-pack is not installed. Run 'cargo install wasm-pack'"
    exit 1
fi

if ! command -v cargo &> /dev/null; then
    echo "❌ Error: cargo is not installed."
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed."
    exit 1
fi

# Cleanup on Exit
cleanup() {
    echo ""
    echo "🛑 Shutting down Loxi Ecosystem..."
    kill $(jobs -p) 2>/dev/null
    exit
}
trap cleanup SIGINT SIGTERM

echo "🚀 Building WASM for Logistics Client..."
cd protocol/crates/loxi-logistics
wasm-pack build --target web --out-dir pkg --dev
cd ../../..

echo "🌐 Starting Services in Parallel..."

# 2. Start Orchestrator
echo "   [1/4] Starting Orchestrator (Port 3005)..."
(cd protocol/crates/loxi-orchestrator && cargo run --quiet) &

# 3. Start Tile Server
echo "   [2/4] Starting Tile Server (Port 8080)..."
(cd protocol/crates/loxi-logistics && sh serve_tiles.sh > /dev/null) &

# 4. Start Web Worker App
echo "   [3/4] Starting Web Worker UI (Port 5173)..."
(cd apps/worker-web && npm run dev -- --host > /dev/null) &

# 5. Start CLI Client (Optional - for simulation)
echo "   [4/4] Starting CLI Logistics Client..."
# Sleep to let Orchestrator start
sleep 3
(cd protocol/crates/loxi-logistics && cargo run --quiet --bin client) &

echo "✅ All systems GO. Logs will stream below."
echo "Press Ctrl+C to stop everything."
echo "----------------------------------------"

wait
