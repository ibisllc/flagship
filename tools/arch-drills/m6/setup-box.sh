#!/bin/bash
# Milestone 6 drill box (docs/architecture-v2/drills/m6-upcloud.md): a throwaway Debian 13 amd64
# VM gets this branch's tree as an installed box release (the artifact's pinned Node, npm ci,
# tsc -b), the Go unseal helper and the Rust boot client built from it, real cryptsetup,
# tpm2-tools and swtpm (UpCloud offers no vTPM), and swtpm as a systemd unit whose state survives
# a reboot.
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
  cryptsetup cryptsetup-bin xxd openssl e2fsprogs lvm2 tpm2-tools swtpm swtpm-tools libtss2-tcti-swtpm0t64 >/dev/null
tpm2_createprimary --version | head -n1

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

log "go (go.dev, checked against go.dev's published sha256)"
GOV=go1.26.3
GOSHA=$(curl -fsSL --proto '=https' 'https://go.dev/dl/?mode=json&include=all' | jq -r --arg v "$GOV" '.[] | select(.version==$v) | .files[] | select(.filename==($v+".linux-amd64.tar.gz")) | .sha256')
[ -n "$GOSHA" ] || { echo "no sha for $GOV"; exit 1; }
curl -fsSL --proto '=https' -o /tmp/go.tgz "https://go.dev/dl/$GOV.linux-amd64.tar.gz"
echo "$GOSHA  /tmp/go.tgz" | sha256sum -c -
rm -rf /usr/local/go && tar -xzf /tmp/go.tgz -C /usr/local
ln -sf /usr/local/go/bin/go /usr/local/bin/go

log "release tree"
REL=/opt/flagship-releases/$COMMIT
rm -rf "$REL" && mkdir -p "$REL/app"
tar -xf "$SRC_TAR" -C "$REL/app"
ln -sfn "$REL/app" /opt/flagship
cd "$REL/app"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npx tsc -b

log "the Go unseal helper and the Rust boot client"
(cd installer/unseal-helper && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o /usr/local/lib/flagship-unseal-go .)
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal >/dev/null
fi
export PATH="$HOME/.cargo/bin:$PATH"
(cd rust && cargo build --release --locked -p flagship-boot -p flagship-keyd)
install -m 0755 rust/target/release/flagship-boot /usr/local/lib/flagship-boot-rust

log "swtpm as a unit (state in /var/lib/flagship-m6/tpm survives a reboot)"
mkdir -p /var/lib/flagship-m6/tpm
cat > /etc/systemd/system/flagship-m6-swtpm.service <<'UNIT'
[Unit]
Description=swtpm for the milestone 6 drill
[Service]
ExecStart=/usr/bin/swtpm socket --tpm2 --tpmstate dir=/var/lib/flagship-m6/tpm --server type=tcp,port=2321 --ctrl type=tcp,port=2322 --flags not-need-init,startup-clear
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now flagship-m6-swtpm.service
ls -l /dev/tpm* 2>/dev/null || echo "no vTPM device on this VM (UpCloud offers none); the drill uses swtpm"
log "done: $(git -C "$REL/app" rev-parse HEAD 2>/dev/null || echo "$COMMIT")"
