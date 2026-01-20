# Loxi Quick Start

## Prerequisites

- Rust (stable) (install from [rustup.rs](https://rustup.rs))
- For WASM builds: `wasm-pack` (install: `cargo install wasm-pack`)

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd <repo-directory>

# Build all crates
cargo build --workspace

# Run tests
cargo test --workspace
```

## Using the CLI

### Solve a Problem from JSON

```bash
cargo run --bin loxi -- --problem examples/simple_3stop.json --pretty
```

### With Deterministic Seed

```bash
cargo run --bin loxi -- \
  --problem examples/simple_3stop.json \
  --seed 42 \
  --pretty
```

## Modeling Notes (MVP)

- **Time windows**: arriving early is allowed; the solver models this as **waiting until the time window start**. Only late arrival is penalized.
- **Determinism**: results are reproducible **when** you provide a seed (`--seed` or `solve_route_seeded`).

### Save Solution to File

```bash
cargo run --bin loxi -- \
  --problem examples/simple_3stop.json \
  --output solution.json \
  --pretty
```

## Problem JSON Format

```json
{
  "stops": [
    {
      "id": "stop_1",
      "location": {"lat": 40.7128, "lon": -74.0060},
      "time_window": {"start": 28800, "end": 36000},
      "service_time": 300,
      "demand": 10.0,
      "priority": 1
    }
  ],
  "vehicle": {
    "capacity": 100.0,
    "start_location": {"lat": 40.7128, "lon": -74.0060},
    "end_location": {"lat": 40.7128, "lon": -74.0060},
    "shift_window": {"start": 28800, "end": 64800},
    "speed_mps": 10.0
  }
}
```

### Field Descriptions

**Stop Fields:**
- `id`: Unique identifier
- `location`: Latitude/longitude in decimal degrees
- `time_window`: Allowed arrival time (seconds since midnight)
- `service_time`: Time to service this stop (seconds)
- `demand`: Load/weight/package count
- `priority`: Higher = more important (affects cost)

**Vehicle Fields:**
- `capacity`: Maximum load capacity
- `start_location`: Depot/starting point
- `end_location`: Return location (can differ from start)
- `shift_window`: Working hours (seconds since midnight)
- `speed_mps`: Average speed in meters per second (~10 m/s ≈ 36 km/h)

## Solution JSON Format

```json
{
  "route": ["stop_1", "stop_2", "stop_3"],
  "cost": 12345.67,
  "cost_breakdown": {
    "total_distance": 10000.0,
    "total_time": 1000,
    "time_window_penalty": 0.0,
    "capacity_penalty": 0.0,
    "priority_cost": 1.5
  },
  "violations": [],
  "metadata": {
    "solver_version": "0.1.0",
    "solve_time_ms": 5,
    "seed": 42,
    "iterations": 150
  }
}
```

## Using the Library (Rust)

```rust
use loxi_types::{Problem, Stop, Vehicle, Location, TimeWindow};
use loxi_heuristics::{Solver, SolverConfig};

fn main() {
    // Create a problem
    let stops = vec![
        Stop::new(
            "stop1",
            Location::new(40.7128, -74.0060),
            TimeWindow::new(0, 86400),
            300,
            10.0,
            1,
        ),
    ];
    
    let problem = Problem::new(stops, Vehicle::default());
    
    // Solve it
    let mut solver = Solver::default();
    let solution = solver.solve(&problem).unwrap();
    
    println!("Cost: {}", solution.cost);
    println!("Route: {:?}", solution.route);
}
```

## Running Benchmarks

```bash
# Run all benchmarks
cargo bench --workspace

# Run specific benchmark
cargo bench --package loxi-bench

# View results
xdg-open target/criterion/report/index.html  # Linux
# open target/criterion/report/index.html    # macOS
```

### Benchmark

For stable results, use fixed Criterion settings and target a specific bench:

```bash
# More stable Criterion runs (recommended)
cargo bench -p loxi-bench --bench routing_bench -- \
  --measurement-time 10 --warm-up-time 5 --sample-size 50

# Save output to a shareable file
cargo bench -p loxi-bench --bench routing_bench -- \
  --measurement-time 10 --warm-up-time 5 --sample-size 50 \
  | tee bench-output.txt
```

## Development

### Run Tests

```bash
./scripts/test.sh
```

### Format Code

```bash
cargo fmt --all
```

### Lint Code

```bash
cargo clippy --workspace --all-targets
```

### Check for Errors

```bash
cargo check --workspace
```

## Next Steps

- See [README.md](README.md) for project overview.

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
cargo clean
cargo build --workspace
```

### Tests Fail

```bash
# Run tests with verbose output
cargo test --workspace -- --nocapture
```

### WASM Build Issues

```bash
# Install wasm-pack
cargo install wasm-pack

# Build WASM module
cd crates/loxi-wasm
wasm-pack build --target web
```

## Browser Demo

```bash
# Build the WASM package from repo root
make wasm-build

# Serve the demo (from repo root)
python3 -m http.server 8000
```

Open `http://localhost:8000/demo/` in your browser.
The demo uses Leaflet from a CDN (internet connection required for map rendering).

### Hot Reload (Demo Only)

Add `?hot=1` to enable live reload when the WASM bundle changes:

`http://localhost:8000/demo/?hot=1`

This only affects the demo page JavaScript and does not change the Rust/WASM binary size.

