# docs/archive — historical handoffs & completed trackers

These files are **frozen history**, kept for provenance. They are no longer
maintained and may be stale.

**The single source of truth for current status and open work is the root
`CLAUDE.md`** ("Current status & open work"). Living design specs stay in
`docs/` (indexed from `CLAUDE.md`). Operational runbooks stay in
`docs/runbooks/`.

## What's here and why

| File | Was | Superseded by |
|---|---|---|
| `SESSION-HANDOFF.md`, `session-handoff-2026-06-02.md`, `session-handoff-2026-06-03.md`, `next-session-handoff.md`, `next-session-prompt.md`, `next-session-webapp-cycle.md`, `operator-next-steps-2026-05-20.md` | dated session/handoff notes | `CLAUDE.md` |
| `owner-e2e-checklist.md`, `end-to-end-test-checklist.md`, `e2e-test-instructions-2026-06-02.md` | one-off / dated e2e checklists | `CLAUDE.md` open work + `docs/e2e-test-plan.md` (the living rig design) |
| `feature-parity.md` | parity matrix snapshot (every row had reached ✅) | `CLAUDE.md` |
| `build-tasks.md`, `v1-launch-program.md` | v1-launch tracking checklists | `CLAUDE.md` |
| `plan-external-domains-and-demo.md` | execution plan (external domains + demo — shipped) | shipped; `docs/runbooks/` for ops |
| `sample-user-vps-plan.md` | demo-VPS provisioning plan (shipped/live) | `docs/runbooks/demo-users-bootstrap.md` |

If you need detail from one of these, read it — but record any still-live
decision back into `CLAUDE.md` or the relevant living spec, not here.
