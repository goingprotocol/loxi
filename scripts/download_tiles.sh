#!/bin/bash
set -e

# ==============================================================================
# Loxi Tile Downloader
# --------------------
# Downloads pre-built Buenos Aires Valhalla tiles from the latest GitHub
# release. If no release is available, falls back to generating them locally
# using Docker (requires docker to be installed).
# ==============================================================================

TILES_DIR="protocol/crates/logistics/loxi-logistics/data/valhalla_tiles"
RELEASE_URL="https://github.com/goingprotocol/loxi/releases/latest/download/buenos_aires_tiles.tar.gz"

mkdir -p "$TILES_DIR"

echo "🗺️  Loxi Tile Setup"
echo "==================="

# 1. Try to download pre-built tiles from GitHub Releases
echo "📡 Checking for pre-built tiles..."
HTTP_STATUS=$(curl -sL -o /dev/null -w "%{http_code}" "$RELEASE_URL")

if [ "$HTTP_STATUS" = "200" ]; then
    echo "⬇️  Downloading Buenos Aires tiles from release..."
    curl -L "$RELEASE_URL" | tar -xz -C "$TILES_DIR"
    echo "✅ Tiles ready at $TILES_DIR"
    exit 0
fi

echo "ℹ️  No pre-built release found (HTTP $HTTP_STATUS)."
echo ""

# 2. Fall back to local generation via Docker
if command -v docker &> /dev/null; then
    echo "🐳 Docker found. Generating tiles from OSM data (this takes ~10 min)..."
    echo "   Coverage: Buenos Aires, Argentina"
    bash protocol/crates/logistics/loxi-logistics/scripts/generate_tiles.sh
    echo "✅ Tiles generated at $TILES_DIR"
else
    echo "❌ Docker not found either."
    echo ""
    echo "To get tiles, choose one of:"
    echo ""
    echo "  A) Wait for the next tagged release — tiles will be attached automatically."
    echo ""
    echo "  B) Generate tiles yourself (requires Docker):"
    echo "       docker --version   # verify docker is running"
    echo "       bash protocol/crates/logistics/loxi-logistics/scripts/generate_tiles.sh"
    echo ""
    echo "  C) Bring your own Valhalla tiles and place them at:"
    echo "       $TILES_DIR/  (must contain 0/, 1/, 2/ directories)"
    exit 1
fi
