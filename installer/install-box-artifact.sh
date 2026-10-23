#!/bin/bash
# Install a verified box release artifact (SEC-INSTALL-001, SEC-NODE-001).
#
# The only way code reaches a production box: no git clone, no npm, no apt
# repository, no NodeSource. It verifies the artifact first
# (installer/verify-box-artifact.sh: digest, size, commit, architecture,
# threshold signatures, anti-rollback, Node floor), unpacks it beside the
# running release, and flips /opt/flagship to it in one atomic rename. The
# previous release stays on disk so a failed health gate can flip back.
#
#   install-box-artifact.sh --manifest F --artifact F \
#       --trust-keys K1,K2 --threshold N --expect-sha256 H --expect-commit C \
#       --arch A --node-floor X.Y.Z [--releases /opt/flagship-releases] \
#       [--current /opt/flagship] [--state /var/flagship] [--bin /usr/local/bin]
#
# Exit 0 on success. 1 = refused by the verifier (nothing changed). 3 = the
# unpacked tree failed its own checks (nothing was switched). 2 = usage.
set -u
set -o pipefail

here=$(cd "$(dirname "$0")" && pwd)
releases=/opt/flagship-releases current=/opt/flagship state=/var/flagship bin=/usr/local/bin
manifest="" artifact="" trust="" threshold="" expect_sha="" expect_commit="" arch="" node_floor="" min_sequence=""

usage() { echo "usage: $0 --manifest F --artifact F --trust-keys K --threshold N --expect-sha256 H --expect-commit C --arch A --node-floor V [--min-sequence N] [--releases D] [--current P] [--state D] [--bin D]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2 ;;
    --artifact) artifact="$2"; shift 2 ;;
    --trust-keys) trust="$2"; shift 2 ;;
    --threshold) threshold="$2"; shift 2 ;;
    --expect-sha256) expect_sha="$2"; shift 2 ;;
    --expect-commit) expect_commit="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --node-floor) node_floor="$2"; shift 2 ;;
    --min-sequence) min_sequence="$2"; shift 2 ;;
    --releases) releases="$2"; shift 2 ;;
    --current) current="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    --bin) bin="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$manifest" ] && [ -n "$artifact" ] && [ -n "$trust" ] && [ -n "$threshold" ] && [ -n "$expect_sha" ] \
  && [ -n "$expect_commit" ] && [ -n "$arch" ] && [ -n "$node_floor" ] || usage

last_seq=""
[ -s "$state/artifact-sequence" ] && last_seq=$(tr -d '[:space:]' < "$state/artifact-sequence")
# A fresh box has no history, but the installer that generated this script knows the lowest
# release it will accept: --min-sequence N means "sequence N or higher".
if [ -z "$last_seq" ] && [ -n "$min_sequence" ] && [ "$min_sequence" -gt 0 ] 2>/dev/null; then
  last_seq=$((min_sequence - 1))
fi

verify_args=(--manifest "$manifest" --artifact "$artifact" --trust-keys "$trust" --threshold "$threshold"
  --expect-sha256 "$expect_sha" --expect-commit "$expect_commit" --arch "$arch" --node-floor "$node_floor")
[ -n "$last_seq" ] && verify_args+=(--last-sequence "$last_seq")
"${BASH:-bash}" "$here/verify-box-artifact.sh" "${verify_args[@]}" || exit 1

commit=$(printf '%s' "$expect_commit" | tr 'A-F' 'a-f')
sequence=$(jq -er '.manifest.sequence' "$manifest") || exit 1

# ---- look inside before unpacking: nothing absolute, nothing that climbs out ----
if tar -tzf "$artifact" | LC_ALL=C grep -E '(^/|(^|/)\.\.(/|$)|[[:cntrl:]])' >/dev/null; then
  echo "refused: the artifact lists an unsafe path" >&2
  exit 3
fi

mkdir -p "$releases" "$state" "$bin" || exit 3
dest="$releases/$commit"
staging="$releases/.incoming-$commit-$$"
rm -rf "$staging"
mkdir -p "$staging" || exit 3
trap 'rm -rf "$staging"' EXIT
tar -xzf "$artifact" -C "$staging" --strip-components=1 --no-same-owner || { echo "refused: unpack failed" >&2; exit 3; }

# The unpacked tree must be what the manifest said it was.
[ -x "$staging/app/installer/flagship-unseal" ] || { echo "refused: no unseal helper in the artifact" >&2; exit 3; }
[ -x "$staging/app/.runtime/node/bin/node" ] || { echo "refused: no Node runtime in the artifact" >&2; exit 3; }
[ -f "$staging/BUILD-INFO.json" ] || { echo "refused: no BUILD-INFO.json" >&2; exit 3; }
[ "$(jq -r .commit "$staging/BUILD-INFO.json")" = "$commit" ] || { echo "refused: BUILD-INFO commit differs from the manifest" >&2; exit 3; }
[ "$(jq -r .arch "$staging/BUILD-INFO.json")" = "$arch" ] || { echo "refused: BUILD-INFO arch differs" >&2; exit 3; }
for f in package.json package-lock.json installer/flagship-unseal scripts/install-helper.ts node_modules/tsx/dist/cli.mjs; do
  [ -e "$staging/app/$f" ] || { echo "refused: the artifact lacks $f" >&2; exit 3; }
done

# A release directory is immutable: replace it only with identical bytes (a re-run), never overwrite a different one.
if [ -d "$dest" ]; then
  if ! diff -rq "$staging/app" "$dest/app" >/dev/null 2>&1; then
    echo "refused: $dest already exists with different contents" >&2
    exit 3
  fi
  rm -rf "$staging"
else
  mv "$staging" "$dest" || exit 3
fi
trap - EXIT

# ---- the Node and tsx every script on the box uses ----
ln -sfn "$current/.runtime/node/bin/node" "$bin/node.new" && mv -f -T "$bin/node.new" "$bin/node" 2>/dev/null || mv -f "$bin/node.new" "$bin/node"
cat > "$bin/flagship-tsx.new" <<'WRAP'
#!/bin/sh
# Run a TypeScript file with the box's own Node and tsx. No npm, no npx, no network.
exec /opt/flagship/.runtime/node/bin/node /opt/flagship/node_modules/tsx/dist/cli.mjs "$@"
WRAP
chmod 755 "$bin/flagship-tsx.new" && mv -f "$bin/flagship-tsx.new" "$bin/flagship-tsx"

# ---- the one atomic switch, keeping the previous release for rollback ----
if [ -L "$current" ]; then
  prev=$(readlink "$current")
  printf '%s\n' "$prev" > "$state/artifact-previous"
fi
if [ -e "$current" ] && [ ! -L "$current" ]; then
  echo "refused: $current is a real directory (a legacy install); migrate it with the update path" >&2
  exit 3
fi
ln -sfn "$dest/app" "$current.new" || exit 3
if mv -T "$current.new" "$current" 2>/dev/null; then :; else mv -f -h "$current.new" "$current" || exit 3; fi
printf '%s\n' "$sequence" > "$state/artifact-sequence.new" && mv -f "$state/artifact-sequence.new" "$state/artifact-sequence"
jq -n --arg c "$commit" --arg a "$arch" --argjson s "$sequence" --arg d "$expect_sha" \
  '{commit:$c, arch:$a, sequence:$s, artifactSha256:$d}' > "$state/artifact-current.json"
sync
echo "installed: $commit $arch sequence $sequence"
