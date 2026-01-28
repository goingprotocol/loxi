#!/bin/bash
set -e

# Configuration
BRIDGE_SOURCE="engines/valhalla/src/binding.cpp"
TARGET_DIR="protocol/crates/loxi-logistics/libs/wasm32"
BRIDGE_LIB="libvalhalla_binding.a"

echo "🚀 Compiling C++ Bridge with Docker (emcc) for WASM32..."

# 1. Run compilation in Docker with volume mounts
echo "📦 Running emcc inside loxi-valhalla-builder..."

docker run --platform linux/amd64 --rm \
    -v "$(pwd)/engines/valhalla/src:/app/bridge_src" \
    -v "$(pwd)/$TARGET_DIR:/app/out" \
    loxi-valhalla-builder \
    /bin/bash -c "
        echo 'Compiling binding.cpp...'
        emcc -c /app/bridge_src/binding.cpp -o /app/binding.o \
        -I/app/valhalla \
        -I/app/valhalla/build/src \
        -I/app/valhalla/third_party/rapidjson/include \
        -I/app/wasm-libs/include \
        -I/app/boost \
        -std=c++20 \
        -fPIC \
        -DEMSCRIPTEN \
        -O3
        
        echo 'Creating static library...'
        emar rcs /app/out/$BRIDGE_LIB /app/binding.o
        chmod 666 /app/out/$BRIDGE_LIB
    "

echo "✅ Bridge compiled and extracted successfully to $TARGET_DIR/$BRIDGE_LIB"
ls -lh "$TARGET_DIR/$BRIDGE_LIB"
