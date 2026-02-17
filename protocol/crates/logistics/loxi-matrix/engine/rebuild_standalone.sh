#!/bin/bash
set -e

# Ensure we are in the directory of the script
cd "$(dirname "$0")"

# 1. Build the Builder Image (if missing)
if [[ "$(docker images -q loxi-valhalla-builder 2> /dev/null)" == "" ]]; then
    echo "🚀 Building loxi-valhalla-builder Docker image..."
    docker build -t loxi-valhalla-builder .
fi

# 2. Compile to WASM (Standalone)
echo "🔨 Compiling Valhalla Standalone WASM..."

# Define Flags as an array (split '-s' and 'FLAG=VALUE' or eliminate space)
# Using no spaces around equality for direct flag passing
# And for '-s', we either pass "-sFLAG=VALUE" or "-s" "FLAG=VALUE"
# Let's use simple string concatenation in the array or just explicit args in the docker command
# to avoid bash array expansion issues inside docker run argument passing.

docker run --platform linux/amd64 --rm -v $(pwd)/src:/output loxi-valhalla-builder \
    em++ /output/binding.cpp \
    -std=c++20 \
    -O3 \
    -fexceptions \
    -frtti \
    -sWASM=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=67108864 \
    -sMAXIMUM_MEMORY=4GB \
    -sEXPORTED_FUNCTIONS="['_init_valhalla','_valhalla_matrix','_valhalla_route','_get_last_matrix_len','_get_last_route_len','_malloc','_free']" \
    -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','FS']" \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME='ValhallaModule' \
    -sENVIRONMENT='web,worker' \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
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
    --js-library /output/js_library.js \
    -o /output/valhalla_engine.js

echo "✅ Build Complete! Artifacts in src/valhalla_engine.js and src/valhalla_engine.wasm"
ls -lh src/valhalla_engine.wasm

echo "📦 Installing artifacts to loxi-logistics..."
cp src/valhalla_engine.js ../../loxi-logistics/public/assets/valhalla/valhalla_engine.js
cp src/valhalla_engine.wasm ../../loxi-logistics/public/assets/valhalla/valhalla_engine.wasm
echo "✅ Artifacts installed to loxi-logistics/public/assets/valhalla/"
