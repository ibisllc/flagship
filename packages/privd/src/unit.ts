/**
 * systemd units for the broker and the unprivileged daemon (SEC-DAEMON-001). Text only; the daemon's
 * first start writes them (server-daemon privdInstall.ts).
 *
 * The broker keeps root because Docker, systemctl, mount and the firewall need it, and it acts on the
 * host's own mount table and network: so it has no private mount or network namespace (a loop mount
 * made in one would be invisible to Docker; iptables would fence an empty namespace). What keeps it
 * narrow is the closed set of operations (policy.ts), a socket only the daemon's group can open, and
 * no new privileges. The daemon runs as `flagship`, reaches this socket and keyd's, binds :443 for
 * LAN-direct, reads the journal, and holds no other capability.
 */
export const PRIVD_SOCKET = "/run/flagship-privd/privd.sock";
export const PRIVD_UNIT_PATH = "/etc/systemd/system/flagship-privd.service";
export const PRIVD_DAEMON_DROPIN_PATH = "/etc/systemd/system/flagship-daemon.service.d/40-privd.conf";
export const DAEMON_USER = "flagship";
export const PRIVD_AUDIT_LOG = "/var/log/flagship-privd/audit.log";

export function privdUnit(binary = "/opt/flagship/packages/privd/dist/main.js", node = "/usr/local/bin/node"): string {
  return `[Unit]
Description=Flagship privileged broker (a closed set of host operations for the unprivileged daemon)
After=docker.service
Before=flagship-daemon.service

[Service]
Type=simple
ExecStart=${node} ${binary} --socket ${PRIVD_SOCKET} --audit ${PRIVD_AUDIT_LOG} --socket-group ${DAEMON_USER}
# No User=: a system service is root already. An explicit User=root together with NoNewPrivileges=yes makes systemd (Debian 13, v257)
# drop CAP_SETUID from the service, and NoNewPrivs then keeps every child from getting it back; runsc's gofer needs it
# (setuid), so every gVisor container failed with 'fork/exec /proc/self/exe: operation not permitted'.
RuntimeDirectory=flagship-privd
RuntimeDirectoryMode=0755
LogsDirectory=flagship-privd
LogsDirectoryMode=0750
StateDirectory=flagship-privd
StateDirectoryMode=0700
UMask=0022
Restart=always
RestartSec=2
NoNewPrivileges=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
LimitCORE=0

[Install]
WantedBy=multi-user.target
`;
}

/** The privileged helper the daemon hands host operations to: flagship-privd, or the Rust broker's privd v1 socket. */
export interface PrivilegedHelper {
  unit: string;
  socket: string;
}
export const PRIVD_HELPER: PrivilegedHelper = { unit: "flagship-privd.service", socket: PRIVD_SOCKET };

/** The daemon's drop-in once its helper answers: its own account, the groups it needs, one capability. */
export function daemonPrivdDropIn(helper: PrivilegedHelper = PRIVD_HELPER): string {
  return `[Unit]
Wants=${helper.unit}
After=${helper.unit}

[Service]
User=${DAEMON_USER}
Group=${DAEMON_USER}
SupplementaryGroups=systemd-journal
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
RuntimeDirectory=flagship-daemon
RuntimeDirectoryMode=0755
Environment=FLAGSHIP_DAEMON_UNPRIVILEGED=1
Environment=FLAGSHIP_PRIVD_SOCKET=${helper.socket}
`;
}

/** The daemon's account: a system user with its own group, no shell, no home of its own. */
export function privdSetupScript(): string {
  return `getent group ${DAEMON_USER} >/dev/null || groupadd --system ${DAEMON_USER}
id ${DAEMON_USER} >/dev/null 2>&1 || useradd --system --gid ${DAEMON_USER} --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ${DAEMON_USER}
`;
}
