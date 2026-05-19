# Maintainers protocol — deployment & operations

Flagship dogfoods the [maintainers protocol](https://github.com/ibisllc/maintainers).
This doc explains how the protocol's code is consumed, what keys it
needs, and what's load-bearing for adopters who want to set up the same
model for their own repository.

> **★ 2026-05-19 — the hosted `flagshipserver.com/maintainers/` web-ui
> surface has been REMOVED (and is NOT coming back).** It was a
> non-load-bearing convenience viewer: nothing in the trust path ever
> fetched it (consumers verify-forward from the *baked* pin against the
> project's own `.maintainers/`, never from a network-served page —
> §13). The correct, sufficient surfaces are: (1) an adopter exposes
> their `.maintainers/` folder over their **git host's plain GET**
> (GitHub/GitLab/Gitea already serve it) — that is the adopter's
> responsibility, not ours to host; (2) public transparency is the
> **Maintainers Checkpoints repo** (a mirrorable git repo, by design
> NOT a service anyone operates); (3) operators use the **`maintainers`
> CLI**. Hosting webserver/UI code for this is explicitly out of
> scope. Any reference below to a hosted `/maintainers/` page or its
> `apps/web/public/maintainers/` bundle is superseded by this note.

> tl;dr — Flagship consumes the **published `@ibisllc/maintainers` npm
> package** (exact-pinned in `packages/server-daemon/package.json`,
> resolved by `npm ci`/`npm install` with lockfile integrity) exactly
> like any external adopter. The conformance test-vector artifact ships
> inside that package (`node_modules/@ibisllc/maintainers/conformance/`)
> and the iOS/Android cross-language replays read it from there. The
> old build-time clone bootstrap (`scripts/pull-maintainers.sh` +
> `scripts/maintainers.pinned-sha`) has been **removed** — see
> "Adoption" below. There is **no hosted maintainers web UI** (the
> former `flagshipserver.com/maintainers/` surface was removed — see
> the banner above). No keys are required to consume the package; one
> fine-grained GitHub PAT is required only if you also deploy the
> Model-A push adapter.

---

## Adoption: the transition to the published package is DONE

**Status: COMPLETE (2026-05-19).** Flagship now consumes the published
`@ibisllc/maintainers@0.1.0` from the public npm registry — exact-pinned
in `packages/server-daemon/package.json`, integrity-locked in
`package-lock.json`, fetched by `npm ci`/`npm install` like any other
dependency. The build-time clone bootstrap
(`scripts/pull-maintainers.sh` + `scripts/maintainers.pinned-sha`, plus
the npm `preinstall`/`postinstall` hooks, the root workspace entry, and
the TS project references into `maintainers/packages/protocol`) has been
**deleted**. The rest of this section is retained as the rationale that
drove the transition.

`scripts/maintainers.pinned-sha` + `scripts/pull-maintainers.sh`
(clone `ibisllc/maintainers` at a pinned commit SHA at build time) was
**flagship's private pre-1.0 dogfooding bootstrap only**. It was *not*
a distribution mechanism and must never be presented to external
adopters as one. A bespoke clone-at-build shell script is one of the
highest-friction ways to depend on a library — the opposite of the
maintainers project's whole objective ("usable by others in their
own projects easily").

Why the SHA-pull is acceptable *for now*: while flagship and
maintainers are **co-developed**, the SHA-pull lets us bump to an
unreleased `main` commit instantly without a publish cycle (exactly
what happened merging `ibisllc/maintainers#1` → re-pin `10c65aa`).
That convenience is real and only justified during co-development.

**MUST transition — trigger:** as soon as the spec is deemed mature,
i.e. when flagship↔maintainers **co-development ends**. This is
expected *soon* — the protocol primitives are all coded; the main
gap is end-to-end testing, not new protocol surface. Do not let the
pull-script ossify into the de-facto integration story; that would
keep external adoption hard indefinitely.

**What the transition is (the adopter-friendly model):**

1. **Publish `@ibisllc/maintainers` to npm** — semver, `npm publish
   --provenance` (Sigstore-backed supply-chain attestation), pinned
   by consumers via exact version + lockfile integrity / `npm ci`.
   Same reproducibility as a SHA pin, a fraction of the friction, and
   a *stronger* standard tamper-evidence story than "fetch this SHA
   over https." (Trust is anchored in the genesis pubkey — data —
   not the code channel, so the code channel should optimize purely
   for adoption friction.)
2. **Treat the versioned spec as the primary portable artifact** —
   `docs/spec/v1.md` + the `maintainers/<purpose>/v1` canonical-bytes
   tags + a **published conformance test-vector set**, so non-TS
   adopters (Swift, Kotlin, Go, Rust, …) can implement links 1–4 and
   self-verify. The TS package is the *reference* implementation, not
   the only one. This directly de-risks the iOS/Android port (#10)
   and every adopter who isn't a TS project.
3. **Flagship then drops the pull-script** and consumes the published
   `@ibisllc/maintainers` exactly like any external adopter — which
   is the only way the "we dogfood the same model adopters use"
   claim becomes *true* (today flagship dogfoods a path no adopter
   would ever use, which undercuts the rationale).

Tracked as **SESSION-HANDOFF.md §3 #35** (trigger-gated MUST).

---

## Threat model & applicability boundary

**maintainers propagates trust forward from a pinned root; it never
creates trust.** Reading this before adopting it (or before reasoning
about what a compromise buys an attacker) is mandatory — the
guarantee is precise and its edges are sharp.

### A purge is a detectable *denial*, not a *forgery*

Three mechanisms compose:

1. **Link-1 is a baked genesis pubkey in the *consumer*, not in the
   protected repo.** The artifact the end-user runs ships the genesis
   pubkey compiled in (`@flagship/protocol`'s
   `MAINTAINER_GENESIS_PUBKEYS`, or any adopter's equivalent).
   Verification walks *forward* from that pin.
2. **Fail-closed is mandatory.** Empty / absent / forked
   `.maintainers/` ⇒ no chain rooted in the pinned genesis ⇒
   `authorizedCaKeys` empty ⇒ reject **everything**. The spec forbids
   fallback: absence of a genesis is a hard reject, never a downgrade.
3. **`verifyEndorsementChainAgainstGit` pins the first-parent commit
   walk** between consecutive endorsements (intermediate-commit list +
   Merkle root, checked against the *local* git history).

Together: an attacker who takes the history and purges/rewrites
`.maintainers/` cannot forge a trusted build — they get a build that
*fails to validate* on every fail-closed consumer. They can't
substitute their own `.maintainers/` (any chain not signed by the
genesis private key is rejected) and can't keep two real endorsements
while swapping the code between them (the git-walk catches it). The
purge degrades to a **visible, safe failure** — the property working,
not breaking.

### The applicability boundary (where adoption makes sense)

Everything bottoms out at one out-of-band fact: the genesis pin the
consumer was built with, and the consumer's own provenance. So the
guarantee tiers by who the attacker controls:

| Attacker controls | maintainers gives you |
|---|---|
| A mirror/host of the protected project (≠ maintainer, ≠ consumer build) | **Full protection.** The realistic open-source threat; covered. |
| An insider / compromised host distinct from the root | **Tamper-evidence + an auditable ceremony log.** A divergence is provable after the fact. |
| The consumer's own root (source **+** build **+** distribution of the verifying artifact) | **Nothing** — they strip the pin and the verify call. No in-band scheme (SLSA, Sigstore, signed apt, …) survives this; trust must be anchored out of band. |

**The guarantee scales with the size of the independent population
that can detect a divergence from the pinned root.** Maximal in open
source — the genesis pubkey is published in many independent places,
reproducible builds let many parties confirm "this binary == this
audited source", and a missing/forked `.maintainers/` is socially
conspicuous because thousands hold the real history. It degrades
toward "trust the vendor" as that population shrinks. A closed
single-vendor adopter still gets a real, auditable tamper-evident
ceremony log (valuable against a compromised mirror/insider distinct
from the root) — but cannot be protected against the root party
itself, because no independent population exists to notice
divergence. **This is the design's stated assumption, not a
limitation to paper over: maintainers is for projects with an agreed,
widely-replicated canonical source.**

### Consequences (load-bearing)

- **Every consumer MUST be fail-closed with a real pin.** A port that
  fails open, or ships an empty genesis as a "TODO", silently
  destroys the entire property for its users. This is why the #35
  conformance vectors are not optional and **must include mandatory
  negative cases**: absent genesis ⇒ reject; forked/unknown genesis ⇒
  reject; endorsement gap / substituted intermediate ⇒ reject. No
  Swift/Kotlin/Go/Rust port (cf. SESSION-HANDOFF §3 #9/#10) may pass
  conformance while quietly weakening fail-closed.
- **The genesis pin must be maximally visible and independently
  re-derivable** — published in multiple channels and, ideally, tied
  to reproducible builds — since it is the single load-bearing
  out-of-band fact.

---

## Where the UI lives — N/A (removed 2026-05-19)

There is **no hosted maintainers UI**. The former
`flagshipserver.com/maintainers/` surface (`apps/web/public/maintainers/`)
was deleted — see the banner at the top of this doc. It was never in the
trust path. Adopters expose their `.maintainers/` over their git host's
plain GET; public transparency is the Maintainers Checkpoints repo;
operators use the `maintainers` CLI. Hosting webserver/UI code for this
is out of scope.

---

## How the code is consumed

The protocol code is **not** checked into this repo and is **not**
cloned at build time. Flagship depends on the published npm package
exactly like any external adopter:

1. **Single source of truth.** `ibisllc/maintainers` is the canonical
   home; `@ibisllc/maintainers` on npm is its published artifact.
   Vendoring or cloning the sources here would invite drift.
2. **Dogfood for real.** Consuming the published package is the same
   shape adopters use — npm registry fetch, exact version pin, lockfile
   integrity (`npm ci`). We hit the exact pinning/reproducibility story
   they do, with none of the bespoke-clone friction.

### The dependency — `@ibisllc/maintainers`

- Declared exact-pinned in `packages/server-daemon/package.json`
  (`"@ibisllc/maintainers": "0.1.0"` — no caret; matches the protocol's
  pin-the-artifact ethos) and integrity-locked in the root
  `package-lock.json`.
- Resolved by ordinary `npm ci` / `npm install` from the public
  registry. No git, no clone, no lifecycle hook, no env knobs.
- Ships its compiled `dist/`, the `SPEC.md`, and the **conformance
  test-vector artifact** at
  `node_modules/@ibisllc/maintainers/conformance/` (the shared 17-vector
  manifest + the additive `checkpoint-request/` set). The TypeScript,
  iOS, and Android cross-language conformance replays all read that
  on-disk artifact at runtime (never transcribed).

To upgrade: bump the exact version in
`packages/server-daemon/package.json`, run `npm install` to refresh the
lockfile integrity, and commit. Trust is anchored in the baked genesis
pin (data), not the code channel, so the registry is purely an
adoption-friction optimization.

---

## Keys & their scopes

Three distinct scopes, kept deliberately separate:

### 1. Dependency fetch — **zero keys**

`@ibisllc/maintainers` is a public npm package. `npm ci`/`npm install`
fetches it anonymously from the public registry. No PAT, no deploy key,
no secrets.

Adopters who maintain a private fork can publish it to their own
registry/scope and point the dependency at that — the same exact-pin +
lockfile-integrity story applies.

### 2. Hosted maintainers UI — **removed (N/A)**

There is no hosted UI (removed 2026-05-19 — see the top banner). A
`.maintainers/` folder is already readable over its git host's public
GET; nothing here needs keys. Authority *writes* are the genesis /
`upsert-mandate` / `ca-endorsement` ceremonies via the `maintainers`
CLI (Model B: a normal signed PR), and public witnessing is the
Checkpoints repo — neither requires a deployer-side key.

### 3. Model-A push adapter (optional) — **one fine-grained PAT**

If you stand up the Cloudflare Worker push adapter
(`packages/server-adapters/cloudflare-worker` in the maintainers repo),
that Worker holds **exactly one secret**:

- A **fine-grained personal access token** with `contents: write`
  scoped to *one repo only* (`ibisllc/flagship`).

Things to know about that PAT:

- GitHub fine-grained PATs cannot be scoped by file path. The PAT
  could in principle modify any file in `ibisllc/flagship`.
- The maintainers-protocol verifier compensates: it only honours
  `.maintainers/` changes that carry a valid signed envelope.
  Modifications to `.maintainers/` files via the PAT *without* a
  valid envelope are rejected by every consumer (daemon, install
  script, downstream verifier). The PAT is the trust to *send* an
  envelope; the envelope's signature is the trust to *accept* it.
- Modifications to other paths (source code) via the PAT would land
  in the repo, but our branch protection requires PR review on
  `main`, so a compromised PAT can at worst open a noisy PR that
  reviewers reject.
- **Defence in depth**: the adapter pushes to a `maintainers-auto`
  branch and opens a PR; merging requires CODEOWNERS approval. So
  even a compromised PAT can't directly mutate `main`.

If you don't want a PAT in production at all, run Model B only (the
UI generates a patch; you paste it into a PR manually). For Flagship's
small maintainer set, Model B is honestly enough.

---

## How the code "runs"

It's TypeScript, all the way down. No PHP, no Python, no Ruby.

- **`@ibisllc/maintainers`** — pure TS library. Runs in the browser
  and in Node 20+. Zero runtime dependencies beyond the standard JS
  runtime + Web Crypto. Used by the daemon, the install script, and
  every other consumer that validates an envelope.

- **`@maintainers/web-ui`** — TS that compiles to ES modules. Hosted
  as static files. Runs entirely in the browser. Uses WebAuthn-PRF
  to derive the signing key from the user's hardware (Touch ID,
  Windows Hello, YubiKey-via-FIDO2). The library exposes
  `mountApp(element, options)` and we wrap it in a small host
  page (`apps/web/public/maintainers/index.html`) for the Flagship
  UX.

- **`@maintainers/cli`** — Node 20+ via `tsx`. Lets you sign
  envelopes from a headless environment (CI, an air-gapped
  machine, a YubiKey-via-PIV laptop without a browser). Useful for
  the bootstrap genesis ceremony.

- **`@maintainers/extension`** — Chrome / Firefox MV3 extension that
  overlays maintainer info on GitHub / Gitea / Codeberg repo pages.
  Doesn't run on our infrastructure; users install it themselves.

- **`@maintainers/server-adapters/cloudflare-worker`** — Optional
  Worker for Model A. Holds the PAT, accepts signed envelopes from
  the browser, commits them to the repo via the GitHub Contents API.

### Does the browser commit?

In Model A: the browser **assembles** the canonical commit and signs
it; the adapter **executes** the commit via a PAT. The browser never
holds the PAT.

In Model B: the browser **emits** a patch (a `.tar.gz` plus a
suggested commit message); the user applies it via a normal
`git apply` + push, or pastes it into a GitHub web-UI commit.

### How does it parse `.maintainers/`?

The `parse-folder.ts` module fetches files via the **repo provider**
(GitHub raw, Gitea raw, IPFS gateway — pluggable). Each file is a
canonical-bytes envelope (CBOR-encoded; tagged `maintainers/<kind>/v1`).
The verifier walks the chain:

1. `genesis.cbor` is the root mandate.
2. Each subsequent mandate must be endorsed by a valid current
   mandate (or its designated successor after expiry).
3. Each release endorsement must be signed by a current mandate-holder
   in the right scope.

The walker caps at a configurable max-depth (default 64) to defeat
pathological chains.

---

## Adopter checklist

If you want to set up the same model for *your* repository:

1. Use `@ibisllc/maintainers` from npm directly (or fork
   `github.com/ibisllc/maintainers` and publish your fork to your own
   registry/scope if you need to diverge).
2. In your own repo:
   - Add `@ibisllc/maintainers` as an **exact-pinned** dependency
     (no caret) and commit the lockfile; install with `npm ci` so the
     integrity hash is enforced.
   - That's it — no clone script, no `preinstall` hook, no
     `.gitignore` entry. The conformance artifact is shipped inside the
     package at `node_modules/@ibisllc/maintainers/conformance/`.
3. Run the [genesis ceremony](https://github.com/ibisllc/maintainers#genesis)
   to populate your `.maintainers/` folder with a root mandate.
4. (Optional) Host the UI: copy
   `apps/web/public/maintainers/index.html` from Flagship as a
   starting template; adjust the `repoOwner` + `repoName` it passes
   to `mountApp`.
5. (Optional) Deploy the Model-A push adapter if you want browser-side
   editors. Otherwise, Model B (paste-the-patch) is fine and needs no
   keys at all.

---

## What's *not* in this doc

- The protocol envelope format itself — see
  [`ibisllc/maintainers/docs/spec/v1.md`](https://github.com/ibisllc/maintainers/blob/main/docs/spec/v1.md).
- The genesis ceremony — see the maintainers README.
- The WebAuthn-PRF derivation — see `web-ui/src/webauthn.ts` in the
  maintainers repo.
- How the Flagship daemon consumes `.maintainers/` at install time —
  see `installer/install.sh` and `packages/installer-apkovl/scripts/`
  in this repo.
