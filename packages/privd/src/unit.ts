/**
 * systemd units for the broker and the unprivileged daemon (SEC-DAEMON-001). Text only; the
 * installer writes them and the appliance check reads them back (installer/verify-privd-unit.sh).
 *
 * The broker keeps root only because Docker and systemctl need it, and loses everything else:
 * it can reach no network, cannot see home directories, and cannot gain new privileges. The
 * daemon runs as `flagship` with the broker's group, so it reaches the broker's socket and nothing
 * root-owned besides.
 */
export const PRIVD_SOCKET = "/run/flagship-privd/privd.sock";

export function privdUnit(binary = "/opt/flagship/packages/privd/dist/main.js"): string {
  return `[Unit]
Description=Flagship privileged broker (a closed set of host operations for the unprivileged daemon)
After=docker.service
Before=flagship-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/node ${binary} --socket ${PRIVD_SOCKET} --audit /var/log/flagship-privd/audit.log
User=root
RuntimeDirectory=flagship-privd
RuntimeDirectoryMode=0750
Group=flagship
UMask=0007
Restart=always
RestartSec=2
NoNewPrivileges=yes
PrivateNetwork=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/log/flagship-privd /run/flagship-privd
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
CapabilityBoundingSet=CAP_SYS_BOOT CAP_NET_ADMIN CAP_SYS_ADMIN CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER CAP_KILL CAP_SETUID CAP_SETGID
SystemCallArchitectures=native
LimitCORE=0

[Install]
WantedBy=multi-user.target
`;
}
