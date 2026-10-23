#!/usr/bin/env bash
#
# gym-box-artifact — give the gym a signed box artifact for ITS commit (SEC-INSTALL-001).
#
# Every bootstrap installs the artifact for the exact commit in release/box-release.json, checked
# against release/box-artifact-trust.json. The gym branch trusts its own key, so the gym can sign
# its own artifacts without touching production's. For the gym branch's tip this:
#
#   1. plans     skips when the tip already is its release commit (scripts/gym-box-release.mjs)
#   2. builds    tools/box-artifact/build.ts build, per architecture, from a clean `git archive`
#   3. signs     tools/box-artifact/build.ts sign with the gym key, then verifies against the trust file
#   4. uploads   to the gym's artifact bucket (flagship-iso-gym), served at gym.flagshipserver.com/build/iso
#   5. records   writes release/box-release.json, regenerates the compiled constants, commits on the gym
#                branch and pushes (the gym Worker deployed next compiles them in)
#
# Usage: bash scripts/gym-box-artifact.sh --worktree <gym worktree> [--arch amd64,arm64] [--dry-run] [--no-push]
#
# Env: GYM_ARTIFACT_KEY_FILE  hex Ed25519 seed (default ~/.config/flagship/gym-artifact-key, mode 600).
#                             Created on first use; its public key goes into the gym branch's trust file.
#      GYM_ARTIFACT_BUCKET    default flagship-iso-gym
#
# Never touches production: the key, the bucket and the trust file are the gym's.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

WT="" ARCHES="amd64" DRY=0 PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT="$2"; shift 2 ;;
    --arch) ARCHES="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-push) PUSH=0; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$WT" ] && [ -d "$WT/.git" -o -f "$WT/.git" ] || { echo "--worktree <gym worktree> is required" >&2; exit 2; }

say() { echo "  $*"; }
die() { echo "gym-box-artifact: $*" >&2; exit 1; }
BUCKET="${GYM_ARTIFACT_BUCKET:-flagship-iso-gym}"
KEY_FILE="${GYM_ARTIFACT_KEY_FILE:-$HOME/.config/flagship/gym-artifact-key}"

PLAN="$(node "$HERE/gym-box-release.mjs" plan --worktree "$WT")"
ACTION="$(node -e 'console.log(JSON.parse(process.argv[1]).action)' "$PLAN")"
COMMIT="$(node -e 'console.log(JSON.parse(process.argv[1]).commit)' "$PLAN")"
SEQ="$(node -e 'console.log(JSON.parse(process.argv[1]).sequence)' "$PLAN")"
say "plan: $PLAN"
if [ "$ACTION" = "skip" ]; then say "nothing to build"; exit 0; fi

if [ ! -f "$KEY_FILE" ]; then
  [ "$DRY" = "1" ] && { say "DRY-RUN would create the gym signing key at $KEY_FILE"; } || {
    mkdir -p "$(dirname "$KEY_FILE")"; umask 077
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex")+"\n")' > "$KEY_FILE"
    say "created the gym signing key at $KEY_FILE"
  }
fi
PUB=""
if [ -f "$KEY_FILE" ]; then
  PUB="$(node -e 'const c=require("node:crypto");const seed=Buffer.from(require("node:fs").readFileSync(process.argv[1],"utf8").trim(),"hex");if(seed.length!==32)process.exit(3);const k=c.createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});console.log(c.createPublicKey(k).export({format:"der",type:"spki"}).subarray(-32).toString("hex"))' "$KEY_FILE")" || die "the gym key file is not a 32-byte hex seed"
fi

# The gym branch trusts exactly its own key.
TRUST="$WT/release/box-artifact-trust.json"
if [ -n "$PUB" ] && ! node -e 'const t=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.exit(t.threshold===1&&t.keys.length===1&&t.keys[0]===process.argv[2]?0:1)' "$TRUST" "$PUB"; then
  if [ "$DRY" = "1" ]; then say "DRY-RUN would set $TRUST to threshold 1 and the gym key $PUB"; else
    node -e 'const f=process.argv[1],t=JSON.parse(require("node:fs").readFileSync(f,"utf8")); t.threshold=1; t.keys=[process.argv[2]]; require("node:fs").writeFileSync(f, JSON.stringify(t,null,2)+"\n")' "$TRUST" "$PUB"
    say "gym trust file now names the gym key"
  fi
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
for ARCH in ${ARCHES//,/ }; do
  say "build $COMMIT $ARCH (sequence $SEQ)"
  if [ "$DRY" = "1" ]; then say "DRY-RUN would: tools/box-artifact/build.ts build/sign/verify, then upload to r2://$BUCKET"; continue; fi
  # Build from the gym worktree's own repository (the commit must exist there).
  (cd "$WT" && npx tsx tools/box-artifact/build.ts build --commit "$COMMIT" --arch "$ARCH" --sequence "$SEQ" --out "$OUT" --repo "$WT") || die "build failed for $ARCH"
  NAME="flagship-box-${COMMIT:0:12}-$ARCH"
  (cd "$WT" && npx tsx tools/box-artifact/build.ts sign --manifest "$OUT/$NAME.manifest.unsigned.json" --out "$OUT/$NAME.manifest.json" --key-file "$KEY_FILE") || die "signing failed for $ARCH"
  (cd "$WT" && npx tsx tools/box-artifact/build.ts verify --manifest "$OUT/$NAME.manifest.json" --artifact "$OUT/$NAME.tar.gz" --commit "$COMMIT" --arch "$ARCH" --trust release/box-artifact-trust.json) || die "the signed manifest does not verify against the gym trust file"
  rm -f "$OUT/$NAME.manifest.unsigned.json"
done

if [ "$DRY" = "1" ]; then say "DRY-RUN: nothing uploaded or committed"; exit 0; fi

for f in "$OUT"/*; do
  say "upload $(basename "$f")"
  (cd "$WT/apps/com" && npx wrangler r2 object put "$BUCKET/$(basename "$f")" --file "$f" --remote >/dev/null) || die "upload of $(basename "$f") failed"
done
# Boxes fetch gVisor from this bucket first (storage.googleapis.com refuses some clouds' addresses).
(cd "$WT/apps/com" && PATH="$PWD/node_modules/.bin:$PATH" bash "$WT/scripts/publish-gvisor-mirror.sh" --bucket "$BUCKET" --skip-if-at "https://gym.flagshipserver.com/build/iso") \
  || say "the gym's gVisor mirror was not published (app installs on gym boxes may fail to download gVisor)"
(cd "$WT" && npx tsx tools/box-artifact/release-index.ts "$OUT" >/dev/null) && (cd "$WT/apps/com" && npx wrangler r2 object put "$BUCKET/releases.json" --file "$OUT/releases.json" --remote >/dev/null) || say "releases.json not published (the gym's Update button will not list this release)"

node "$HERE/gym-box-release.mjs" write --worktree "$WT" --commit "$COMMIT" --sequence "$SEQ" --base-url "https://gym.flagshipserver.com/build/iso" >/dev/null
(cd "$WT" && node scripts/gen-box-release.mjs --write >/dev/null)
(cd "$WT" && git add release packages/protocol/src packages/flagship-builder/src apps/mobile apps/web/public/webapp/lib/boxRelease.js packages/control-plane/src 2>/dev/null; \
  git -c user.name="flagship-gym" -c user.email="gym@flagshipserver.com" commit -q -m "gym: box release ${COMMIT:0:12} (sequence $SEQ)" -m "The gym's boxes install this signed artifact. Built and signed by scripts/gym-box-artifact.sh with the gym key.")
say "gym release committed: $COMMIT sequence $SEQ"
if [ "$PUSH" = "1" ]; then (cd "$WT" && git push --force-with-lease origin gym >/dev/null) && say "pushed gym"; fi
