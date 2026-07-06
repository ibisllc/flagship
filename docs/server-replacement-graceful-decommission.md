# Graceful server replacement & decommission hand-off

**Status:** design spec (no code yet). Author: this session. Depends on:
`docs/box-recipe-persistence-and-restore.md` (restore-onto-replacement),
`docs/lock-and-poweroff.md` (power primitives), the account-deletion self-delete
order (the durable-order template), peer-backup (`backupLoop.ts`), the tunnel hub
(`apps/web/src/tunnel/registry.ts`, `tunnelHub.ts`).

---

## 1. Problem

Two boxes that claim the same FQDN (same `podCanonical`) **fight for the route**.
The hub registry is keyed by `podCanonical`, last-registration-wins
(`registry.ts register()`: `tunnels.delete(pc)` then `tunnels.set(pc, new)`), and
tunnels reconnect on every network blip — so two live boxes ping-pong the route,
serving **divergent data** off their separate disks (split-brain), and both run
ACME for the same name (LE duplicate-cert limit churn). This happens whenever a
recipe is re-issued and a second box is booted while the first is still alive —
e.g. a reburn-in-place, a migration to new hardware, or a returning zombie.

Today the only thing stopping this is a human remembering to power the old box
off first. We want an **enforced hand-off**: replacing a server first *retires*
the box that holds the spot — flush a final backup, release routing, power off —
and only then lets the replacement claim the name.

## 2. Goals / non-goals

**Goals**
- Replacing a server issues a **decommission order** for the incumbent box
  *before* the replacement can claim the route.
- The order survives the incumbent losing routing (delivery is **outbound**, not
  inbound-served).
- The incumbent flushes a final peer-backup **without needing routing**, so the
  replacement can restore continuous data.
- A returning **zombie** self-retires instead of re-entering the fight.
- **The platform cannot evict a user's box.** Only an owner-IRK-signed order
  causes a box to release/power-off. `.com` and Fly may *store, deliver, replay,
  and hint* — never *authorize*.

**Non-goals**
- Not zero-downtime. A brief gap (old flushes + powers off → new restores +
  serves) is acceptable for a replacement; live failover/HA is out of scope.
- Not a new transport. Reuse the existing `.com` mailbox + the daemon's outbound
  heartbeat poll + peer-backup; add records and one order type, not a new pipe.

**Disk disposition is a CHOICE, not fixed.** Decommission always does
final-backup (if enabled) + release-routing + power-off; what happens to the disk
is a signed parameter (§6a). Wiping is *encouraged* for retired/repurposed/
discarded hardware — it is the strongest anti-zombie guarantee (a wiped box has no
data and no keys, so it can never re-enter the fight) and the right data-at-rest
hygiene. The only rule is **wipe strictly after the data is safely elsewhere**
(see §6a) — this is NOT the unconditional account-deletion `servers-self-delete`
wipe, which destroys data with no continuity.

## 3. Trust & threat model — the invariants

The data plane (`.services`/Fly) and the identity plane (`.com`) are
**content-blind and untrusted for authority**. The phone (owner IRK) is the only
trust root. Therefore:

- **I1 — Owner-signed-or-inert.** Every box state change (release routing, power
  off) fires ONLY on an envelope verified against the box's config-pinned
  `cfg.irkPublicKey`. A bare signal from Fly/`.com` ("you've been replaced") is at
  most a *hint to go fetch your signed order now* — never the authorization.
  Consequence: a malicious/compromised `.com` or Fly can at worst cause a box to
  *poll* (a self-DoS bounded by the poll), never to retire.
- **I2 — Instance-bound (replay-safe).** The order names the SPECIFIC instance it
  retires (that box's **STK pubkey**) + `issuedAt` + `nonce`. A box acts only if
  the order names *its own* STK. The replacement (a different STK, minted fresh at
  its first boot) ignores every order aimed at the predecessor — so a replayed old
  order can never retire the new box.
- **I3 — Backup ≠ routing.** Releasing routing must NOT disable the box's ability
  to *deposit its own backup*. The two credentials are separate (routing =
  RootEntitlement on the hub; backup = STK challenge-response over the box's own
  `serverId`-keyed namespace). A retired box can still flush to its own namespace;
  it just can't serve.
- **I4 — Durable + idempotent.** The order lives in `.com` D1; the box consumes it
  via its normal outbound poll and marks it locally so replays are no-ops.

## 4. Key insight: the closeout is entirely OUTBOUND

A dying/retired box cannot be *reached* (its inbound route is gone), but it can
still *reach out*:

- to **`.com`** (flagshipserver.com over plain outbound HTTPS — independent of the
  tunnel/SNI route) to pull its closing order and to report progress;
- to **peer-backup targets / the matchmaker** to push its final chunks, proving
  "this is *my* namespace, take it" with its STK — no routing entitlement needed.

So both *order delivery* and *final backup* ride channels that do not depend on the
box being routable. This is the architectural pivot that makes the whole thing
work, and it's why "revoke routing first, then ask it to back up + power off" is
safe rather than self-defeating.

## 5. Happy-path flow (replace a live box X with a new box Y, same FQDN)

```
phone                         .com (D1)                 box X (incumbent)         hub (Fly)            box Y (new)
  │ 1. owner taps "Replace"                                                                          
  │ 2. mint server-decommission(STK_X, action, nonce)  ── owner-IRK-signed ──┐                       
  │ 3. POST order ──────────────▶ store order (durable) │                    │                       
  │                             revoke STK_X entitlement │                    │                       
  │                             (add to hub revoked set) │                    │                       
  │                                          ┌───────────┘                    │                       
  │                          4. heartbeat poll picks up order (≤5 min;        │                       
  │                             or hub NACKs X's next register → "replaced,   │                       
  │                             go check .com now" hint accelerates it)       │                       
  │                          5. X verifies owner-IRK sig + STK==me            │                       
  │                          6. X: final peer-backup flush (epoch N) ─────────┼──▶ peers / .com       
  │                          7. X reports "final-backup epoch N complete" ───▶│                       
  │                          8. X releases route + powers off (executeLockAndPower, NO wipe)          
  │ 9. owner mints Y's recipe (same FQDN), burns/boots Y                                              
  │10. Y first-boot: gen-identity (STK_Y) → entitlement relay → owner approves ──▶ .com authorizes STK_Y
  │11. Y restores from backup namespace at epoch N (re-derives SWK from UMK) ◀── peers / .com         
  │12. Y registers on hub (X is revoked/gone) → clean, sole claim ──────────────────────────▶ serves 
```

If X is **already dead** at step 1: steps 4–8 simply don't happen now; the order
*waits* in `.com`. The hub revocation (step 3) already stops a returning zombie
from stealing the route, and when the zombie does reboot and poll (step 4) it
self-retires. Y restores from the last backup X managed before dying.

## 6. The `server-decommission` order

A new owner-IRK envelope (`packages/protocol`), byte-identical TS/Swift/Kotlin,
pinned vector. Canonical bytes (sketch):

```
flagship/server-decommission/v1
  | podCanonical            (the FQDN being handed off)
  | retiredStkPubHex        (I2 — the SPECIFIC instance to retire)
  | finalBackup             ("yes" | "no")        — flush epoch before releasing
  | diskDisposition         ("keep" | "wipe-after-handoff" | "wipe-now")  — §6a
  | backupEpoch             (monotonic; the final-flush target — see §9)
  | nonce
  | issuedAt
```

- Signed by owner IRK; the box re-verifies under `cfg.irkPublicKey`. The order is
  **self-contained and self-authorizing**: a box that receives it (by ANY channel)
  and verifies sig + STK-match executes it directly — it never has to call back to
  ask "what does the owner want?" (that's the whole instruction).
- `retiredStkPubHex` is the load-bearing replay guard (I2). The order is inert on
  any box whose STK ≠ `retiredStkPubHex`.

### 6a. Disk disposition

The disposition rides *in the one signed order* (so a single message drives the
whole closeout). All three release routing + stop serving immediately:

- **`keep`** — power off, data intact. For reburn-in-place (the reburn re-LUKSes
  the disk with a fresh key anyway → effectively scrubbed) or when the owner wants
  a local fallback copy. Lowest friction; leaves a powered-off box that *could* be
  re-powered (it self-retires via the durable order if so).
- **`wipe-after-handoff`** (recommended for retiring hardware) — final-flush →
  release + go **idle** (de-routed, powered, data intact) → wait (bounded) for
  `.com` to confirm *the replacement restored successfully* → then wipe + power
  off. **Fail-safe:** if the confirm never arrives within the window, power off
  **without** wiping (keep the data as the fallback). This keeps the old disk as a
  safety net until the new box is *proven*, then scrubs it — the strongest
  anti-zombie + best hygiene with no data-loss window.
- **`wipe-now`** — final-flush → wipe → power off, no wait. Accepts the backup as
  the sole copy. For "discard/compromised hardware, get it gone now" urgency.

Wipe reuses the account-deletion `realWipeContent` machinery (stop data-services,
`docker compose down -v`, prune, drop the app-data tree) **plus** scrubbing the
box's own key material so a wiped box is inert. A `wipe-*` order with
`finalBackup:"no"` is only valid when the owner has explicitly accepted data loss
(the client gates this — see §11.4).

## 7. Delivery channels

The signed order is **self-authorizing**: whichever way it arrives, a box that
verifies sig (I1) + STK-match (I2) runs the **whole** closeout directly — it never
calls back to ask "what does the owner want?" (the order already says everything:
backup-or-not, disk disposition). So these are just *carriers* of the same bytes.

1. **The eviction message itself, replayed by the hub (the fast path — "receiving
   it is enough").** When X tries to (re)register and its entitlement is revoked,
   the hub returns a typed `replaced` NACK **carrying the owner-signed order blob**
   — Fly is replaying bytes it cannot forge. X verifies + STK-matches and
   immediately executes. This is exactly the model from the discussion: *one
   signed message sets the whole thing in motion, no second inquiry.*
2. **Durable in `.com`, pulled outbound (the offline fallback).** The identical
   signed order is also stored in a `server_decommission_orders` lane (or
   `secret_mailbox` `purpose:"decommission"`, mirroring the self-delete deposit)
   and fetched by the daemon's heartbeat poll (`GET /api/server/:domain/
   decommission`, consume-once, **revoke-tolerant**). This covers X being
   **offline/dead** at eviction (it picks the order up whenever it next boots +
   polls — and self-retires instead of re-joining the fight) and any missed hub
   delivery.

Both carry the same bytes; the box's action is identical. The **only** thing that
must hold (so this is safe, per §3): the trigger is the *signed order*, not a bare
unsigned NACK reason. A bare reason alone at most nudges X to poll — so a
malicious hub can't evict (I1) — and the per-instance STK-binding means a replayed
old order is inert on the new box (I2). Within those two guards, your instinct is
exactly right: **the signed eviction message is the whole trigger.**

## 8. Routing supersede (stop the fight)

- **Mechanism that already exists:** the hub accepts an optional **revoked
  entitlement-cert-id list per user** (`tunnelHub.ts` opts) and the entitlement
  carries a cert id. Decommission = `.com` adds STK_X's entitlement cert id to
  that revoked set. The hub then **NACKs X's HELLO** → X can't register → can't
  steal the route. This is the enforcement layer independent of whether X
  cooperates with the graceful order.
- **Authorized-instance bookkeeping:** `.com` tracks, per `podCanonical`, the
  current authorized STK (set when an entitlement is approved; superseded ones go
  to the revoked set). Y's entitlement approval (step 10) makes STK_Y current.
- **Availability trade-off (pitfall — see §11):** the hub revocation check must
  decide fail-open vs fail-closed when `.com` is unreachable. Recommend: keep the
  *signature* check fail-closed (already is), but treat the *revocation* lookup as
  fail-open with a short TTL cache — a momentary `.com` outage must not brick the
  whole fleet's ability to register; the worst case on fail-open is a brief flap
  window the order/zombie-poll still closes.

## 8b. Bounding the state: generations, GC, and the successor-carried lineage

A permanent per-FQDN revoked-set on `.com`/the hub would grow forever. We don't
keep one: **the revocation proof lives on the heir and the phone, and the hub's
knowledge of it is ephemeral** — rebuilt from what the connecting box presents,
purged when that box goes offline. Decision (owner, this session): carry the
**FULL chain** of predecessor evictions, not just the latest.

- **L1 — the heir presents its full eviction chain; the hub holds it ephemerally
  (the adjudicator).** On connect, the legitimate box presents its owner-signed
  entitlement **+ the signed evictions of ALL prior tenants of this FQDN**. The hub
  honours those revocations only while that box is connected and **purges them on
  disconnect** — so no permanent hub/`.com` state ever accumulates (your "it's
  purged out of Fly when the server goes offline" point). Because the chain is
  *complete*, a race from **any-depth** predecessor (not just the immediate one) is
  rejected by explicit owner-signed proof — which means the eviction chain is
  **self-sufficient and a monotonic generation counter is NOT required** (gens can
  stay only as an optional compact tie-break). Cost is trivial: a few hundred bytes
  per eviction, an empty list for ~everyone, borne only by rare re-provisioners.
- **L2 — the phone is the durable owner-side memory.** The phone **remembers every
  box it evicted** per FQDN. This (a) powers L3, and (b) lets it **re-hand the full
  chain to each new replacement**, so a fresh box inherits all prior evictions even
  though it never met those boxes. The phone is the source of truth; the box carries
  a working copy to present; `.com` need not retain anything long-term.
- **L3 — the phone retires the old instance (encryption-only, strongest).** The
  replacement flow **removes X from the phone's box list / marks it decommissioned**,
  so a rebooting encrypted zombie's disk-unlock request is *not surfaced / declined*
  — it can't boot to start the fight at all. This is the keystone that closes the
  lone-zombie case below.

**GC.** `.com` can delete the eviction order once **(old box ACKed consume OR a
timeout)** AND **(the new box connected + ACKed it holds the full chain)** AND
**time T** — because the proof now lives on the heir + the phone, and the hub
rebuilds its transient revoked-knowledge from the heir's presented chain on every
connect.

**The honest edge (so we don't over-claim).** The chain protects whenever the
**legitimate box is online to present it** — i.e. every *concurrent* race, fully.
It can't help when the legit box is **offline** and a **lone** zombie returns
(nobody is there to present the chain, and `.com` may have GC'd it).

- **Encrypted boxes: fully closed by L3** — the zombie can't unlock without the
  phone, and the phone forgot it. So GC-after-T is sound *for LUKS boxes*.
- **No-LUKS boxes: residual gap** — they boot without phone approval, so a
  lone-returning zombie with the successor offline + the eviction GC'd could serve
  stale data. Mitigation: for `diskEncryption:"none"` keep the revocation longer
  (don't GC as eagerly, or never), or accept it as part of the lower-assurance
  no-LUKS tier. **GC eagerness is therefore encryption-conditional**, not universal.

## 9. Backup without routing (I3) + the hand-off barrier

- **Credential decoupling.** Peer-backup already authenticates the depositor by
  **STK challenge-response** over its own namespace (`peerBackup/registry.ts`
  ownerStkPub; matchmaker `verifyPbAnnounce/RequestPeers`), and chunks are sealed
  with the **SWK** (`encryptChunk(content, swk)`). None of that consults the
  routing entitlement, so a routing-revoked box can still push its final flush.
  **Action item:** audit every peer-backup / matchmaker accept path to confirm it
  gates on "owns this namespace" (STK/SWK), *not* on a live routing entitlement,
  and fix any that conflate them — else step 3 would break step 6.
- **Backup epochs.** Because the same `serverId` namespace is written by X (final
  flush) and then by Y (after restore), tag backup generations with a monotonic
  **epoch**. X's final flush is epoch N; Y restores *at epoch N* and writes epoch
  ≥ N+1. This prevents Y from restoring a half-written flush and prevents X and Y
  writes from interleaving into one ambiguous state.
- **The barrier.** With `action=final-backup-then-poweroff`, Y must not serve
  authoritative data until X's "epoch N complete" is recorded at `.com` (step 7).
  Y polls for it, restores, then serves. If X never confirms (died mid-flush), Y
  restores the last *complete* epoch and the owner is told the tail may be lost.

## 10. Box-side consumer (`decommissionConsumer`)

Mirror `selfDeleteConsumer` (the proven shape), minus the wipe:

1. Poll `GET /api/server/:domain/decommission` (revoke-tolerant) on the heartbeat,
   or react to the hub `replaced` NACK.
2. Decode + **verify owner-IRK signature** under `cfg.irkPublicKey`. Reject
   forged/wrong-account/junk without acting (the self-delete consumer's 10-case
   test set is the template).
3. **STK gate (I2):** ignore unless `retiredStkPubHex == myStk`.
4. **Idempotency:** a local marker (`/var/flagship/decommissioned`) — re-delivery
   is a no-op.
4a. **Transfer guard:** abort if a transfer-a-box is in progress for this box (§11.13).
5. If `finalBackup`: trigger an immediate `backupLoop` flush at `backupEpoch`;
   report "epoch N complete" to `.com`.
6. Release routing (drop the tunnel), then apply `diskDisposition` (§6a):
   - `keep` → `executeLockAndPower` (poweroff, suppress auto-unlock). No wipe.
   - `wipe-now` → `realWipeContent` + key-scrub, then poweroff.
   - `wipe-after-handoff` → go idle; on `.com`'s "replacement restored" confirm,
     `realWipeContent` + key-scrub + poweroff; on timeout, poweroff WITHOUT wiping
     (data stays as the fallback).
   All paths converge on the lock-and-poweroff latch (§11.14).

## 11. Pitfalls & side effects (the part to read twice)

1. **Replay against the new box (critical).** Without I2's STK binding, replaying
   X's order would retire Y at the same FQDN → nothing serves. STK-binding +
   `nonce`/`issuedAt` are mandatory, not optional.
2. **Platform-evict (critical).** If the hub NACK could *by itself* power a box
   off, Fly/`.com` could evict any user at will. I1 forbids it — the NACK only
   triggers a fetch of a signed, verified order.
3. **Revoking routing breaks the final backup** if peer-backup accept paths gate
   on the routing entitlement. Must be decoupled (I3 / §9 audit) — otherwise step
   3 silently defeats step 6 and you lose the tail data.
4. **No backup enrolled → silent data loss.** `action=final-backup-...` is
   meaningless if peer-backup was never set up. The phone flow MUST pre-flight:
   "this server has no backup; replacing will lose its data — continue / set up
   backup first." Hard gate, not a toast.
5. **Compromised/buggy incumbent can't be trusted to flush honestly.** "epoch N
   complete" is the box's own claim. For `keep`/`wipe-after-handoff` this is
   tolerable (the disk survives as a fallback until the replacement is proven). But
   **`wipe-now` is unforgiving** — a wrong "complete" + immediate wipe = permanent
   loss, no fallback. So `wipe-now` should require the stronger guarantee (backup
   *targets* attesting receipt to `.com`, or a verify-restore-before-wipe), while
   `wipe-after-handoff` is the safe default (it only wipes after the *new* box
   confirms a good restore). v1 may ship `keep`/`wipe-after-handoff` and gate
   `wipe-now` behind that attestation. Don't pretend any of it is atomic.
6. **Abort / change-of-mind.** Once X is revoked it may already be powering off. A
   pending decommission must be **cancellable** before power-off (re-authorize
   STK_X: remove from the revoked set, deposit a signed `decommission-cancel`).
   After power-off the only "undo" is to re-burn — document it.
7. **`.com` down during a HELLO.** Fail-closed revocation bricks registration
   fleet-wide on a `.com` blip; fail-open risks a brief flap. Recommend fail-open
   with TTL cache (§8).
8. **Downtime window.** Between X-release and Y-serve the FQDN is dark (SNI
   passthrough has no box → TLS won't complete). Acceptable for replacement; set
   owner expectations ("your server will be briefly offline during the switch").
9. **Cert churn / LE limits.** Each box ACMEs the same name; rapid
   replace/reburn cycles can hit LE's ~5 duplicate-certs/week. Y reusing X's cert
   key (it can, via the recipe/key continuity) or simply not churning avoids it;
   flag for the restore-flow design.
10. **Multi-admin race.** Two admin phones could issue decommission + cancel (or
    two decommissions) concurrently. Orders are owner-IRK-signed (shared identity);
    `.com` must serialize per `podCanonical` (last-writer or a CAS on the
    authorized-STK record) and the box obeys the highest `issuedAt`.
11. **Generation skew on the hint.** The hub must only NACK-`replaced` the STK it
    actually superseded; if it blanket-NACKs the `podCanonical`, it could hit Y.
    The NACK is keyed by STK, and Y's STK is current → never NACKed.
12. **Order outlives the FQDN.** If a `podCanonical` is later reused for a totally
    different purpose, a very old undelivered decommission order must not fire on a
    new box — I2 (STK binding) already covers this, but `.com` should also expire
    stale undelivered orders.
13. **Interaction with transfer-a-box.** A box that's being *given away*
    (namespace migration) must not be decommissioned out from under the acquirer.
    Decommission targets the *retiring* STK at the *owner's* podCanonical; a
    transfer re-homes to a new owner. Ensure the two flows are mutually exclusive
    per box (a transfer-in-progress blocks decommission and vice versa).
14. **Dead-man overlap.** A box already mid dead-man lockout shouldn't also be
    chasing a decommission; both end in `executeLockAndPower`, so converge them on
    one local "powering-down" latch to avoid double-fire / log noise.

## 12. Surface to build

- **protocol:** `server-decommission` (+ `decommission-cancel`) envelopes +
  vectors (TS/Swift/Kotlin).
- **storage (`.com`):** a decommission-order lane (new table or `secret_mailbox`
  `purpose:"decommission"`); the per-`podCanonical` authorized-STK + revoked-cert
  bookkeeping (likely extends the servers/routing tables); D1 + InMemory + parity.
- **control-plane (`.com`):** deposit (IRK-mailbox-auth) + consume-once
  revoke-tolerant GET + the "epoch N complete" report + cancel; populate the hub's
  revoked-entitlement set on deposit.
- **hub (`apps/web`):** consult the revoked set on HELLO (fail-open TTL); typed
  `replaced` NACK carrying the signed order; keyed by STK.
- **daemon:** `decommissionConsumer` (poll + verify + STK-gate + final-flush +
  `executeLockAndPower`, no wipe); peer-backup accept-path decoupling audit; epoch
  tagging in `backupLoop`.
- **clients (iOS/Android/webapp):** the "Replace this server" flow — backup
  pre-flight gate, mint + deposit the signed order, watch X retire, then mint Y's
  recipe (ties into the recipe-regeneration work in
  `box-recipe-persistence-and-restore.md`); a "cancel pending replacement" affordance.

## 13. Build phases

1. **Protocol + `.com` order lane + revoke wiring** (no client) — deposit/consume,
   hub revocation populated, tests. The fight stops here (revocation alone).
2. **Daemon `decommissionConsumer`** (poll + verify + STK-gate + power-off, no
   backup yet) — graceful self-retire. Reburn-gated for live validation.
3. **Backup decoupling audit + epochs + the barrier** — data continuity.
4. **Client "Replace server" flow + pre-flight gate + cancel** — the owner UX.
5. **Hub `replaced` NACK accelerator** — latency polish (optional; the poll
   already works).

## 14. Open questions for the owner

- **Should decommission ALWAYS try a final backup,** or only when the owner opts
  in per-replacement? (Default: try if backup is enrolled, else hard-gate.)
- **Backup-receipt attestation** (pitfall 5): worth the complexity for v1, or
  accept best-effort continuous backup?
- **Cancel window:** how long does `.com` hold a deposited decommission before the
  box is assumed retired and Y is cleared to claim? (Proposed: Y waits for X's
  "released" report OR a timeout, whichever first.)
- **Cert key continuity** on replace (reuse X's cert key on Y to dodge LE limits)
  vs. a clean per-box key — decide alongside the recipe-regeneration design.
- **Revocation check fail-open vs fail-closed** on `.com` outage (§8/pitfall 7).
- **GC eagerness (§8b):** GC the eviction order after acks + T for LUKS boxes
  (sound — L3 closes the lone-zombie case), but keep it longer / forever for
  no-LUKS? Confirm the encryption-conditional GC policy + the value of T.
- **Lineage depth — DECIDED (full chain).** The heir carries every predecessor's
  eviction; the phone remembers all of them. (Self-sufficient proof; trivial cost.)
- **Generations — now optional.** The full chain adjudicates any-depth race without
  a monotonic counter; keep generations only if a compact tie-break is wanted.
  Open: is the marginal compactness worth the issuance-monotonicity bookkeeping?
