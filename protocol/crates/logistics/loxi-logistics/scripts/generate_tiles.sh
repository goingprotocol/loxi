#!/bin/bash
set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Go up one level from scripts/ to reach loxi-logistics root
CRATE_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$CRATE_ROOT/data/valhalla_data"
TILES_DIR="$CRATE_ROOT/data/valhalla_tiles"

PBF_URL="https://download.geofabrik.de/south-america/argentina-latest.osm.pbf"
PBF_FILE="argentina-latest.osm.pbf"
FULL_PBF_PATH="$DATA_DIR/$PBF_FILE"
BUILD_MARKER="$DATA_DIR/.last_build"

echo "🗺️  Loxi Valhalla Tile Manager"
echo "=============================="
echo "📂 Data Dir:  $DATA_DIR"
echo "📂 Tiles Dir: $TILES_DIR"

mkdir -p "$DATA_DIR"
mkdir -p "$TILES_DIR"

# 1. Conditional Download
echo ""
echo "📡 Checking for OSM updates..."

# 1. Conditional Download
echo ""
echo "📡 Checking for OSM updates..."

# Get modification time before download (if exists)
MOD_TIME_BEFORE=0
if [ -f "$FULL_PBF_PATH" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        MOD_TIME_BEFORE=$(stat -f %m "$FULL_PBF_PATH")
    else
        MOD_TIME_BEFORE=$(stat -c %Y "$FULL_PBF_PATH")
    fi
fi

# Attempt download with time condition
# curl -z uses the file's timestamp to send If-Modified-Since
if [ -f "$FULL_PBF_PATH" ]; then
    curl -L -z "$FULL_PBF_PATH" -o "$FULL_PBF_PATH" "$PBF_URL"
else
    curl -L -o "$FULL_PBF_PATH" "$PBF_URL"
fi

# Get modification time after download
MOD_TIME_AFTER=0
if [ -f "$FULL_PBF_PATH" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        MOD_TIME_AFTER=$(stat -f %m "$FULL_PBF_PATH")
    else
        MOD_TIME_AFTER=$(stat -c %Y "$FULL_PBF_PATH")
    fi
fi

# 2. Check if Rebuild Needed
NEEDS_REBUILD=false

if [ ! -f "$BUILD_MARKER" ]; then
    echo "🆕 No previous build detected."
    NEEDS_REBUILD=true
elif [ "$MOD_TIME_AFTER" -gt "$MOD_TIME_BEFORE" ]; then
    echo "🔄 New OSM data detected (File updated)."
    NEEDS_REBUILD=true
elif [ -z "$(ls -A $TILES_DIR)" ]; then
    echo "⚠️  Tiles directory is empty."
    NEEDS_REBUILD=true
else
    echo "✅ Tiles are up to date."
fi

if [ "$1" == "--force" ]; then
    echo "💪 Forced rebuild requested."
    NEEDS_REBUILD=true
fi

if [ "$NEEDS_REBUILD" = false ]; then
    exit 0
fi

# 3. Generate Config & Tiles (Docker)
echo ""
echo "🏗️  Starting Valhalla Build (Docker)..."
echo "    This process may take 15-30 minutes."

# CONFIG
docker run --rm \
    --user $(id -u):$(id -g) \
    -v "$TILES_DIR":/valhalla_tiles \
    ghcr.io/valhalla/valhalla:latest \
    valhalla_build_config \
        --mjolnir-tile-dir /valhalla_tiles \
        --mjolnir-tile-extract /valhalla_tiles/tiles.tar \
        --mjolnir-timezone /valhalla_tiles/timezones.sqlite \
        --mjolnir-admin /valhalla_tiles/admins.sqlite \
        > "$TILES_DIR/valhalla.json"

# TILES
docker run --rm \
    --user $(id -u):$(id -g) \
    -v "$TILES_DIR":/valhalla_tiles \
    -v "$DATA_DIR":/data \
    ghcr.io/valhalla/valhalla:latest \
    valhalla_build_tiles -c /valhalla_tiles/valhalla.json /data/$PBF_FILE

# 4. Cleanup & Mark
touch "$BUILD_MARKER"

echo ""
echo "✅ Build Complete!"
echo "📂 Tiles are ready in $TILES_DIR"
