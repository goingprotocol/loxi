#!/bin/bash
set -e

echo "=== Running workspace tests ==="
cargo test --workspace --lib

echo ""
echo "=== Running CLI test ==="
cargo run --bin loxi -- --problem examples/simple_3stop.json --pretty

echo ""
echo "✅ All tests passed!"

