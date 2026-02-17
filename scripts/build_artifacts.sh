#!/bin/bash
set -e

# ==============================================================================
# Loxi Artifact Builder
# ---------------------
# Builds Rust WASM crates and organizes them into a distribution folder ready 
# to be served by 'loxi serve'.
# ==============================================================================

# Determine correct directories
PROTOCOL_DIR="protocol"
CRATES_DIR="$PROTOCOL_DIR/crates/logistics"
DIST_DIR="$CRATES_DIR/loxi-logistics/public"
TEMPLATES_DIR="$CRATES_DIR/loxi-worker-pkg/templates"

# SOURCE OF TRUTH (Valhalla Engine)
VALHALLA_SRC="$CRATES_DIR/loxi-matrix/engine/src"

echo "🧹 Cleaning dist directory ($DIST_DIR)..."
rm -rf $DIST_DIR
mkdir -p $DIST_DIR/assets/valhalla
mkdir -p $DIST_DIR/assets/pkg
mkdir -p $DIST_DIR/assets/shared

# Function to build a crate
build_crate() {
    local crate_name=$1
    local output_name=$2
    local template_name=$3
    
    echo "📦 Building $crate_name..."
    
    mkdir -p "$DIST_DIR/assets/pkg/$output_name"
    
    pushd "$CRATES_DIR/$crate_name" > /dev/null
    
    # Build WASM with web target
    wasm-pack build --target web --out-dir ../../../../$DIST_DIR/assets/pkg/$output_name --no-typescript
    
    popd > /dev/null
    
    if [ ! -z "$template_name" ]; then
        echo "📄 Injecting Worker Entry: $template_name -> assets/pkg/$output_name/worker.js"
        cp "$TEMPLATES_DIR/$template_name" "$DIST_DIR/assets/pkg/$output_name/worker.js"
    fi
}

# 1. Build Loxi Matrix (Valhalla Integration)
build_crate "loxi-matrix" "matrix" "matrix_worker.js"

# 2. Build Loxi VRP (Solver)
build_crate "loxi-vrp" "vrp" "vrp_worker.js"

# 3. Build Loxi Partitioner (H3)
build_crate "loxi-partitioner" "partitioner" "partitioner_worker.js"

# Pull Pre-compiled Valhalla Core Assets from SOURCE OF TRUTH (Loxi Matrix Engine)
echo "📦 Pulling Valhalla Core Assets from engine source ($VALHALLA_SRC)..."
cp "$VALHALLA_SRC/valhalla_engine.wasm" "$DIST_DIR/assets/valhalla/"
cp "$VALHALLA_SRC/valhalla_engine.js" "$DIST_DIR/assets/valhalla/"

# Pull Valhalla.json from tiles data (canonical location)
echo "📦 Pulling valhalla.json configuration..."
cp "$CRATES_DIR/loxi-logistics/data/valhalla_tiles/valhalla.json" "$DIST_DIR/assets/valhalla/"

# Pull Shared SDK/Managers from engine source
echo "📦 Pulling ValhallaResourceManager from engine source..."
cp "$VALHALLA_SRC/ValhallaResourceManager.js" "$DIST_DIR/assets/shared/"

# 4. Deploy Solution Visualizer Worker (for client-side route visualization)
echo "📦 Deploying Solution Visualizer Worker..."
mkdir -p "$DIST_DIR/assets/pkg/loxi_solution_visualizer"
cp "$TEMPLATES_DIR/solution_visualizer_worker.js" "$DIST_DIR/assets/pkg/loxi_solution_visualizer/worker.js"

# Link Tiles (Direct route)
TILES_SRC="$CRATES_DIR/loxi-logistics/data/valhalla_tiles"
echo "🔗 Linking valhalla_tiles to dist/tiles..."
# Use absolute path for target to avoid relative link breaks
ln -snf "$(realpath $TILES_SRC)" "$DIST_DIR/tiles"

echo "✅ Artifacts built successfully in ./$DIST_DIR"
echo "👉 Run 'cargo run -- node --dist ./$DIST_DIR' to serve."
