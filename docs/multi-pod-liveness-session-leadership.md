# Multi-pod liveness, per-pod sessions, and per-service leadership — fixes + gossip

**Status:** Phases 1-6 BUILT + CI-green (bug fixes + the full gossip broadcast path
+ CGK post-boot provisioning + owner-vote UI + `.com` lead relay). A box-side
**reburn** is the remaining live validation (CI proves the units + cross-platform
byte-compat, not the physical fan-out). Surfaced live from
`frank`/`leticia` on `harry` (a fresh `frank` install on the box that used to run
`leticia`; `leticia` is now just turned off). Three independent client/directory
bugs, none of them secret-persistence (a fresh install regenerates every on-disk
secret; the boxes share only the phone-held account keys, by design). The fix for
the third bug grows into a full, `.com`-independent, per-service leadership system.

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
  set, `currentPod = currentPodId's pod ?? leaderPod ?? pods.first` falls through
  to `pods.first` = whatever `/pods` returned first = `frank`. No oldest-wins
  order, no stickiness — and, more deeply, **the client is inventing a leader at
  all**, which it should never do.

---

## Fix A — heartbeat-freshness liveness (one source of truth)

**Signal:** `lastReported` (the STK-signed daemon-status heartbeat, ~5 min
cadence). It already lands for live boxes.

1. **`.com` computes liveness server-side** (`podInventory.ts`) so all three
   clients agree. Keep the existing `state` for wire compat, add:
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
   leader/anchor eligibility (Fix C) read the real signal. Webapp + Android
   mirror.
5. **Stronger signal (optional, future):** the tunnel hub's live registry is
   real-time (a turned-off box's tunnel drops immediately). A hub→`.com`
   connected-pod report would make liveness instantaneous instead of
   window-delayed — noted, not required for v1. (The gossip system below makes the
   *boxes* learn each other's liveness in real time regardless.)

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

## Fix C — per-service leadership by gossip (+ a "preferred server" default)

The reframe that fixes Bug C properly: **there is no global "leader of all
servers."** Machines are independent; a global boss is a fiction. There are only
two real things, and conflating them is what produced the bug.

1. **Per-service lead — the routable truth.** For each service `slug--author`, the
   lead is the **highest-clout live server that actually runs it**. That is what
   `<service>.<user>` routes to. Computed locally by every box from gossip.
   Different services may have different leads; the common case (one box runs
   everything) just makes one box lead everything — an *outcome*, never an
   assumption.
2. **Preferred server — a frontend default + a clout signal, NOT a role.** The
   server the phone prefers and shows as "your server." Its only effects: (a) the
   UI's default selected pod, and (b) the owner's vote raises that server's clout
   so it wins per-service leadership wherever it runs.

This kills Bug C at the root: the client never invents a leader. It *reads*
per-service leads the servers computed, and "current server" is the
preferred-server default, not `pods.first`.

### C.0 — Clout (the deterministic ranking every box computes)

Over the **live** members running a given service, highest clout wins:

1. **Most-recent owner vote.** A server holding an owner-signed preferred-server
   designation outranks all un-voted servers; among voted, the **newest
   `issuedAt`** wins.
2. **Oldest birth certificate.** The owner-IRK signature that admitted the box to
   the cloud — the **immutable create-time authCode** (signed once, dated,
   tamper-proof). The most *senior* box wins by default. This **replaces the old
   `.com` `registered_at` ordering**: seniority is now a signed, verifiable,
   `.com`-independent fact, not a mutable DB field.
3. **Alphabetical** (server identity / domain) — the (≈impossible) exact-tie
   breaker.

A pure function of signed inputs → every box computes the same answer → agreement
with no coordinator. "Free-for-all with jitter, but only claim if you outrank the
current holder."

### C.1 — The gossip system (`broadcast--user`)

The servers of a cloud tell each other, continuously, everything needed to compute
clout + per-service leads — **without the phone wiring up siblings, and without
`.com` being the authority.**

- **Each box periodically announces** (the gossip payload):
  `name N · authkey A + birth-date D · owner-vote V + date (if any) · services
  [slug--author, …] · liveness`.
- **Transport — `https://broadcast--user.flagship.services`:** a reserved
  per-account fan-out name (keep the ugly `--`; it's a machine URL). It **cannot
  be SNI-passthrough** — it targets N boxes, not one — so the **hub terminates its
  TLS** (a `*.flagship.services` wildcard cert covers it) and **fans the POST body
  to every connected box of `<user>`** over their tunnels.
- **Content-blind via a shared secret.** The body is symmetric
  encrypted+authenticated with the **Cloud Gossip Key (CGK)**, so the hub fans an
  **opaque blob** and learns only metadata (account, size, timing) — consistent
  with "Fly is content-blind." CGK is **derived, not stored**:
  `CGK = HKDF-SHA256(umk.seed, "flagship.cloud-gossip.v1", 32)`. Every box —
  including one created months later — derives the identical key; the phone can
  always recompute it; nothing is escrowed. (DOTS-tagged like the box SWK,
  deliberately distinct from it.)
- **Returns nothing.** Fire-and-forget. A box learns its siblings only from the
  *incoming* broadcasts the hub delivers to its own inbound endpoint — no
  membership count or liveness leaks back through the reply.
- **Bootstrap = mesh, steady-state = star.** On coming online, or when a service
  has no live lead, boxes broadcast freely (mesh) to discover each other; once a
  per-service lead is settled, the churn drops toward a star (only the lead must
  keep announcing for that service). **No phone-provided sibling list required** —
  the broadcast finds them. **Self-hosted without Fly** = the owner wires sibling
  reachability manually (the documented trade-off of going Fly-less).

### C.2 — Claiming the route (gentleman's agreement + the loser yields)

Per-service leadership becomes *real* routing by the lead claiming
`<service>.<user>` at the hub. The hub stays **dumb and content-blind**:

- **Grant-on-capability.** The hub grants the route to any claimant that proves
  it's an entitled, non-evicted server of the account running that service — the
  **existing HELLO entitlement check + the decommission eviction check**. The hub
  does NOT judge leadership and its **last-write-wins is left untouched** (minimal
  surgery, no new hub failure mode). Domain management is harness code, not the
  vibecoded app — so we can assume peaceful, restrained claims.
- **The daemon rule (each gossip round, per service it touches):** *if I am the
  highest-clout live runner of S and don't hold the route → claim it; if I am NOT
  and I currently hold it → release it.* The **release half** is what kills the
  original flap: frank/leticia fought forever only because nothing ever yielded
  (no liveness, no gossip, last-write-wins forever). Now a transient double-claim
  (failover, partition-heal) **self-heals in one gossip round** when the loser
  sees it's outranked and yields.
- **Letters of support (documented escalation, NOT built):** if we ever distrust a
  daemon to yield, or a real race bites, the lead could present a quorum of
  signed sibling endorsements the hub verifies. Unneeded for v1
  (harness-controlled daemons on the owner's own hardware + loser-yields closes
  the window). Cheap middle ground if wanted: the claim HELLO already carries the
  claimant's signed birth-date/vote, so the hub could refuse to replace a holder
  with a **provably lower-clout** claimant — a comparison of two signed
  timestamps, default off.

### C.3 — The owner's vote (preferred-server designation)

- The owner signs `flagship/set-leader/v1` (owner IRK:
  `user | preferredStkPubHex | issuedAt | nonce`; `"none"` clears) and delivers it
  to the boxes (via `.com` deposit and/or the broadcast). It is a **clout input,
  not a command**: the designated box includes the vote in its gossip; everyone
  recomputes; the designee — now highest-clout wherever it runs a service —
  claims those routes (loser-yields hands them over).
- **The vote rides the claim:** when the designee claims a route it presents the
  signed vote; the yielding box verifies it and steps down. The vote needs no
  separate authoritative channel — it's the top tier of clout, justified by the
  claim it rides on.
- **Lifecycle:** the vote wins only while its server is **live and runs the
  service** (a dead/absent designee just loses the clout contest → normal
  seniority resumes); a **newer** vote beats an older; `"none"` reverts to pure
  seniority. The UI shows the designee as the **preferred server** immediately and
  as the per-service **lead** once it has claimed; the brief "becoming → leader"
  is the claim landing, not a heavyweight ceremony.

### C.4 — What `.com` and the clients do (relay, not authority)

- The boxes are canonical. **`.com` relays** the gossip-computed per-service leads
  + the preferred-server designation to the clients for display (or clients read
  leads directly from the boxes). **If `.com` is down, the boxes still elect +
  route among themselves** over the broadcast — leadership survives a `.com`
  outage, which is the whole point of grounding it in the boxes.
- Clients **read** the preferred-server (default pod) + per-service leads; the iOS
  `pods.first`/sticky/dangling-leader guessing is **deleted**.

### C.5 — Protocol artifacts (cross-platform: TS/Swift/Kotlin byte-identical + pinned vectors)

- **CGK** — `HKDF-SHA256(umk.seed, "flagship.cloud-gossip.v1", 32)`.
- **Gossip announcement** — canonical bytes
  (`flagship/gossip/v1 | user | name | birthAuthHex | birthDate | voteStkHex |
  voteDate | services(joined) | liveness | issuedAt`), **HMAC-SHA256'd with CGK**
  (authenticity among siblings) and CGK-encrypted for transport.
- **`flagship/set-leader/v1`** — owner-IRK preferred-server vote
  (`user | preferredStkPubHex | issuedAt | nonce`; `"none"` clears). Mirrors the
  `server-decommission` envelope shape.
- **Clout ranking** — the pure C.0 function, so box, phone, and `.com` relay all
  agree byte-for-byte on who leads.
- **Birth certificate** — the create-time owner-IRK authCode is the seniority
  source; define its canonical birth-date extraction.

---

## Sequencing, tests, surface

Build smallest→largest. **Phases 1-2 alone close all three reported bugs;** 3-6
add the gossip leadership system.

- **Phase 1 — `.com` directory truth (Fix A):** `liveness`/`lastSeenMsAgo`
  server-side + the provision-bridge caveat + a deterministic display order.
  `podInventory` tests + a freshness-window unit + the bridge edge case. Closes
  Bug A's directory half for every client at once. *(Pure additive, `.com` only.)*
- **Phase 2 — clients consume (Fix A display + Fix B + Fix C-read):**
  `PodInfo.liveness` plumbing + the reconciler change (stop "REGARDLESS of
  liveness"); per-pod base URL + per-pod token store; **delete the
  `pods.first`/sticky/dangling-leader guess** → render liveness + read the
  relayed preferred-server / per-service leads. iOS + Android + webapp. **This
  alone resolves all three reported bugs** (Bug C is gone the moment the client
  stops inventing a leader).
- **Phase 3 — protocol foundation:** CGK, gossip announcement (HMAC + encrypt),
  `set-leader` vote, clout ranking, birth-cert date — TS/Swift/Kotlin +
  pinned vectors. Pure, no live wiring; unblocks everything below.
- **Phase 4 — the broadcast fan-out:** the hub's `broadcast--user` TLS termination
  + content-blind per-account fan-out (returns nothing) + the reserved-name
  carve-out (a user can't create `broadcast`/`servers`/`all`). Hub/`.com` tests for
  fan-out scoping + payload opacity.
- **Phase 5 — the daemon gossip + claim/yield:** the box gossip loop (announce +
  receive + decrypt + compute per-service leads) + the claim/yield rule against
  the hub. Reburn-gated for the live loop; unit-tested with a mocked transport
  (convergence, loser-yields, clout ties, a dead-sibling re-elect).
- **Phase 6 — owner vote UI + relay:** the "Set preferred server" action (sign
  `set-leader`) + the "preferred / becoming / lead" display, all three clients;
  `.com` relay of the computed leads + the designation. Reburn-gated live.

**Interaction with the decommission feature:** orthogonal but complementary —
decommission *removes* a replaced box (owner-signed eviction at the hub); this
makes a *non*-decommissioned silent box read correctly, each server's page
reachable, and leadership a real, gossip-held, owner-tilted property. The eviction
check the hub already does for decommission is exactly the "non-evicted" half of
C.2's grant-on-capability — they compose cleanly.

## As-built status (this branch)

**Phases 1-5 are built + CI-green** (all three reported bugs fixed; the full
gossip path built and unit-tested):

- **Phase 1 (`.com` Fix A):** `liveness`/`lastSeenMsAgo` + oldest-first order on
  `/pods`; `FRESHNESS_WINDOW = 15 min`; bridged `lastReported` classified `never`
  (not `unreachable`). control-plane tests green.
- **Phase 2 (clients):** webapp + iOS (1229 XCTests) + Android (1124) — honest
  liveness states, per-pod base URL + per-pod token store (keyed `pod-<fqdn>`, with
  a legacy-token migration), and the `pods.first`/dangling-leader guess **deleted**
  (a new box can no longer seize leadership; a dangling leader re-anchors to the
  oldest pod).
- **Phase 3 (protocol):** `deriveCGK`, gossip canonical+HMAC+`seal/open`,
  `set-leader` vote, `electLeadForService`/`compareClout`, `birthDateFromAuthCode`
  — TS (708) + Swift (16) + Kotlin, pinned cross-platform vectors.
- **Phase 4 (hub):** `broadcast--<user>.flagship.services` content-blind
  per-account fan-out — reuses the SNI router's existing hub→box stream origination
  (`FRAME_OPEN`/`DATA`), delivers the opaque body to each sibling's
  `POST /internal/gossip`, returns `204`. `broadcast`/`servers`/`all` reserved.
  apps/web tests green.
- **Phase 5 (daemon):** CGK read (env → `/var/flagship/cgk.hex` → install-blob
  sibling, mirror of SWK; absent ⇒ gossip disabled, no brick); the `/internal/gossip`
  ingest + SiblingView (45 s announce, ~112 s liveness window); per-service election
  + claim/yield **live-wired to `runtime.urlController`** (claim/release the tier-2
  `<slug>.<user>` FQDN). server-daemon tests green.

**Two honest seams (now addressed):** the daemon's self-vote getter (returned
`null`) was lit by Phase 6's `setLeaderConsumer`; the `urlController.release` *soft*
release is resolved by the **routing-resolution** design below (a cold/unclaimed
meta-URL is re-resolved on demand, so a stale claim no longer matters — and the one
real teardown case is closed by the on-delete unclaim).

**Phase 6 (BUILT, reburn-gated for live):** the owner's control surface + turning
gossip on for real boxes — (a) **CGK post-boot provisioning** via the
`flagship/cgk-delivery/v1` sealed `.com` deposit lane (twin of the secret-free SWK
delivery — CGK is NEVER in the recipe; daemon `cgkDepositConsumer` persists +
restarts → gossip wires), (b) the "Set preferred server" action signs `set-leader`
+ deposits; the daemon `setLeaderConsumer` feeds the gossip `readSelfVote`, (c) the
daemon reports `leadsServices` in its (signature-safe) heartbeat → `/pods` relays it
→ clients show "lead"/"preferred". Pinned cross-platform CGK-delivery vector on
TS/Swift/Kotlin/webapp. A **reburn** validates the box-side deposit→claim→loop live.

## Routing resolution — eager-claim + nudge-on-miss + park-or-drop

How a leader-routed meta-URL (`<service>.<user>`, a purchased add-on domain) reaches
the right box when the holder just changed or never claimed — closing the soft-release
seam **without** any fly-directed "add this domain to your routing" message.

**The invariant (kept):** a box only ever receives traffic for a name it has already
**claimed** (`registry.register` via its tunnel HELLO `controlledDomains`). TLS
terminates on the box, so it can only serve a name it holds the cert + service for —
the claim *is* "I am ready to terminate this." No box is ever sent unexpected traffic.

**Fast path (unchanged):** the gossip-elected per-service lead proactively claims the
meta-URLs it leads (and pre-warms their certs); `registry.findBySni` routes off the
claim table. A handoff to a higher-clout lead self-heals — the new lead's claim
**overwrites** (last-register-wins). A dead lead's claim is dropped on **socket-close**
(`unregister` → redistribute orphans).

**Cold miss (new):** a request arrives for a meta-URL with no live claimer →

1. The hub **parks** the pre-TLS-handshake TCP stream (it has only peeked the SNI; it
   never decrypts).
2. The hub **nudges** the user's online boxes (reuses the Phase-4 fan-out:
   `deliverGossipToBox` → a plaintext `POST /internal/route-nudge {domain}`; the nudge
   isn't secret, so it is *not* CGK-sealed — the hub has no CGK).
3. Each box, on the nudge, consults its gossip election for that service:
   `electLeadForService(self + live siblings, slug)`. If self is the elected lead (or
   the only live runner — the single-box case elects self trivially) **and** runs the
   service, it **claims** the domain the normal way (`urlController.claim` + ensure the
   pre-warmed cert) — which lands in the hub's registry.
4. The hub, watching for the claim, pipes the parked stream the instant it lands.
5. **No claim within the hold window, or the chosen box is unreachable → the hub drops
   the connection** (decision 1: a dropped connection *is* "service unavailable"; a
   literal HTTP 503 is impossible here — the hub has no cert to terminate
   `<service>.<user>` under passthrough).

**Why there is no race (the key property):** the box **claims before any traffic is
sent to it** — the claim is a HELLO/control-channel update fully applied to the
registry, and the request stream is opened only *after*. There is no "serve-this-domain
then here's-the-request" pair to order, because the hub never sends a routing
directive. The only residual is two boxes briefly both claiming during a failover blip
→ last-register-wins picks one; the loser stops claiming next round. Benign, pre-existing.

**Decisions:**
- **(1) Can't reach / no holder → drop the connection** (no literal 503 under
  passthrough; a branded holding page would need the hub to hold a meta-URL cert,
  rejected to preserve content-blindness).
- **(2) Single-flight:** N parked requests for the same cold domain share ONE nudge +
  ONE election and all release together on the claim. (Without it: redundant but
  idempotent re-elections.)
- **(3) Cache invalidation:** covered by **socket-close** (death) + the **on-delete
  unclaim** (teardown) + **claim-overwrite** (handoff). No TTL backstop until a stale
  entry is actually observed.
- **(4) Cert pre-warm:** the elected lead pre-mints/loads the meta-URL cert so its
  claim is instantly serveable and the parked request never waits on ACME.

**On service delete (the harness, closing the last release case):** the box (1) removes
the service from its local routing/serving, (2) re-broadcasts gossip without it (so
siblings recompute leads), and (3) **unclaims the domain at the hub** (a lightweight
`registry`-drop so the next request re-resolves) — then deletes quietly.

**Net pieces to build:** the hub's park-on-miss + nudge + wait-for-claim + drop-on-
timeout (single-flight per domain); the box's `/internal/route-nudge` → elect → claim +
cert-prewarm handler; the harness's on-delete unclaim; and the lead's cert pre-warm.
**No `FRAME_OPEN` routing grant, no fly-directed routing** — eliminated, along with its
ordering race. Validate alongside the 2-box reburn (the nudge path is now load-bearing).

## Open questions

- **Liveness window value** (15 min proposed) + the tri-state copy ("unreachable"
  vs "offline" vs "last seen …").
- **Per-pod token migration:** how existing single-slot tokens migrate to the
  pod-keyed store (best-effort: attribute the current token to the current
  anchor's pod, re-pair others on demand).
- **CGK rotation:** derived-from-UMK means it only rotates when the UMK does. Is a
  rotatable gossip key ever needed (e.g. to evict a compromised box from the
  gossip without a full UMK roll)? If so, layer an epoch into the HKDF info string
  and broadcast the epoch bump — deferred unless a real need appears.
- **Gossip cadence + the inbound endpoint:** the announce interval (vs the ~15 min
  liveness window — gossip should be tighter, ~30-60 s, so failover beats the
  directory window), and the box-side inbound path the hub fans to (a dedicated
  authenticated `/internal/gossip` on the box's normal port).
- **Reserved-name collision:** carve `broadcast`/`servers`/`all` (and the chosen
  one) out of the user-creatable server/service namespace before shipping Phase 4.
- **Birth-cert artifact, exactly:** confirm the create-time authCode (not the
  re-mintable entitlement) is the seniority source on every platform, and pin its
  date field in the vectors so seniority can never be gamed by a re-issue.
- **`.com` relay vs direct read:** do clients read per-service leads from `.com`
  (simple, one fetch) or directly from a box (more live, `.com`-independent)? v1
  relays via `.com` for the UI; the boxes remain canonical so the direct path can
  be added without a model change.
