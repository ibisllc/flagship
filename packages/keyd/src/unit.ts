/**
 * The systemd units for flagship-keyd and the properties they must have on the box
 * (SECURITY-HARDENING-PLAN.md 5.1). `KEYD_REQUIRED_PROPERTIES` is what
 * `installer/verify-keyd-unit.sh` checks against `systemctl show` on the real appliance.
 */

export const KEYD_USER = "flagship-keyd";
export const KEYD_GROUP = "flagship-keyd";
export const KEYD_STATE_DIR = "/var/lib/flagship-keyd";
export const KEYD_RUNTIME_DIR = "flagship-keyd";
export const KEYD_SOCKET = "/run/flagship-keyd/keyd.sock";
/** The group that may open the socket: the daemon, and nothing that runs apps. */
export const KEYD_CLIENT_GROUP = "flagship-keyd-clients";

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

export function keydServiceUnit(opts: { nodePath?: string; keydEntry?: string } = {}): string {
  const node = opts.nodePath ?? "/usr/local/bin/node";
  const entry = opts.keydEntry ?? "/opt/flagship/packages/keyd/dist/main.js";
  return `[Unit]
Description=Flagship key daemon (box identity and workload keys)
Before=flagship-daemon.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${KEYD_USER}
Group=${KEYD_GROUP}
SupplementaryGroups=${KEYD_CLIENT_GROUP}
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
  return `getent group ${KEYD_GROUP} >/dev/null || groupadd --system ${KEYD_GROUP}
getent group ${KEYD_CLIENT_GROUP} >/dev/null || groupadd --system ${KEYD_CLIENT_GROUP}
id ${KEYD_USER} >/dev/null 2>&1 || useradd --system --gid ${KEYD_GROUP} --home-dir ${KEYD_STATE_DIR} --no-create-home --shell /usr/sbin/nologin ${KEYD_USER}
install -d -m 0700 -o ${KEYD_USER} -g ${KEYD_GROUP} ${KEYD_STATE_DIR}
`;
}
