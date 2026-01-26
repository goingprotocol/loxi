#!/bin/bash
# Convert existing OSM data to Valhalla tiles
# This script assumes you already have argentina-latest.osm.pbf

set -e

echo "🗺️  Valhalla Tile Converter for Loxi"
echo "===================================="
echo ""

# Check if Valhalla is installed
if ! command -v valhalla_build_tiles &> /dev/null; then
    echo "❌ Valhalla is not installed."
    echo ""
    echo "Install with:"
    echo "  brew install valhalla"
    exit 1
fi

echo "✅ Valhalla is installed"
echo ""

# Ask for the path to the .osm.pbf file
read -p "📂 Enter the full path to your argentina-latest.osm.pbf file: " OSM_FILE

if [ ! -f "$OSM_FILE" ]; then
    echo "❌ File not found: $OSM_FILE"
    exit 1
fi

echo "✅ Found OSM file: $OSM_FILE"
echo ""

# Create output directory in loxi project
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TILES_DIR="$SCRIPT_DIR/../valhalla_tiles"
mkdir -p "$TILES_DIR"

# Create Valhalla config
CONFIG_FILE="$SCRIPT_DIR/valhalla_config.json"
echo "📝 Creating Valhalla configuration..."
valhalla_build_config \
    --mjolnir-tile-dir "$TILES_DIR" \
    --mjolnir-tile-extract "$TILES_DIR/tiles.tar" \
    --mjolnir-timezone "$TILES_DIR/timezones.sqlite" \
    --mjolnir-admin "$TILES_DIR/admins.sqlite" \
    > "$CONFIG_FILE"

echo "✅ Configuration created at: $CONFIG_FILE"
echo ""

# Build tiles
echo "🔨 Building Valhalla tiles..."
echo "This will take 20-40 minutes and use ~4GB of RAM."
echo "Output directory: $TILES_DIR"
echo ""
echo "Progress:"
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

# Create tile server script
SERVER_SCRIPT="$SCRIPT_DIR/serve_tiles.sh"
cat > "$SERVER_SCRIPT" << EOF
#!/bin/bash
# Valhalla Tile Server for Loxi
TILES_DIR="$TILES_DIR"

echo "🌐 Starting Valhalla Tile Server"
echo "Serving tiles from: \$TILES_DIR"
echo "URL: http://localhost:8080"
echo ""
echo "Workers will download tiles from this server."
echo "Press Ctrl+C to stop"
echo ""

cd "\$TILES_DIR"
python3 -m http.server 8080
EOF

chmod +x "$SERVER_SCRIPT"

echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Start the tile server:"
echo "   cd $SCRIPT_DIR"
echo "   ./serve_tiles.sh"
echo ""
echo "2. Update Worker configuration:"
echo "   VITE_TILE_SERVER_URL=http://localhost:8080"
echo ""
echo "3. Workers will automatically download only the tiles they need"
echo "   (e.g., Buenos Aires = ~10MB, not the full 2GB)"
