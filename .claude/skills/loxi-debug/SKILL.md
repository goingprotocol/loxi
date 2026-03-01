---
name: loxi-debug
description: Debug the Loxi distributed VRP pipeline end-to-end. Use when diagnosing issues with worker connections, auction lifecycle, task dispatch, VRP solving, or matrix calculation failures.
argument-hint: "[orchestrator|auction|vrp|matrix|worker|all]"
allowed-tools: Bash, Read, Grep
---

# Loxi Pipeline Debugger

Diagnose the Loxi POC pipeline. Focus area: `$ARGUMENTS` (default: all)

## Architecture recap
```
Browser Worker → ws:3005 (Orchestrator) → Architect (:warp API)
POST /logistics/submit-problem → Architect → Orchestrator auction
Orchestrator → LeaseAssignment → Worker → WASM solve → SubmitSolution
```

## Key files to check
- Orchestrator: `protocol/crates/loxi-orchestrator/src/lib.rs`
- Scheduler: `protocol/crates/loxi-orchestrator/src/scheduler.rs`
- Architect: `protocol/crates/logistics/loxi-logistics/src/architect/mod.rs`
- Matrix engine: `protocol/crates/logistics/loxi-logistics/src/engines/matrix/mod.rs`
- SDK: `sdk/web/src/index.ts`

## Debug areas

### orchestrator — Connection & auth issues
- Check RSA key in `.env`: `cat protocol/crates/loxi-orchestrator/.env | grep RSA_`
- Look for `InvalidKeyFormat` or JWT errors in logs
- Check WebSocket upgrade path in `lib.rs:handle_connection`

### auction — Task dispatch failures
- Grep for auction state: `grep -n "AuctionState\|LeaseAssignment\|ClaimTask" protocol/crates/loxi-orchestrator/src/`
- Check `scheduler.rs:schedule_task()` for affinity matching logic
- Verify `active_auctions` cleanup (timeout watchdog in `scheduler.rs`)

### vrp — VRP solver failures
- Check that matrix was calculated before VRP attempt
- VRP requires `distance_matrix` and `duration_matrix` — no Haversine fallback
- Check `engines/vrp/mod.rs` for `vrp-pragmatic` invocation

### matrix — Matrix calculation failures
- Check Valhalla tiles: `ls protocol/crates/logistics/loxi-logistics/data/valhalla_tiles/`
- Check `valhalla.json` config: `cat protocol/crates/logistics/loxi-logistics/data/valhalla_tiles/valhalla.json | head -5`
- Check `engines/matrix/mod.rs:calculate_matrices_for_problem()`

### worker — Browser worker connection issues
- Check SDK: `sdk/web/src/index.ts` — `runAgnosticWorker` at line 481
- Check worker WASM artifacts exist in `apps/worker-web/public/assets/pkg/`
- Check that `apps/worker-web/dist/` is built and served

### all — Full pipeline smoke test
1. Run all checks above in sequence
2. Check if node is running: `lsof -i :3005 -i :8080`
3. Check recent git log for relevant changes: `git log --oneline -10`
4. Summarize all findings with severity (CRITICAL / WARNING / INFO)

## Output format
For each issue found:
- **[SEVERITY]** Description
- File: `path/to/file.rs:line`
- Suggested fix
