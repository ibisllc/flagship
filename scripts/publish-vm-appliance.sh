#!/usr/bin/env bash
# Publish VM appliances built by vm-appliance.yml: for each run, download its
# artifact, upload the parts to R2 `flagship-iso/`, and copy its manifest to
# apps/web/public/downloads/. One run at a time, deleting each download after
# its upload, so it needs disk for one appliance (~3 GB), not all of them.
#
#   scripts/publish-vm-appliance.sh <run-id> [<run-id>…]
#
# Needs `gh` and a logged-in `wrangler` on PATH. Then commit the manifests and
# deploy .com: Studio reads them from /downloads/.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <run-id> [<run-id>…]" >&2; exit 2; }
command -v wrangler >/dev/null || { echo "wrangler isn't on PATH" >&2; exit 1; }
repo=$(git rev-parse --show-toplevel)
downloads="$repo/apps/web/public/downloads"

for run in "$@"; do
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  echo "== run $run: downloading"
  gh run download "$run" --dir "$work"
  dir=$(dirname "$(find "$work" -name R2-KEY-PREFIX.txt | head -1)")
  prefix=$(tr -d '[:space:]' < "$dir/R2-KEY-PREFIX.txt")
  manifest=$(find "$dir" -name 'FlagshipVMAppliance-*.json' | head -1)
  [ -n "$prefix" ] && [ -f "$manifest" ] || { echo "run $run: no appliance in its artifact" >&2; exit 1; }
  python3 - "$dir" "$prefix" "$manifest" <<'EOF'
import hashlib, json, pathlib, sys
d, prefix, manifest = pathlib.Path(sys.argv[1]), sys.argv[2], json.load(open(sys.argv[3]))
for p in manifest["parts"]:
    f = d / f"{prefix}.{p['name']}"
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != p["sha256"] or f.stat().st_size != p["sizeBytes"]:
        sys.exit(f"{f.name} doesn't match its manifest")
print(f"{len(manifest['parts'])} parts match the manifest")
EOF
  for part in "$dir/$prefix".part-*; do
    echo "== uploading $(basename "$part")"
    wrangler r2 object put "flagship-iso/$(basename "$part")" --file "$part" --remote
  done
  cp "$manifest" "$downloads/"
  echo "== run $run: published $(basename "$manifest")"
  rm -rf "$work"
  trap - EXIT
done
echo "Done. Commit apps/web/public/downloads/ and deploy .com."
