#!/usr/bin/env bash
# Scan a marketplace listing's docker image with Trivy + custom checks
# and POST the signed result back to flagshipserver.com.
#
# This script is the OPERATIONAL side of the marketplace security
# scan service. It runs out-of-band (manual today; GitHub Actions
# nightly is the next step) against listings.
#
# Required env:
#   FLAGSHIP_SCANNER_PRIV_HEX  Ed25519 private key (hex, 32 bytes).
#                              The matching public key must be set on
#                              .com as MARKETPLACE_SCANNER_PUBKEY_HEX.
#   FLAGSHIP_R2_BUCKET         R2 bucket where reports get uploaded
#                              (e.g. "flagship-marketplace-scans").
#   AWS_ACCESS_KEY_ID +        Cloudflare R2 credentials (S3-compatible).
#   AWS_SECRET_ACCESS_KEY
#   AWS_ENDPOINT_URL_S3        e.g. "https://<account>.r2.cloudflarestorage.com"
#
# Args:
#   $1  creator   (e.g. "alice")
#   $2  slug      (e.g. "habit-tracker")
#   $3  image     OPTIONAL (e.g. "ghcr.io/alice/habit-tracker:1.4.2").
#                 When omitted, the image ref is RESOLVED from the listing's
#                 manifest: GET /api/marketplace/<creator>/<slug>, then
#                 jq '.listing.manifest_json | fromjson | .runtime.image'.
#                 A listing whose manifest names no runtime.image is LOGGED
#                 and SKIPPED (exit 0) — nothing to pull, don't fail the run.
#
# What it does:
#   1. docker pull <image>; capture the resolved digest.
#   2. trivy image --format json --output report.json <image>
#   3. Score the report → grade A..F (see grade_from_trivy below).
#   4. Upload report.json to R2 under <creator>/<slug>/<scannedAt>.json.
#   5. Sign + POST a MarketplaceScanResult to .com.

set -euo pipefail

CREATOR="${1:?usage: scan-marketplace-listing.sh <creator> <slug> [image]}"
SLUG="${2:?missing slug}"
IMAGE="${3:-}"

: "${FLAGSHIP_SCANNER_PRIV_HEX:?}"
: "${FLAGSHIP_R2_BUCKET:?}"
: "${AWS_ACCESS_KEY_ID:?}"
: "${AWS_SECRET_ACCESS_KEY:?}"
: "${AWS_ENDPOINT_URL_S3:?}"

API_BASE="${FLAGSHIP_API_BASE:-https://flagshipserver.com}"
WORK="$(mktemp -d -t flagship-scan.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# 0. Resolve the image ref from the listing's manifest when $3 is absent.
#    The listing carries `manifest_json`; the container the daemon runs is
#    named by `runtime.image` (docs/manifest.md). No resolvable image ⇒
#    log + skip (exit 0), matching the queue-drain's log+skip policy.
if [[ -z "$IMAGE" ]]; then
  echo "[scan] no image arg — resolving from $CREATOR/$SLUG manifest"
  LISTING_JSON=$(curl -fsS "$API_BASE/api/marketplace/$CREATOR/$SLUG" || echo "")
  if [[ -z "$LISTING_JSON" ]]; then
    echo "[scan] SKIP: could not fetch listing $CREATOR/$SLUG"
    exit 0
  fi
  IMAGE=$(jq -r '(.listing.manifest_json // .manifest_json // "") | select(. != "") | fromjson | .runtime.image // ""' <<<"$LISTING_JSON" 2>/dev/null || echo "")
  if [[ -z "$IMAGE" || "$IMAGE" == "null" ]]; then
    echo "[scan] SKIP: manifest for $CREATOR/$SLUG names no runtime.image"
    exit 0
  fi
  echo "[scan] resolved image=$IMAGE"
fi

echo "[scan] $CREATOR/$SLUG image=$IMAGE"

# 1. Pull + capture digest.
docker pull "$IMAGE" >/dev/null
IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null \
  || docker inspect --format='{{.Id}}' "$IMAGE")
DIGEST_HEX="${IMAGE_DIGEST##*sha256:}"
echo "[scan] image digest: sha256:$DIGEST_HEX"

# 2. Trivy.
REPORT="$WORK/report.json"
trivy image \
  --quiet \
  --no-progress \
  --format json \
  --output "$REPORT" \
  --severity CRITICAL,HIGH,MEDIUM,LOW \
  "$IMAGE"

# 3. Grade. Heuristic: each CRITICAL caps at F; >5 HIGH caps at D;
# any HIGH caps at C; otherwise A. Coarse for v1 — real production
# probably wants a custom-checks pass on top.
grade_from_trivy() {
  local report="$1" crit hi
  crit=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' "$report")
  hi=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' "$report")
  if [[ "$crit" -gt 0 ]]; then echo "F"; return; fi
  if [[ "$hi" -gt 5 ]]; then echo "D"; return; fi
  if [[ "$hi" -gt 0 ]]; then echo "C"; return; fi
  echo "A"
}
GRADE=$(grade_from_trivy "$REPORT")
echo "[scan] grade: $GRADE"

# 4. Upload report.json to R2.
SCANNED_AT_MS=$(($(date +%s%N) / 1000000))
REPORT_KEY="$CREATOR/$SLUG/$SCANNED_AT_MS.json"
aws --endpoint-url "$AWS_ENDPOINT_URL_S3" \
  s3 cp "$REPORT" "s3://$FLAGSHIP_R2_BUCKET/$REPORT_KEY" \
  --content-type application/json \
  --quiet
echo "[scan] uploaded report → $REPORT_KEY"

# 5. Sign + POST. Uses Node so we can re-use the protocol package's
# signMarketplaceScanResult — keeps the canonical-bytes shape in one
# place across .com and the scanner.
node --no-warnings - <<NODE
const { signMarketplaceScanResult, ed } = await import("@flagship/protocol");
const priv = Buffer.from(process.env.FLAGSHIP_SCANNER_PRIV_HEX, "hex");
const claim = {
  creator: "$CREATOR",
  slug: "$SLUG",
  grade: "$GRADE",
  reportKey: "$REPORT_KEY",
  imageDigestHex: "$DIGEST_HEX",
  scannedAt: $SCANNED_AT_MS,
};
const sig = signMarketplaceScanResult(claim, { privateKey: priv, publicKey: ed.getPublicKey(priv) });
const body = JSON.stringify({
  request: claim,
  signature: Buffer.from(sig).toString("hex"),
});
const r = await fetch("${API_BASE}/api/marketplace/$CREATOR/$SLUG/scan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
if (!r.ok) {
  console.error("post failed:", r.status, await r.text());
  process.exit(1);
}
console.log("posted ✅");
NODE
