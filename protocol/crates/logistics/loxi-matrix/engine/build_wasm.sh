#!/bin/bash
set -e

# Ensure we are in the directory of the script (engines/valhalla)
cd "$(dirname "$0")"

# 1. Build/Check the Builder Image (This contains the pre-compiled Valhalla C++ libs)
echo "🚀 Checking loxi-valhalla-builder Docker image..."
if [[ "$(docker images -q loxi-valhalla-builder 2> /dev/null)" == "" ]]; then
    echo "⚠️  Docker image not found. Building loxi-valhalla-builder..."
    echo "☕ This will compile Valhalla from source (15-30 mins). Grab a coffee."
    docker build -t loxi-valhalla-builder .
else
    echo "✅ Docker image 'loxi-valhalla-builder' found."
fi

# 2. Compile its Binding and Extract all Static Libraries
echo "📂 Compiling binding and extracting static libraries for Unified WASM build..."
LIBS_DEST="../libs/wasm32"
mkdir -p "$LIBS_DEST"

# Create a temporary container
CONTAINER_ID=$(docker create loxi-valhalla-builder)

# Compile binding.cpp to libvalhalla_binding.a inside Docker
# We use the same flags as the original build but targeting a static lib
docker run --rm \
    -v $(pwd)/src:/output \
    loxi-valhalla-builder \
    em++ /output/binding.cpp \
    -std=c++20 \
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
    -c -o /output/binding.o

# Create the archive locally (since we don't have emar, we can use docker)
docker run --rm \
    -v $(pwd)/src:/output \
    loxi-valhalla-builder \
    emar rcs /output/libvalhalla_binding.a /output/binding.o

# Copy out the archive
cp src/libvalhalla_binding.a "$LIBS_DEST/"

# Copy the other necessary libraries from the container
docker cp "$CONTAINER_ID":/app/valhalla/build/src/libvalhalla.a "$LIBS_DEST/"
docker cp "$CONTAINER_ID":/app/wasm-libs/lib/libprotobuf.a "$LIBS_DEST/"
docker cp "$CONTAINER_ID":/app/wasm-libs/lib/libz.a "$LIBS_DEST/"
docker cp "$CONTAINER_ID":/app/wasm-libs/lib/liblz4.a "$LIBS_DEST/"
docker cp "$CONTAINER_ID":/app/wasm-libs/lib/libgeos_c.a "$LIBS_DEST/"
docker cp "$CONTAINER_ID":/app/wasm-libs/lib/libgeos.a "$LIBS_DEST/"
docker cp "$CONTAINER_ID":/app/wasm-libs/lib/libsqlite3.a "$LIBS_DEST/"

# Remove the temporary container
docker rm "$CONTAINER_ID" > /dev/null

echo "✅ Libraries extracted to $LIBS_DEST"
echo "✨ You can now run 'sh start-dev.sh' from the root to perform the unified build."


