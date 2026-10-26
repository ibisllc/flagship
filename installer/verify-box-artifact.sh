#!/bin/bash
# Verify a box release artifact BEFORE anything in it runs (SEC-INSTALL-001).
#
# This is the one piece of the install that cannot be written in the artifact's
# own Node: nothing from the artifact may judge itself. It needs only bash,
# jq, openssl 3 and sha256sum, all of which the target has before any Node does.
#
# The manifest file is { "manifest": {...}, "signatures": [{keyHex, signatureHex}] }
# (packages/protocol/src/boxArtifact.ts). The canonical bytes it checks are
#   flagship/box-artifact/v1|commit|arch|artifactSha256|artifactBytes|nodeVersion|
#   nodeSha256|lockSha256|sbomSha256|provenanceSha256|minVerifier|sequence|issuedAt
# and must equal the TypeScript canonical form byte for byte (shared vectors).
#
#   verify-box-artifact.sh --manifest FILE --artifact FILE \
#       --trust-keys HEX[,HEX...] --threshold N \
#       --expect-sha256 HEX --expect-commit HEX40 --arch amd64|arm64 \
#       [--last-sequence N] [--node-floor X.Y.Z] [--verifier-version N]
#       [--pq-key-ids HEX[,HEX...]] [--legacy-manifests HEX[,HEX...]] [--now MS]
#
# With --pq-key-ids (the code pin BOX_ARTIFACT_PQ_PIN, packages/protocol/src/boxArtifactPq.ts)
# a signer counts only with its hybrid companion (`signatures[i].pq`) over
#   flagship/box-artifact/v2|sha256(v1 canonical)|signer|keyId
# under a pinned `release-key` binding from the file's `pqBindings`; Ed25519 is checked with
# openssl's Ed25519 and ML-DSA-65 (OpenSSL 3.5 or later). A manifest whose v1 digest is in
# --legacy-manifests was signed before the cut-over and needs no PQ half.
#
# Exit 0 only if every check passes. On refusal it prints "refused: <code>" and
# exits 1 (the codes are the TypeScript BoxArtifactRefusal names); exit 2 is a
# usage error. Nothing is written outside a private temp directory.
set -u
set -o pipefail

VERIFIER_VERSION_DEFAULT=1
manifest="" artifact="" trust="" threshold="" expect_sha="" expect_commit="" arch=""
last_seq="" node_floor="" verifier_version="$VERIFIER_VERSION_DEFAULT"
pq_key_ids="" legacy_manifests="" now_ms=""

usage() { echo "usage: $0 --manifest F --artifact F --trust-keys K1,K2 --threshold N --expect-sha256 H --expect-commit C --arch A [--last-sequence N] [--node-floor V] [--verifier-version N]" >&2; exit 2; }
refuse() { echo "refused: $1${2:+ ($2)}" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2 ;;
    --artifact) artifact="$2"; shift 2 ;;
    --trust-keys) trust="$2"; shift 2 ;;
    --threshold) threshold="$2"; shift 2 ;;
    --expect-sha256) expect_sha="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --last-sequence) last_seq="$2"; shift 2 ;;
    --node-floor) node_floor="$2"; shift 2 ;;
    --verifier-version) verifier_version="$2"; shift 2 ;;
    --pq-key-ids) pq_key_ids="$2"; shift 2 ;;
    --legacy-manifests) legacy_manifests="$2"; shift 2 ;;
    --now) now_ms="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$manifest" ] && [ -n "$artifact" ] && [ -n "$trust" ] && [ -n "$threshold" ] \
  && [ -n "$expect_sha" ] && [ -n "$expect_commit" ] && [ -n "$arch" ] || usage
for t in jq openssl; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t" >&2; exit 2; }; done

hex40='^[0-9a-f]{40}$'; hex64='^[0-9a-f]{64}$'; semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; int='^(0|[1-9][0-9]*)$'

# ---- the manifest, field by field (jq -r gives null as the text "null": rejected by the patterns) ----
get() { jq -er ".manifest.$1 | if type==\"string\" or type==\"number\" then tostring else error(\"bad type\") end" "$manifest" 2>/dev/null; }
commit=$(get commit)                 || refuse bad-manifest commit
m_arch=$(get arch)                   || refuse bad-manifest arch
artifact_sha=$(get artifactSha256)   || refuse bad-manifest artifactSha256
artifact_bytes=$(get artifactBytes)  || refuse bad-manifest artifactBytes
node_version=$(get nodeVersion)      || refuse bad-manifest nodeVersion
node_sha=$(get nodeSha256)           || refuse bad-manifest nodeSha256
lock_sha=$(get lockSha256)           || refuse bad-manifest lockSha256
sbom_sha=$(get sbomSha256)           || refuse bad-manifest sbomSha256
prov_sha=$(get provenanceSha256)     || refuse bad-manifest provenanceSha256
min_verifier=$(get minVerifier)      || refuse bad-manifest minVerifier
sequence=$(get sequence)             || refuse bad-manifest sequence
issued_at=$(get issuedAt)            || refuse bad-manifest issuedAt

[[ "$commit" =~ $hex40 ]] || refuse bad-manifest commit
[ "$m_arch" = amd64 ] || [ "$m_arch" = arm64 ] || refuse bad-manifest arch
for pair in "artifactSha256:$artifact_sha" "nodeSha256:$node_sha" "lockSha256:$lock_sha" "sbomSha256:$sbom_sha" "provenanceSha256:$prov_sha"; do
  [[ "${pair#*:}" =~ $hex64 ]] || refuse bad-manifest "${pair%%:*}"
done
[[ "$node_version" =~ $semver ]] || refuse bad-manifest nodeVersion
for pair in "artifactBytes:$artifact_bytes" "minVerifier:$min_verifier" "sequence:$sequence" "issuedAt:$issued_at"; do
  [[ "${pair#*:}" =~ $int ]] || refuse bad-manifest "${pair%%:*}"
done
[ "$artifact_bytes" -gt 0 ] 2>/dev/null || refuse bad-manifest artifactBytes

canonical="flagship/box-artifact/v1|$commit|$m_arch|$artifact_sha|$artifact_bytes|$node_version|$node_sha|$lock_sha|$sbom_sha|$prov_sha|$min_verifier|$sequence|$issued_at"

# ---- the trust set ----
[[ "$threshold" =~ $int ]] && [ "$threshold" -ge 1 ] || refuse bad-trust threshold
IFS=',' read -r -a keys <<< "$trust"
declare -A authorized=()
for k in "${keys[@]}"; do
  k=$(printf '%s' "$k" | tr 'A-F' 'a-f')
  [[ "$k" =~ $hex64 ]] || refuse bad-trust key
  authorized["$k"]=1
done
[ "${#authorized[@]}" -ge "$threshold" ] || refuse bad-trust threshold

tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT
printf '%s' "$canonical" > "$tmp/canonical.bin"

# ---- the PQ pin: which signers must also carry their hybrid companion ----
HYBRID_TAG="flagship/hybrid-sig/ed25519-mldsa65/v1"
KEYID_TAG="flagship/pq-key-id/v1"
hex_of() { printf '%s' "$1" | xxd -p | tr -d '\n'; }
# hybrid_verify <ed hex> <mldsa hex> <purpose> <payload text> <signature hex>: both halves over M'.
hybrid_verify() {
  local ed="$1" ml="$2" purpose="$3" payload="$4" sig="$5"
  [ "${#sig}" -eq 6746 ] || return 1
  { printf '%02x' "${#HYBRID_TAG}"; hex_of "$HYBRID_TAG"; printf '0002%s%s' "$ed" "$ml"
    printf '%02x' "${#purpose}"; hex_of "$purpose"; printf '%08x' "${#payload}"; hex_of "$payload"; } | xxd -r -p > "$tmp/m.bin"
  printf '%s' "${sig:0:128}" | xxd -r -p > "$tmp/es.bin"
  printf '%s' "${sig:128}" | xxd -r -p > "$tmp/ms.bin"
  { printf '%s' "302a300506032b6570032100$ed" | xxd -r -p | openssl pkey -pubin -inform DER -out "$tmp/hed.pem"; } 2>/dev/null || return 1
  { printf '%s' "308207b2300b0609608648016503040312038207a100$ml" | xxd -r -p | openssl pkey -pubin -inform DER -out "$tmp/hml.pem"; } 2>/dev/null || return 1
  openssl pkeyutl -verify -pubin -inkey "$tmp/hed.pem" -rawin -in "$tmp/m.bin" -sigfile "$tmp/es.bin" >/dev/null 2>&1 || return 1
  openssl pkeyutl -verify -pubin -inkey "$tmp/hml.pem" -rawin -in "$tmp/m.bin" -sigfile "$tmp/ms.bin" -pkeyopt "context-string:$HYBRID_TAG" >/dev/null 2>&1 || return 1
}
need_pq=""
declare -A pinned_ids=() bound_ml=() bound_id=()
if [ -n "$pq_key_ids" ]; then
  IFS=',' read -r -a ids <<< "$pq_key_ids"
  for k in "${ids[@]}"; do [[ "$k" =~ $hex64 ]] || refuse bad-trust pq-key-id; pinned_ids["$k"]=1; done
  if command -v sha256sum >/dev/null 2>&1; then v1_digest=$(printf '%s' "$canonical" | sha256sum | cut -d' ' -f1); else v1_digest=$(printf '%s' "$canonical" | shasum -a 256 | cut -d' ' -f1); fi
  need_pq=1
  IFS=',' read -r -a legacy <<< "$legacy_manifests"
  for d in "${legacy[@]}"; do [ "$d" = "$v1_digest" ] && need_pq=""; done
fi
if [ -n "$need_pq" ]; then
  [ -n "$now_ms" ] || now_ms=$(( $(date +%s) * 1000 ))
  [[ "$now_ms" =~ $int ]] || refuse bad-trust now
  nb=$(jq -er '.pqBindings // [] | length' "$manifest" 2>/dev/null) || nb=0
  j=0
  while [ "$j" -lt "$nb" ] && [ "$j" -lt 32 ]; do
    b=".pqBindings[$j]"; j=$((j + 1))
    [ "$(jq -r "$b | keys | join(\",\")" "$manifest" 2>/dev/null)" = "ed25519PubHex,issuedAt,mldsaPubHex,role,signature,subjectId,v" ] || continue
    bv=$(jq -r "$b.v" "$manifest")
    # Wire v1 repeats the ML-DSA key in the signed statement; v2 (the compact form a YubiKey can sign: its PIV
    # applet takes about 3 KB of message) leaves it out, the hybrid message already carries it. Release keys only.
    { [ "$bv" = 1 ] || [ "$bv" = 2 ]; } && [ "$(jq -r "$b.role" "$manifest")" = release-key ] \
      && [ "$(jq -r "$b.subjectId" "$manifest")" = flagship-box-artifact ] || continue
    bed=$(jq -r "$b.ed25519PubHex" "$manifest"); bml=$(jq -r "$b.mldsaPubHex" "$manifest")
    bat=$(jq -r "$b.issuedAt | if type==\"number\" then tostring else \"x\" end" "$manifest"); bsig=$(jq -r "$b.signature" "$manifest")
    [[ "$bed" =~ $hex64 ]] && [ "${#bml}" -eq 3904 ] && [[ "$bml" =~ ^[0-9a-f]+$ ]] && [[ "$bat" =~ $int ]] || continue
    [ "$bat" -le $((now_ms + 300000)) ] || continue
    [ -z "${bound_ml[$bed]:-}" ] || continue
    kid=$( { printf '%02x' "${#KEYID_TAG}"; hex_of "$KEYID_TAG"; printf '000207c0%s%s' "$bed" "$bml"; } | xxd -r -p | openssl dgst -sha512 -binary | head -c 32 | xxd -p | tr -d '\n')
    [ -n "${pinned_ids[$kid]:-}" ] || continue
    if [ "$bv" = 2 ]; then
      hybrid_verify "$bed" "$bml" "flagship/pq-key-binding/v2" "flagship/pq-key-binding/v2|release-key|flagship-box-artifact|$bed|$bat" "$bsig" || continue
    else
      hybrid_verify "$bed" "$bml" "flagship/pq-key-binding/v1" "flagship/pq-key-binding/v1|release-key|flagship-box-artifact|$bed|$bml|$bat" "$bsig" || continue
    fi
    bound_ml["$bed"]="$bml"; bound_id["$bed"]="$kid"
  done
fi

# ---- signatures: distinct authorized keys with a valid Ed25519 signature ----
declare -A signed=()
classical_only=0
count=$(jq -er '.signatures | length' "$manifest" 2>/dev/null) || refuse bad-manifest signatures
[[ "$count" =~ $int ]] || refuse bad-manifest signatures
i=0
while [ "$i" -lt "$count" ] && [ "$i" -lt 32 ]; do
  key=$(jq -r ".signatures[$i].keyHex // \"\"" "$manifest" | tr 'A-F' 'a-f')
  sig=$(jq -r ".signatures[$i].signatureHex // \"\"" "$manifest" | tr 'A-F' 'a-f')
  i=$((i + 1))
  [ -n "${authorized[$key]:-}" ] || continue
  [ -z "${signed[$key]:-}" ] || continue
  [[ "$sig" =~ ^[0-9a-f]{128}$ ]] || continue
  # An Ed25519 public key is the 12-byte SPKI prefix followed by the 32 raw bytes.
  { printf '%s' "302a300506032b6570032100$key" | xxd -r -p | openssl pkey -pubin -inform DER -out "$tmp/pub.pem"; } 2>/dev/null || continue
  printf '%s' "$sig" | xxd -r -p > "$tmp/sig.bin"
  openssl pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin -in "$tmp/canonical.bin" -sigfile "$tmp/sig.bin" >/dev/null 2>&1 || continue
  if [ -n "$need_pq" ]; then
    pkid=$(jq -r ".signatures[$((i - 1))].pq.keyId // \"\"" "$manifest")
    psig=$(jq -r ".signatures[$((i - 1))].pq.signatureHex // \"\"" "$manifest")
    if [ -z "${bound_id[$key]:-}" ] || [ "$pkid" != "${bound_id[$key]}" ] \
      || ! hybrid_verify "$key" "${bound_ml[$key]}" "flagship/box-artifact/v2" "flagship/box-artifact/v2|$v1_digest|$key|$pkid" "$psig"; then
      classical_only=$((classical_only + 1))
      continue
    fi
  fi
  signed["$key"]=1
done
if [ "${#signed[@]}" -lt "$threshold" ]; then
  [ -n "$need_pq" ] && [ $(( ${#signed[@]} + classical_only )) -ge "$threshold" ] && refuse pq-signature-required "${#signed[@]} of $threshold with their PQ signature"
  refuse not-enough-signatures "${#signed[@]} of $threshold"
fi

# ---- the file, the recipe and the host ----
expect_sha=$(printf '%s' "$expect_sha" | tr 'A-F' 'a-f')
[ "$expect_sha" = "$artifact_sha" ] || refuse digest-mismatch recipe
if command -v sha256sum >/dev/null 2>&1; then measured=$(sha256sum "$artifact" | cut -d' ' -f1); else measured=$(shasum -a 256 "$artifact" | cut -d' ' -f1); fi
[ "$measured" = "$artifact_sha" ] || refuse digest-mismatch file
size=$(wc -c < "$artifact" | tr -d ' ')
[ "$size" = "$artifact_bytes" ] || refuse size-mismatch
expect_commit=$(printf '%s' "$expect_commit" | tr 'A-F' 'a-f')
[ "$expect_commit" = "$commit" ] || refuse commit-mismatch
[ "$arch" = "$m_arch" ] || refuse arch-mismatch
[ "$min_verifier" -le "$verifier_version" ] || refuse verifier-too-old
if [ -n "$last_seq" ]; then
  [[ "$last_seq" =~ $int ]] || refuse rollback last-sequence
  [ "$sequence" -gt "$last_seq" ] || refuse rollback
fi
if [ -n "$node_floor" ]; then
  [[ "$node_floor" =~ $semver ]] || refuse node-below-floor floor
  lowest=$(printf '%s\n%s\n' "$node_floor" "$node_version" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)
  [ "$lowest" = "$node_floor" ] || refuse node-below-floor "$node_version"
fi

echo "verified: $commit $m_arch sequence $sequence signed by ${#signed[@]}"
exit 0
