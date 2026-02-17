#!/bin/bash
set -e

# Ensure we are in the directory of the script
cd "$(dirname "$0")"

# Output directory for libs
LIBS_DIR="../../protocol/crates/loxi-logistics/libs/wasm32"
mkdir -p "$LIBS_DIR"

echo "🚀 Building loxi-valhalla-builder Docker image..."
# Check if image exists to avoid rebuild if not needed (optional, but good for speed)
if [[ "$(docker images -q loxi-valhalla-builder 2> /dev/null)" == "" ]]; then
    echo "⚠️  Image not found. Building from source (this takes time)..."
    docker build -t loxi-valhalla-builder .
else
    echo "✅ Image 'loxi-valhalla-builder' found."
fi

echo "📦 Extracting Static Libraries (.a) from Docker..."

# Create a dummy container to copy files out
id=$(docker create loxi-valhalla-builder)

# Copy all required libs
# Note: Paths depend on where they are in the Docker image. 
# Based on Dockerfile, they are likely in /app/valhalla/build/src or /app/wasm-libs/lib

echo "   - Copying libvalhalla.a..."
docker cp "$id:/app/valhalla/build/src/libvalhalla.a" "$LIBS_DIR/"

echo "   - Copying libvalhalla_binding.a (if exists)..."
# Verify if we need to compile binding.cpp inside docker content or if we just need libraries.
# The user's build_wasm.sh compiles binding.cpp using em++ and links against libs.
# Rust needs: libvalhalla.a, libprotobuf.a, etc.
# AND it needs the C++ binding object/lib if we are linking C++ code.
# But `loxi-logistics` crate links against `valhalla` library.
# The `libvalhalla_binding.a` usually comes from compiling the C++ binding code.

# Let's verify commonly needed deps
docker cp "$id:/app/wasm-libs/lib/libprotobuf.a" "$LIBS_DIR/"
docker cp "$id:/app/wasm-libs/lib/libz.a" "$LIBS_DIR/" || echo "⚠️ libz.a not found"
docker cp "$id:/app/wasm-libs/lib/libgeos.a" "$LIBS_DIR/"
docker cp "$id:/app/wasm-libs/lib/libgeos_c.a" "$LIBS_DIR/"
docker cp "$id:/app/wasm-libs/lib/liblz4.a" "$LIBS_DIR/"
docker cp "$id:/app/wasm-libs/lib/libsqlite3.a" "$LIBS_DIR/"

# Copy libc++ and libc++abi from Emscripten sysroot (Critical for std::string etc.)
# Using wildcard path structure because version might vary, but path from 'find' was:
# /emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libc++.a
echo "   - Copying libc++ and libc++abi..."
docker cp "$id:/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libc++.a" "$LIBS_DIR/"
docker cp "$id:/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libc++abi.a" "$LIBS_DIR/"
# Also libc.a for standard C functions (strcpy, printf, etc.)
docker cp "$id:/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libc.a" "$LIBS_DIR/"
# docker cp "$id:/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libunwind.a" "$LIBS_DIR/" || echo "⚠️ libunwind.a not found (might be built-in)"

# Clean up extraction container
docker rm -v "$id"

echo "🔨 Compiling libvalhalla_binding.a from binding.cpp..."
# We need to compile the C++ binding code into a static library for Rust to link against
rm -f "$LIBS_DIR/libvalhalla_binding.a"
docker run --rm -v $(pwd)/src:/src -v $(pwd)/../../protocol/crates/loxi-logistics/libs/wasm32:/output loxi-valhalla-builder \
    /bin/bash -c "
    em++ -c /src/binding.cpp \
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
    -o /output/valhalla_binding.o && \
    emar rcs /output/libvalhalla_binding.a /output/valhalla_binding.o
    "

echo "✅ Libraries (including generated binding) ready in $LIBS_DIR"
ls -lh "$LIBS_DIR"
