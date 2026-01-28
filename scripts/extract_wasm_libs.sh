#!/bin/bash
set -e

# Extract precompiled Valhalla WASM64 static libraries and headers from Docker
# These were built with -s MEMORY64=1

TARGET_DIR="protocol/crates/loxi-logistics/libs/wasm64"
INCLUDE_DIR="protocol/crates/loxi-logistics/libs/include"

mkdir -p "$TARGET_DIR"
mkdir -p "$INCLUDE_DIR"

echo "📦 Extracting libraries from loxi-valhalla-builder..."

# Create a temporary container
CONTAINER_ID=$(docker create loxi-valhalla-builder)

# 1. Extract .a files
docker cp "$CONTAINER_ID:/app/valhalla/build/src/libvalhalla.a" "$TARGET_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/lib/libprotobuf.a" "$TARGET_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/lib/liblz4.a" "$TARGET_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/lib/libgeos.a" "$TARGET_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/lib/libgeos_c.a" "$TARGET_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/lib/libsqlite3.a" "$TARGET_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/lib/libz.a" "$TARGET_DIR/"

# 2. Extract Headers (Essential for FFI / bindgen)
echo "📂 Extracting include headers..."
docker cp "$CONTAINER_ID:/app/valhalla/valhalla" "$INCLUDE_DIR/"
docker cp "$CONTAINER_ID:/app/wasm-libs/include/." "$INCLUDE_DIR/"
# Boost is giant, we only need property_tree and some basics, but let's take the core if possible
# Alternatively, we can assume the host has boost or copy only what we need. 
# Valhalla headers depend heavily on boost.
docker cp "$CONTAINER_ID:/app/boost/boost" "$INCLUDE_DIR/"

# Remove temporary container
docker rm "$CONTAINER_ID"

echo "✅ Extraction Complete!"
ls -lh "$TARGET_DIR"
