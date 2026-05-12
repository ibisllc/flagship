# Flagship marketplace scanner (#56)

Standalone service that runs Trivy + custom checks on marketplace
listings and posts a signed scan result back to `flagshipserver.com`.

## What it does

For each marketplace listing whose `scan_grade` is NULL:

1. Pulls the docker image at the listing's `imageRef`.
2. Runs Trivy (`trivy image --format json --quiet --severity HIGH,CRITICAL`)
   against the image.
3. Runs custom checks against the listing's `flagship.app.json` manifest:
   - No `*` in `data.network.allowedHosts`.
   - No `runtime.requiresPrivileged: true`.
   - No suspicious `runtime.envInject.*` patterns.
4. Computes a grade (A/B/C/D/F) from the Trivy CVE counts + custom-check results.
5. Uploads the full JSON report to R2 at `r2://flagship-scan-reports/<creator>/<slug>/<imageDigest>.json`.
6. Posts a signed `MarketplaceScanResult` envelope to `POST /api/marketplace/<creator>/<slug>/scan`.

## Grade rubric

| Grade | Criteria |
|---|---|
| A | 0 CRITICAL + 0 HIGH CVEs in Trivy output; all custom checks pass. |
| B | 0 CRITICAL + 1-2 HIGH CVEs; all custom checks pass. |
| C | 0 CRITICAL + 3-5 HIGH CVEs; OR 1 minor custom check warning. |
| D | 0 CRITICAL + 6+ HIGH CVEs; OR multiple custom check warnings. |
| F | Any CRITICAL CVE; OR any "no shipping" custom check failure (network=`*`, requiresPrivileged=true, etc.). |

The rubric is intentionally cautious — most well-maintained images
land at B+ — so a marketplace listing that ships A is "this maintainer
clearly cares about CVEs." An F listing is hidden from search by
default (a config knob).

## Deployment

The scanner is meant to run on a Flagship-operated host (a low-end
VPS or a Flagship-pod with Docker installed). It is NOT a Cloudflare
Worker — running Trivy needs filesystem access + a Docker daemon.

```sh
# One-time:
sudo apt install -y trivy docker.io
npm install -g tsx
git clone https://github.com/harrywinner2/flagship
cd flagship/services/marketplace-scanner

# Configure env:
export FLAGSHIP_API_URL="https://flagshipserver.com"
export FLAGSHIP_SCANNER_PRIV_HEX=$(cat .scanner-key)
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=flagship-scan-reports

# Run on a cron (every 6 hours):
0 */6 * * * cd /opt/flagship-scanner && npm start >>scanner.log 2>&1
```

## Signing key

`FLAGSHIP_SCANNER_PRIV_HEX` is the Ed25519 private key whose pubkey
is set as the Worker's `MARKETPLACE_SCANNER_PUBKEY_HEX` env var. The
control-plane handler validates incoming scan results against this
pubkey; only the scanner can post.

To rotate:

1. Generate a new keypair: `node -e 'const {ed25519}=require("@noble/curves/ed25519"); const p=ed25519.utils.randomPrivateKey(); console.log("priv:", Buffer.from(p).toString("hex")); console.log("pub:", Buffer.from(ed25519.getPublicKey(p)).toString("hex"))'`
2. Update Worker secret: `wrangler secret put MARKETPLACE_SCANNER_PUBKEY_HEX` (paste pub).
3. Update scanner env: `FLAGSHIP_SCANNER_PRIV_HEX=<new priv>`.
4. Restart the scanner cron.

## Local testing

```sh
npm test            # runs the grading-rubric unit tests (no Docker needed)
npm start -- --dry  # walks the listing list + computes grades without posting
```

## What's stubbed in this v1

- Trivy invocation uses `child_process.execFileSync`. For high-volume
  use a proper pool + async would be better; out of scope.
- Custom-check set is intentionally narrow (3 checks). Extend as new
  app-platform attack vectors are discovered.
- No retry on R2 upload failure — a missed scan just retries on the
  next cron tick.

This service is BUSL-1.1 → Apache 2.0 in 2030, same as the rest of
the project.
