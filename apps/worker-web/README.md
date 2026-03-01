# Loxi Worker UI

The browser-side worker application. Open it in multiple tabs and each tab becomes a compute node that bids on and solves routing tasks dispatched by the Loxi Orchestrator.

---

## Running locally

```bash
cp .env.example .env   # edit if your orchestrator runs on a different host or port
npm install
npm run dev            # starts on http://localhost:5173
```

Open the URL in two or more tabs. Each tab registers independently as a worker with its own hardware fingerprint.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VITE_ORCHESTRATOR_URL` | `ws://localhost:3005` | WebSocket address of the Grid Orchestrator |
| `VITE_ARCHITECT_URL` | `http://localhost:8080` | HTTP base URL of the Logistics API server |

---

## What the UI does

**Node Authority panel** — shows the hardware profile the browser will advertise to the orchestrator (CPU threads, RAM). You can cap it with a voluntary resource preset (TITAN / DESKTOP / MOBILE) so a tab doesn't monopolise your machine. The Partner/Referral ID field sets the `owner_id` used to route solution notifications back to this tab.

**Mission Architect panel** — lets you generate a random stop set (Small = 10 stops, Medium = 60, Heavy = 500) or upload your own. CSV files need `lat` and `lon` columns; an optional `id` or `name` column is used as the stop label. You can also paste a JSON array directly into the text area. Once a problem is loaded, hit **Dispatch** to send it to the conductor.

**Map** — renders stops as circle markers. When a solution arrives, markers are coloured by route and the road-level polylines from Valhalla appear as coloured lines. Hovering a stop shows its ID and time window.

**Live Telemetry** — a scrolling log of all orchestrator events: task assignment, progress updates, errors, and mission completion.

**Header** — shows the live worker count (polled every 5 seconds from `/workers/count`), the current status badge, and — once a solution is ready — buttons to re-run visualisation or export routes.

---

## Exporting results

Once a mission completes, two export buttons appear in the header:

- **⬇ CSV** — one row per stop: `route_id, stop_id, lat, lon, order`
- **⬇ GeoJSON** — a FeatureCollection with one LineString per route and a Point for each stop

Files are named `loxi_routes_{mission_id}.csv` / `.geojson`.

---

## Building for production

```bash
npm run build   # outputs to dist/
```

The `dist/` directory can be served statically. Set `VITE_ORCHESTRATOR_URL` and `VITE_ARCHITECT_URL` to your production endpoints at build time or via a runtime config.
