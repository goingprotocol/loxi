echo "🗺️  Valhalla Tile Builder (Docker)"
echo "=================================="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running."
    echo ""
    echo "Please start Docker Desktop and try again."
    exit 1
fi

echo "✅ Docker is running"
echo ""

# Look for OSM file in common locations
OSM_FILE=""
SEARCH_PATHS=(
    "$HOME/Programacion/going_engine/osrm-data/argentina-latest.osm.pbf"
    "$HOME/Programacion/going_engine/argentina-latest.osm.pbf"
    "$HOME/Downloads/argentina-latest.osm.pbf"
)

for path in "${SEARCH_PATHS[@]}"; do
    if [ -f "$path" ]; then
        OSM_FILE="$path"
        break
    fi
done

if [ -z "$OSM_FILE" ]; then
    echo "❌ Could not find argentina-latest.osm.pbf in common locations."
    echo ""
    echo "Searched:"
    for path in "${SEARCH_PATHS[@]}"; do
        echo "  - $path"
    done
    echo ""
    read -p "📂 Enter the full path to your .osm.pbf file: " OSM_FILE
    
    if [ ! -f "$OSM_FILE" ]; then
        echo "❌ File not found: $OSM_FILE"
        exit 1
    fi
fi

echo "✅ Found OSM file: $OSM_FILE ($(du -h "$OSM_FILE" | cut -f1))"
echo ""

echo "✅ Found OSM file: $OSM_FILE ($(du -h "$OSM_FILE" | cut -f1))"
echo ""

# Create output directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TILES_DIR="$SCRIPT_DIR/../valhalla_tiles"
mkdir -p "$TILES_DIR"

echo "📦 Pulling Valhalla Docker image..."
docker pull ghcr.io/valhalla/valhalla:latest

echo ""
echo "🔨 Building Valhalla tiles..."
echo "This will take 5-15 minutes for Buenos Aires."
echo "Output directory: $TILES_DIR"
echo ""

# Run Valhalla tile builder with proper configuration
docker run -it --rm \
  -v "$(dirname "$OSM_FILE"):/data" \
  -v "$TILES_DIR:/tiles" \
  ghcr.io/valhalla/valhalla:latest \
  bash -c "
    valhalla_build_config --mjolnir-tile-dir /tiles > /tmp/valhalla.json && \
    valhalla_build_tiles -c /tmp/valhalla.json /data/$(basename "$OSM_FILE")
  "

echo ""
echo "✅ Tiles built successfully!"
echo ""
echo "📊 Tile Statistics:"
du -sh "$TILES_DIR"
find "$TILES_DIR" -name "*.gph" 2>/dev/null | wc -l | xargs echo "Total tile files:"
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
echo "2. Workers will automatically download only the tiles they need"
echo "   (e.g., Buenos Aires = ~10MB, not the full 2GB)"
