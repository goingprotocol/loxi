---
name: doc-module
description: Write human-readable documentation for a specific Rust crate, module, or TypeScript file. Explains what it does, why it exists, and how to use it — in prose, not generated docstring boilerplate.
argument-hint: "[file or module path, e.g. protocol/crates/loxi-orchestrator/src/lib.rs]"
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

# Document a Module

Write documentation for: `$ARGUMENTS`

## Step 1 — Read the code

Read the file(s) specified. Also read any types it imports from sibling modules to understand the full picture. If the argument is a crate name rather than a file path, find the `lib.rs` or `mod.rs`.

## Step 2 — Understand it deeply

Before writing anything, answer these questions internally:
- What problem does this module solve?
- What are the 2–3 most important types / functions / exports?
- What would a new contributor need to know to make a change here safely?
- What are the non-obvious invariants or assumptions baked in?

## Step 3 — Write the documentation

### For Rust files
Write a module-level doc comment (`//!`) at the top of the file. Structure:
1. One-sentence summary of what the module does
2. A short paragraph (3–5 sentences) explaining the design — why it's structured this way, what tradeoffs were made
3. A "Usage" or "Key types" subsection if the module is a public API
4. Any important invariants or caveats (e.g. "This map is never pruned — callers must call `drain_expired` periodically")

### For TypeScript files
Write a JSDoc block at the top. Same structure as above.

### Writing rules
- Sound like the person who wrote the code, explaining it to a smart colleague
- Mention the *why*, not just the *what*
- Use concrete examples over abstract descriptions where it helps
- Do not restate what is already obvious from function signatures
- Avoid filler: "This module provides...", "This function is responsible for..."
- Keep it tight — every sentence must earn its place

## Step 4 — Apply

Write the doc comment into the file. Print a diff summary of what was added.
