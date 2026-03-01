---
name: release-notes
description: Write user-facing release notes for a pilot, demo, or version release. Audience is non-technical stakeholders (logistics executives, ops teams, investors). No code, no jargon — just what changed and why it matters.
argument-hint: "[version or audience, e.g. 'v0.2 pilot' or 'investor update']"
allowed-tools: Bash, Read, Glob, Write
---

# Write Release Notes

Write release notes for: `$ARGUMENTS`

## Step 1 — Gather what changed

```bash
git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~30")..HEAD
```

Also read the most recent CHANGELOG.md entry if it exists.

## Step 2 — Identify the audience

From `$ARGUMENTS`, determine who is reading:
- **pilot / customer**: logistics ops managers, fleet coordinators — care about reliability, speed, route quality
- **investor / executive**: care about traction, technical differentiation, what's de-risked
- **internal / engineering**: full detail is fine, but still write prose not bullet dumps

Default to **pilot** audience if unclear.

## Step 3 — Write the release notes

Structure:
```
## What's new in [VERSION]

[One sentence that captures the theme of this release — what's the headline improvement?]

### [Capability area 1]
[2–3 sentences. What works now that didn't before. Concrete outcome, not feature name.]

### [Capability area 2]
...

### Reliability & correctness
[If any bugs were fixed, describe what could go wrong before and what the system does now.]
```

Writing rules:
- Write for someone who has not looked at the code — ever
- Lead with outcomes, not features: "Routes now update in real time as drivers check in" not "Added WebSocket event handler"
- Translate technical fixes into user-visible impact: "Fixed a bug where duplicate solutions could overwrite a completed route" → "A completed route can no longer be overwritten if the system receives a late confirmation from a second worker"
- No acronyms without expansion on first use
- Active voice, present tense for capabilities ("The system now supports…"), past tense for fixes ("An issue where X would Y has been resolved")
- No bullet lists — full sentences in short paragraphs
- Length: 200–400 words maximum

## Step 4 — Output

Print the release notes to the terminal. Do not write to a file unless the user asks.
