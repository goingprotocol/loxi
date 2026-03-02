#!/bin/bash
set -e

# ==============================================================================
# Loxi Tile Downloader
# --------------------
# Downloads pre-built Valhalla routing tiles for one or more cities.
#
# By default, downloads/generates Buenos Aires tiles.
#
# Multi-city support:
#   Set LOXI_CITIES to a comma-separated list of Geofabrik region slugs.
#   Each slug is the path under https://download.geofabrik.de/ to the .osm.pbf.
#   Examples:
#     LOXI_CITIES="south-america/argentina-latest"         (default)
#     LOXI_CITIES="south-america/argentina-latest,south-america/uruguay-latest"
#     LOXI_CITIES="europe/germany-latest,europe/france-latest"
#
#   All regions are baked into a single tile tree that Valhalla serves together.
#   No valhalla.json changes are required — all tiles share one tile directory.
# ==============================================================================

TILES_DIR="protocol/crates/logistics/loxi-logistics/data/valhalla_tiles"
DATA_DIR="protocol/crates/logistics/loxi-logistics/data/valhalla_data"

# Default to Buenos Aires (Argentina) if LOXI_CITIES is not set
LOXI_CITIES="${LOXI_CITIES:-south-america/argentina-latest}"

mkdir -p "$TILES_DIR"
mkdir -p "$DATA_DIR"

echo "🗺️  Loxi Tile Setup"
echo "==================="
echo "   Regions: $LOXI_CITIES"

# Split LOXI_CITIES into an array
IFS=',' read -ra CITY_SLUGS <<< "$LOXI_CITIES"

# ── Attempt to download pre-built tiles from GitHub Releases ──────────────────
# For now only single-city pre-built releases exist (Buenos Aires).
# Multi-city builds always fall through to local Docker generation.
if [ "${#CITY_SLUGS[@]}" -eq 1 ]; then
    SLUG="${CITY_SLUGS[0]}"
    # Derive a release asset name from the slug (last path component, strip -latest)
    ASSET_NAME=$(basename "$SLUG" | sed 's/-latest//')_tiles.tar.gz
    RELEASE_URL="https://github.com/goingprotocol/loxi/releases/latest/download/${ASSET_NAME}"

    echo "📡 Checking for pre-built tiles ($ASSET_NAME)..."
    HTTP_STATUS=$(curl -sL -o /dev/null -w "%{http_code}" "$RELEASE_URL")

    if [ "$HTTP_STATUS" = "200" ]; then
        echo "⬇️  Downloading tiles from release..."
        curl -L "$RELEASE_URL" | tar -xz -C "$TILES_DIR"
        echo "✅ Tiles ready at $TILES_DIR"
        exit 0
    fi
    echo "ℹ️  No pre-built release found (HTTP $HTTP_STATUS). Falling back to local build."
else
    echo "ℹ️  Multi-region build requested — skipping pre-built release check."
fi

echo ""

# ── Fall back to local generation via Docker ──────────────────────────────────
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found."
    echo ""
    echo "To get tiles, choose one of:"
    echo ""
    echo "  A) Wait for the next tagged release — tiles will be attached automatically."
    echo ""
    echo "  B) Install Docker and re-run this script."
    echo ""
    echo "  C) Bring your own Valhalla tiles and place them at:"
    echo "       $TILES_DIR/  (must contain 0/, 1/, 2/ directories)"
    exit 1
fi

echo "🐳 Docker found. Downloading PBF data and building tiles..."
echo "   This may take 15-60 minutes depending on region size."

# Download all requested PBF files
PBF_FILES=()
for SLUG in "${CITY_SLUGS[@]}"; do
    SLUG="$(echo "$SLUG" | xargs)"  # trim whitespace
    PBF_NAME="$(basename "$SLUG").osm.pbf"
    PBF_PATH="$DATA_DIR/$PBF_NAME"

    if [ -f "$PBF_PATH" ]; then
        echo "♻️  $PBF_NAME already downloaded, checking for updates..."
        curl -L -z "$PBF_PATH" -o "$PBF_PATH" "https://download.geofabrik.de/${SLUG}.osm.pbf"
    else
        echo "⬇️  Downloading $PBF_NAME from Geofabrik..."
        curl -L -o "$PBF_PATH" "https://download.geofabrik.de/${SLUG}.osm.pbf"
    fi
    PBF_FILES+=("/data/$PBF_NAME")
done

# Generate Valhalla config (writes to tiles dir)
docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/$TILES_DIR":/valhalla_tiles \
    ghcr.io/valhalla/valhalla:latest \
    valhalla_build_config \
        --mjolnir-tile-dir /valhalla_tiles \
        --mjolnir-tile-extract /valhalla_tiles/tiles.tar \
        --mjolnir-timezone /valhalla_tiles/timezones.sqlite \
        --mjolnir-admin /valhalla_tiles/admins.sqlite \
        > "$TILES_DIR/valhalla.json"

# Build tiles from all PBF files in one pass
echo "🏗️  Building Valhalla tiles from ${#PBF_FILES[@]} region(s)..."
docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$PWD/$TILES_DIR":/valhalla_tiles \
    -v "$PWD/$DATA_DIR":/data \
    ghcr.io/valhalla/valhalla:latest \
    valhalla_build_tiles -c /valhalla_tiles/valhalla.json "${PBF_FILES[@]}"

echo ""
echo "✅ Tiles ready at $TILES_DIR"
