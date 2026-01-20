#!/bin/bash
set -e

echo "=== Running benchmarks ==="
cargo bench --workspace

echo ""
echo "✅ Benchmarks complete!"
echo "Results saved to target/criterion/"

