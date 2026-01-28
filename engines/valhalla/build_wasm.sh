#!/bin/bash
set -e

# Ensure we are in the directory of the script (engines/valhalla) so Dockerfile is found
cd "$(dirname "$0")"

# 1. Build the Builder Image (This compiles Valhalla C++ libs)
# This Step takes TIME (15-30 mins on first run)
echo "🚀 Building loxi-valhalla-builder Docker image..."
echo "⚠️  This will compile Valhalla from source. Grab a coffee. ☕"
docker build -t loxi-valhalla-builder .

# 2. Compile our Binding to WASM
echo "🔨 Compiling WASM binding..."
docker run --rm -v $(pwd)/src:/output loxi-valhalla-builder \
    em++ /output/binding.cpp \
    -std=c++20 \
    -fexceptions \
    -frtti \
    -o /output/loxi_valhalla.js \
    -I/app/valhalla \
    -I/app/valhalla/build \
    -I/app/valhalla/build/src \
    -I/app/valhalla/third_party/rapidjson/include \
    -I/app/valhalla/third_party/date/include \
    -I/app/valhalla/third_party/unordered_dense/include \
    -I/app/valhalla/third_party/protozero/include \
    -I/app/valhalla/third_party/libosmium/include \
    -I/app/valhalla/third_party/vtzero/include \
    -I/app/wasm-libs/include \
    -I/app/boost \
    -L/app/valhalla/build/src \
    -L/app/wasm-libs/lib \
    -lvalhalla \
    -lprotobuf \
    -llz4 \
    -lgeos_c \
    -lgeos \
    -lsqlite3 \
    -lz \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MEMORY64=1 -Wno-experimental -Wno-error \
    -s MAXIMUM_MEMORY=16GB \
    -s TOTAL_STACK=33554432 \
    -s INITIAL_MEMORY=67108864 \
    -s EXPORTED_FUNCTIONS="['_init_valhalla', '_valhalla_matrix', '_malloc', '_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall', 'cwrap', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8', 'FS']" \
    -O0 \
    -g

echo "✅ Build Complete! WASM artifacts are in src/"
ls -lh src/loxi_valhalla.wasm
