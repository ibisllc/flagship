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
| `src/scanResult.ts` | Builds + signs the envelope using **`@flagship/protocol`'s `signMarketplaceScanResult`** — same bytes `.com` verifies. No hand-rolled canonical bytes. |
| `src/scanner.ts` | Pure orchestration: assess → grade → assemble report → (upload) → signed post. Fail-closed. |
| `src/ports.ts` | Injected interfaces: `ScanRunner`, `ReportStore`, `ResultPoster`, `QueueSource`, `Clock`. |
| `src/adapters.ts` | **Thin real adapters** (git/npm/trivy/semgrep, R2 PUT, HTTP post, scan-queue). NOT unit-tested against real infra. |
| `src/index.ts` | Thin cron entry: wires real adapters + drains the landed scan-queue. |

The vitest gate substitutes fake ports — it never execs
git/npm/trivy/semgrep/docker or touches the network. The real tools
run only at the live/operator edge.

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
