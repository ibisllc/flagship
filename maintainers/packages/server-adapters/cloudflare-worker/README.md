# @maintainers/server-adapter-cloudflare-worker

Cloudflare Worker reference implementation of the **Model A** server-side
adapter for the [maintainers protocol](../../../docs/spec/v1.md).

A signature-gated push proxy. The Worker holds a GitHub fine-grained
PAT (single repo, `contents:write`) and accepts envelope-bearing POSTs
to `/commit`. Every commit is gated on the envelope's signatures
verifying against the current on-repo `.maintainers/` state. Writes
outside `.maintainers/**` are refused unconditionally.

## Why a server-side adapter at all?

Most adopters can't run their own backend just to manage authority
keys. Model A is the "we run it for you, but we can't betray you"
option: the Worker can't synthesize commits — every commit must
already be signed by the project's authorized keys before it ever
reaches the Worker, and the Worker's path-prefix fence guarantees the
PAT can't be exfiltrated into source code. The PAT is bound to a
single repo, scoped to `contents:write`, and never appears in any
response body or log.

## Endpoints

### `POST /commit`

Submit a signed envelope. The Worker verifies it against the repo's
current `.maintainers/` state and, on success, commits the file via
the GitHub Contents API.

Request body:

```json
{
  "repoUrl": "github.com/foo/bar",
  "targetBranch": "main",
  "path": ".maintainers/tracks/release/mandates/2026-06-01-renewal.json",
  "envelope": { "kind": "Mandate", ... },
  "envelopeBytes": "6d61696e7461696e6572732f6d616e6461..."
}
```

`envelopeBytes` is the hex-encoded canonical-bytes derivation of the
envelope (see `@maintainers/protocol`'s `canonical*()` helpers). The
Worker re-derives it locally and refuses any request where they
diverge — closing the "send signature for envelope X while claiming
envelope Y" attack.

Success: `200 { ok: true, commit: "<sha>", path, branch }`.

Failure: `{ ok: false, reason: "<machine-readable>", detail?: "..." }`
with one of `400 / 403 / 429 / 502 / 500`. The full list of `reason`
values is exhaustively covered by tests in `tests/policy.test.ts`.

### `GET /verify?repoUrl=github.com/foo/bar`

Returns the verified `.maintainers/` summary view:

- per-track current authority (holder + mandate + expiry + successors)
- key directory
- derived takeover alarms (successor signed a new mandate after the
  prior holder's expiry — UI cue, not blocking)

Browser extensions can use this as a fast cached server-side
alternative to their own client-side verification.

### `GET /healthz`

Returns `{ ok: true }`. No state.

## Defense-in-depth

Five independent fences, each sufficient to refuse a commit:

1. **Path-prefix.** `path` must start with `.maintainers/`. Hard-coded;
   re-checked at the moment of the GitHub PUT.
2. **Envelope shape.** Body must parse as one of six known envelope
   kinds at version 1. Unknown kinds: refused. (Spec rule that
   consumers ignore unknown kinds for authority decisions does NOT
   apply to a write-gate.)
3. **Canonical-bytes match.** Request's `envelopeBytes` MUST equal the
   bytes the Worker derives locally. Forecloses the
   sig-for-envelope-X-claimed-as-Y class.
4. **Signatures verify.** Every signature in the envelope must
   Ed25519-verify against the canonical bytes.
5. **Authority.** Signers must satisfy the relevant track's approval
   rule against the current on-repo state. Genesis condition (no
   `.maintainers/` directory yet) accepts any well-formed self-signed
   Mandate on a first-come basis.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `GITHUB_MAINTAINERS_PAT` | Fine-grained PAT, `contents:write`, single repo. **Set via `wrangler secret put`**, never in `wrangler.toml`. | (required) |
| `ALLOWED_REPOS` | Comma-separated `github.com/owner/repo` allowlist. Empty = deny-all. | `""` (deny-all) |
| `RATE_LIMIT_PER_IP_PER_HOUR` | Per-IP commit cap. | `60` |
| `RATE_LIMIT_PER_REPO_PER_HOUR` | Per-repo commit cap. | `100` |
| `DEFAULT_BRANCH` | Branch used when `targetBranch` is omitted from a request. | `main` |
| `MAINTAINERS_PATH_PREFIX` | Hard-coded fence, do not change in deployment. | `.maintainers/` |
| `RATE_LIMITER` | Optional Cloudflare native rate-limit binding. If unbound, the Worker falls back to an in-memory throttle (approximate due to isolate churn). | (unbound) |

Never bake org-specific defaults into the deployed code: anyone who
deploys this Worker for their own org should be able to point
`ALLOWED_REPOS` at their repo and walk away.

## PAT setup

1. Create a GitHub fine-grained PAT.
2. Set **repository access** to *only the single repo* this Worker manages.
3. Set permissions: **Contents: Read and write** — nothing else. No
   metadata, no admin, no other scopes.
4. Set an expiry no longer than the rotation cadence you operate
   (90 days is reasonable).
5. Load it as a Worker secret:

```sh
cd maintainers/packages/server-adapters/cloudflare-worker
npx wrangler secret put GITHUB_MAINTAINERS_PAT
# paste the token at the prompt; it's never written to disk
```

Rotate by repeating step 5 with a fresh token, then revoking the old
one in GitHub settings.

## Deploy

```sh
cd maintainers/packages/server-adapters/cloudflare-worker

# One-time
npx wrangler secret put GITHUB_MAINTAINERS_PAT

# Set the allowed-repos list at deploy time. Empty = deny-all (default).
# Either edit wrangler.toml [vars].ALLOWED_REPOS, or push it as a var:
npx wrangler deploy --var ALLOWED_REPOS:github.com/myorg/myrepo

# Subsequent deploys (after code changes):
npx wrangler deploy
```

## Tests

```sh
# From the package root, after monorepo `npm install`:
npx vitest run --dir tests
```

The test suite is fully offline — no GitHub mocks, no network. It
covers every policy-decision branch and the Worker's helper functions.

## Dependencies

- `@maintainers/protocol` — the canonical-bytes + verifier package
  (workspace-local).
- `@cloudflare/workers-types` (devDep) — type declarations.
- `wrangler` (devDep) — the deploy CLI.

No runtime production dependencies outside the workspace. The
protocol package itself depends on `@noble/curves` and
`@noble/hashes`, both of which are pure-JS and ship into the Worker
unmodified.

## Security posture

A Worker that holds a write-capable PAT for `main` is a high-value
target. The mitigations stacked here:

- **Signature verification is the gate.** A commit cannot land unless
  the envelope already carries valid signatures from keys currently
  authorized on the relevant track. Compromising the Worker (without
  also compromising the authorized keys) yields no useful capability.
- **Path-prefix is the fence.** If verification ever slips, the Worker
  still refuses to write outside `.maintainers/**`. The fence is
  enforced both before the GitHub read (to deny without spend) and
  immediately before the PUT (to deny even if a future code path
  forgot).
- **Repo allowlist.** A bound PAT against a single repo plus an
  in-config allowlist of canonical repo identifiers — both must match.
- **Rate limit.** Per-IP and per-repo caps. The CF native binding is
  preferred; the in-memory fallback is approximate and exists only as
  a last-resort safety.
- **Token hygiene.** The PAT never appears in any response body or
  log. Error paths return generic reasons (`github-write-failed`,
  `internal-error`). For audit-grade logs, attach Cloudflare logpush
  to a private destination.
- **No envelope echo.** The Worker does NOT log full envelopes —
  pubkeys may be intended to remain private until commit lands.
