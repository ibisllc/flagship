# Multi-pod liveness, per-pod sessions, and stable leadership — fixes

**Status:** design spec (no code yet). Surfaced live from `frank`/`leticia` on
`harry` (a fresh `frank` install on the box that used to run `leticia`; `leticia`
is now just turned off). Three independent client/directory bugs, none of them
secret-persistence (a fresh install regenerates every on-disk secret; the boxes
share only the phone-held account keys, by design).

## The three bugs (root causes, verified)

- **A — a turned-off box reads "online" forever.** `.com`'s `/pods` `state` is
  hardcoded `"online"` (= *registered*, `podInventory.ts:260`), and iOS
  `PendingServerReconciler.swift:84` surfaces "every registered server as
  `.online` — **REGARDLESS of liveness**" (it only drops `revokedAt` rows). There
  is **no heartbeat-freshness expiry**, so `leticia` (last STK-signed heartbeat
  ~3.5h ago, when its box was repurposed) still reads online. The signal to use
  already exists and is fresh: the 5-minutely daemon-status heartbeat populates
  `lastReported` (`frank` ~2 min, `leticia` ~3.5h).
- **B — only one server's in-app page loads; others say "Connecting."** iOS uses
  **one global `podBaseUrl`** (`PodSessionSync` writes a single base URL from the
  single resolved `currentPod`) **plus a single-active session token** (documented
  limitation). The public URL serves with no auth, but the authenticated
  server-detail BFF borrows that one global base URL + token, so any pod that
  isn't the anchor — or a fresh box whose pairing didn't overwrite the single
  token slot — fails the load → the `connecting()` placeholder
  (`ServerDetailScreen.swift:230`).
- **C — a new server auto-seizes leadership.** `.com`'s `listForUser` is
  `SELECT * FROM servers WHERE username = ?` — **no `ORDER BY`**, so `/pods` order
  is non-deterministic (it returned the *newest*, `frank`, first). `addPod`
  already guards (`if leaderPodId == nil`), so the bug is the **dangling-leader
  fallback**: when the persisted `leaderPodId` points at a pod that left the live
  set (e.g. an older box that got revoked → filtered out), `currentPod =
  currentPodId's pod ?? leaderPod ?? pods.first` falls through to `pods.first` =
  whatever `/pods` returned first = `frank`. No oldest-wins order, no stickiness.

---

## Fix A — heartbeat-freshness liveness (one source of truth)

**Signal:** `lastReported` (the STK-signed daemon-status heartbeat, ~5 min
cadence). It already lands for live boxes.

1. **`.com` computes liveness server-side** (`podInventory.ts`) so all three
   clients agree. Add a per-pod field — keep the existing `state` for wire
   compat, add:
   - `liveness: "live" | "unreachable" | "never"` and `lastSeenMsAgo: number | null`.
   - `live` ⟺ `lastReported != null && (now - lastReported) < FRESHNESS_WINDOW`.
   - `never` ⟺ registered but never reported (and not bridged-live) — a box still
     coming up.
   - `unreachable` otherwise (was live, now silent past the window — turned off OR
     a network blip; the UI says "last seen 3h ago", not "online" and not a hard
     "dead").
2. **`FRESHNESS_WINDOW` ≈ 3× the heartbeat cadence (~15 min)** — tolerates 2
   missed heartbeats so a healthy box never flickers; a turned-off box flips to
   `unreachable` within ~15 min.
3. **Provision-bridge caveat (must handle):** `podInventory.ts:198-210` already
   back-fills `lastReported` from the provision-status `"live"` phase for a box
   that serves but never POSTs a heartbeat — that value is **static** (set once),
   so a naive freshness check would wrongly mark such a box `unreachable` after
   the window. Distinguish *bridged* `lastReported` (→ classify `never`/
   "provisioned, awaiting first heartbeat", not `unreachable`) from a *real*
   heartbeat (→ apply the window). (Better long-term: make every box actually
   heartbeat — the tracked "daemon-status heartbeat not landing" item — then the
   bridge can retire.)
4. **Clients** stop trusting registration for liveness: iOS `PodInfo` gains
   `lastReported`/`liveness`; `PendingServerReconciler` sets `.status` (and the
   richer `livenessState`) from `liveness`, not "registered". The server card +
   the leader/anchor eligibility (Fix C) read the real signal. Webapp + Android
   mirror.
5. **Stronger signal (optional, future):** the tunnel hub's live registry is
   real-time (a turned-off box's tunnel drops immediately). A hub→`.com`
   connected-pod report would make liveness instantaneous instead of
   window-delayed — noted, not required for v1.

---

## Fix B — per-pod base URL + per-pod session token

A pod's base URL is **deterministic from its fqdn** (`https://<pod.fqdn>`), so the
single global anchor is simply wrong — there is no reason to store one.

1. **Per-pod base URL.** Drop the single `SessionStore.podBaseUrl` anchor for
   loads: when opening server X's detail, the screens client targets
   `https://<X.fqdn>` directly. (`PodSessionSync`'s single-anchor role goes away,
   or is reduced to a default-tab convenience only.)
2. **Per-pod session token.** Replace the single-active token slot with a
   **pod-keyed token store** (`sessionToken(forPodId:)`). Pairing — create-time
   pairing or a manual pair — writes *that box's* token under *its* pod id; a 2nd
   box no longer overwrites the 1st. Loading X's detail uses X's token. (Closes
   the documented "single-active slot" gap.)
3. **Honest states (no more catch-all "Connecting"):**
   - X `unreachable`/`never` (Fix A) → "offline — last seen …" / "still coming
     up", NOT "Connecting".
   - X has no stored token → "Pair this device with this server", NOT
     "Connecting".
   - X live + token + reachable → load; "Connecting" reverts to a true transient.
4. **All surfaces.** iOS + Android adopt the per-pod model; the webapp keys
   `podBaseUrl`/`sessionToken` per *profile* today (one anchor per account) — it
   needs the same per-pod split. Verify each.

---

## Fix C — deterministic + sticky leadership

The user's invariant: **first-ever server is leader; the last remaining after
deletions is leader; adding a new server never changes the leader.**

1. **Deterministic order:** `.com` `listForUser` → `ORDER BY registered_at ASC`
   (oldest first). Now `pods.first` is meaningfully the *oldest*, and every client
   list/leader fallback is stable.
2. **Leadership is sticky + heals deterministically.** `leaderPodId` persists.
   - Set once for the first server (`addPod`, already correct).
   - **Adding a new server never reassigns it** (already guarded — keep it).
   - Reassign ONLY when the current leader genuinely **leaves the registered set**
     (deleted/revoked, not merely offline — an offline leader may come back), to
     the **oldest remaining** (= `pods.first` after the ASC order).
   - The user can still explicitly `setLeader`.
3. **Kill the dangling-leader fallback.** Today `currentPod = leaderPod ??
   pods.first` silently promotes `pods.first` when `leaderPodId` doesn't resolve.
   Instead: on reconcile, if `leaderPodId` is absent from the live registered set,
   **explicitly re-anchor** it to the oldest remaining (deterministic with the new
   order) — don't let a transient resolution failure float leadership to whatever
   `/pods` happened to return first.
4. **(Clarify) what "leader" governs.** Confirm whether this `leaderPodId` is
   purely the iOS default-selected pod or also the routing leader (tier-2
   `<service>.<user>` leader-routing / RCK). If the latter, the sticky rule must
   also drive routing-leader selection so the two never disagree. (Open question
   below.)

---

## Sequencing, tests, surface

- **`.com` (smallest, highest-leverage, ship first):** `ORDER BY registered_at
  ASC` (Fix C.1) + the `liveness`/`lastSeenMsAgo` fields (Fix A.1-3). Pure
  additive; `podInventory` tests + a freshness-window unit test + the
  provision-bridge edge case. Rides the next Worker deploy.
- **iOS / Android clients:** `PodInfo.liveness` plumbing + reconciler change (A);
  per-pod base-URL + per-pod token store (B); sticky/heal leadership (C). XCTest /
  unit tests: a silent pod classifies `unreachable`; opening a non-anchor pod
  loads against its own fqdn+token; a new server doesn't change the leader; a
  removed leader re-anchors to the oldest.
- **webapp:** mirror A (render liveness) + B (per-pod podBaseUrl/token) + C
  (ordering already comes from `.com`).
- **Interaction with the decommission feature (just shipped):** orthogonal but
  complementary — decommission *removes* a replaced box (revoke+evict); these
  fixes make a *non*-decommissioned silent box read correctly, each server's page
  reachable, and leadership stable. A decommissioned box (revoked) is already
  filtered; an offline-but-registered box now reads `unreachable` instead of
  `online`.

## Open questions

- **Liveness window value** (15 min proposed) + the tri-state copy
  ("unreachable" vs "offline" vs "last seen …").
- **Does `leaderPodId` also drive routing-leader / RCK selection?** If yes, the
  sticky rule must be the single source for both.
- **Per-pod token migration:** how existing single-slot tokens migrate to the
  pod-keyed store (best-effort: attribute the current token to the current
  anchor's pod, re-pair others on demand).
- **Heartbeat reliability:** should v1 also push the "daemon-status heartbeat not
  landing" fix so `lastReported` is universally fresh (and the provision-bridge
  caveat retires)?
