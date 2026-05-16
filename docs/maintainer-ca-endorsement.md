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
   verifier + tests. **✅ BUILT on branch `feat/ca-endorsement`
   (`496abae7`) in `./maintainers` — 12 new tests, 243 suite green,
   protocol `tsc` clean; spec §2.6/§3.7/§5.1 added.** Remaining: push
   the branch → PR/review in `ibisllc/maintainers` → land → bump
   `scripts/maintainers.pinned-sha` (governed; user/CI-side). The
   branch is durable locally (`./maintainers` HEAD parked at the
   pinned SHA so `pull-maintainers.sh` won't hard-reset the ref).
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
