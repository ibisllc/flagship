/**
 * The Rust custody/broker/core path on the box (docs/architecture-v2/engine-and-rust-path.md §2).
 *
 * Three components, each a systemd unit whose ExecStart is a small launcher:
 *
 *   keyd    the Rust keyd serves the same socket and state as the TS keyd (wire v1); TS fallback
 *   broker  root; privd v1 socket for the daemon (the full privd contract: the daemon's privileged
 *           helper once it runs as `flagship`), typed v2 socket for core; fallback: the TS privd
 *           on the same v1 socket
 *   core    unprivileged; the controller in shadow mode against the broker; fallback: idle
 *
 * `flagship-rust-select` (root, ExecStartPre) picks Rust only when the box's switch is on, the
 * release carries the binary and its SHA-256 equals the one the release's PINS.json names (a
 * file inside the signed artifact), and the binary has not just failed to start three times in a
 * row. `flagship-rust-select confirm` (root, ExecStartPost) waits for the component's socket;
 * when it never appears the unit fails, systemd restarts it, and the third quick failure
 * switches that component to its fallback until a different binary arrives. The choice and its
 * `flagship-rust-select stopped` (root, ExecStopPost) counts a run that systemd says failed, so a
 * binary that crashes after coming up is caught the same way. The choice and its
 * reason are written to /run/flagship-rust/<component>.status for the daemon and its update gate.
 */

export const RUST_STATE_DIR = "/var/lib/flagship-rust";
export const RUST_RUN_DIR = "/run/flagship-rust";
export const RUST_SELECT_PATH = "/usr/local/sbin/flagship-rust-select";
export const RUST_EXEC_PATH = "/usr/local/sbin/flagship-rust-exec";
export const RUST_BIN_DIR_REL = "installer/rust";
export const RUST_PINS_REL = "installer/rust/PINS.json";

export const BROKER_UNIT_PATH = "/etc/systemd/system/flagship-broker.service";
export const CORE_UNIT_PATH = "/etc/systemd/system/flagship-core.service";
export const KEYD_RUST_DROPIN_PATH = "/etc/systemd/system/flagship-keyd.service.d/30-rust.conf";
export const BROKER_V1_SOCKET = "/run/flagship-broker/privd.sock";
export const BROKER_TYPED_SOCKET = "/run/flagship-broker/broker.sock";
export const CORE_DIR = "/var/lib/flagship-core";
export const CORE_CHECKPOINT = "/var/lib/flagship-core/ts-checkpoint.json";
export const CORE_STATUS = "/run/flagship-core/status.json";
export const CORE_USER = "flagship-core";

export type RustComponent = "keyd" | "broker" | "core";
export const RUST_COMPONENTS: readonly RustComponent[] = ["keyd", "broker", "core"];

/** Failed runs in a row before a component falls back, and how long a run must last to reset them. */
export const RUST_MAX_ATTEMPTS = 3;
export const RUST_STABLE_SECS = 120;

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export interface RustScriptPaths {
  releasePath?: string;
  configPath?: string;
  engineActivePath?: string;
  stateDir?: string;
  runDir?: string;
}

/** The daemon's account once it gives up root (packages/privd unit.ts DAEMON_USER). */
export const DAEMON_ACCOUNT = "flagship";
export const BROKER_AUDIT_LOG = "/var/lib/flagship-broker/audit.log";

export function rustSelectScript(opts: RustScriptPaths = {}): string {
  const release = opts.releasePath ?? "/opt/flagship";
  const config = opts.configPath ?? "/var/lib/flagship/arch-v2.json";
  const engineActive = opts.engineActivePath ?? "/var/lib/flagship/engine-active";
  const stateDir = opts.stateDir ?? RUST_STATE_DIR;
  const runDir = opts.runDir ?? RUST_RUN_DIR;
  for (const p of [release, config, engineActive, stateDir, runDir]) if (!SAFE_PATH.test(p)) throw new Error(`unsafe path ${p}`);
  return `#!/bin/bash
# Flagship Rust path selector (installed by the daemon; rustStack/units.ts). Never prints a key.
set -u
cmd="\${1:-}"; comp="\${2:-}"
case "$comp" in keyd|broker|core) ;; *) echo "flagship-rust-select: unknown component" >&2; exit 2 ;; esac
state='${stateDir}'
run='${runDir}'
release='${release}'
config='${config}'
bin="$release/${RUST_BIN_DIR_REL}/flagship-$comp"
pins="$release/${RUST_PINS_REL}"
max=${RUST_MAX_ATTEMPTS}
stable=${RUST_STABLE_SECS}
mkdir -p "$state" "$run" && chmod 0700 "$state" && chmod 0755 "$run"
now=$(date +%s)

want_rust=$(jq -r '.rust // "off"' "$config" 2>/dev/null || echo off)
[ "$want_rust" = on ] || want_rust=off
want=$(jq -r --arg c "flagship-$comp" '.binaries[$c] // empty' "$pins" 2>/dev/null || true)
[[ "$want" =~ ^[0-9a-f]{64}$ ]] || want=""

status() { # choice reason sha
    local tmp="$run/$comp.status.tmp"
    jq -cn --arg c "$comp" --arg ch "$1" --arg r "$2" --arg s "$3" --arg p "$want" --arg sw "$want_rust" --argjson at "$now" \\
        '{component:$c,choice:$ch,reason:$r,sha256:$s,pinned:$p,switch:$sw,at:$at}' > "$tmp" && mv -f "$tmp" "$run/$comp.status"
    chmod 0644 "$run/$comp.status" 2>/dev/null || true
}

case "$cmd" in
select)
    choice=ts; reason=""; have=""
    if [ "$want_rust" != on ]; then
        reason=switched-off
    elif [ ! -f "$bin" ] || [ ! -x "$bin" ]; then
        reason=no-binary
    else
        have=$(sha256sum "$bin" 2>/dev/null | cut -d' ' -f1)
        if [ -z "$want" ]; then
            reason=unpinned
        elif [ "$want" != "$have" ]; then
            reason=hash-mismatch
        else
            # Failed runs of this binary in a row, counted by \`stopped\` (ExecStopPost) from
            # systemd's own verdict; a new binary starts from zero, and an earlier binary's good
            # run no longer counts as this one's.
            crashes=$(cat "$state/$comp.crashes" 2>/dev/null || echo 0)
            [[ "$crashes" =~ ^[0-9]+$ ]] || crashes=$max
            [ "$(cat "$state/$comp.crashes-sha" 2>/dev/null)" = "$have" ] || { crashes=0; echo 0 > "$state/$comp.crashes"; echo "$have" > "$state/$comp.crashes-sha"; rm -f "$state/$comp.confirmed"; }
            if [ "$crashes" -ge "$max" ]; then
                reason=failed-to-start
            else
                choice=rust; reason=pinned
            fi
        fi
    fi
    : > "$run/$comp.env"
    if [ "$choice" = rust ]; then
        # The daemon's own account, once it runs without root: the Rust components admit callers
        # by the uid the kernel reports, which never carries a supplementary group.
        daemon_uid=$(id -u ${DAEMON_ACCOUNT} 2>/dev/null || true)
        [[ "$daemon_uid" =~ ^[0-9]+$ ]] || daemon_uid=""
        case "$comp" in
        keyd)
            gid=$(getent group flagship-keyd-clients | cut -d: -f3)
            { echo "FLAGSHIP_KEYD_ALLOW_UIDS=0\${daemon_uid:+,$daemon_uid}"; [ -n "$gid" ] && echo "FLAGSHIP_KEYD_ALLOW_GIDS=$gid"; } > "$run/$comp.env" ;;
        broker)
            engine=$(cat '${engineActive}' 2>/dev/null | tr -cd 'a-z')
            [ "$engine" = podman ] || engine=docker
            core_uid=$(id -u ${CORE_USER} 2>/dev/null || true)
            {
                echo "FLAGSHIP_BROKER_ENGINE=$engine"
                echo "FLAGSHIP_BROKER_ENGINE_FILE=${engineActive}"
                echo "FLAGSHIP_BROKER_V1_UIDS=0\${daemon_uid:+,$daemon_uid}"
                getent group ${DAEMON_ACCOUNT} >/dev/null && echo "FLAGSHIP_BROKER_V1_GROUP=${DAEMON_ACCOUNT}"
                [ -n "$core_uid" ] && echo "FLAGSHIP_BROKER_TYPED_UIDS=$core_uid"
            } > "$run/$comp.env" ;;
        esac
    fi
    chmod 0644 "$run/$comp.env"
    echo "$choice" > "$run/$comp.choice"
    chmod 0644 "$run/$comp.choice"
    status "$choice" "$reason" "$have"
    echo "[rust-path] $comp: $choice ($reason)"
    ;;
confirm)
    sock="\${3:-}"
    choice=$(cat "$run/$comp.choice" 2>/dev/null || echo ts)
    sha=$(jq -r '.sha256 // ""' "$run/$comp.status" 2>/dev/null || true)
    [ "$choice" = rust ] || exit 0
    for _ in $(seq 1 80); do
        [ -e "$sock" ] && break
        sleep 0.25
    done
    if [ ! -e "$sock" ]; then
        echo "[rust-path] $comp: the Rust binary did not come up; systemd restarts it"
        status rust not-ready "$sha"
        exit 1
    fi
    echo "$now" > "$state/$comp.confirmed"
    echo "$sha" > "$state/$comp.good"
    status rust running "$sha"
    ;;
stopped)
    # ExecStopPost: systemd says why the run ended. A clean stop (a restart, a shutdown) counts
    # nothing; a crash, or a start that never came up, counts against the Rust binary, unless it
    # had been up longer than the stable window, which starts the count again.
    choice=$(cat "$run/$comp.choice" 2>/dev/null || echo ts)
    [ "$choice" = rust ] || exit 0
    [ "\${SERVICE_RESULT:-success}" = success ] && exit 0
    confirmed=$(cat "$state/$comp.confirmed" 2>/dev/null || echo 0)
    [[ "$confirmed" =~ ^[0-9]+$ ]] || confirmed=0
    crashes=$(cat "$state/$comp.crashes" 2>/dev/null || echo 0)
    [[ "$crashes" =~ ^[0-9]+$ ]] || crashes=0
    if [ "$confirmed" -gt 0 ] && [ $((now - confirmed)) -gt "$stable" ]; then crashes=0; fi
    echo $((crashes + 1)) > "$state/$comp.crashes"
    echo "[rust-path] $comp: the Rust binary stopped (\${SERVICE_RESULT:-?} \${EXIT_CODE:-} \${EXIT_STATUS:-}); failed runs: $((crashes + 1))"
    ;;
*)
    echo "usage: flagship-rust-select select|confirm|stopped <component> [socket]" >&2; exit 2 ;;
esac
exit 0
`;
}

/** Runs as the unit's own user: execs the chosen program. With no fallback argv it idles. */
export function rustExecScript(releasePath = "/opt/flagship", runDir = RUST_RUN_DIR): string {
  if (!SAFE_PATH.test(releasePath) || !SAFE_PATH.test(runDir)) throw new Error("unsafe path");
  return `#!/bin/bash
# Flagship Rust path launcher (installed by the daemon; rustStack/units.ts).
set -u
comp="\${1:-}"; shift || true
case "$comp" in keyd|broker|core) ;; *) echo "flagship-rust-exec: unknown component" >&2; exit 2 ;; esac
rust_args=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do rust_args+=("$1"); shift; done
[ $# -gt 0 ] && shift
choice=$(cat '${runDir}'/"$comp".choice 2>/dev/null || echo ts)
if [ "$choice" = rust ]; then
    if [ -r '${runDir}'/"$comp".env ]; then set -a; . '${runDir}'/"$comp".env; set +a; fi
    exec '${releasePath}/${RUST_BIN_DIR_REL}'/flagship-"$comp" "\${rust_args[@]}"
fi
if [ $# -gt 0 ]; then exec "$@"; fi
# No TypeScript counterpart: stay up and do nothing, so the unit reads as active-in-fallback.
exec sleep infinity
`;
}

export function keydRustDropIn(opts: { nodePath?: string; keydEntry: string }): string {
  const node = opts.nodePath ?? "/usr/local/bin/node";
  return `# Written by the Flagship daemon (rustStack/units.ts): the Rust keyd, TS keyd as fallback.
[Service]
ExecStartPre=+${RUST_SELECT_PATH} select keyd
ExecStart=
ExecStart=${RUST_EXEC_PATH} keyd serve -- ${node} --jitless ${opts.keydEntry} serve
ExecStartPost=+${RUST_SELECT_PATH} confirm keyd /run/flagship-keyd/keyd.sock
ExecStopPost=+${RUST_SELECT_PATH} stopped keyd
`;
}

/**
 * The broker unit. Its fallback is the TS privd on the same v1 socket, so the daemon's privileged
 * helper stays up whichever binary runs. Hardened like privd's own unit (packages/privd unit.ts):
 * it acts on the host's mount table and network (loop mounts the engine must see, the host's
 * firewall), so it has no private mount or network namespace, and Podman runs as its child, so
 * nothing that would also bind every container (no SUID/SGID filter, no address-family list).
 */
export function brokerServiceUnit(opts: { nodePath?: string; privdEntry?: string } = {}): string {
  const node = opts.nodePath ?? "/usr/local/bin/node";
  const privd = opts.privdEntry ?? "/opt/flagship/packages/privd/dist/main.js";
  for (const p of [node, privd]) if (!SAFE_PATH.test(p)) throw new Error(`unsafe path ${p}`);
  return `[Unit]
Description=Flagship privileged broker (architecture v2)
After=docker.service
Before=flagship-daemon.service flagship-core.service
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStartPre=+${RUST_SELECT_PATH} select broker
ExecStart=${RUST_EXEC_PATH} broker serve -- ${node} ${privd} --socket ${BROKER_V1_SOCKET} --audit ${BROKER_AUDIT_LOG} --socket-group ${DAEMON_ACCOUNT}
ExecStartPost=+${RUST_SELECT_PATH} confirm broker ${BROKER_V1_SOCKET}
ExecStopPost=+${RUST_SELECT_PATH} stopped broker
Restart=always
RestartSec=2
RuntimeDirectory=flagship-broker
RuntimeDirectoryMode=0755
StateDirectory=flagship-broker
StateDirectoryMode=0700
Environment=FLAGSHIP_BROKER_V1_SOCKET=${BROKER_V1_SOCKET}
Environment=FLAGSHIP_BROKER_SOCKET=${BROKER_TYPED_SOCKET}
Environment=FLAGSHIP_BROKER_STATE=/var/lib/flagship-broker
# No User=: a system service is root already. An explicit User=root together with NoNewPrivileges=yes makes systemd (Debian 13, v257)
# drop CAP_SETUID from the service, and NoNewPrivs then keeps every child from getting it back; runsc's gofer needs it
# (setuid), so every gVisor container failed with 'fork/exec /proc/self/exe: operation not permitted'.
NoNewPrivileges=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
LimitCORE=0
UMask=0022

[Install]
WantedBy=multi-user.target
`;
}

export function coreServiceUnit(): string {
  return `[Unit]
Description=Flagship controller, shadow mode (architecture v2)
After=flagship-broker.service
Wants=flagship-broker.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${CORE_USER}
Group=${CORE_USER}
ExecStartPre=+${RUST_SELECT_PATH} select core
ExecStart=${RUST_EXEC_PATH} core shadow --
ExecStartPost=+${RUST_SELECT_PATH} confirm core ${CORE_DIR}/controller.lock
ExecStopPost=+${RUST_SELECT_PATH} stopped core
Restart=always
RestartSec=5
StateDirectory=flagship-core
StateDirectoryMode=0700
RuntimeDirectory=flagship-core
RuntimeDirectoryMode=0755
Environment=FLAGSHIP_CORE_DIR=${CORE_DIR}
Environment=FLAGSHIP_CORE_BROKER=${BROKER_TYPED_SOCKET}
Environment=FLAGSHIP_CORE_STATUS=${CORE_STATUS}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateNetwork=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @mount @debug @module @raw-io @reboot @swap @obsolete
LimitCORE=0
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

export function coreSetupScript(): string {
  return `id ${CORE_USER} >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${CORE_USER}`;
}
