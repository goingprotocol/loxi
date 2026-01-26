#!/bin/bash
# Valhalla Tile Setup for Loxi
# This script downloads OSM data for Argentina and builds Valhalla tiles

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TILES_DIR="$SCRIPT_DIR/valhalla_tiles"
DATA_DIR="$SCRIPT_DIR/valhalla_data"

echo "🗺️  Loxi Valhalla Tile Builder"
echo "=============================="
echo ""

# Check if Valhalla is installed
if ! command -v valhalla_build_tiles &> /dev/null; then
    echo "❌ Valhalla is not installed."
    echo ""
    echo "Install with:"
    echo "  macOS:  brew install valhalla"
    echo "  Linux:  sudo apt-get install valhalla-bin"
    echo "  Docker: docker pull ghcr.io/valhalla/valhalla:latest"
    exit 1
fi

echo "✅ Valhalla is installed"
echo ""

# Create directories
mkdir -p "$DATA_DIR"
mkdir -p "$TILES_DIR"

# Download Argentina OSM data
OSM_FILE="$DATA_DIR/argentina-latest.osm.pbf"
if [ ! -f "$OSM_FILE" ]; then
    echo "📥 Downloading Argentina OSM data (~1.5GB)..."
    echo "This will take 5-10 minutes depending on your connection."
    curl -L -o "$OSM_FILE" \
        "https://download.geofabrik.de/south-america/argentina-latest.osm.pbf"
    echo "✅ Download complete"
else
    echo "✅ Argentina OSM data already downloaded"
fi

echo ""

# Create Valhalla config
CONFIG_FILE="$DATA_DIR/valhalla.json"
echo "📝 Creating Valhalla configuration..."
valhalla_build_config \
    --mjolnir-tile-dir "$TILES_DIR" \
    --mjolnir-tile-extract "$TILES_DIR/tiles.tar" \
    --mjolnir-timezone "$TILES_DIR/timezones.sqlite" \
    --mjolnir-admin "$TILES_DIR/admins.sqlite" \
    > "$CONFIG_FILE"

echo "✅ Configuration created"
echo ""

# Build tiles
echo "🔨 Building Valhalla tiles..."
echo "This will take 20-40 minutes and use ~4GB of RAM."
echo "Progress will be shown below:"
echo ""

valhalla_build_tiles \
    -c "$CONFIG_FILE" \
    "$OSM_FILE"

echo ""
echo "✅ Tiles built successfully!"
echo ""
echo "📊 Tile Statistics:"
du -sh "$TILES_DIR"
find "$TILES_DIR" -name "*.gph" | wc -l | xargs echo "Total tile files:"
echo ""

# Create a simple tile server script
SERVER_SCRIPT="$SCRIPT_DIR/serve_tiles.sh"
cat > "$SERVER_SCRIPT" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TILES_DIR="$SCRIPT_DIR/valhalla_tiles"

echo "🌐 Starting Valhalla Tile Server"
echo "Serving tiles from: $TILES_DIR"
echo "URL: http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop"
echo ""

cd "$TILES_DIR"
python3 -m http.server 8080
EOF

chmod +x "$SERVER_SCRIPT"

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Start the tile server:"
echo "   ./serve_tiles.sh"
echo ""
echo "2. The tiles will be available at:"
echo "   http://localhost:8080"
echo ""
echo "3. Workers will automatically download only the tiles they need"
echo "   (e.g., Buenos Aires = ~10MB, not the full 2GB)"
