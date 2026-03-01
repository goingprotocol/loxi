---
name: cargo-check
description: Run cargo fmt, clippy -D warnings, and tests against the protocol workspace. Use this when the user wants to check code quality, run CI checks locally, or before committing.
argument-hint: "[fmt|clippy|test|all]"
allowed-tools: Bash
---

# Cargo Quality Check

Run quality checks on the `protocol/` Cargo workspace. Arguments: `$ARGUMENTS` (default: all)

## Workspace path
All commands use `--manifest-path protocol/Cargo.toml`.

## Steps

Run the requested checks (or all if no argument given):

### fmt — Check formatting
```bash
cargo fmt --manifest-path protocol/Cargo.toml --all -- --check
```
If it fails, auto-fix with:
```bash
cargo fmt --manifest-path protocol/Cargo.toml --all
```
Then report which files were reformatted.

### clippy — Lint with warnings as errors
```bash
cargo clippy --manifest-path protocol/Cargo.toml --workspace --all-targets -- -D warnings
```
Report each warning/error with file:line and the fix applied.

### test — Run all tests
```bash
cargo test --manifest-path protocol/Cargo.toml --workspace
```
Report pass/fail counts.

## Output format
After each step, summarize:
- ✅ PASS or ❌ FAIL
- Files changed (fmt) or errors found (clippy/test)
- Any fixes applied

If `$ARGUMENTS` is empty or `all`, run fmt → clippy → test in sequence and stop on first failure.
If a specific check is named (e.g. `clippy`), run only that one.
