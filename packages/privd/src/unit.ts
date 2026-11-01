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
export const DAEMON_HARDENING_DROPIN_PATH = "/etc/systemd/system/flagship-daemon.service.d/45-hardening.conf";
/**
 * Drop-ins this release line writes that an older release does not know, relative to /etc/systemd/system.
 * Every rollback path removes them before the daemon starts again (installer/rollback-box-artifact.sh,
 * flagship-updater `restore`), so an older release never runs under settings it cannot take back.
 * The same list is in both; a test keeps them equal.
 */
export const RELEASE_DROPINS: readonly string[] = ["flagship-daemon.service.d/45-hardening.conf"];
/** Root-only record of the sandbox's crash-loop count and of its removal (updateGuard.ts). */
export const HARDENING_STATE_DIR = "/var/lib/flagship-hardening";
/** Starts in a row, each within HARDENING_QUICK_SECS of the one before, after which the guard removes the sandbox. */
export const HARDENING_MAX_QUICK_STARTS = 5;
export const HARDENING_QUICK_SECS = 120;

/**
 * Variables that change what Node, the dynamic loader or OpenSSL load or trust, dropped from every
 * Flagship unit whatever an EnvironmentFile or systemd's DefaultEnvironment says (release plan G9:
 * a retained Node process starts from a sanitized environment). keyd's unit.ts carries the same list.
 */
export const UNSAFE_ENV: readonly string[] = [
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_ICU_DATA",
  "NODE_V8_COVERAGE", "NODE_REPL_EXTERNAL_MODULE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "GCONV_PATH", "MALLOC_CONF",
  "OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_ENGINES", "SSL_CERT_FILE", "SSL_CERT_DIR",
];
export const UNSET_ENV_LINE = `UnsetEnvironment=${UNSAFE_ENV.join(" ")}`;

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
${UNSET_ENV_LINE}
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

/**
 * The unprivileged daemon's sandbox (release plan G9), a drop-in of its own so a box that gave up root
 * before this existed gets it from the root "update-guard" step on its next boot. Only for the daemon
 * as `flagship`: a root daemon still writes units and scripts under /etc and /usr. Nothing here may
 * stop the daemon doing its job, so what it leaves out is deliberate:
 * - no MemoryDenyWriteExecute: V8's JIT needs it, and `--jitless` removes WebAssembly, which Node's
 *   own fetch (undici's HTTP parser) needs (measured, docs/architecture-v2/execution-surfaces.md);
 * - no PrivateTmp: files pass through /tmp and /var/tmp to the broker's operations;
 * - no ProtectSystem=strict: the daemon's writable state is spread over /var and the owner's data;
 *   `full` makes /usr, /boot and /etc read-only, and the release tree is read-only by name;
 * - no PrivateDevices or ProtectClock (which closes the device list): GPU probes run as its children.
 */
export function daemonHardeningDropIn(): string {
  return `# Written by the Flagship daemon's root setup step (privd unit.ts daemonHardeningDropIn).
[Service]
${UNSET_ENV_LINE}
ProtectSystem=full
ReadOnlyPaths=-/opt/flagship-releases -/opt/flagship
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=~@clock @cpu-emulation @debug @module @mount @obsolete @raw-io @reboot @swap
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
LimitNOFILE=65536
TasksMax=4096
MemoryMax=75%
LimitCORE=0
`;
}

/** The daemon's account: a system user with its own group, no shell, no home of its own. */
export function privdSetupScript(): string {
  return `getent group ${DAEMON_USER} >/dev/null || groupadd --system ${DAEMON_USER}
id ${DAEMON_USER} >/dev/null 2>&1 || useradd --system --gid ${DAEMON_USER} --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ${DAEMON_USER}
`;
}
