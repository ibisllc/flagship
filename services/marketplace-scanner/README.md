# Flagship marketplace scanner

The marketplace security-scan service (build-tasks §L). Given a
listing, it clones the canonical pod's repo at the pinned
`manifest_hash`, runs a sandboxed tool chain, computes a deterministic
A–F grade, uploads a report to R2, and posts a **scanner-signed**
`MarketplaceScanResult` back to `flagshipserver.com`. `.com` already
verifies that envelope (`handleMarketplaceScanResult` →
`verifyMarketplaceScanResult`) and writes
`marketplace_listings.scan_grade + scan_report_key`. This package is
the previously-missing *producer* of that envelope.

## Architecture (pure core + injected ports)

Mirrors the `packages/control-plane` convention: a pure,
runtime-agnostic, fully-unit-tested core + thin runtime adapters.

| File | Role |
|---|---|
| `src/grade.ts` | Pure A–F policy. Single source of truth for thresholds (see `POLICY.md`). Includes the fail-closed `gradeScanError`. |
| `src/trivy.ts` | The **injectable container-vuln seam** — `TrivyRunner { scan(imageRef): Promise<Finding[]> }`, the `Finding` type, the shared `parseTrivyJson`/`tallyFindings`/`findingsToVulnerabilities` helpers, and a deterministic `FakeTrivyRunner` for tests. |
| `src/scanResult.ts` | Builds + signs the envelope using **`@flagship/protocol`'s `signMarketplaceScanResult`** — same bytes `.com` verifies. No hand-rolled canonical bytes. |
| `src/scanner.ts` | Pure orchestration: assess → grade → assemble report → (upload) → signed post. Fail-closed. |
| `src/ports.ts` | Injected interfaces: `ScanRunner`, `ReportStore`, `ResultPoster`, `QueueSource`, `Clock`. |
| `src/adapters.ts` | **Thin real adapters** — `ExecTrivyRunner` (`trivy image`/`trivy fs` via `execFile`), `ExecScanRunner` (git/npm/semgrep + the injected `TrivyRunner`), R2 PUT, HTTP post, scan-queue. NOT unit-tested against real infra. |
| `src/index.ts` | Thin cron entry: wires real adapters + drains the landed scan-queue. |

The vitest gate substitutes fake ports — it never execs
git/npm/trivy/semgrep/docker or touches the network. The real tools
run only at the live/operator edge.

### The Trivy seam (HARD CONSTRAINT: no Trivy/Docker in CI)

The container-vulnerability scan is an **injected dependency**:

```ts
interface TrivyRunner { scan(imageRef: string): Promise<Finding[]> }
```

`ExecTrivyRunner` (in `adapters.ts`) is the real impl — it shells out
via `execFile('trivy', ['image' | 'fs', …])` and is **never** run by
the test gate. `FakeTrivyRunner` (in `trivy.ts`) returns canned
findings (or throws to exercise fail-closed) so the whole pipeline —
fold → grade → report → signed post — is unit-tested with no binaries.
`ExecScanRunner` takes a `TrivyRunner` in its constructor (defaulting
to `ExecTrivyRunner`), so a caller can swap in a `trivy image <ref>`
runner without touching the orchestration. Search the source for
`TODO(live):` for the two real-edge seams (the Trivy binary + sandbox
flags, and the R2 upload).

## Grade policy

See `POLICY.md` (public, deterministic, mirrors `src/grade.ts`).
Worst-finding-dominates; fail-closed F when a scan does not complete.

## Deployment

Runs on a Flagship-operated Docker-equipped host (low-end VPS or
Flagship pod), NOT a Cloudflare Worker — the tool chain needs a
filesystem + child processes.

```sh
sudo apt install -y git nodejs npm trivy
pipx install semgrep
npm install -g tsx
git clone https://github.com/ibisllc/flagship
cd flagship/services/marketplace-scanner

export FLAGSHIP_API_BASE="https://flagshipserver.com"
export FLAGSHIP_SCANNER_PRIV_HEX=$(cat .scanner-key)   # 32-byte hex
export FLAGSHIP_SCAN_QUEUE_BEARER=...                   # matches .com's scan-queue secret
export FLAGSHIP_R2_BUCKET_URL=https://<r2-write-proxy>  # report uploads
# optional: FLAGSHIP_SCAN_STALE_DAYS=30

# cron, every 6h:
0 */6 * * * cd /opt/flagship-scanner && npm start >>scanner.log 2>&1
```

`npm start -- --dry` walks the queue and computes + signs grades
**without** uploading or posting.

## Owner secrets (what lights the live pipeline)

None of these ship with values — the owner sets them to turn the pipeline
on. Until then the surfaces fail safely (the scan-queue 401/503s, the
scanner refuses to start, `.com` refuses scan posts).

| Secret | Where it lives | What it does |
|---|---|---|
| `FLAGSHIP_SCANNER_PRIV_HEX` | scanner host env | Ed25519 **private** key (32-byte hex) the scanner signs each `MarketplaceScanResult` with. The ONE credential that authorizes posting a grade. Keep off `.com`. |
| `MARKETPLACE_SCANNER_PUBKEY_HEX` | `.com` Worker secret | The matching **public** key. `handleMarketplaceScanResult` verifies every inbound grade against it; a wrong/absent key ⇒ 503 (post refused). Must be the pubkey of the priv above. |
| `SERVICES_CONTROL_SECRET` | `.com` Worker secret **and** the scanner's `FLAGSHIP_SCAN_QUEUE_BEARER` | The shared bearer that gates `GET /api/internal/marketplace-scan-queue`. The scanner presents it as `Authorization: Bearer …`; `.com` constant-time-compares. **The two MUST be the same string.** |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_ENDPOINT_URL_S3` + `FLAGSHIP_R2_BUCKET` | scanner host env (bash edge) / `FLAGSHIP_R2_BUCKET_URL` for the Node edge | Cloudflare R2 (S3-compatible) credentials + endpoint + bucket the full JSON report is uploaded to (`<creator>/<slug>/<treeDigest>.json`). A failed upload is non-fatal for the grade (the grade still posts; the report URL 404s until the next scan). |

Optional knobs: `FLAGSHIP_API_BASE` (default `https://flagshipserver.com`),
`FLAGSHIP_SCAN_STALE_DAYS` (rescan cadence), `--dry` (compute + sign, no
upload/post). The install-gate threshold
`MARKETPLACE_INSTALL_BLOCKED_GRADES` is a **`.com`** knob (default `F`),
not a scanner one — it decides which grades block install.

## Image resolution

The scanner grades the **container the daemon runs**, named by
`runtime.image` in the listing's manifest (`docs/manifest.md`). The
scan-queue now carries each listing's `manifest_json`; the drain resolves
`runtime.image` (`src/imageRef.ts`) and:

- resolvable ⇒ scans `trivy image docker://<ref>` (falling back to a
  source-tree `trivy fs` of the clone only when the manifest names no
  image);
- **unresolvable ⇒ LOG + SKIP** the listing (it stays never-scanned for
  the next tick) — a repo-only / not-yet-published listing has no image to
  pull, and blocking the whole drain on it (or minting a spurious F) would
  starve every other listing. `scripts/scan-marketplace-listing.sh` makes
  its `$3` image arg optional and applies the same resolve-or-skip via `jq`.

## Signing key

`FLAGSHIP_SCANNER_PRIV_HEX` is the Ed25519 private key whose pubkey is
set on the Worker as `MARKETPLACE_SCANNER_PUBKEY_HEX`. The
control-plane handler verifies every incoming result against that
pubkey; only the holder of the private key can post a grade.

To rotate: generate a new keypair, `wrangler secret put
MARKETPLACE_SCANNER_PUBKEY_HEX` (new pub), update
`FLAGSHIP_SCANNER_PRIV_HEX` (new priv), restart the cron.

## Local testing

```sh
npm test    # pure policy + signed-postback round-trip + fail-closed; no Docker/network
```

BUSL-1.1 → Apache 2.0 in 2030, same as the rest of the project.
