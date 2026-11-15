// The flagship-daemon unit. One text for the bootstrap (userdata.ts, every installed box) and the
// retail image (retailImage.ts), where an unclaimed box has no daemon.env yet: its unit reads the
// file only when it exists, and the daemon runs the claim service alone until a claim gives it one.

export const DAEMON_UNIT_PATH = "/etc/systemd/system/flagship-daemon.service";

export function daemonServiceUnit(opts: { envFileOptional?: boolean } = {}): string {
  const unit = `[Unit]
Description=Flagship server daemon
After=network-online.target flagship-first-boot-register.service
Wants=network-online.target
# Never stop restarting on a headless box: with a start-limit the daemon's
# legitimate self-restarts (below) could trip StartLimitBurst and systemd would
# give up, stranding the box with no console to recover it.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/opt/flagship
EnvironmentFile=/etc/flagship/daemon.env
# SEC-KEY-003: a crash must never write key material to disk, and files the daemon
# creates are private by default.
LimitCORE=0
UMask=0077
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning packages/server-daemon/dist/index.js
# MUST be always, NOT on-failure. The daemon deliberately exits 0 to ask the
# supervisor to restart it once it has provisioned a post-boot secret or staged
# an update: the SWK-deposit + CGK-deposit consumers, the admin-root rotation
# consumer, and the self-update commit all exit with code 0 so the next boot
# re-reads the new state (server-daemon/src/index.ts). Under on-failure systemd
# treats exit 0 as success and does NOT restart, so a secret-free-recipe box
# dies the instant it consumes its SWK, before it ever claims its entitlement,
# opens the tunnel, runs ACME, or serves HTTPS. The real host power-off/reboot is
# a separate systemctl poweroff (deadMan.ts), so always never strands a shutdown.
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
  return opts.envFileOptional ? unit.replace("EnvironmentFile=/etc/flagship/daemon.env\n", "EnvironmentFile=-/etc/flagship/daemon.env\n") : unit;
}
