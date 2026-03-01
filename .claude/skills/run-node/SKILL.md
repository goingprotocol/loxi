---
name: run-node
description: Start the Loxi node (orchestrator + architect server). Use when the user wants to boot the POC, run the node, start the server, or test the full stack locally.
argument-hint: "[port]"
allowed-tools: Bash
---

# Run Loxi Node

Start the full Loxi node stack. Port: `$ARGUMENTS` (default: 3005)

## Pre-flight checks

1. **Check .env exists:**
   ```bash
   ls protocol/crates/loxi-orchestrator/.env
   ```
   If missing, warn: "RSA keypair missing — run: `openssl genrsa 4096 | tee /tmp/loxi.key && openssl rsa -in /tmp/loxi.key -pubout > /tmp/loxi.pub`"

2. **Check binary exists:**
   ```bash
   ls -la protocol/target/release/loxi 2>/dev/null
   ```
   If missing, build it:
   ```bash
   cargo build -p loxi-orchestrator --release --manifest-path protocol/Cargo.toml
   ```

3. **Check tiles exist:**
   ```bash
   ls protocol/crates/logistics/loxi-logistics/data/valhalla_tiles/ 2>/dev/null | head -5
   ```
   If missing, warn: "Routing tiles not found. Run `scripts/download_tiles.sh` or generate via Docker."

4. **Check tiles symlink:**
   ```bash
   ls apps/worker-web/public/tiles 2>/dev/null
   ```
   If missing, create: `ln -s $(pwd)/protocol/crates/logistics/loxi-logistics/data/valhalla_tiles $(pwd)/apps/worker-web/public/tiles`

## Start the node

```bash
scripts/run_node.sh
```

Or directly:
```bash
PORT=${ARGUMENTS:-3005}
ENV_FILE="protocol/crates/loxi-orchestrator/.env"
set -a && source "$ENV_FILE" && set +a
protocol/target/release/loxi node --port "$PORT" --dist "$(pwd)/apps/worker-web/dist"
```

## Expected output

Look for these log lines confirming successful boot:
- `🎯 Orchestrator listening on 0.0.0.0:3005`
- `🌐 Artifact server listening on :8080`
- `🏗️ Architect connected to Orchestrator`

## Troubleshooting

- **`InvalidKeyFormat`**: RSA key has literal `\n` in .env. The binary handles this via `.replace("\\n", "\n")` — if still failing, check auth.rs.
- **Port in use**: `lsof -i :3005` to find and kill the conflicting process.
- **Valhalla error**: Check that `data/valhalla_tiles/valhalla.json` exists and points to valid tile dirs.
