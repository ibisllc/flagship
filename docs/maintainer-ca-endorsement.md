# Maintainer → CA endorsement (`CaEndorsement`)

**Status:** design, gating artifact. Decided 2026-05-16. This precedes any
code because it is (a) a change to an externally-adoptable protocol
(`ibisllc/maintainers`) and (b) load-bearing for the project's "verifiable in
the open-source releases" claim. Rationale/threat-model context also lives in
agent memory `project_maintainer_ca.md`. **Operator/successor runbook:
`docs/ca-operations.md`** (issue lease / rotate CA / take over) — backed
by shipped tooling: `scripts/rotate-ca.mjs` + the upstream
`maintainers ca-endorsement` CLI command.

## 1. Problem

`.com` holds a hot CA key (`FLAGSHIP_CA_PRIV_HEX`, materialized by
`caKeypairFromEnv`). It signs `UserPubKeyBinding` (username→IRK directory
attestation) and `DemoDirective` (#84). Today that key is trusted **purely
from an env secret** — no link to any maintainer authority. A `.com`
compromise that leaks the CA key can mint forged directory bindings and
backdate them indefinitely; rotating the key does nothing because nothing
ties "which CA key is authoritative" to a verifiable, revocable root.

Flagship already dogfoods the **maintainers protocol** (`ibisllc/maintainers`,
pinned via `scripts/maintainers.pinned-sha`, verified offline by
`packages/server-daemon/src/releaseVerifier.ts`, chain in-repo at
`.maintainers/`). It already scaffolds a **`ca` track**
(`.maintainers/tracks/ca/`) whose holder is the (currently placeholder)
maintainer YubiKey identity. The missing piece: a verifiable statement, made
by the maintainer, that *this hot CA pubkey is authorized right now*.

## 2. Why not the obvious alternatives

- **Pin the CA pubkey in the clients.** Kills the maintainer's emergency
  power (can't rotate the CA without an app release). Rejected.
- **Model the operational CA pubkey as the `ca`-track mandate holder,
  maintainer as successor.** No upstream change, but the verifier's rule is
  *most-recent-valid-mandate-wins, no grace, no overlap*: a pre-expiry
  renewal mandate must be signed by `pred.holder` (= the CA itself → a
  compromised CA self-renews forever), and a post-expiry one leaves a
  validity gap (CA "down") every lease period. Reintroduces the grace
  period the protocol explicitly refuses. Rejected.
- **Drop the hot CA, sign directory attestations with the maintainer key
  directly.** Impossible: `UserPubKeyBinding` is signed per-request by an
  always-online Worker; a YubiKey can't live there.

## 3. Decision

Add a **`CaEndorsement`** envelope **upstream in `ibisllc/maintainers`**,
mirroring `ReleaseEndorsement`, with **one deliberate semantic deviation**.

| | `ReleaseEndorsement` (existing) | `CaEndorsement` (new) |
|---|---|---|
| Payload | commit hash + merkle root + intermediate commits | operational CA pubkey + scope |
| Verified against | `currentAuthority(track, e.issuedAt)` — authority **at issue time** | `currentAuthority(caTrack, NOW)` — authority **at the validation clock** |
| Lifetime model | append-only historical fact; chains to predecessor | independent, short `[notBefore, notAfter)` **lease**; latest-valid-at-now wins; no predecessor chain |
| Who signs | current release-track authority | current `ca`-track authority (the cold maintainer key) |

The deviation is the entire security point. Releases are immutable history
("this commit was authorized") and must survive maintainer rotation,
contained by N-of-M + `TakeoverAlarm` + the git first-parent walk. A CA
endorsement is *liveness-sensitive present-tense authority* — it must
evaporate the instant it is no longer freshly attested, judged by the
verifier's own clock, never by an attacker-controlled `issuedAt`.

## 4. Upstream spec delta — `ibisllc/maintainers/docs/spec/v1.md` §6

> Lands in the maintainers repo via its own PR/review, then Flagship bumps
> `scripts/maintainers.pinned-sha` and re-pulls. Do **not** vendor it into
> Flagship.

### 4.1 Type (`@maintainers/protocol` `types.ts`)

```ts
export interface CaEndorsement {
  kind: "CaEndorsement";
  version: 1;
  endorsementId: Uuid;
  track: string;          // the ca-class track this is scoped to (e.g. "ca")
  caPubkey: Pubkey;       // the hot operational key being authorized
  scope: string;          // free-form, e.g. "flagship/directory-attestation"
  notBefore: Iso8601;     // lease window start
  notAfter: Iso8601;      // lease window end (the cadence knob — see §7)
  issuedAt: Iso8601;
  signedBy: Pubkey;       // must be the ca-track authority at NOW (not issuedAt)
  signatures: SignatureEntry[];
}
```
Add to the `Envelope` union.

### 4.2 Canonical bytes (`canonical.ts`)

Reuse `joinTagged("ca-endorsement", parts)` (same tagged-string scheme as
mandates/release-endorsements — *not* CBOR; the deployment doc's "CBOR"
phrasing is stale, the code joins tagged strings):

```
maintainers/ca-endorsement/v1
  | endorsementId | track | caPubkey | scope | notBefore | notAfter | issuedAt | signedBy
```

### 4.3 Verifier (`endorsement.ts` / `verifier.ts`)

`verifyCaEndorsements(endorsements, caTrack, approvalRule, now)` →
`{ valid: CaEndorsement[]; rejections: [...] }`. For each:

1. envelope kind/version ok; signatures verify over `canonicalCaEndorsement`.
2. `now ∈ [notBefore, notAfter)` — else `lease-expired` / `lease-not-yet`.
3. `auth = currentAuthority(caTrack, now)` (**NOW**, the deviation). Require
   `auth !== null`, `e.signedBy === auth.holder`, and the track
   `approvalRule` satisfied by `signatures` (same threshold logic as
   mandates/releases).
4. No predecessor/chain requirement. If several pass, the **current CA** is
   the one from the most recent still-in-window endorsement
   (`max issuedAt` among those with `now ∈ window`).

Exports added to `index.ts`. Tests in the maintainers repo mirror the
release-endorsement suite plus: backdated `issuedAt` rejected; out-of-window
rejected; endorsement signed by an *expired* ca-track holder rejected at the
later `now`; rotation (new endorsement, different `caPubkey`) supersedes.

## 5. Flagship integration

### 5.1 Where the endorsement lives & is issued

A `CaEndorsement` JSON sits in `.maintainers/` (proposed
`.maintainers/ca-endorsements/<date>-<id>.json`) — in-repo, open-source,
offline-verifiable, exactly like release endorsements. It is produced by the
maintainers UI (`flagshipserver.com/maintainers/`) WebAuthn-PRF/YubiKey
ceremony: the maintainer enters the operational CA pubkey + lease window and
taps the YubiKey. Renewal = a fresh endorsement before the prior window
closes (windows may freely overlap — endorsements aren't mandates).

### 5.2 Verification chain (every CA-signed artifact)

```
pinned scripts/maintainers.pinned-sha  (the trusted .maintainers snapshot)
  → verifyTrack("ca", ca/policy.json, ca mandates)        [@maintainers/protocol]
  → currentAuthority(caTrack, now) = the cold maintainer  (else: no trust)
  → a CaEndorsement, now ∈ [notBefore,notAfter), signedBy = that authority
  → that endorsement's caPubkey
  → Ed25519-verify the UserPubKeyBinding / DemoDirective signature under it
```

Consumers that must adopt this:

- **Daemon** — already has `releaseVerifier.ts`; add the `ca`-endorsement
  path (reuse `@maintainers/protocol`). Pure-fs/offline, no `.com` trust.
- **Clients (iOS / Android / webapp)** — need a **`ca`-track + CaEndorsement
  verifier**. Webapp can use `@maintainers/protocol` directly (TS). iOS/
  Android need a faithful port (Ed25519 + the tagged-canonical-bytes + the
  `currentAuthority(now)` rule) operating over the `.maintainers/` snapshot
  shipped/pinned with the app. This is the largest new client surface and is
  the concrete content of #84 **C1.2c** once unblocked.
- **`.com`** does not gain trust authority — it only *serves* the
  `.maintainers/` files and the CA artifacts; the verdict is always local.

### 5.3 Runbooks

- **Renew (routine):** maintainer issues a new `CaEndorsement` (same
  `caPubkey`, next window) before `notAfter`. Zero gap (overlap allowed).
- **Rotate CA (planned):** new endorsement with the new `caPubkey`; let the
  old window lapse. `.com` starts signing with the new key once its
  endorsement is in window.
- **Compromise:** stop issuing endorsements for the leaked `caPubkey`. At
  `now ≥ notAfter` every artifact it ever signed stops verifying globally —
  no revocation list, no enumeration. Mint a new CA, endorse it, `.com`
  re-signs (cheap: `UserPubKeyBinding`/`DemoDirective` are short-lived and
  re-fetched, so "re-issue everything" is just the next refresh).
- **Maintainer key loss:** the existing `ca`-track mandate `successors` +
  N-of-M takeover path (unchanged; `TakeoverAlarm` still fires).

## 6. Threat model (what this closes)

- **Leaked hot CA key:** bounded to one lease window; killed by withholding
  the next endorsement; backdating defeated (verification at NOW).
- **CA self-perpetuation:** impossible — the CA never signs its own
  authority; only the cold maintainer does.
- **`.com` compromise:** can serve stale/garbage but cannot forge authority
  (no maintainer key); verdict is local + offline.
- **Out of scope (unchanged):** user identity/content stays phone/IRK-
  rooted; the maintainer can only attest *directory* facts, and
  `UserPubKeyBinding` is still cross-checkable against the user's own
  IRK-signed `claim-username` (defense in depth — a rogue maintainer causes
  a *detectable directory lie*, not a silent account takeover).

## 7. Open knobs (proposed defaults; cheap to change)

| Knob | Proposed default |
|---|---|
| CA lease window (`notAfter - notBefore`) | **7 days**, renew at ~2 days remaining (user said "daily/weekly") |
| `ca`-track mandate cadence (the *maintainer's* term, distinct timescale) | leave at the scaffolded 180 d / 1-of-N for now; revisit with the real-key genesis |
| Endorsement storage path | `.maintainers/ca-endorsements/` |
| Clock skew tolerance at window edges | ±5 min |

Two distinct timescales: a long maintainer **mandate** (who may endorse) vs a
short CA **lease** (which hot key is live now). Don't conflate them.

## 8. Sequencing

This is a prerequisite for **#84 C1.2c** (client verify of `DemoDirective`)
and ultimately for hardening **all** CA-signed artifacts. The #84 *backend*
(storage/protocol/control-plane) is already done & committed; only the client
honoring waits on this.

1. **(this doc)** + upstream spec delta drafted. ✅
2. Upstream `ibisllc/maintainers`: `CaEndorsement` type + canonical +
   verifier + tests. **⚠️ The original `496abae7` work was local-only
   to a prior machine and was LOST (never pushed; `./maintainers` is
   git-ignored + freshly pulled at the pinned SHA — see
   SESSION-HANDOFF.md §0).** **✅ FAITHFULLY RECONSTRUCTED 2026-05-16**
   from §4 + §9 (ReleaseEndorsement as template): 4 commits on
   `feat/ca-endorsement` (tip `5cace76`), **257 suite green** (was
   231; +26 tests), `tsc -b` clean across the whole maintainers
   workspace; pushed to `ibisllc/maintainers`; **PR #1 open**
   (https://github.com/ibisllc/maintainers/pull/1). Remaining: the
   governed PR *merge* → then bump `scripts/maintainers.pinned-sha`
   to the merge SHA + `pull-maintainers.sh` (do NOT pin to the
   unmerged branch tip).
3. Flagship: bump `scripts/maintainers.pinned-sha`; daemon `ca`-endorsement
   path + tests.
4. **Real-YubiKey genesis ceremony** (human; current `ca`-track holder is a
   deterministic placeholder per its KeyFile metadata) + first real
   `CaEndorsement` for the production CA pubkey.
5. Client `ca`-verifier: webapp (`@maintainers/protocol`), then iOS/Android
   ports. = **#84 C1.2c**, now on the real chain.
6. Extend the same gate to `UserPubKeyBinding` consumers.

Steps 2 and 4 have a human in the loop (upstream review; YubiKey ceremony) —
they cannot complete from a CLI session; build to the seam and document it.

---

## 9. Consumer trust chain (the 4 links) + checkpoint

A consumer accepts a user-key artifact (`UserPubKeyBinding`,
`DemoDirective`) iff **all four** hold, evaluated at the consumer's
clock `now`:

1. **Pinned genesis** — the app ships the `.maintainers` genesis
   pubkey(s); transport is untrusted and verified forward from it.
2. **Maintainer authority at now** — `verifyTrack(ca)` →
   `currentAuthority(ca, now)`: genesis → holder-signed renewals →
   successor takeovers. A *gap-takeover* (`signedBy != prior.holder &&
   issuedAt >= prior.expiresAt`) raises a **minor `TakeoverAlarm`** —
   surfaced, not fail-closed; "critical" is a human/social call on a
   public dispute, never an automatic protocol state. (A gapless
   renewal raises nothing; a gapless takeover is impossible.)
3. **Live CaEndorsement** — `verifyCaEndorsements(now)` against link 2;
   `authorizedCaKeys(now)` = the operational keys authorized now.
4. **The artifact** — its own signature verifies under a key in
   link 3's set, and it is within its own TTL.

Empty link-3 set ⇒ reject **all** CA artifacts (fail closed); never
fall back to a previously-seen CA.

**Checkpoint (perf, not trust):** a client persists the last authority
state it verified from the pinned genesis (`{track, mandateId, holder,
successors, issuedAt, expiresAt, ackedAlarms}`) and sends it so the
server returns only the suffix (`verifyTrackFromCheckpoint`). Spec
§5.2's three invariants bind it: optimization-not-floor (genesis stays
the anchor; corrupt checkpoint → re-walk), suffix cryptographically
chained to the checkpoint, alarms unskippable (a server may drop benign
same-holder renewals but cannot hide a gap-takeover).

**Status:** links 1–3 + the checkpoint are built & tested in
`@maintainers/protocol` (`feat/ca-endorsement`, reconstructed
2026-05-16, tip `5cace76`, **PR `ibisllc/maintainers#1`** open:
`verifyTrack`, `currentAuthority`, `verifyCaEndorsements`,
`authorizedCaKeys`, `verifyTrackFromCheckpoint`,
`checkpointFromVerifiedTrack`; 257 suite green). The **remaining
wire** is link-4 enforcement at each consumer
— daemon (extend `releaseVerifier.ts` with the ca path), then
iOS/Android/webapp — which is exactly **#84 C1.2c**, now a one-liner
per call site via `authorizedCaKeys`. Per-platform wiring is the
large surface; it is sequenced, not yet coded.

---

## 10. Ceremony surface: CLI-signs / web-prepares + the commit-writer service (decided 2026-05-16, user)

Three coupled decisions, to **execute in a future session** (this
section is the workplan; no code landed yet):

### 10.1 Signing is CLI + a YubiKey HARDWARE signer — never browser memory

The maintainer key is the root of the whole CA chain; a forged
`Mandate`/`CaEndorsement` ultimately forges `UserPubKeyBinding`/
`DemoDirective`. If that key is ever *exfiltrated* the break is total,
silent, and permanent.

- **Browser WebAuthn-PRF** (the `setupCloudRecovery`-style path) derives
  the maintainer Ed25519 seed *into page JS memory*. A compromised page
  — XSS, a malicious/served-JS supply-chain dep, a content-script
  browser extension — reads and exfiltrates it. The served-JS + origin
  + extension surface is not something flagshipserver.com can fully
  control. Acceptable for *user* recovery (blast radius = one account,
  sub-origin-isolated); **unacceptable for the maintainer root.**
- **CLI + YubiKey-resident Ed25519** (PIV slot, or a FIDO2-resident key
  used as a signer — NOT a PRF-derived in-memory key): the private key
  never leaves the token. The host feeds the exact canonical
  maintainers-protocol bytes in, gets a signature out, gated by touch/
  PIN. Worst case under compromise = a bounded number of forged
  signatures *while the attacker is physically present during a touch*
  — never silent key theft. The CLI TCB (a pinned, auditable local
  binary) is far smaller than browser + served-JS + extensions.

**Decision:** ALL maintainer-key ceremonies — genesis, `Mandate`,
`CaEndorsement` (the weekly lease), takeover — are **CLI + YubiKey
hardware signer**. The maintainer private key NEVER materializes in
browser memory. The protocol is unchanged: Ed25519 over the existing
canonical tagged bytes; the only new work is wiring real PIV/FIDO2
signer *sources* into the CLIs (today their YubiKey source is "staged"
and the key is a local hex file — that hex-file mode stays only as an
air-gapped/successor fallback, documented as lower-assurance).

The website keeps ONLY the safe parts: chain/lease **status**, ceremony
**preparation/preview** (show the exact canonical bytes + the .maintainers
diff that will be committed), and the **commit trigger** (§10.2) over an
already-signed artifact. The web-ui never holds or derives a signing
key. (User accepted CLI for ceremonies since web is materially weaker
for the root; the web stays for the parts where it is not.)

Open sub-question for the future session (capture, do not resolve now):
whether a YubiKey FIDO2 *assertion* can itself BE the protocol
signature (challenge = canonical bytes). It cannot directly — a
WebAuthn assertion signs `authenticatorData || hash(clientDataJSON)`,
not the bare canonical bytes, so it would need an upstream
canonical-bytes-scheme change in `ibisllc/maintainers`. Default plan:
PIV-slot Ed25519 over raw canonical bytes via the CLI (no upstream
protocol change). Revisit the assertion-as-signature variant only if a
web-native signing path is later deemed worth an upstream spec delta.

### 10.2 The commit-writer service (a Worker on .com) — holds NO key

From the website OR the CLI the maintainer can "set in motion" a
service that actually writes the `.maintainers/` commit (upstream
`ibisllc/maintainers`, then Flagship bumps `scripts/maintainers.
pinned-sha` + re-pulls). Design:

- Hosted as a route on the **.com Worker** (it is the natural POST
  target for a website button and a CLI alike; it already has
  Cloudflare secret storage).
- It holds **NO maintainer key and NO hot CA key** — only a
  least-privilege GitHub credential (a fine-grained PAT or GitHub App
  installation token scoped to `ibisllc/maintainers` *contents:write*
  only). Stored as a Worker secret; rotatable.
- Input: a fully-signed, self-verifying `Mandate`/`CaEndorsement`
  JSON (produced by the CLI in §10.1). The Worker **re-verifies**
  before committing: well-formed envelope, signature verifies, signer
  chains to the pinned genesis, and it is an *append-only* addition
  under `.maintainers/` (never rewrites/deletes history). Then it
  creates the commit via the GitHub API — to a branch + an auto-PR by
  default (governance-reviewable), or direct per repo policy.
- **Compromise blast radius:** at worst it commits a *valid signed*
  artifact, or DoS-refuses, or commits garbage that the offline
  verifier + open-source auditability reject. It **cannot forge
  authority** (no signing key). This asymmetry is exactly why the
  *committer* is safe on .com while the *signer* is not.
- The CLI may instead commit directly with the maintainer's own
  `gh`/git (no service needed) — the Worker path is the website
  convenience and the successor-proof fallback. Both funnel the same
  signed artifact; one verify-then-commit code path.

### 10.3 Genesis + the baked-in pubkey (null until the first ceremony)

- The apps ship a pinned constant `MAINTAINER_GENESIS_PUBKEYS` (link-1
  of §9). It is **null/empty until the user runs the first real
  YubiKey genesis ceremony.** Verifiers MUST treat empty-genesis as
  **fail-closed**: no maintainer authority ⇒ reject ALL CA artifacts.
  This is safe pre-release — demo uses mock recovery, there are no
  real users, nothing is shipped.
- The **genesis ceremony** (CLI + the primary YubiKey): generate the
  cold maintainer Ed25519 on the token, write the genesis `Mandate`
  for the `ca`/`release`/`ops` tracks naming the **second YubiKey** in
  `successors`, commit it via §10.2, and emit the genesis pubkey to
  bake into the next build. A pre-release human step, done once.
- For build/test/analysis: assume the genesis is present — use the
  existing deterministic `.maintainers/` placeholder as the test
  genesis. The real pubkey swap is the documented pre-release step;
  every verifier's empty-genesis path is independently fail-closed
  tested.

### 10.4 Upstream push is pre-authorized

The user authorized pushing `feat/ca-endorsement` to
`ibisllc/maintainers`. The future session does, in order:
(1) push the branch + open the governed PR; (2) on merge, bump
`scripts/maintainers.pinned-sha` + `pull-maintainers.sh`; (3) that
unblocks the link-4 wiring (#84 C1.2c: daemon `releaseVerifier.ts`
ca-path, then webapp/iOS/Android) which becomes a one-liner-per-
call-site via `authorizedCaKeys`, gated by the §10.3 fail-closed
genesis constant. Steps 1–2 are now CLI-doable (authorized); only the
governed PR *merge* + the real-YubiKey genesis remain human.

---

## 11. Hardware mandate + the NFC-tap maintainer app (usability ⊕ security; 2026-05-16, user)

Refines §10. Still a future-session workplan — no code yet. Goal the
user set: *maximize security while doing the extra work to make it
fool-proof for a non-expert successor* ("someone who won't be bothered
to learn the ins and outs").

### 11.1 Hardware mandate

All maintainers (and their named successors) MUST use a **YubiKey 5
series, firmware ≥ 5.7, NFC variant**, with the **PIV applet holding an
Ed25519 key**. Rationale + the linchpin fact:

- fw 5.7 added **Ed25519/X25519 to PIV**. A PIV-slot Ed25519 key signs
  the presented message with standard RFC-8032 pure Ed25519. The
  maintainers protocol verify is plain `ed.verify(sig, canonicalBytes,
  pub)`. **⇒ a PIV-Ed25519 signature over the canonical bytes is
  byte-identical to the current scheme and verifies unchanged — NO
  upstream `ibisllc/maintainers` spec delta needed.** This kills the
  §10.1 open sub-question (WebAuthn-assertion-as-signature): we don't
  need it; PIV-Ed25519 signs raw canonical bytes directly.
- fw is NOT field-upgradable on YubiKeys ⇒ "≥5.7" means maintainers
  buy 5.7+ units (the user's 5C NFC @ 5.7.4 qualifies). Mandate is
  reasonable + security-positive; the user accepted mandating it.
- **Two keys per maintainer**: a primary + the key named in the genesis
  Mandate `successors` (the natural recovery — lose/brick the primary ⇒
  successor takeover via the existing protocol path, no key-escrow).
- PIV policy: **touch = always** (every signature needs a physical
  tap — defeats malware-triggered silent signing) + **PIN once per
  session**. Build-time confirm: fw 5.7.4 PIV-Ed25519 signs the
  presented message (no caller pre-hash) and short canonical bytes fit
  the NFC/extended-APDU limit (they do — tagged pipe-joined string).

### 11.2 The ceremony surface: a dedicated NFC-tap maintainer app

The §10.1 "CLI signs / web prepares" hand-off is clunky. Replace the
*primary* surface with a **dedicated "Flagship Maintainer" mobile app**:
single device, one tap.

- Flow: app shows the pending ceremony in **plain language** ("Renew
  Flagship's weekly CA lease?", "Set up the Flagship maintainer root —
  this is genesis", "Take over as maintainer") + the human summary +
  the raw canonical bytes + the exact `.maintainers` diff that will be
  committed (auditable). Big "**Hold your YubiKey to the top of your
  phone**". User taps → app does the PIV-Ed25519 sign APDU over NFC
  (PIN screen; touch policy auto-satisfied by the tap) → POSTs the
  signed artifact to the §10.2 .com commit-writer. **One device, one
  tap. No CLI, no copy-paste, no git/JSON/PEM.**
- **Genesis** in-app: PIV `GENERATE` the Ed25519 on the primary key
  (never leaves token) → prompt "tap your backup/successor key" → read
  its PIV pubkey (public read, no PIN) → write the genesis Mandate
  (ca/release/ops) naming it `successors` → commit via §10.2 → show
  the genesis pubkey to bake into the build (`MAINTAINER_GENESIS_
  PUBKEYS`, §10.3). Two taps, fully guided.
- **Recurring chore made trivial**: a push notification → open app →
  "Renew? [tap]" → done in ~10s, so lease cadence is never a burden
  (keeps the 7d default; cadence-vs-window stays a knob, not a chore).
- **Successor fool-proofing**: install one app; it walks the takeover
  with a checklist + plain-language refusals; **fail-closed with
  human-readable reasons** (never a silent/ambiguous state). No CLI,
  no terminal. PIN-lockout foot-gun mitigated by: in-app guided PIN
  setup, explicit retry/PUK warnings, and the two-key design being the
  real recovery (don't rely on PUK).

### 11.3 Platform + packaging decisions

- **Android-first, iOS fast-follow.** Both are technically feasible
  (Android `yubikit-android` PIV/NFC is most mature; iOS Core NFC
  ISO7816 + YubiKit PIV/NFC works with the NFC ISO7816 entitlement +
  PIV AID `A0 00 00 03 08` — this CORRECTS the user's "not sure Apple
  exposes the primitive": it does, for PIV; only third-party
  FIDO2-over-NFC is the restricted thing, which we don't use).
- **Separate, minimal app — NOT a mode in the consumer Flagship app.**
  Smaller TCB; a compromised consumer build can't become a
  maintainer-signing surface; clean successor mental model ("install
  Flagship Maintainer"). **Reproducibly built** (reuse the build-iso.yml
  double-build discipline) so the binary is auditable like the ISO.
- Security posture: the app (like the CLI) never holds the key — the
  token signs. "Show X / sign Y" risk is mitigated identically (OSS +
  reproducible build + on-screen raw-bytes/diff + the independent .com
  committer + offline verifier + public `.maintainers`). **Equivalent
  security to the CLI, far better usability.** The CLI remains ONLY
  the air-gapped / app-store-down / successor escape hatch (documented,
  lower-frequency, never the primary path).

### 11.4 Open knobs (record, decide at build)

- Lease cadence vs compromise window (7d default; the app makes any
  cadence painless — could shorten, but 7d stays unless revisited).
- iOS App Store vs notarized sideload for a niche maintainer tool
  (sideload/TestFlight may be lower-friction than review).
- PIV slot choice (9c "digital signature" vs 9a) + PIN/PUK policy
  defaults baked into the genesis flow.
- Whether the app also drives `rotate-ca` (hot-CA-key rotation) — it
  CANNOT (hot key must never touch a phone; that stays CLI-only,
  unchanged from §10/ca-operations). The app only ever drives
  cold-key (Mandate/CaEndorsement/genesis/takeover) ceremonies.

---

## 12. Generic, project-agnostic OSS maintainers app (decided 2026-05-16, user — final refinement)

The maintainer app (§11) is **NOT Flagship-specific**. It is a generic
companion to `@maintainers/protocol`: *our OSS contribution*. Anyone
running any project that adopts the `ibisllc/maintainers` protocol in
its source downloads ONE app, points it at their repo, saves their own
git credential into it, and starts running ceremonies. Flagship is
merely the first configured consumer.

### 12.1 Decentralized: the app commits directly (no required hosted service)

- The maintainer configures, per repo: the **forge + repo** (GitHub /
  GitLab / Gitea-Forgejo / generic git-over-SSH), the **`.maintainers/`
  path** (convention, overridable), and a **git write credential**
  (a fine-grained PAT scoped to that one repo's contents, or a
  per-repo deploy/SSH key) stored on-device.
- Ceremony: tap YubiKey → PIV-Ed25519 signs the canonical bytes →
  **the app itself commits** the signed artifact to `.maintainers/`
  via the configured forge API / git-over-SSH (branch + auto-PR by
  default, or direct per the project's policy read from its config).
- ⇒ **Zero infra for adopters.** The §10.2 hosted `.com` commit-writer
  is **DOWNSCOPED to an optional, opt-in mode** for maintainers who
  refuse any git token on a phone (it then takes the YubiKey-signed
  artifact and commits with a server-side credential). It is NOT the
  generic path and NOT required; the default is app-direct-commit.
  Flagship MAY run/use it; an arbitrary adopter never needs to.

### 12.2 Why a git credential on the device is acceptable (security)

The git token/key is **write-transport, not authority**:

- Authority is solely the YubiKey-held Ed25519 (PIV-resident; never on
  the phone, §11). Every `Mandate`/`CaEndorsement` is verified offline
  by `@maintainers/protocol` against the chained authority from the
  pinned genesis. A stolen git credential **cannot forge authority** —
  the verifier rejects anything not Ed25519-signed by the chained key.
- Worst case of a compromised device/credential: push garbage or
  tamper `.maintainers/` history in **one repo** (DoS) — contained by
  the protocol's append-only first-parent walk + `TakeoverAlarm` +
  open-source auditability + offline verification (history rewrite is
  detectable; the verdict is always re-derived from pinned genesis).
- Mitigations the app MUST implement: store the credential in
  hardware-backed secure storage (iOS Keychain w/ Secure Enclave
  protection class; Android Keystore, StrongBox where available),
  gate its use behind device biometric, and guide the user to the
  **narrowest scopeable** credential the forge supports (single-repo
  fine-grained PAT contents:write, or a single-repo deploy key).
- Net: device-direct-commit + YubiKey-signing is *more* decentralized
  than a mandatory hosted committer and **no weaker** (authority never
  leaves the token in either model). This asymmetry is the whole
  reason it's safe to ship as a generic tool.

### 12.3 Genericization (nothing Flagship-hardcoded)

- The signing + canonical bytes + verifier are already
  project-agnostic (they live in `@maintainers/protocol`). The app
  hardcodes NONE of: repo, forge, `.maintainers/` path, track names,
  or scope strings. Track set + policies + `CaEndorsement` scope
  strings (Flagship's are e.g. `flagship/directory-attestation`) are
  **read from the target repo's `.maintainers/` config**, not baked in.
- Per-project app config is a small profile: `{ forge, repo,
  maintainersPath, credentialRef }`. The maintainer can hold profiles
  for several projects in one app install.
- The per-consumer baked genesis pubkey + fail-closed verifier wiring
  (§10.3, tasks #30/#8/#9/#10) is a **CONSUMER-PROJECT** concern, not
  the app's — each adopting project bakes its own genesis into its own
  clients. Flagship's wiring becomes the reference template other
  adopters copy. The app only *produces & commits* genesis/lease/
  takeover artifacts for whatever project it's pointed at.

### 12.4 Home + packaging

- The app's canonical home is **upstream in `ibisllc/maintainers`**
  (with the protocol + CLI), released as the OSS maintainers app — not
  vendored Flagship-only. Flagship pins/consumes it like it pins the
  protocol. Reproducible build (build-iso.yml-style) so the published
  binary is auditable. Android-first, iOS fast-follow (§11.3).
- `rotate-ca` and any hot-operational-key tooling stay
  Flagship-specific + CLI-only (a hot service key is a consumer
  concern, never the generic cold-key app's job; never on a phone).
