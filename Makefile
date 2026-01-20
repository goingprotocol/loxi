.PHONY: help build test bench clean fmt lint run-example install
.PHONY: pages-build

help: ## Show this help message
	@echo "Loxi - Available commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Build all crates
	cargo build --workspace

build-release: ## Build all crates in release mode
	cargo build --workspace --release

test: ## Run all tests
	cargo test --workspace

test-verbose: ## Run tests with verbose output
	cargo test --workspace -- --nocapture

bench: ## Run benchmarks
	cargo bench --workspace

clean: ## Clean build artifacts
	cargo clean

fmt: ## Format code
	cargo fmt --all

lint: ## Run clippy linter
	cargo clippy --workspace --all-targets

check: ## Check code without building
	cargo check --workspace

run-example: ## Run CLI with example problem
	cargo run --bin loxi -- --problem examples/simple_3stop.json --pretty --verbose

run-example-seeded: ## Run CLI with seeded example
	cargo run --bin loxi -- --problem examples/simple_3stop.json --seed 42 --pretty

install: ## Install CLI locally
	cargo install --path crates/loxi-cli

wasm-build: ## Build WASM module
	cd crates/loxi-wasm && wasm-pack build --target web

pages-build: ## Build dist/ output suitable for Cloudflare Pages
	./scripts/build_pages.sh

ci: fmt lint test ## Run CI checks locally

all: clean build test ## Clean, build, and test everything

dev: fmt check ## Quick development check (format + check)

verify: ci run-example ## Full verification (CI + run example)

