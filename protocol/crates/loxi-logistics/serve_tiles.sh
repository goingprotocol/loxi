#!/bin/bash
# Valhalla Tile Server for Loxi
# Serves tiles from the loxi-logistics directory with CORS enabled

TILES_DIR="/Users/sergiosolis/Programacion/going/loxi/protocol/crates/loxi-logistics/valhalla_tiles"
CONFIG_FILE="$TILES_DIR/valhalla.json"

echo "🌐 Starting Valhalla Tile Server"
echo "Serving tiles from: $TILES_DIR"

# Step 1: Generate Official Valhalla Config
if command -v docker &> /dev/null; then
    echo "🏗️ Generating official Valhalla config using Docker..."
    # We use ghcr.io/valhalla/valhalla to get the production-grade valhalla_build_config tool
    docker run --rm \
      -v "$TILES_DIR":/valhalla_tiles \
      ghcr.io/valhalla/valhalla \
      valhalla_build_config --mjolnir-tile-dir /valhalla_tiles \
      > "$CONFIG_FILE"
    
    if [ $? -eq 0 ]; then
        echo "✅ Official valhalla.json generated successfully."
    else
        echo "⚠️ Warning: Failed to generate config with Docker. Serving existing or manual config."
    fi
else
    echo "⚠️ Docker not found. Skipping official config generation."
fi

echo "URL: http://localhost:8080"
echo "Config available at: http://localhost:8080/valhalla.json"
echo ""
echo "Workers will download tiles from this server."
echo "Press Ctrl+C to stop"
echo ""

cd "$TILES_DIR"
python3 -m http.server 8080 --bind 0.0.0.0 &
SERVER_PID=$!

# Enable CORS by adding headers (Python 3.7+)
# Note: Simple HTTP server doesn't support CORS natively
# Using a workaround with socat or switching to a CORS-enabled server

# Kill the simple server and use a CORS-enabled one
kill $SERVER_PID 2>/dev/null

# Create a simple CORS-enabled server
python3 << 'EOF'
from http.server import HTTPServer, SimpleHTTPRequestHandler
import sys

class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        return super().end_headers()

httpd = HTTPServer(('0.0.0.0', 8080), CORSRequestHandler)
print("Server running on http://0.0.0.0:8080")
httpd.serve_forever()
EOF
