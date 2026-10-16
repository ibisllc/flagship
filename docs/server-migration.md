# Server migration — move a server to new hardware, safely, in place

## Data path (owner decision, 2026-10-16): the server backup, not peer shards

Migrate no longer moves data through peer-backup shards (the old box no
longer needs to be "enrolled"). It is a backup of the old server, restored
onto the new one, then the take-over and the wipe below, all on the same
primitives as Back up now and Import a backup
(`docs/server-backup-and-clone.md`):

1. **Initiate** and **provision** as below (admin-signed
   `flagship/server-migration/v1`; the new box is an ordinary new server
   that attaches to the session).
2. **Estimate.** The app reads the old box's backup size
   (`GET /api/screens/server-archive/backups/estimate`) and asks the new
   box to time the link (`POST /api/screens/server-archive/probe-link` on
   the old box, a one-use 8 MiB `/api/archive-probe/<token>`; `POST
   /api/screens/server-restore/probe {url}` on the new one → bytes per
   second), and shows the expected downtime (backup + transfer + restore)
   before anything starts.
3. **Pause and back up the old box:** `POST .../backups/run {purpose:
   "migrate"}`. The box pauses every app (`docker pause`: nothing writes
   after the backup; Postgres and the files folders stay readable), makes a
   saved backup with a key from its pool (the account slot), and pins it
   until the move ends (`serverArchive/migratePause.ts`, marker
   `<dataDir>/migrate-pause.json`). Every app URL answers 503 with a calm
   "This app is moving to a new server; it will be back shortly" page.
   Abort (`POST .../backups/resume`), a failed backup, or a day without a
   freeze unpauses the apps.
4. **The new box takes the backup:** the app opens the backup file with the
   account key, signs `flagship/server-restore/v1` for the NEW box, and
   sends it after pairing (`POST /api/screens/server-restore/order`, refused
   on a server that already has apps). It approves a browser-style download
   request on the old box (`flagship/archive-download/v1`) and hands the new
   box the link: `POST /api/screens/server-restore/pull {url, requestId}`.
   The new box fetches `<link>/bundle` itself (box to box, HTTP Range,
   resumable), keeps only the data part, and the app commits the content
   key as for an import. Every app is tried; failed apps are named and the
   restore ends.
5. **Pre-seeded → confirm-ready → freeze → take over → wipe**, unchanged:
   the new box acks pre-seeded once its restore is done (`restoredAny`); the
   freeze's final flush is a no-op for a move on the archive path (the apps
   were paused before the backup); the old box is wiped after the take-over.

Progress is shown as backup %, transfer % (`restore.received / bytes`) and
restore % (apps done / apps). Downtime is the pause: backup + transfer +
restore. **Live replication** (streaming writes so the pause disappears)
remains a later version.

The rest of this document is the original design (2026-07-01); where it
talks about peer-backup pre-seed and final deltas, the data path above
replaces it.

> **Status: DESIGN. Build post-launch.** Recorded 2026-07-01. Most parts already exist —
> **this spec is the orchestration that makes them fit into one guided "Migrate this
> server" flow**: mint a replacement box that comes online, restores the data, takes over
> the name, and only then wipes the old box. Same owner, same name, same data — new
> hardware.

## Goal + the user's flow

From the **server page → "Migrate to new machine / VM"**:
1. Mint a **replacement** for THIS server (same `<server>.<user>` name + owner, a *new*
   box), on any target (USB-burned box, the desktop **VM appliance**, or native install).
2. The new box **comes online** and **restores this server's data**.
3. Once the new box is confirmed healthy + caught up, **retire the old box** (final delta
   backup → release routing).
4. The new box **takes over** the name (routing + cert).
5. **Format/wipe the old box** — but *only after* take-over is confirmed.

The URL/identity never changes; the box behind it does.

## What migration is (and isn't)

- **Migration = same owner, same name/identity, NEW hardware.** The `<server>.<user>`
  name, the owner, the admin master root, the RCK route, and the data all carry over; only
  the physical box (and its per-box identity key + per-box cert) change.
- **Not transfer-a-box.** Transfer changes the *owner* (`alice`→`bob`, a namespace
  migration; `docs/account-deletion-and-name-reclaim.md` §4). Migration keeps the owner and
  the name — it's a *hardware* move, so there is **no namespace change**, just a new box
  claiming the same name and the old one releasing it.
- **Migration ≈ graceful replacement + guaranteed data-restore + routing cutover**, tied
  together and surfaced as one flow. It builds directly on
  `docs/server-replacement-graceful-decommission.md`.

## Invariants (the safety spine)

1. **No data loss.** The new box restores the old box's data, and the old box takes a
   **final delta backup at freeze** that the new box applies before take-over. **The old
   box is wiped ONLY after the new box confirms a good restore + successful take-over**
   (disposition `wipe-after-handoff` from the decommission spec; fail-safe = *keep* the old
   box on any timeout/failure). A failed migration never destroys the only copy.
2. **No split-brain.** Exactly one box serves the name at a time. The new box does **not**
   claim routing until the old box has **released** it (release-before-claim). The hub's
   eviction (rejects the evicted STK at HELLO) + the routing-resolution park-on-miss/nudge
   handle the cutover cleanly.
3. **Continuity.** Same `<server>.<user>` (and tier-2 `<service>.<user>`) names → bookmarks/
   links keep working. The new box mints its **own A′ cert** for the same SANs, claims the
   **RCK** route (phone re-points RCK to the new box's STK), and the phone **re-pins** the
   new box's cert fingerprint at cutover.
4. **Identity preserved without re-derivation pain.** The **SWK is deterministic**
   (`deriveSWK(umk, serverId)`), so the new box re-derives the *same* SWK → the old box's
   **peer-backup shares decrypt** with no escrow dance. The new box gets a fresh per-box
   identity key + entitlement (owner/admin-root-signed) — normal first-boot provisioning.
5. **Admin-gated.** Migration retires + wipes a box and re-homes routing — a **SENSITIVE
   op** → it rides the Slice-D **admin master root** gate (`requireMasterAdmin`,
   `docs/device-admin-tier-spec.md`). Every order below is admin-root-anchored.

## The orchestrated state machine (phone-driven)

The phone is the orchestrator (it holds the RCK, the admin root, and the UMK for
SWK/backup keys). A migration is a tracked session (phone-side + a `.com` lane).

| # | Phase | Actor | What happens |
|---|---|---|---|
| 1 | **Initiate** | admin phone | "Migrate this server" → admin-root Face ID. Mint a **replacement recipe** for the same `serverDomain` (same owner + admin root; SWK re-derives deterministically). |
| 2 | **Provision new** | owner + new box | Owner applies the recipe on the new target (burn / VM appliance / native). New box boots, registers as a pod, claims its entitlement — but **does not claim the name**. |
| 3 | **Pre-seed data** | new box | New box **restores the latest peer-backup** (SWK-decrypted) → gets ~current data while the old box keeps serving live. |
| 4 | **Confirm ready** | admin phone | Phone verifies the new box is healthy + restored (a "ready to take over" signal; reuse the provision-status/health surface). |
| 5 | **Freeze + hand off** | old box | Phone signs the eviction (disposition `wipe-after-handoff`). Old box **freezes writes → flushes a FINAL delta backup → releases routing** → reports "handed off." |
| 6 | **Take over** | new box + phone | New box **restores the final delta → claims the name**: mints its A′ cert, claims the RCK route (phone re-points RCK to the new STK), phone **re-pins** the new cert fingerprint. Brief write-frozen window (step 5→6). |
| 7 | **Wipe old** | old box | Only after the new box **confirms it is serving the name**, the old box **crypto-shreds** (destroy the LUKS key + `docker compose down -v` + drop the data tree) + powers off. **Fail-safe: no take-over confirmation ⇒ old box is KEPT, migration abortable, no data lost.** |
| 8 | **Done** | — | Old hardware is free to reburn/repurpose. The server is now on the new box, same name/URL. |

## Pieces reused (this is mostly wiring, not new mechanism)

- **Graceful decommission / eviction** — retire the old box (final flush, release routing,
  disposition `wipe-after-handoff`): `docs/server-replacement-graceful-decommission.md`,
  `server_evictions` lane, daemon `decommissionConsumer.ts`.
- **Peer-backup + restore** — the data carry-over; the "final delta at freeze" is the
  decommission's final-flush consumed by the new box.
- **SWK determinism** — new box re-derives the same SWK → backup shares decrypt (recovery).
- **Per-box A′ cert** — new box mints its own for the same SANs
  (`docs/per-user-cert-and-addressing.md`); the old cert is abandoned.
- **RCK routing + claim/yield + routing-resolution** — release-before-claim cutover
  (`docs/multi-pod-liveness-session-leadership.md` + the park-on-miss/route-nudge work).
- **Cert-fingerprint pinning** — the phone re-pins the new box at cutover.
- **Replacement recipe mint** — the "Replace this server" entry already mints a same-name
  recipe; migration is its complete, data-aware form.
- **Admin master root** — sensitive-op authorization (`requireMasterAdmin`,
  `docs/device-admin-tier-spec.md`).
- **Provision-status / health surface** — the migration progress timeline (the hali
  status-surface design).
- **Deployment-form-agnostic** — the new box can be a USB appliance, the desktop **VM
  appliance** (`docs/desktop-vm-appliance.md`), or a native install; migration is
  identity+data+routing moving, indifferent to form. (So "move my server from an old Mac
  mini to a new one," or "from a USB box to a hosted VM," both work.)

## The glue to build (the gaps)

1. **A migration session/state-machine** (phone + a `.com` `migrations` lane) that
   sequences the phases and enforces the ordering (esp. release-before-claim and
   wipe-only-after-confirm).
2. **The data-restore handshake** — the new box waits for + restores the old box's *final*
   backup (not a stale one) before take-over, and emits a "restore OK" confirmation the
   fail-safe keys off.
3. **The replacement-recipe mint for an existing server** — same `serverDomain`/owner/
   admin-root, deterministic SWK; confirm it wires the old box's decommission.
4. **Cutover atomicity** — RCK re-point + cert claim + cert re-pin as one confirmed step;
   old wipes only after the new box reports "serving the name."
5. **Progress + abort UX** — a migration timeline on the server page, and a safe **abort**
   (before step 7 the old box is untouched-enough to resume serving).

## Downtime model

A **brief write-frozen window** at cutover (freeze → final delta → new claims). Reads may
blip during the routing cutover (seconds, handled by park-on-miss). True zero-downtime
**live replication** (streaming the DB so the freeze window disappears) is a **v2** — the
freeze-and-delta model is the pragmatic v1.

## Open questions / phasing

- **Final-delta mechanism:** exact "freeze + delta backup" for the data stack (postgres
  logical/physical delta; minio/forgejo state) vs a simpler "final full flush" for v1.
- **Concurrent-writes at freeze:** how the daemon quiesces services cleanly.
- **Abort semantics:** precise point-of-no-return (before step 7) and how the old box
  resumes serving if the migration is aborted.
- **Multi-pod servers:** a server that is already multi-pod (per-service leadership) —
  migrate one pod at a time vs the whole identity.
- **Phasing:** v0 = manual replace + full restore + `wipe-after-handoff` + manual RCK
  re-point (the pieces, lightly glued); v1 = the guided one-tap flow with the migration
  state machine + final-delta + auto cutover + abort; v2 = live replication (no freeze).
