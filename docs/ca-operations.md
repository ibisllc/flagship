# CA operations — issue a lease, rotate the CA, take over as maintainer

Audience: the Flagship maintainer and **any future successor**. If you
are a successor and Harry is gone, you can run everything here with your
own YubiKey + a unix shell. Nothing here needs Harry.

Design rationale: `docs/maintainer-ca-endorsement.md`. Protocol:
`maintainers/docs/spec/v1.md` (the de-versioned, final-named spec —
§2.6/§3.7/§5.1; §7.1 published-fetch layout; §12 Conformance).

---

## The one security rule

Two keys, never mixed:

| Key | Where it lives | Signs | Tool |
|---|---|---|---|
| **Maintainer key** (cold) | your YubiKey | `Mandate`, `CaEndorsement` (the lease) | web-ui (tap) **or** `maintainers` CLI |
| **Operational CA key** (hot) | `FLAGSHIP_CA_PRIV_HEX` Cloudflare Worker secret | `UserPubKeyBinding`, `DemoDirective`, per request | `scripts/rotate-ca.mjs` only |

**The hot CA private key is NEVER generated in or sent through a
browser.** It is generated locally by `rotate-ca` and transmitted only
to Cloudflare. The web-ui only ever signs *leases* (it never sees the
hot key). This is why "Replace CA" in the browser is just *pasting a
public key* — the private half stays in the CLI.

**There is no "re-issue every user key" daemon, by design.**
`UserPubKeyBinding` / `DemoDirective` are minted per request with a ~7d
TTL and re-fetched. Once the Worker holds the new key **and** a live
`CaEndorsement` covers it, the next fetch is already signed by the new
CA. Nothing to batch; nothing long-running and privileged. (If you
think you need such a daemon, re-read this paragraph — wanting it means
the lease/refetch model isn't being trusted, and that model is the
whole security argument.)

---

## Operation 1 — issue / renew a CA lease (the recurring chore)

A lease (`CaEndorsement`) says "this hot CA pubkey is authorized until
`notAfter`". Verified against the ca-track authority **at the verifier's
clock** — so a lapsed lease invalidates the CA globally with no
revocation list. Renew before `notAfter`; overlapping leases are fine
and make renewal gap-free (a server serves the valid lease that runs
*farthest into the future*).

Default cadence: **7-day** leases, renew at ~2 days remaining. (You can
run any cadence; "renew weekly forever" is the expected lifestyle.)

**Path A — web-ui (everyday, with the phone + YubiKey):**
1. Open `https://flagshipserver.com/maintainers/` → the Flagship
   project → **Issue CA lease**.
2. The CA pubkey is pre-filled with the currently-served one; expiry
   defaults to **now + 7 days** (editable). Scope defaults to
   `flagship/directory-attestation`.
3. Tap your YubiKey. The browser PRF-derives your maintainer Ed25519
   key in page memory, signs the canonical `CaEndorsement` bytes, and
   commits it (Model A adapter) or hands you a one-click PR (Model B).
4. Done. `.com` serves it automatically; no deploy.

> Web-ui status: the signing/commit machinery (PRF, Model A/B adapter,
> the protocol `signCaEndorsement`) all exists; what remains is one new
> view + route. See "Next upstream increment" at the bottom — until it
> lands, use Path B, which is fully equivalent.

**Path B — CLI + YubiKey (the supported maintainer-root path; also the
air-gapped / store-down / successor escape hatch):**
```sh
cd maintainers          # the pulled ibisllc/maintainers clone
node packages/cli/dist/index.js ca-endorsement \
  --ca-pubkey <64-hex operational CA pubkey> \
  --scope flagship/directory-attestation \
  --duration 7d \
  --track ca \
  --signing-key yubikey-piv:slot=9c \
  --path ../.maintainers
# writes .maintainers/ca-endorsements/<ts>-<id>.json — commit it (PR to main)
```
Before the real run, preview it: add `--dry-run` to print the EXACT
canonical bytes (hex + utf-8) and the would-write `.maintainers` diff
while signing/writing **nothing** and touching no PIN/token (it
resolves pubkeys via the no-PIN public read only). The real run prints
a plain-language banner + the same byte/diff REVIEW and then requires
a **typed confirmation** (a ceremony-specific phrase — for
`ca-endorsement` the phrase is exactly `CA-LEASE`) before any token
touch or write; `--yes` is the deliberate non-interactive bypass
(banner + preview still shown). The PIN and any `file:` private key are
never logged anywhere (regression-tested). The same `--dry-run`/banner/
typed-confirm machinery applies to `upsert-mandate` (the ONE mandate
verb — genesis/renew/takeover/repolicy all collapse into it) and to
`create-key`.

The `ca-endorsement` command and the `yubikey-piv:` signer source both
exist (maintainers #28, hardened in the ceremony-tooling chunk): the
PIV-resident Ed25519 private half never leaves the token, and a
PIV-Ed25519 signature over the canonical bytes is byte-identical
RFC-8032 Ed25519, so there is **zero protocol/wire/spec change**
(§11.1). The native PC/SC transport is verified only at the YubiKey
gate; until the libpcsclite wiring lands the source fail-closes with a
precise `PcscBuildError` — it never silently falls back. **Lower-
assurance fallback** (air-gapped / successor, documented as such):
`--signing-key file:<maintainer-ed25519-priv-hex-file>` — a local
32-byte hex file you guard.

Check what is being served at any time:
```sh
node scripts/rotate-ca.mjs status     # lists leases; marks the SERVED one
```

---

## Operation 2 — rotate the operational CA key

Use when the hot key may be exposed, or on a hygiene schedule. One
command drives it, in the **safe order** (new lease live *before* the
key swap, so there is no gap — the old lease keeps serving until its
own `notAfter`):

```sh
node scripts/rotate-ca.mjs rotate            # add --dry-run first if unsure
```
It will:
1. generate a new Ed25519 CA keypair locally (seed stays in process
   memory, never written/logged),
2. print + clipboard-copy the new **public** key,
3. tell you to issue a lease for it — Operation 1, Path A "Replace CA"
   (paste the pubkey) or Path B with the new `--ca-pubkey`,
4. **block until it independently verifies a live lease for that exact
   pubkey** (signature over the real canonical bytes + window +
   ca-track-authorized signer),
5. only then `wrangler secret put FLAGSHIP_CA_PRIV_HEX` (seed via
   stdin, never argv), with a confirm,
6. optionally verify a live `/pubkey-cert` now signs under the new CA
   (`--verify-user <name>`).

No daemon, no re-issuance step. Caches roll within the TTL (~7d); the
old lease covers that window.

If the tool aborts at step 4 (timeout / no live lease) **nothing was
changed** — fix the lease and re-run.

---

## Operation 3 — take over as maintainer (successor)

If the current maintainer is gone, a named successor takes the ca (and
release/ops) tracks. Under the LOCKED v2 model there is ONE succession
mechanism (renewal = rotation = takeover = repolicy): the named
successor signs the **next mandate** on the track via the ONE
`upsert-mandate` verb. There is **no separate `takeover` verb** (it was
collapsed into `upsert-mandate`); there is **no self-renewal**.

- **Web-ui:** `…/maintainers/` → project → the track → status/preview
  only (the web-ui never signs the root; §10.1). The actual successor
  signature is the CLI path below (or the NFC-tap app, §11).
- **CLI** (the successor signs the next mandate on the track; the
  predecessor's embedded `approvalRule` over its `successors` governs
  acceptance — verified FORWARD from the baked pin):
  ```sh
  cd maintainers
  node packages/cli/dist/index.js upsert-mandate \
    --track ca \
    --signing-key yubikey-piv:slot=9c \
    --holder yubikey-piv:slot=9c \
    --duration 180d \
    --path ../.maintainers
  # --dry-run first; the agent verifies the canonical bytes + that the
  # signer is a named successor of the current mandate BEFORE any tap.
  ```
  The signing key MUST be a pubkey listed in the predecessor mandate's
  `successors` (the CLI fail-closes in `assemble`, before any tap, if it
  is not). The holder CHANGES → this is a takeover and is visible to
  every consumer (the banner says so). Repeat per track (`ca`,
  `release`, `ops`).

Then you are the track authority and Operations 1–2 are yours.

> Note: under the v2 model there is no longer a "deterministic
> placeholder genesis holder" to replace — the from-scratch origin
> mandate IS the genesis (Operation 0). Until Operation 0 runs, the
> per-surface pin (`MAINTAINER_PINNED_MANDATE_HASH`) is empty and every
> consumer fail-closes (`pin-unconfigured`) — safe, since nothing is
> released and demo uses mock recovery.

---

## Why a server can be down-but-safe

If no live lease covers `now`, consumers reject **all** CA-signed
artifacts (fail closed). That is the intended behavior of withholding a
lease during a suspected compromise. The cost of forgetting to renew is
the same as a detected compromise: directory attestations stop until
you issue a lease. It is never a silent downgrade.

---

## Next upstream increment (web-ui CA-lease views)

Tractable, bounded, no security objection (same PRF/YubiKey model as
the existing `renew`/`takeover` views; the hot key is never present):

- `maintainers/packages/web-ui/src/views/ca-lease.ts` — a view mirroring
  `views/renew.ts`: form (caPubkey prefilled from the served lease,
  scope, expiry = now+7d editable), "Replace CA" mode = same form with
  an empty pubkey field for paste.
- `app.ts`: add routes `…/ca-lease` and `…/ca-replace` (mirror the
  `takeover` route wiring at `app.ts` ~line 193).
- `envelopes.ts`: add a `signCaEndorsement`-backed builder (the
  protocol export already exists from this workstream).
- Commit path: the existing Model A/B adapter — unchanged.

Until it lands, Operation 1 Path B (CLI) is the exact functional
equivalent and is the supported path. The CLI is also the only
successor-proof path if the web-ui host is ever unavailable, so it must
keep working regardless.

---

## SECURITY-MODEL CORRECTION (2026-05-16, user-decided) — read this first

The "Path A web-ui (everyday)" framing above is **superseded** for the
maintainer ROOT key. Full rationale: `docs/maintainer-ca-endorsement.md`
§10. Summary:

- **Signing is CLI + a YubiKey hardware signer ONLY** (PIV-resident
  Ed25519 over the raw canonical bytes). The maintainer private key
  never enters browser memory. Browser WebAuthn-PRF derives an
  *exfiltratable* in-memory key — unacceptable for the root (total,
  silent, permanent break if stolen). This is the supported path, not
  a fallback. The local-hex-file key source stays ONLY as an
  air-gapped/successor lower-assurance fallback, labelled as such.
- **The web-ui never signs.** It does status, ceremony preview (shows
  the exact canonical bytes + the .maintainers diff), and the
  commit-trigger over an ALREADY-signed artifact.
- **Commit-writer service** (a .com Worker route, future session):
  holds NO maintainer/CA key — only a least-privilege
  `ibisllc/maintainers` contents:write GitHub credential. It
  re-verifies the signed artifact chains to the pinned mandate + is
  append-only, then commits (branch + auto-PR by default). Worst-case
  compromise = commit-a-valid-signed-thing / DoS / garbage caught by
  the offline verifier — it cannot forge authority. CLI may instead
  `gh`/git-commit directly; same verify-then-commit path, the Worker
  is the website convenience + successor-proof fallback.

## Operation 0 — genesis (once, pre-release, CLI + primary YubiKey)

**This is the Human Gate B ceremony. It is IRREVERSIBLE — it creates the
root of trust. Run it exactly; `--dry-run` every track first.**

Under the **LOCKED Phase-2 v2 model** (de-versioned: the protocol's
first-ever shipped name is final — Mandate wire `version: 1`, canonical
tag `maintainers/mandate/v1`, NO "v2"/`…V2` anywhere), genesis is **the
first `upsert-mandate` run from scratch (ORIGIN)** per track — there is
**no `genesis` verb** (it, `mandate`, and `takeover` were deleted in
c4.5d and collapsed into the ONE `upsert-mandate`). The from-scratch
origin mandate:

- is **self-signed by its holder** (`--signing-key` pubkey MUST equal
  the `--holder`; omit `--holder` to use the signing key as holder —
  the CLI hard-fails in `assemble`, before any tap, otherwise);
- carries its **succession policy INLINE** —
  `approvalRule {kind:"threshold", threshold}` (`--threshold`, default
  1), `successors` (`--successors`, default `[holder]`), `minSuccessors`
  (`--min-successors`, default 1), `maxDurationSeconds`
  (`--max-duration`, default = this mandate's own window),
  `defaultDurationSeconds` (`--default-duration`, default = the window);
- carries the project-level block on the ORIGIN mandate:
  `--project-name` (REQUIRED for a from-scratch mandate),
  `--project-contact`, `--project-homepage`, `--project-tracks a,b`.

There is **no `policy.json`** (root or per-track) in v2 — the rule
governing mandate K+1 is signed *into* mandate K, as trustworthy as the
chain. The on-disk artifact written is exactly
`.maintainers/tracks/<TRACK>/mandates/<compact-iso>-<short-id>.json`
(append-only, refuse-overwrite) and nothing else.

The baked anchor is **`MAINTAINER_PINNED_MANDATE_HASH`** — the **pinned
mandate's canonical hash** (`mandatePinHash`, sha256 of the canonical
bytes), per surface (#30 generalised). It is **NOT**
`MAINTAINER_GENESIS_PUBKEYS` — that constant no longer exists (verify in
flagship `packages/protocol/src/maintainerCa.ts`:
`export const MAINTAINER_PINNED_MANDATE_HASH = ""`, which rejects
`pin-unconfigured` until Gate B). Consumers verify the chain **forward**
from that pinned hash; the pin IS the floor (spec §5.2 rewritten).

The command surface below is verified against the LANDED `maintainers`
CLI (`packages/cli/src/commands/upsertMandate.ts` + `lib/args.ts`/
`ceremony.ts`/`duration.ts`), post-c4.5/c4.6/c4.7/c5. The
`upsert-mandate` command does NOT generate the on-token key — that is a
hardware prerequisite (the `(P)` checklist below).

> **GATE-B EXECUTION REALITY (verified against landed source — read
> before attempting).** `maintainers/packages/cli/src/lib/piv-pcsc.ts`
> `connectPcscChannel()` is, by #28's deliberate design, a **fail-closed
> stub that throws UNCONDITIONALLY** — even when the optional `pcsclite`
> binding IS installed (it does `void mod; throw new PcscBuildError(…)`).
> #28 shipped the pure tested `piv-apdu` codec + the `PcscChannel` seam +
> this stub; the real binding wiring (reader enumeration → connect →
> APDU transmit Buffer↔Uint8Array) is the explicitly-deferred
> **human-gate increment**, implementable only with the real reader+token
> present to verify the round-trip. So executing Gate B is a TWO-PART
> ordered step:
>
> **(P) the human provisions the environment** (the copy-pasteable
> checklist below) → **(A) the agent implements + LIVE-verifies the
> `connectPcscChannel` libpcsclite wiring** behind the existing tested
> `PcscChannel` seam + `piv-apdu` codec, proving the round-trip with a
> NON-destructive public-key read FIRST (security-critical native
> transport; lands upstream via a governed `maintainers` PR + re-pin,
> like PR #1/#2; **NEVER written blind / bolted unverified** — the
> hardware-in-loop verification is the whole point of doing it AT the
> gate). The exact libpcsclite API contract the (A) step implements
> against is recorded in-code as the **"GATE-(A) NATIVE-BINDING
> IMPLEMENTATION PLAN"** doc-comment on `connectPcscChannel` in
> `piv-pcsc.ts` (reader enum → `pcsclite()` `reader`/`status` events →
> `reader.connect({share_mode})` → `reader.transmit(Buffer, resLen,
> protocol, cb)` → Buffer↔Uint8Array marshalling into the pure
> `piv-apdu` codec → SELECT PIV AID `A0 00 00 03 08`, then the
> non-destructive GET-pubkey FIRST, then VERIFY PIN / GENERAL
> AUTHENTICATE). Mirror summary: it is mechanical and reviewable, not
> invented under time pressure — and it is performed WITH hardware,
> NEVER before. Then the `--dry-run` and the signed ceremony below.
>
> **The `file:` hex key is NOT acceptable for the genesis root** — it
> would put the root-of-trust private half on disk, defeating the entire
> on-token/no-escrow model; `file:` is the documented *successor /
> air-gapped* lower-assurance path ONLY, never for minting genesis.
>
> **STEP-(A) UX REALITY — the no-hardware UX state machine (LANDED in
> this chunk, hardware-independent).** The prompt+wait+retry loop
> wrapping the binding is already built and unit-tested
> (`lib/piv-connect.ts` `connectPcscChannelWithPrompt` +
> `tests/piv-connect.test.ts`), behind a TYPED transport-error taxonomy
> (`lib/piv-pcsc.ts`):
> - `PcscNotReadyError` — **RECOVERABLE**: no reader yet / no token yet /
>   not-tapped-yet. The loop PROMPTS ("Waiting for your YubiKey: …",
>   "Insert the YubiKey…"), waits, polls, retries. This is the everyday
>   absent-hardware UX, NOT a failure. The (A) wiring MUST map the
>   absent-reader / empty-reader / card-removed-mid-prompt /
>   `SCARD_E_NO_SMARTCARD` / `SCARD_W_REMOVED_CARD` conditions to this.
> - `PcscSecurityError` — **FATAL**: wrong key, PIN/signature failure,
>   tamper. The loop HARD-ABORTS and NEVER falls back to a weaker/
>   in-process key. Fail-closed is a SECURITY property only. The (A)
>   wiring MUST map a wrong-slot-pubkey / blocked-PIN / bad-signature to
>   this.
> - `PcscBuildError` — **FATAL, non-recoverable build condition**: the
>   `pcsclite` binding is absent / not wired. NOT retried (a missing
>   binding is not a missing reader); precise message + the `file:`
>   lower-assurance pointer preserved.
>
> Non-interactive (piped / `--yes` / CI) fails closed DETERMINISTICALLY
> and immediately — it never hangs waiting for a human who isn't there.
> Bounded: an overall deadline (default 120s) caps the wait; the
> inter-attempt wait is a cooperative sleeper, never a busy-loop. The
> (A) increment ONLY supplies the raw `reader.transmit`; this UX machine
> and the `piv-apdu` codec are already proven with zero hardware. (This
> whole reality callout exists because an empty USB scan was once
> mistaken for a blocker without first asking the operator to plug the
> key in — do not repeat that; an absent reader is a prompt+wait, never
> a conclusion or a fatal verdict.)

### What is dry-run-verifiable WITHOUT hardware vs what needs the YubiKey

So the operator knows precisely where the human gate is:

| Step | Needs the YubiKey? | Why |
|---|---|---|
| `upsert-mandate … --dry-run` (exact canonical bytes + the `.maintainers` diff, no PIN/tap) | **NO** | Resolves the signer pubkey via the no-PIN public read (`loadSignerBoundPubKey`); proven byte-fidelity-equal to a real signed run (`tests/dryrun.test.ts`). With a `file:` pubkey for the dry-run you don't even need the token to preview structure. |
| Byte-fidelity self-check (the dry-run preview bytes == `canonicalMandate` of the envelope a real signed run produces; uuid/timestamps pinned) | **NO** | Asserted in `tests/dryrun.test.ts` ("byte-fidelity: from-scratch genesis dry-run preview bytes EQUAL …"). |
| The no-hardware UX state machine (not-ready→prompt+wait+retry; security→hard-abort; build→fail-closed; non-interactive→fail-closed; bounded) | **NO** | Fully unit-tested with injected fakes (`tests/piv-connect.test.ts`). |
| `connectPcscChannel` libpcsclite wiring (reader enum → connect → `transmit`) — the **(A)** increment | **YES (live)** | Security-critical native transport; the round-trip is verified ONLY with the real reader+token; non-destructive pubkey read FIRST. |
| The signed ceremony (typed `UPSERT-MANDATE` confirm + PIN + physical tap) | **YES** | The on-token Ed25519 GENERAL AUTHENTICATE — the private half never leaves the token. |
| `verify` / `status` of the resulting `.maintainers/` (chain resolves forward from the recomputed `mandatePinHash`) | **NO** | Pure offline verifier over the written artifacts. |

### (P) Human-provisioning checklist (copy-pasteable — hand verbatim)

Do these, in order, BEFORE the agent runs step (A) or any signed
ceremony. Each is a human-owned, non-code-derivable input.

```sh
# 1. Install the optional PC/SC binding so connectPcscChannel can load
#    it (the build-not-wired PcscBuildError clears only once this is
#    importable). macOS already ships the PCSC framework; Linux needs
#    libpcsclite-dev + the pcscd daemon running.
#    macOS:
npm i -g pcsclite        # or add it to the maintainers ceremony build
#    Debian/Ubuntu:
#   sudo apt-get install -y libpcsclite-dev pcscd && sudo systemctl enable --now pcscd
#   npm i -g pcsclite

# 2. Install YubiKey Manager (ykman) for on-token keygen.
#    macOS:
brew install ykman
#    Debian/Ubuntu:
#   sudo apt-get install -y yubikey-manager

# 3. On EACH of the two YubiKeys, generate an Ed25519 key ON the token
#    in PIV slot 9c ("digital signature": PIN-gated every signature),
#    touch policy = always, PIN once per session. The private half is
#    generated on-token and NEVER exported. Run this once PER key
#    (plug in key #1, run it; swap to key #2, run it):
ykman piv keys generate \
  --algorithm ED25519 \
  --pin-policy ONCE \
  --touch-policy ALWAYS \
  9c \
  slot-9c-public.pem
#    (If the key/PUK is still factory-default, ykman will prompt; set a
#    real PIN/PUK now — this is the §11.4 human knob, fixed once.)

# 4. Export the SECOND (backup/successor) YubiKey's slot-9c PUBLIC key
#    to a 64-hex file so the genesis run can name it in --successors
#    without juggling two tokens on one reader mid-ceremony.
#    Convert the slot-9c-public.pem from key #2 to 32-byte raw hex:
openssl pkey -pubin -in slot-9c-public.pem -outform DER \
  | tail -c 32 | xxd -p -c 64 > backup-9c.pub
#    (Or, if you prefer: pass --successors yubikey-piv:slot=9c and
#    physically swap to the backup token when the no-PIN public read is
#    requested — loadSignerPubKeyList resolves sequentially.)

# 5. Plug in BOTH YubiKeys (or have the primary in, backup-9c.pub on
#    disk from step 4).
```

Two human decisions to make and record (NOT code-derivable):

- **`<DURATION>` for the cold genesis mandate.** Per the LOCKED Phase-2
  D1 the cold maintainer track is *long-lived* (changing quorum / the
  track set is a NEW from-scratch ceremony with a NEW pin). A multi-year
  duration is appropriate, e.g. `3650d`. Expiry is not terminal — a
  later succession `upsert-mandate` renews/extends — but pick a
  comfortably long genesis duration regardless.
- **The create-time succession policy.** `--threshold N`,
  `--min-successors N`, `--max-duration <DURATION>`. Solo founder:
  leave `--threshold 1`, `--successors file:backup-9c.pub` (the named
  successor is the ONLY recovery if the primary is lost/bricked — there
  is NO key escrow). Growth: set a real `--threshold N` over `N` named
  `--successors` and the strong quorum property switches on
  automatically. `--max-duration` bounds every future successor's
  window (the anti-rubber-hose property — perpetuation structurally
  requires the quorum to periodically re-convene).

Also build the CLI (dist/ is gitignored — absent on a fresh clone):
```sh
cd maintainers && npm run build      # = tsc -b, idempotent
```

### The ceremony (per track: ca, release, ops — repeat all of A/B)

For each `<TRACK>` in `ca`, then `release`, then `ops`:

**A. Dry-run first (signs/writes NOTHING, no PIN, no tap):**
```sh
cd maintainers
node packages/cli/dist/index.js upsert-mandate \
  --track <TRACK> \
  --duration <DURATION> \
  --signing-key yubikey-piv:slot=9c \
  --successors  file:backup-9c.pub \
  --threshold   1 \
  --min-successors 1 \
  --max-duration <DURATION> \
  --project-name flagship \
  --project-contact harry@flagship.services \
  --path ../.maintainers \
  --dry-run
```
(Omit `--holder` so the signing key is the holder — a from-scratch
mandate MUST be self-signed; the CLI hard-fails in `assemble` if
`--holder` ≠ `--signing-key`.) The agent verifies the printed canonical
bytes (hex + utf-8) and the unsigned `.maintainers` diff:
`kind:"Mandate"`, `version:1`, `track:"<TRACK>"`, `holder` ==
`signedBy` (genesis is self-signed), `successors` == the backup pubkey,
`approvalRule:{kind:"threshold",threshold:1}`, the inline
`minSuccessors`/`maxDurationSeconds`/`defaultDurationSeconds`, the
`project` block, and the would-write path
`.maintainers/tracks/<TRACK>/mandates/<compact-iso>-<short-id>.json`
(NO `policy.json` — there is none in v2). Re-running mints a fresh
id/timestamps, so the dry-run preview is exact for that invocation
only — confirm the *structure*; the dryrun.test.ts byte-fidelity test
is what proves preview==real with uuid/timestamps pinned.

**B. Real run (drop `--dry-run`):** same command without `--dry-run`.
The CLI prints the FROM-SCRATCH ORIGIN banner + the same byte/diff
REVIEW, then prompts: `Type UPSERT-MANDATE (exactly) then Enter to
proceed, anything else aborts:` (the typed-confirm phrase for
`upsert-mandate` is `UPSERT-MANDATE`, per `confirmPhrase`). The human
types `UPSERT-MANDATE`, then **taps the primary YubiKey** (PIN once,
touch per signature). Do **not** use `--yes` for the real ceremony —
type the phrase by hand. It writes the signed mandate and prints
`holder:` / `issuedAt:` / `expiresAt:` / `mandateId:` / `successors:` /
`rule:` / `PIN (canonical hash):`.

### After all three tracks (agent)

1. **Verify the chain.** Run
   `node packages/cli/dist/index.js verify --path ../.maintainers`
   (exits non-zero on any failure) and
   `node packages/cli/dist/index.js status --path ../.maintainers` —
   every track must resolve FORWARD from its from-scratch origin
   mandate; the agent independently re-checks the canonical bytes +
   signatures + the `mandatePinHash` before the irreversible bake.
2. **Record the pinned-mandate canonical hash.** The CLI printed
   `PIN (canonical hash):` for each track; it is `mandatePinHash` of
   that track's from-scratch origin mandate. **This per-surface re-bake
   is Phase C** (#30 generalised): the SAME value goes into FOUR
   locations — `@flagship/protocol` `maintainerCa.ts`
   `MAINTAINER_PINNED_MANDATE_HASH` (covers the daemon #8 + the webapp
   #9 via the const), iOS (Swift), Android (Kotlin). Same value, four
   baked locations. Record the exact per-track hash in the ceremony
   artifact + `docs/v1-launch-program.md` so the mobile re-bake is
   provably identical. (Do NOT edit `maintainerCa.ts` here — Phase C
   owns the bake; Operation 0 only produces + records the hash.)
3. **Commit** the `.maintainers/` artifacts (the three from-scratch
   mandates — one per track; NO `policy.json`). **Deploy nothing.**
4. **Validate a consumer/port via the c5 portable conformance
   artifact.** `maintainers/conformance/` (spec §12) is the
   dependency-free 17-vector set (4 happy + all 10 mandatory
   fail-closed negatives + totality + CA-no-pin) every consumer and
   every #10 port (iOS/Android) MUST replay through its verifier — the
   guard that no surface ships with a wrong/empty/placeholder pin or a
   mis-implemented verify-forward. Re-run the #8 suite + the flagship
   gate to prove links 1–4 resolve against the real origin (they were
   correctly inert while the const was empty).

## Upstream push — governed-PR + re-pin (Phase-A.merge)

The ceremony-tooling hardening lands upstream via a **governed
`maintainers` PR** (PR #1/#2 precedent: a human merges it), then the
orchestrator bumps `scripts/maintainers.pinned-sha` +
`pull-maintainers.sh`, then `npm publish @maintainers/protocol`, then
flagship DROPS the pull-script and consumes the published package like
any adopter — THEN Gate B (the first `upsert-mandate`, its
`mandatePinHash` pinned per surface). The "Next upstream increment
(web-ui CA-lease views)" above is REPLACED by §10.1: those views become
status/preview-only; no signing view is built.

## CEREMONY SURFACE UPDATE (2026-05-16, user) — the NFC-tap maintainer app

Refines the above. Full design: `docs/maintainer-ca-endorsement.md`
§11. The **primary** ceremony surface is now a dedicated, minimal,
reproducibly-built **"Flagship Maintainer" mobile app** (Android-first,
iOS fast-follow — both feasible): open app → plain-language ceremony +
raw-bytes/diff preview → **tap the YubiKey to the phone (NFC)** →
PIV-Ed25519 signs the canonical bytes (key never leaves the token;
protocol UNCHANGED — PIV-Ed25519 == standard Ed25519 over the same
bytes) → POST to the §10.2 .com commit-writer. One device, one tap.
Genesis (from-scratch `upsert-mandate`) + succession are guided in-app
(two taps). Hardware mandate: YubiKey 5, fw ≥ 5.7 (PIV-Ed25519), NFC,
two keys/maintainer, touch=always. The web-ui shrinks to status only.
**The CLI here is now the air-gapped / store-down / successor ESCAPE
HATCH, not the everyday path** — it must keep working but is no longer
what a maintainer normally touches. `rotate-ca` (hot CA key) stays
CLI-only, unchanged (the hot key must never touch a phone).

## OSS-GENERIC REFRAME (2026-05-16, user) — the app is project-agnostic

`docs/maintainer-ca-endorsement.md` §12. The maintainer NFC-tap app is
a GENERIC OSS tool (home: upstream `ibisllc/maintainers`), not
Flagship-only. Any project adopting the maintainers protocol: download
the app, add a profile `{forge, repo, maintainersPath, credentialRef}`,
save a narrowly-scoped per-repo git credential (hardware-stored,
biometric-gated), tap the YubiKey → the **app commits directly** to
that repo's `.maintainers/`. The §10.2 hosted `.com` commit-writer is
now OPTIONAL/opt-in (credential-off-phone mode) — NOT required; the
default is app-direct-commit, zero infra for adopters. Authority is
still ONLY the YubiKey Ed25519 (never on the phone); the git
credential is write-transport, can't forge authority (offline verifier
+ append-only walk contain a stolen token to one-repo DoS). Flagship =
one configured consumer; its baked-pinned-mandate-hash + fail-closed
verifier wiring is the reference template other adopters copy.
