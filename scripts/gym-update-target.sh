#!/usr/bin/env bash
#
# gym-update-target — a second, newer signed gym release for the live `update` group to move a box to.
#
# Every new box moves itself to the newest release the index lists on its first boot, so a gym box is
# always on the newest release by the time the update group orders one; the only other gym releases
# are older, which the release catalog refuses (no downgrades). This keeps one release hidden until the
# group needs it:
#
#   build      after scripts/gym-box-artifact.sh: builds the gym tip (the "gym: box release" commit, a
#              child of the release every gym box installs) with the next sequence, signs it with the
#              gym key and uploads the artifact, but leaves it OUT of releases.json and the catalog.
#              Writes update-target.json beside the artifacts. Skips when that file already names it.
#   publish    adds it to releases.json and signs a catalog that lists it (the update group, phase 9)
#   unpublish  takes it out of releases.json again, so a box made later does not move onto it at its
#              first boot (the catalog keeps it: listing a release allows it, nothing more)
#
# Usage: bash scripts/gym-update-target.sh build|publish|unpublish --worktree <gym worktree> [--no-push]
# Env: the same keys and bucket as scripts/gym-box-artifact.sh. Never touches production.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-}"; shift || true
WT="" PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT="$2"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in build|publish|unpublish) ;; *) echo "usage: gym-update-target.sh build|publish|unpublish --worktree <gym worktree>" >&2; exit 2 ;; esac
[ -n "$WT" ] && [ -e "$WT/.git" ] || { echo "--worktree <gym worktree> is required" >&2; exit 2; }
say() { echo "  $*"; }
die() { echo "gym-update-target: $*" >&2; exit 1; }
BUCKET="${GYM_ARTIFACT_BUCKET:-flagship-iso-gym}"
KEY_FILE="${GYM_ARTIFACT_KEY_FILE:-$HOME/.config/flagship/gym-artifact-key}"
CATALOG_KEY="${GYM_CATALOG_KEY_FILE:-$HOME/.config/flagship/gym-catalog-key.json}"
BASE="https://gym.flagshipserver.com/build/iso"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
put() { # <file> <name>
  local attempt
  for attempt in 1 2 3 4 5; do
    (cd "$WT/apps/com" && npx wrangler r2 object put "$BUCKET/$2" --file "$1" --content-type application/json --remote >/dev/null) && return 0
    say "upload of $2 failed (attempt $attempt of 5)"; sleep $((attempt * 10))
  done
  die "upload of $2 failed"
}
fetch() { curl -fsS -m 25 -H 'cache-control: no-cache' "$BASE/$1?t=$(date +%s)" -o "$2"; }

if [ "$MODE" = "build" ]; then
  FROM="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).commit)' "$WT/release/box-release.json")"
  TO="$(git -C "$WT" rev-parse HEAD)"
  [ "$TO" != "$FROM" ] || die "the gym tip is its own box release; nothing newer to build"
  git -C "$WT" merge-base --is-ancestor "$FROM" "$TO" || die "the gym tip $TO does not descend from the box release $FROM"
  if fetch update-target.json "$OUT/prev.json" 2>/dev/null && [ "$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).commit)' "$OUT/prev.json")" = "$TO" ]; then
    say "update target ${TO:0:12} already built"; exit 0
  fi
  fetch releases.json "$OUT/index.json" || die "no gym releases.json"
  SEQ="$(node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).releases.find(e=>e.commit===process.argv[2]);if(!r)process.exit(3);console.log(r.sequence+1)' "$OUT/index.json" "$FROM")" \
    || die "the box release $FROM is not in the gym's releases.json"
  say "update target: ${FROM:0:12} → ${TO:0:12} (sequence $SEQ)"
  mkdir -p "$OUT/a"
  bash "$HERE/box-artifact-vm.sh" --repo "$WT" --commit "$TO" --sequence "$SEQ" --out "$OUT/a" || die "the VM build failed"
  NAME="flagship-box-${TO:0:12}-amd64"
  (cd "$WT" && npx tsx tools/box-artifact/build.ts sign --manifest "$OUT/a/$NAME.manifest.unsigned.json" --out "$OUT/a/$NAME.manifest.json" --key-file "$KEY_FILE") || die "signing failed"
  (cd "$WT" && npx tsx tools/box-artifact/build.ts verify --manifest "$OUT/a/$NAME.manifest.json" --artifact "$OUT/a/$NAME.tar.gz" --commit "$TO" --arch amd64 --trust release/box-artifact-trust.json) || die "the signed manifest does not verify against the gym trust file"
  rm -f "$OUT/a/$NAME.manifest.unsigned.json"
  for f in "$OUT/a"/*; do
    say "upload $(basename "$f")"
    ok=0
    for attempt in 1 2 3 4 5; do
      if (cd "$WT/apps/com" && npx wrangler r2 object put "$BUCKET/$(basename "$f")" --file "$f" --remote >/dev/null); then ok=1; break; fi
      sleep $((attempt * 15))
    done
    [ "$ok" = 1 ] || die "upload of $(basename "$f") failed"
  done
  node -e 'const fs=require("node:fs");const [m,from,out]=process.argv.slice(1);const x=JSON.parse(fs.readFileSync(m,"utf8")).manifest;fs.writeFileSync(out,JSON.stringify({from,commit:x.commit,sequence:x.sequence,arch:["amd64"],endorsedAt:new Date(x.issuedAt).toISOString(),artifactSha256:x.artifactSha256},null,2)+"\n")' \
    "$OUT/a/$NAME.manifest.json" "$FROM" "$OUT/update-target.json"
  put "$OUT/update-target.json" update-target.json
  if [ "$PUSH" = "1" ]; then
    (cd "$WT" && git tag -f "gym-artifact-${TO:0:12}" "$TO" >/dev/null && git push -q -f origin "gym-artifact-${TO:0:12}") || say "could not tag $TO"
  fi
  say "update target ${TO:0:12} built (hidden until the update group publishes it)"
  exit 0
fi

fetch update-target.json "$OUT/target.json" || die "no update-target.json: run gym-update-target.sh build first"
fetch releases.json "$OUT/index.json" || echo '{"releases":[]}' > "$OUT/index.json"
COMMIT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).commit)' "$OUT/target.json")"

if [ "$MODE" = "unpublish" ]; then
  node -e 'const fs=require("node:fs");const [i,c]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(i,"utf8"));j.releases=(j.releases||[]).filter(e=>e.commit!==c);fs.writeFileSync(i,JSON.stringify(j,null,2)+"\n")' "$OUT/index.json" "$COMMIT"
  put "$OUT/index.json" releases.json
  say "update target ${COMMIT:0:12} taken out of releases.json"
  exit 0
fi

# publish: the catalog first (a box that sees the index entry may order it at once), then the index.
[ -f "$CATALOG_KEY" ] && [ -f "$WT/release/catalog-root.json" ] || die "no gym catalog key or pinned root"
fetch catalog-targets.json "$OUT/prev-targets.json" || echo '{"signed":{"version":0,"releases":[]}}' > "$OUT/prev-targets.json"
PREV_TS=(); fetch catalog-timestamp.json "$OUT/prev-ts.json" && PREV_TS=(--previous-timestamp "$OUT/prev-ts.json")
CV="$(node -e 'const fs=require("node:fs");const [p,t,out]=process.argv.slice(1);const s=JSON.parse(fs.readFileSync(p,"utf8")).signed;const u=JSON.parse(fs.readFileSync(t,"utf8"));const r=(s.releases||[]).filter(x=>x.commit!==u.commit);r.push({commit:u.commit,label:"gym update target",securityVersion:u.sequence,artifactSha256:u.artifactSha256,rolloutPercent:100});fs.writeFileSync(out,JSON.stringify(r));console.log(Math.max((s.version||0)+1,u.sequence))' "$OUT/prev-targets.json" "$OUT/target.json" "$OUT/releases.json")"
(cd "$WT" && npx tsx tools/release-catalog/catalog.ts sign --root release/catalog-root.json --releases "$OUT/releases.json" --version "$CV" --floor 0 \
  --targets-days 180 --snapshot-days 120 --timestamp-days 90 --key "$CATALOG_KEY" "${PREV_TS[@]}" --out-dir "$OUT/cat" >/dev/null) || die "the catalog was not signed"
for n in targets snapshot timestamp; do put "$OUT/cat/$n.json" "catalog-$n.json"; done
node -e 'const fs=require("node:fs");const [i,t]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(i,"utf8"));const u=JSON.parse(fs.readFileSync(t,"utf8"));j.releases=(j.releases||[]).filter(e=>e.commit!==u.commit);j.releases.push({commit:u.commit,sequence:u.sequence,arch:u.arch,endorsedAt:u.endorsedAt});j.releases.sort((a,b)=>b.sequence-a.sequence);fs.writeFileSync(i,JSON.stringify(j,null,2)+"\n")' "$OUT/index.json" "$OUT/target.json"
put "$OUT/index.json" releases.json
say "update target ${COMMIT:0:12} published (catalog v$CV and releases.json)"
