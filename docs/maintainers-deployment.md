# Maintainers protocol — deployment & operations

Flagship dogfoods the [maintainers protocol](https://github.com/ibisllc/maintainers).
This doc explains how the protocol's code is pulled at build time, where the
UI is hosted, what keys it needs, and what's load-bearing for adopters who
want to set up the same model for their own repository.

> tl;dr — `scripts/pull-maintainers.sh` clones `ibisllc/maintainers` at a
> pinned SHA into `./maintainers/` (gitignored). The Flagship build then
> consumes it as a normal npm workspace. Flagship's hosted UI lives at
> `flagshipserver.com/maintainers/`, served by the Cloudflare Worker's
> `[assets]` binding. No keys are required to *pull*; one fine-grained
> GitHub PAT is required only if you also deploy the Model-A push adapter.

---

## Where the UI lives

For Flagship: **`https://flagshipserver.com/maintainers/`** — a subdirectory
of the marketing site, served by the same Cloudflare Worker that hosts
the apex `/`, `/docs`, `/faq`, etc.

Considered and rejected for v1:

- **`maintainers.flagshipserver.com`** — cleaner separation but needs a new
  DNS record, a route in `wrangler.toml`, and a CORS surface for the
  adapter Worker. Will revisit if path conflicts arise or if we want a
  separate Worker for the maintainers UI (e.g., to deploy independently).
- **`maintainers.ibis.dev`** or another Ibis-LLC-owned domain — most
  independent narrative ("Ibis LLC publishes maintainers as a separate
  product, Flagship is an adopter") but adds another Worker + domain +
  cert to operate. Defer until the protocol has external adopters.

A subdirectory is the cheapest deployment that still gives every adopter
a copy-paste-able pattern. The Flagship-specific HTML host page lives at
`apps/web/public/maintainers/index.html`; the library code (compiled
JS from `@maintainers/web-ui`) is copied in by the pull-at-build script.

---

## How the code is pulled

The whole `maintainers/` tree is **not** checked into this repo. Two
reasons:

1. **Single source of truth.** `ibisllc/maintainers` is the canonical
   home. Vendoring its sources here would invite drift the moment a
   commit lands in one place but not the other.
2. **Dogfood.** Pulling from a protocol-managed repo at build time is
   the same shape adopters will use. We hit the same pain points they
   will (auth, pinning, reproducibility) and our build is documentary.

### The pull script — `scripts/pull-maintainers.sh`

```sh
bash scripts/pull-maintainers.sh
```

What it does:

1. Reads `MAINTAINERS_REPO_URL` (default
   `https://github.com/ibisllc/maintainers.git`).
2. Reads `MAINTAINERS_PINNED_SHA` (env override) or
   `scripts/maintainers.pinned-sha` (a one-line file under version
   control).
3. If `maintainers/.git` exists and HEAD is already at the pinned SHA,
   exits 0 silently — fast for repeat invocations.
4. Otherwise `git clone`s (first run) or `git fetch + git reset --hard`s
   to the pinned SHA.
5. Runs `npm install --prefix maintainers --no-audit --no-fund` so the
   maintainers tree has its own resolved `node_modules`.

`scripts/maintainers.pinned-sha` is the *only* file in this repo that
controls which `maintainers` revision Flagship trusts. To upgrade:
overwrite it with a fresh SHA from `ibisllc/maintainers` (after CI
reviews the diff) and commit.

### Where the pull happens in each environment

| Environment | When pull-maintainers runs |
|---|---|
| Local dev (first `git clone`) | `npm install` triggers `preinstall` → pull |
| Local dev (subsequent rebuilds) | Cached on the SHA; near-instant no-op |
| Docker build (Fly app) | First stage runs `pull-maintainers.sh` before `tsc -b` |
| Cloudflare Worker deploy | Same — the Worker bundle includes assets the build pulled |
| CI (GitHub Actions) | Same; the Actions cache keys on the pinned SHA |

---

## Configuration surface

Two knobs, both env-overridable:

| Variable | Default | Purpose |
|---|---|---|
| `MAINTAINERS_REPO_URL` | `https://github.com/ibisllc/maintainers.git` | Where to clone from. Set to your fork if you've forked. |
| `MAINTAINERS_PINNED_SHA` | contents of `scripts/maintainers.pinned-sha` | Pin to a specific commit. Tag refs (`v1.0.0`) work too — the script uses `git fetch` with the value verbatim. |

Anything beyond these two knobs would be moving knobs around for the
sake of moving them. The repo URL is the *only* thing an adopter needs
to change to use their own fork; the SHA is the *only* trust knob.

---

## Keys & their scopes

Three distinct scopes, kept deliberately separate:

### 1. Build-time pull — **zero keys**

`ibisllc/maintainers` is a public repo. Anonymous HTTPS clone works.
No PAT, no deploy key, no secrets.

For adopters whose fork is private, the same script reads
`MAINTAINERS_REPO_URL`; point it at an SSH URL
(`git@github.com:yourorg/maintainers.git`) and let your CI inject an
SSH agent with a *read-only* deploy key scoped to one repo.

### 2. Flagship maintainers UI hosted at `/maintainers/` — **zero keys**

The hosted UI is static. It only *reads* the `.maintainers/` folder
from `ibisllc/flagship` via the public GitHub raw-content URL. No
authentication needed.

Writes from the hosted UI happen through Model A (below) or Model B
(user copies the patch and applies it manually via a normal PR). Model
B requires no keys on the deployer side at all.

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

- **`@maintainers/protocol`** — pure TS library. Runs in the browser
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

1. Fork `github.com/ibisllc/maintainers` (or use it directly — read-only
   from your build doesn't require a fork).
2. In your own repo:
   - Copy `scripts/pull-maintainers.sh` and
     `scripts/maintainers.pinned-sha`.
   - Set `MAINTAINERS_REPO_URL` to your fork (if forked).
   - Add `maintainers/` to `.gitignore`.
   - Add a `preinstall` script that runs `pull-maintainers.sh`.
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
