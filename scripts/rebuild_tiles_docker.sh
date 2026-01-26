#!/bin/bash
set -e

# Valhalla Tile Rebuilder (Docker Version)
# Rebuilds tiles for coverage of Rio Gallegos (and all of Argentina)
# Targets the directory served by loxi-logistics/serve_tiles.sh

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$SCRIPT_DIR/valhalla_data"
# TARGET_DIR must match the directory served by the logistics server
TARGET_DIR="$ROOT_DIR/protocol/crates/loxi-logistics/valhalla_tiles"

# Valhalla Docker Image
DOCKER_IMAGE="ghcr.io/valhalla/valhalla:latest"

echo "🗺️  Regenerating Valhalla Tiles for Rio Gallegos (Argentina)"
echo "========================================================"
echo "🎯 Output Directory: $TARGET_DIR"
echo "📦 Data Directory:   $DATA_DIR"
echo "🐳 Docker Image:     $DOCKER_IMAGE"
echo ""

# Ensure directories exist
mkdir -p "$DATA_DIR"
mkdir -p "$TARGET_DIR"

# 1. Download Argentina OSM Data
OSM_FILE="argentina-latest.osm.pbf"

# Remove potential bad symlink or corrupt file if it's the one we linked
if [ -L "$DATA_DIR/$OSM_FILE" ]; then
    echo "🔗 Removing old symlink..."
    rm "$DATA_DIR/$OSM_FILE"
fi

if [ ! -f "$DATA_DIR/$OSM_FILE" ]; then
    echo "📥 Downloading Argentina OSM data (~400MB)..."
    echo "   (Covering Buenos Aires and all of Argentina)"
    curl -L -o "$DATA_DIR/$OSM_FILE" "https://download.geofabrik.de/south-america/argentina-latest.osm.pbf"
else
    echo "✅ OSM Data found: $DATA_DIR/$OSM_FILE"
fi

# 2. Clean Target Directory
echo "🧹 Cleaning old tiles..."
rm -rf "$TARGET_DIR"/*
# Re-create empty dir just in case
mkdir -p "$TARGET_DIR"

# 3. Build Tiles (Single container to use internal /tmp storage)
echo "🐳 Starting Docker container for build (using internal /tmp for speed)..."

# We use a single container to handle config + build + copy
# This avoids issues with bind-mount I/O for intermediate files
docker run --rm \
    -v "$TARGET_DIR":/out \
    -v "$DATA_DIR":/data \
    --entrypoint /bin/sh \
    $DOCKER_IMAGE \
    -c "
        set -e
        echo '📝 Generating Build Config...'
        mkdir -p /tmp/build
        
        valhalla_build_config \
            --mjolnir-tile-dir /tmp/build \
            --mjolnir-timezone /tmp/build/timezones.sqlite \
            --mjolnir-admin /tmp/build/admins.sqlite \
            > /tmp/build/valhalla.json

        echo '🔨 Building Tiles in container /tmp...'
        # valhalla_build_tiles needs to find the config. 
        # It reads the config to know where to put output.
        valhalla_build_tiles -c /tmp/build/valhalla.json /data/$OSM_FILE

        echo '📤 Copying files to host output...'
        cp -r /tmp/build/* /out/
        
        echo '✅ Build complete inside container.'
    "

echo ""
echo "✅ Tile Generation Complete!"
echo "📂 Check $TARGET_DIR"
du -sh "$TARGET_DIR"
echo ""
echo "👉 Now RESTART the tile server (./serve_tiles.sh) and reload the web worker."
