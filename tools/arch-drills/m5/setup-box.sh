#!/bin/bash
# Milestone 5 drill box (docs/architecture-v2/drills/m5-upcloud.md): a throwaway Debian 13
# amd64 VM gets this branch's tree laid out as an installed box release, with the Node the
# artifact pins, the Rust keyd/broker/core built --locked and PINS.json written the way
# tools/box-artifact/build.ts writes it. Docker is installed too, as the migration source.
#
#   setup-box.sh <40-hex commit> <path to `git archive` tar of that commit>
set -euo pipefail
COMMIT="$1"
SRC_TAR="$2"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be 40 hex"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
log() { echo "[setup $(date -u +%H:%M:%S)] $*"; }

log "packages"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl jq git build-essential pkg-config \
  cryptsetup xxd e2fsprogs nftables iptables zstd docker.io docker-cli docker-compose \
  podman netavark aardvark-dns crun conmon catatonit >/dev/null
systemctl enable --now docker.service

log "node (the artifact's pinned archive)"
PIN=/tmp/node-pins.json
tar -xOf "$SRC_TAR" tools/box-artifact/node-pins.json > "$PIN"
NODE_FILE=$(jq -r .node.archives.amd64.file "$PIN")
NODE_SHA=$(jq -r .node.archives.amd64.sha256 "$PIN")
NODE_BASE=$(jq -r .node.downloadBase "$PIN")
curl -fsSL --proto '=https' -o "/tmp/$NODE_FILE" "$NODE_BASE$NODE_FILE"
echo "$NODE_SHA  /tmp/$NODE_FILE" | sha256sum -c -
mkdir -p /opt/node && tar -xJf "/tmp/$NODE_FILE" -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx

log "release tree"
REL=/opt/flagship-releases/$COMMIT
rm -rf "$REL" && mkdir -p "$REL/app"
tar -xf "$SRC_TAR" -C "$REL/app"
mkdir -p "$REL/app/.runtime/node/bin"
cp /opt/node/bin/node "$REL/app/.runtime/node/bin/node"
jq -n --arg c "$COMMIT" '{commit:$c, arch:"amd64", installedAt:(now|floor)}' > "$REL/INSTALLED.json"
ln -sfn "$REL/app" /opt/flagship
mkdir -p /var/flagship && cp "$REL/INSTALLED.json" /var/flagship/artifact-current.json
cd "$REL/app"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npx tsc -b packages/server-daemon packages/keyd

log "rust (pinned toolchain, --locked)"
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal >/dev/null
fi
export PATH="$HOME/.cargo/bin:$PATH"
cd "$REL/app/rust"
EPOCH=$(date +%s)
SOURCE_DATE_EPOCH=$EPOCH CARGO_INCREMENTAL=0 \
  RUSTFLAGS="--remap-path-prefix=$REL/app=/flagship --remap-path-prefix=$HOME/.cargo=/cargo -C link-arg=-Wl,--build-id=none" \
  cargo build --release --locked -p flagship-keyd -p flagship-broker -p flagship-core
mkdir -p "$REL/app/installer/rust"
for b in flagship-keyd flagship-broker flagship-core; do install -m 0755 "target/release/$b" "$REL/app/installer/rust/$b"; done
RUSTC=$(rustc --version)
LOCK=$(sha256sum Cargo.lock | cut -d' ' -f1)
cd "$REL/app/installer/rust"
jq -n --arg c "$COMMIT" --arg r "$RUSTC" --arg l "$LOCK" \
  --arg k "$(sha256sum flagship-keyd | cut -d' ' -f1)" --arg b "$(sha256sum flagship-broker | cut -d' ' -f1)" --arg o "$(sha256sum flagship-core | cut -d' ' -f1)" \
  '{schema:1, commit:$c, arch:"amd64", rustc:$r, cargoLockSha256:$l, binaries:{"flagship-keyd":$k, "flagship-broker":$b, "flagship-core":$o}}' > PINS.json
cat PINS.json
log "done"
