---
name: write-readme
description: Write or rewrite a README section in plain human prose. Use when the user wants to document a feature, onboarding flow, architecture overview, or any part of the README without AI-sounding filler.
argument-hint: "[section name or topic, e.g. 'quickstart' or 'architecture']"
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

# Write README Section

Write or update the README section for: `$ARGUMENTS`.

## Step 1 — Understand the topic

Read the relevant source files for the requested section:
- For "quickstart" / "getting started": read `scripts/`, any existing README, and the main entry points
- For "architecture": read key source files (`protocol/crates/loxi-orchestrator/src/lib.rs`, `sdk/web/src/index.ts`, etc.)
- For any other topic: use Glob/Grep to find the relevant code first

Also read the existing README.md (if any) to match the current tone and avoid duplicating content.

## Step 2 — Write the section

Rules for human-sounding prose:
- Write in second person ("you") for instructions, first person plural ("we") for design decisions
- Use short sentences. One idea per sentence. Vary length — mix short punchy lines with longer explanatory ones.
- No buzzwords: avoid "seamlessly", "leverage", "robust", "cutting-edge", "powerful", "intuitive"
- Explain *why* alongside *what* — the reason a design decision was made is more valuable than a description of it
- Code blocks for commands, inline code for file names and identifiers
- Headers use sentence case, not title case
- If writing steps, number them. If listing things that aren't ordered, use dashes.
- Do not start consecutive sentences with the same word
- Don't pad with introductory sentences like "In this section, we will..."

## Step 3 — Integrate

If the section already exists in README.md, replace it in place.
If it's new, append it or insert it at a logical position.
Print what changed.
