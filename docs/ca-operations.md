# CA operations — issue a lease, rotate the CA, take over as maintainer

Audience: the Flagship maintainer and **any future successor**. If you
are a successor and Harry is gone, you can run everything here with your
own YubiKey + a unix shell. Nothing here needs Harry.

Design rationale: `docs/maintainer-ca-endorsement.md`. Protocol:
`maintainers/docs/spec/v1.md` §2.6/§3.7/§5.1.

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
a **typed confirmation** (a ceremony-specific phrase, e.g. `CA-LEASE`)
before any token touch or write; `--yes` is the deliberate
non-interactive bypass (banner + preview still shown). The PIN and any
`file:` private key are never logged anywhere (regression-tested). The
same `--dry-run`/banner/typed-confirm applies to `genesis`, `mandate`,
and `takeover`.

The `ca-endorsement` command and the `yubikey-piv:` signer source both
exist (maintainers `feat/piv-ed25519-signer`, #28): the PIV-resident
Ed25519 private half never leaves the token, and a PIV-Ed25519
signature over the canonical bytes is byte-identical RFC-8032 Ed25519,
so there is **zero protocol/wire/spec change** (§11.1). The native
PC/SC transport is verified only at the YubiKey gate; until it is
wired the source fail-closes with a precise message — it never
silently falls back. **Lower-assurance fallback** (air-gapped /
successor, documented as such): `--signing-key
file:<maintainer-ed25519-priv-hex-file>` — a local 32-byte hex file
you guard.

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
release/ops) tracks. This is the existing maintainers-protocol
succession; no Flagship-specific code.

- **Web-ui:** `…/maintainers/` → project → the track → **Take over**
  (route `#/p/github.com/ibisllc/flagship/takeover/ca`). It is offered
  only to a pubkey listed in the prior mandate's `successors` after
  `expiresAt`. Tap YubiKey → signs a successor `Mandate`.
- **CLI:**
  ```sh
  node maintainers/packages/cli/dist/index.js takeover \
    --track ca --successor-key file:<your-priv> \
    --new-holder file:<your-pub> --duration 180d \
    --path .maintainers
  ```
Then you are the ca-track authority and Operations 1–2 are yours.
Repeat per track (`ca`, `release`, `ops`). The `TakeoverAlarm` makes
the transition visible to every consumer — expected and good.

Pre-public-release one-time step: the current ca/release/ops genesis
holder is a **deterministic placeholder** (`.maintainers/keys/*` says
so). Before launch, run the real genesis ceremony with the real
YubiKey (maintainers README → genesis) and replace the placeholder
keyfiles.

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
  re-verifies the signed artifact chains to the pinned genesis + is
  append-only, then commits (branch + auto-PR by default). Worst-case
  compromise = commit-a-valid-signed-thing / DoS / garbage caught by
  the offline verifier — it cannot forge authority. CLI may instead
  `gh`/git-commit directly; same verify-then-commit path, the Worker
  is the website convenience + successor-proof fallback.

## Operation 0 — genesis (once, pre-release, CLI + primary YubiKey)

**This is the Human Gate B ceremony. It is IRREVERSIBLE — it creates the
root of trust. Run it exactly; `--dry-run` every track first.** Generate
the cold maintainer Ed25519 ON the primary YubiKey; write the genesis
`Mandate` for the `ca`, `release`, and `ops` tracks (three runs) naming
the **second YubiKey** in `successors`; commit the resulting
`.maintainers/` artifacts; bake the emitted holder pubkey into the build
as `MAINTAINER_GENESIS_PUBKEYS`. Until this is done that constant is
`Object.freeze([])` and every consumer fail-closes (rejects all CA
artifacts) — safe, since nothing is released and demo uses mock
recovery. Tests/analysis assume the deterministic `.maintainers/`
placeholder genesis is present.

The command surface below is verified against the merged
`maintainers` CLI at the pinned SHA (`scripts/maintainers.pinned-sha`
= `833fa45`, PR #2 / #28). The genesis command does NOT generate the
on-token key — that is a hardware prerequisite (step 1).

> **GATE-B EXECUTION REALITY (verified against source 2026-05-17 s4 —
> read before attempting).** `maintainers/packages/cli/src/lib/
> piv-pcsc.ts` `connectPcscChannel()` is, by #28's deliberate design,
> a **fail-closed stub that throws UNCONDITIONALLY** — even when the
> optional `pcsclite` binding IS installed (it does `void mod; throw
> CliError("…no PC/SC reader/token round-trip…verified only at the
> YubiKey ceremony gate")`). #28 shipped the pure tested `piv-apdu`
> codec + the `PcscChannel` seam + this stub; the real binding wiring
> (reader enumeration → connect → APDU transmit Buffer↔Uint8Array) is
> the explicitly-deferred **human-gate increment**, implementable only
> with the real reader+token present to verify the round-trip. So
> executing Gate B is a TWO-PART step, in this order:
> **(P) human provisions the environment** (install `pcsclite` so the
> binding can load + `ykman` for keygen; generate the on-token Ed25519
> keys; plug in both YubiKeys) → **(A) agent implements + live-verifies
> the `connectPcscChannel` libpcsclite wiring** behind the existing
> tested seam, proving the round-trip with a NON-destructive public-key
> read FIRST (security-critical native transport; lands upstream via a
> governed `maintainers` PR + re-pin, like PR #1/#2; NEVER written
> blind / bolted unverified — the hardware-in-loop verification is the
> whole point of doing it AT the gate) → then the `--dry-run` and the
> signed ceremony below. **The `file:` hex key is NOT acceptable for
> the genesis root** — it would put the root-of-trust private half on
> disk, defeating the entire on-token/no-escrow model; `file:` is the
> documented *successor / air-gapped* lower-assurance path ONLY, never
> for minting genesis.
>
> **STEP-(A) UX REQUIREMENT (hard — the tool must not make
> hardware-presence assumptions).** When the libpcsclite wiring is
> implemented it MUST treat *no reader connected*, *no token in the
> reader*, and *not tapped yet* as **normal, recoverable** states: a
> clear human prompt + wait/poll + retry ("Insert your YubiKey and
> press Enter…", "Tap your YubiKey now…"), with actionable guidance —
> **never** a cryptic fatal `CliError` for the everyday "hardware not
> inserted yet" case. Fail-closed is strictly a SECURITY property
> (never silently sign with a weaker/wrong key, never a hex fallback);
> it must NOT leak into the UX of ordinary absent-hardware. Conformance
> for step (A): "no reader" and "token removed mid-prompt" paths each
> show a friendly wait/retry and recover when the key is inserted —
> add this to the step-(A) tests. (This whole reality callout exists
> because an empty USB scan was once mistaken for a blocker without
> first asking the operator to plug the key in — do not repeat that;
> the only real prep blockers are the unconditional-throw stub +
> `pcsclite`/`ykman` not installed, all plug-in-independent.)

### Prerequisites (human, before any CLI)

1. **On each of the two YubiKeys, generate an Ed25519 key in PIV slot
   `9c`** ("digital signature": PIN-gated every signature), **touch
   policy = always**, **PIN once per session** — per §11.1 of
   `docs/maintainer-ca-endorsement.md` (YubiKey 5, fw ≥ 5.7, NFC). The
   private half is generated on-token and **never exported**. The exact
   `ykman piv keys generate …` invocation + the PIN/PUK policy is the
   maintainer's to run with YubiKey Manager; slot `9c` is the CLI
   default (`DEFAULT_PIV_SLOT`), and the precise slot/PIN/PUK defaults
   are the §11.4 "open knob" the maintainer fixes here, once.
2. **Export the SECOND (backup/successor) YubiKey's slot-9c public key
   to a file** — a no-PIN public read, done once: this lets the genesis
   runs name the successor as `--successors file:backup-9c.pub` without
   juggling two tokens on one reader mid-ceremony. (Alternative: pass
   `--successors yubikey-piv:slot=9c` and physically swap to the backup
   token when the public read is requested — `loadSignerPubKeyList`
   resolves sequentially.) **The named successor is the ONLY recovery
   if the primary is lost/bricked — there is no key escrow.**
3. **Decide `<DURATION>` for the cold genesis mandate.** This is a human
   policy choice (not code-derivable). Per the LOCKED Phase-2 D1 the
   cold maintainer track is *long-lived* (changing quorum/track-set is a
   NEW genesis ceremony); a multi-year duration (e.g. `3650d`) is
   appropriate. Expiry is not terminal: the `mandate` command (the
   append-only track log) renews/extends a track signed by the genesis
   holder — but pick a comfortably long genesis duration regardless.
4. **Build the CLI** (dist/ is gitignored — absent on a fresh clone):
   ```sh
   cd maintainers && npm run build      # = tsc -b, idempotent
   ```

### The ceremony (per track: ca, release, ops — repeat all of steps A/B)

For each `<TRACK>` in `ca`, then `release`, then `ops`:

**A. Dry-run first (signs/writes NOTHING, no PIN, no tap):**
```sh
cd maintainers
node packages/cli/dist/index.js genesis \
  --track <TRACK> \
  --duration <DURATION> \
  --holder-key  yubikey-piv:slot=9c \
  --signing-key yubikey-piv:slot=9c \
  --successors  file:backup-9c.pub \
  --output ../.maintainers \
  --dry-run
```
The agent verifies the printed canonical bytes (hex + utf-8) and the
unsigned `.maintainers` diff: `kind:"Mandate"`, `track:"<TRACK>"`,
`holder` == `signedBy` (genesis is self-signed; the CLI hard-fails if
`--signing-key` ≠ `--holder-key`), `successors` == the backup pubkey,
and the would-write path
`.maintainers/tracks/<TRACK>/mandates/<ts>-<id>.json` (+
`tracks/<TRACK>/policy.json` if missing). Re-running mints a fresh
id/timestamps, so the dry-run preview is exact for that invocation
only — confirm the *structure*, not byte-equality across runs.

**B. Real run (drop `--dry-run`):** same command without `--dry-run`.
The CLI prints the ⚠ GENESIS banner + the same byte/diff REVIEW, then
prompts: `Type GENESIS (exactly) then Enter to proceed, anything else
aborts:`. The human types `GENESIS`, then **taps the primary YubiKey**
(PIN once, touch per signature). Do **not** use `--yes` for the real
ceremony — type the phrase by hand. It writes the signed mandate (+
`policy.json` if missing) and prints `holder:` / `successors:` /
`mandateId:`.

### After all three tracks (agent)

1. **Verify the chain.** Run `node packages/cli/dist/index.js verify
   --path ../.maintainers` (exits non-zero on any failure) and
   `node packages/cli/dist/index.js status --path ../.maintainers` —
   every track must resolve from its genesis; the agent independently
   re-checks the canonical bytes + signatures before the irreversible
   bake.
2. **Bake the genesis pubkey.** The `holder:` pubkey is identical
   across ca/release/ops (the same primary YubiKey self-signed all
   three) — that ONE 64-hex value goes into `@flagship/protocol`
   `maintainerCa.ts` `MAINTAINER_GENESIS_PUBKEYS` (today
   `Object.freeze([])`). #30 flips live; the daemon (#8) and later the
   webapp (#9) consume this const. **Re-bake the SAME value per surface
   in Phase 2 #10** (iOS Swift + Android Kotlin). **Record the exact
   pubkey value in `docs/v1-launch-program.md` + the ceremony artifact**
   so the mobile re-bake is provably identical.
3. **Commit** the `.maintainers/` artifacts (the three mandates + the
   per-track `policy.json`) AND the `MAINTAINER_GENESIS_PUBKEYS` bake to
   flagship. **Deploy nothing.**
4. **Re-run the #8 suite** (`caTrustChain` / `releaseVerifier` tests) +
   the flagship gate to prove links 1–4 now resolve against a real
   genesis (they were correctly inert while the const was empty).

## Upstream push — now pre-authorized

`feat/ca-endorsement` → `ibisllc/maintainers` push + PR is authorized.
Future-session order: push+PR → (merge=governed) → bump
`scripts/maintainers.pinned-sha` + `pull-maintainers.sh` → link-4
wiring (#84 C1.2c) unblocks. The "Next upstream increment (web-ui
CA-lease views)" below is REPLACED by §10.1: those views become
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
Genesis + takeover are guided in-app (two taps). Hardware mandate:
YubiKey 5, fw ≥ 5.7 (PIV-Ed25519), NFC, two keys/maintainer, touch=
always. The web-ui shrinks to status only. **The CLI here is now the
air-gapped / store-down / successor ESCAPE HATCH, not the everyday
path** — it must keep working but is no longer what a maintainer
normally touches. `rotate-ca` (hot CA key) stays CLI-only, unchanged
(the hot key must never touch a phone).

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
one configured consumer; its baked-genesis + fail-closed verifier
wiring is the reference template other adopters copy.
