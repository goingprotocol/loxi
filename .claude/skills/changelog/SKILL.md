---
name: changelog
description: Generate a human-written CHANGELOG entry from recent git commits. Use when the user wants to document what changed in a release or sprint, in plain prose rather than raw commit messages.
argument-hint: "[version or date range, e.g. v0.2.0 or HEAD~10..HEAD]"
allowed-tools: Bash, Read, Write, Edit
---

# Generate CHANGELOG Entry

Write a human-readable CHANGELOG entry for: `$ARGUMENTS` (default: commits since the last tag).

## Step 1 — Gather commits

```bash
git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD
```

If `$ARGUMENTS` looks like a range (e.g. `HEAD~10..HEAD`) use it directly. If it's a version string, find the previous tag and diff from there.

Also run:
```bash
git diff --stat $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD
```

## Step 2 — Group changes

Cluster commits into these buckets (skip any that are empty):
- **Added** — new features, new endpoints, new UI
- **Fixed** — bug fixes, correctness improvements
- **Changed** — behaviour changes, refactors visible to users
- **Removed** — deleted code, deprecated features dropped
- **Security** — auth, validation, data protection

## Step 3 — Write the entry

Write in natural prose, not bullet lists of commit messages. Rules:
- Sound like a engineer writing for a colleague, not a robot summarising diffs
- Lead each bullet with a strong verb in past tense ("Added", "Fixed", "Removed")
- One sentence per item — clear, specific, no filler words ("various", "several", "some improvements")
- Omit internal refactors and style-only commits unless they affect behaviour
- Keep the version header format: `## [VERSION] — YYYY-MM-DD`

## Step 4 — Output

If a CHANGELOG.md exists, prepend the new entry at the top (below any title line).
If it doesn't exist, create it with a `# Changelog` title and the new entry.

Print a summary of what was written.
