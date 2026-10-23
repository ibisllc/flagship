/**
 * The systemd units for flagship-keyd and the properties they must have on the box
 * (SECURITY-HARDENING-PLAN.md 5.1). `KEYD_REQUIRED_PROPERTIES` is what
 * `installer/verify-keyd-unit.sh` checks against `systemctl show` on the real appliance.
 */

export const KEYD_USER = "flagship-keyd";
export const KEYD_STATE_DIR = "/var/lib/flagship-keyd";
export const KEYD_RUNTIME_DIR = "flagship-keyd";
export const KEYD_SOCKET = "/run/flagship-keyd/keyd.sock";
/** The group that may open the socket: the daemon, and nothing that runs apps. */
export const KEYD_CLIENT_GROUP = "flagship-keyd-clients";
const KEYD_GROUP = KEYD_CLIENT_GROUP;

export const KEYD_REQUIRED_PROPERTIES: Readonly<Record<string, string>> = {
  User: KEYD_USER,
  NoNewPrivileges: "yes",
  ProtectSystem: "strict",
  ProtectHome: "yes",
  PrivateTmp: "yes",
  PrivateDevices: "yes",
  PrivateNetwork: "yes",
  ProtectKernelTunables: "yes",
  ProtectKernelModules: "yes",
  ProtectKernelLogs: "yes",
  ProtectControlGroups: "yes",
  ProtectClock: "yes",
  ProtectHostname: "yes",
  RestrictNamespaces: "yes",
  RestrictRealtime: "yes",
  RestrictSUIDSGID: "yes",
  LockPersonality: "yes",
  MemoryDenyWriteExecute: "yes",
  LimitCORE: "0",
  CapabilityBoundingSet: "",
  RestrictAddressFamilies: "AF_UNIX",
  UMask: "0077",
};

export const KEYD_UNIT_PATH = "/etc/systemd/system/flagship-keyd.service";
export const KEYD_DAEMON_DROPIN_PATH = "/etc/systemd/system/flagship-daemon.service.d/20-keyd.conf";

export function keydServiceUnit(opts: { nodePath?: string; keydEntry?: string; legacyDir?: string } = {}): string {
  const node = opts.nodePath ?? "/usr/local/bin/node";
  const entry = opts.keydEntry ?? "/opt/flagship/packages/keyd/dist/main.js";
  const legacy = opts.legacyDir ?? "/var/flagship";
  return `[Unit]
Description=Flagship key daemon (box identity and workload keys)
Before=flagship-daemon.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${KEYD_USER}
# The socket is created with this group: the daemon's group may open it, nothing else.
Group=${KEYD_CLIENT_GROUP}
# On the first start, and on any box that still has keys on the daemon's side of the
# socket, move them in and remove the readable copies. "+" runs this one command
# with full privileges; the service itself stays sandboxed. Safe to run every time.
ExecStartPre=+/usr/bin/env FLAGSHIP_KEYD_STATE=${KEYD_STATE_DIR} FLAGSHIP_KEYD_LEGACY_DIR=${legacy} ${node} ${entry} migrate
ExecStart=${node} ${entry} serve
Environment=FLAGSHIP_KEYD_STATE=${KEYD_STATE_DIR}
Environment=FLAGSHIP_KEYD_SOCKET=${KEYD_SOCKET}
RuntimeDirectory=${KEYD_RUNTIME_DIR}
RuntimeDirectoryMode=0750
StateDirectory=flagship-keyd
StateDirectoryMode=0700
Restart=always
RestartSec=2
# Unix socket only: no network, no devices, no other users' files.
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
# Keys must never reach disk through a crash or swap.
LimitCORE=0
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

/** The daemon waits for keyd and is a member of the client group; nothing else is. */
export function daemonKeydDropIn(): string {
  return `[Unit]
Requires=flagship-keyd.service
After=flagship-keyd.service

[Service]
SupplementaryGroups=${KEYD_CLIENT_GROUP}
Environment=FLAGSHIP_KEYD_SOCKET=${KEYD_SOCKET}
`;
}

export function keydSetupScript(): string {
  return `getent group ${KEYD_CLIENT_GROUP} >/dev/null || groupadd --system ${KEYD_CLIENT_GROUP}
id ${KEYD_USER} >/dev/null 2>&1 || useradd --system --gid ${KEYD_GROUP} --home-dir ${KEYD_STATE_DIR} --no-create-home --shell /usr/sbin/nologin ${KEYD_USER}
install -d -m 0700 -o ${KEYD_USER} -g ${KEYD_GROUP} ${KEYD_STATE_DIR}
`;
}
