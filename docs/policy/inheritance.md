# Inheritance / heir takeover (#77) — v2-deferred, seam-only

**Verdict (triage 2026-05-16):** `packages/control-plane/src/inheritance.ts`
is a **deliberate v2 seam**, not a v1-alpha gap. It is built, exported, and
fully unit-tested, but intentionally **not route-wired** and **not
cron-wired**. No v1-launch action is required. This document is the
decision record the module's own docstring points at.

## Why this is not a v1-alpha item

- Inheritance / heir takeover (#77) is **absent from
  `docs/build-tasks.md §S`** (the v1-alpha done-when checklist) and from
  the `CLAUDE.md` outstanding-work list. It was never scoped into v1.
- The end-to-end estate flow (heir-side `POST /api/inheritance/takeover`
  with K-of-N heir signatures + a 7-day public notice window) depends on
  the same live cross-device recovery exercise that gates B-A2/B-A3/C-A1
  and the recovered-phone work — it cannot be honestly closed from a CLI
  session and is not a launch blocker.
- The module was designed seam-first on purpose. Its commit (`ab678a8`,
  "inheritance: opt-in heir track with K-of-N + 7-day notice (#77)")
  ships the durable state + the pure decision function so a future
  Worker timer / heir UI can adopt it without re-deriving the policy.

## What IS built (and tested) today

In `packages/control-plane/src/inheritance.ts`, exported via the
control-plane barrel (`src/index.ts`), covered by
`packages/control-plane/tests/inheritance.test.ts`:

- `InheritanceStorage` interface + `InMemoryInheritanceStorage`.
- `handlePutInheritanceDeclaration` — verifies the user's IRK signature
  over the canonical declaration, enforces `heirSetVersion` roll-forward
  (replay of an older declaration cannot undo a heir addition), MAX 12
  heirs, 1..N threshold, staleness window. An empty heir list is the
  documented "off"/revoke path.
- `handleGetInheritanceDeclaration` — public read (pubkey fingerprints
  only; no names/contact, so disclosure is safe).
- `eligibleForTakeover` — pure scheduled-job input feed: walks every
  declaration and returns those past `lastSignedAt +
  triggerAfterInactiveDays`.
- `takeoverNoticeWindowEnd` — canonical 7-day notice-end helper.

Default state is OFF: no row exists until the user explicitly opts in.

## What is deferred to v2 (the graduation checklist)

When inheritance is scheduled for a release, the wiring is mechanical —
the policy and crypto are already decided and tested:

1. **`apps/com` route wiring** — mount `POST /api/inheritance`,
   `GET /api/inheritance/:username` onto the Worker (D1-backed
   `InheritanceStorage` adapter alongside the other `@flagship/storage`
   adapters; add a migration for the declaration row).
2. **Scheduled job** — call `eligibleForTakeover` from a Worker
   `scheduled` (cron) trigger; persist/alert on the eligible set. This
   is the deploy-time decision the docstring defers.
3. **Heir-side `POST /api/inheritance/takeover`** — K-of-N heir
   signatures, opens the `takeoverNoticeWindowEnd` 7-day public notice,
   then binds. Needs the live cross-device recovery exercise.
4. **`recordSigningActivity` cross-wiring** — call it from every other
   IRK-signed-envelope endpoint (`rePair`, username-claim/handover, …)
   so the inactive timer reflects real signing activity. Deliberately
   stubbed in `ab678a8` because it touches a wide surface; do it as one
   focused pass when graduating, not piecemeal.

Until all four land, inheritance stays seam-only and OFF for every user;
there is no partial/half-wired state to defend.
