#!/bin/bash
# Valhalla Tile Server for Loxi
TILES_DIR="/Users/sergiosolis/Programacion/going/loxi/scripts/../valhalla_tiles"

echo "🌐 Starting Valhalla Tile Server"
echo "Serving tiles from: $TILES_DIR"
echo "URL: http://localhost:8080"
echo ""
echo "Workers will download tiles from this server."
echo "Press Ctrl+C to stop"
echo ""

cd "$TILES_DIR"
python3 -m http.server 8080
