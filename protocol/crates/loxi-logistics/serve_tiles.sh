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

cd "$(dirname "$TILES_DIR")"

# Create a simple CORS-enabled server with Range Support

# Create a simple CORS-enabled server
python3 << 'EOF'
from http.server import HTTPServer, SimpleHTTPRequestHandler
import sys
import os
import re

class RangeRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        self.send_header('Access-Control-Allow-Headers', 'Range') # CRITICAL: Allow browser to send Range
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        return super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        # Handle Range Header
        range_header = self.headers.get('Range')
        
        # 1. Standard Request (Full File) - If no range, fallback to standard behavior
        if not range_header:
            return super().do_GET()

        # 2. Range Request Logic
        try:
            # Resolve physical path
            path = self.translate_path(self.path)
            if not os.path.isfile(path):
                self.send_error(404, "File not found")
                return

            file_size = os.path.getsize(path)
            
            # Parse Range: bytes=0-1023
            match = re.search(r'bytes=(\d+)-(\d*)', range_header)
            if not match:
                self.send_error(400, "Invalid Range Header")
                return

            first_byte = int(match.group(1))
            last_byte = match.group(2)
            
            if last_byte:
                last_byte = int(last_byte)
            else:
                last_byte = file_size - 1 # Request "to end"

            # Check validity
            if first_byte >= file_size:
                self.send_error(416, "Requested Range Not Satisfiable")
                self.send_header('Content-Range', f'bytes */{file_size}')
                self.end_headers()
                return

            # Clamp
            if last_byte >= file_size:
                last_byte = file_size - 1
            
            length = last_byte - first_byte + 1

            # 3. Serve Partial Content (206)
            self.send_response(206)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Range', f'bytes {first_byte}-{last_byte}/{file_size}')
            self.send_header('Content-Length', str(length))
            self.end_headers()

            # Send bytes
            with open(path, 'rb') as f:
                f.seek(first_byte)
                self.wfile.write(f.read(length))
                
        except Exception as e:
            print(f"Error serving range: {e}")
            self.send_error(500, "Internal Server Error")

httpd = HTTPServer(('0.0.0.0', 8080), RangeRequestHandler)
print("✅ Server running on http://0.0.0.0:8080 (With Range Support)")
httpd.serve_forever()
EOF
