// The host files a retail image ships for the claim service (docs/retail-box-setup.md §7.2, §7.5,
// §11.1). One definition for both writers: the image builder (flagship-builder retailImage.ts) puts
// them on the image, and the daemon puts back any that went missing (server-daemon
// retailClaim/daemon.ts ensureRetailHostConfig). Never on a VM appliance or a USB install.
//
// Least privilege. A box with no owner yet runs the claim service on its own, unprivileged, as
// `flagship-claim` (flagship-claim.service, hardened), and its only root steps go to the claim helper
// (flagship-privd in its retail-claim profile: the wipe and the restart into a claim's first boot).
// Once a claim's first boot has finished, the daemon runs the claim service (as `flagship` once privd
// is in) and the claim unit stays off. Neither account is added to the `bluetooth` group, which may
// call anything on org.bluez (pairing agents, connecting to other devices, adapter settings), nor to
// `input`, which reads every keyboard: both get the seven BlueZ calls the claim peripheral makes
// (bluez.ts) and read access to the power button's event nodes only.

/** The claim service of a box with no owner yet. */
export const RETAIL_CLAIM_USER = "flagship-claim";
/** The account the daemon runs as (privd unit.ts DAEMON_USER); it runs the claim service of a box with an owner. */
export const RETAIL_DAEMON_USER = "flagship";
/** keyd's client group (keyd unit.ts KEYD_CLIENT_GROUP): the claim key is keyd's. */
export const RETAIL_KEYD_CLIENT_GROUP = "flagship-keyd-clients";
export const RETAIL_STATE_DIR = "/var/lib/flagship-retail";
export const RETAIL_FIRST_BOOT_DONE_PATH = "/var/lib/flagship-retail/first-boot-done";
export const RETAIL_MARKER_PATH = "/etc/flagship/retail-image.json";
export const RETAIL_CLAIM_HELPER_SOCKET = "/run/flagship-claim-helper/helper.sock";
/** A group that may read the power button's evdev nodes and nothing else. */
export const RETAIL_POWER_KEY_GROUP = "flagship-powerkey";

export interface RetailHostFile {
  path: string;
  content: string;
  mode: number;
  /** What must reread it after a change. */
  reload: "bluetooth" | "logind" | "dbus" | "udev" | "systemd";
}

/**
 * `/etc/bluetooth/main.conf`: LE only, a resolvable private address, a generic name for the GAP
 * Device Name characteristic (never the hostname), and `Experimental = true` (the same as
 * bluetoothd's `-E`, so no ExecStart override): the scan response's `ScanResponseServiceData`
 * advert property is behind it.
 */
export const BLUEZ_MAIN_CONF = `[General]
Name = Flagship
ControllerMode = le
Privacy = device
Experimental = true

[Policy]
AutoEnable = true
`;
export const BLUEZ_MAIN_CONF_PATH = "/etc/bluetooth/main.conf";

/**
 * A bluetoothd drop-in that forgets the adapter's local identity key before every start, so the
 * private addresses of one boot cannot be resolved to those of the next.
 */
export const BLUEZ_FRESH_IDENTITY_DROP_IN = `[Service]
ExecStartPre=/bin/sh -c 'rm -f /var/lib/bluetooth/*/identity'
`;
export const BLUEZ_FRESH_IDENTITY_DROP_IN_PATH = "/etc/systemd/system/bluetooth.service.d/50-flagship-fresh-identity.conf";

export const LOGIND_DROP_IN_PATH = "/etc/systemd/logind.conf.d/50-flagship-power-key.conf";

/**
 * In the retail metal image from the first boot, so a short press never shuts the box down,
 * claimed or not. Never on a VM appliance: Studio stops a VM gracefully through the ACPI power
 * button, and ignoring it would leave only the forced stop that once corrupted a box mid-update.
 */
export const LOGIND_DROP_IN = `[Login]
HandlePowerKey=ignore
HandlePowerKeyLongPress=ignore
HandleRebootKey=ignore
HandleRebootKeyLongPress=ignore
HandleSuspendKey=ignore
HandleSuspendKeyLongPress=ignore
HandleHibernateKey=ignore
HandleHibernateKeyLongPress=ignore
`;

/**
 * The BlueZ calls the claim peripheral makes (bluez.ts), each named by interface and member, for
 * the daemon's user only. bluetoothd's own calls back into the daemon's GATT application and
 * advertisement are allowed by BlueZ's policy for root (its bluetooth.conf).
 */
export const RETAIL_BLUEZ_CALLS: ReadonlyArray<readonly [iface: string, member: string]> = [
  ["org.freedesktop.DBus.ObjectManager", "GetManagedObjects"],
  ["org.freedesktop.DBus.Properties", "Set"],
  ["org.bluez.GattManager1", "RegisterApplication"],
  ["org.bluez.GattManager1", "UnregisterApplication"],
  ["org.bluez.LEAdvertisingManager1", "RegisterAdvertisement"],
  ["org.bluez.LEAdvertisingManager1", "UnregisterAdvertisement"],
  ["org.bluez.Device1", "Disconnect"],
];

export const RETAIL_DBUS_POLICY_PATH = "/etc/dbus-1/system.d/flagship-retail-claim.conf";
/** Written out in full, for each account (one allow per RETAIL_BLUEZ_CALLS entry; a test keeps them equal). */
export const RETAIL_DBUS_POLICY = `<!-- Flagship retail claim service: only the BlueZ calls it makes (boot-chain retailHost.ts). -->
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="flagship-claim">
    <allow send_destination="org.bluez" send_interface="org.freedesktop.DBus.ObjectManager" send_member="GetManagedObjects"/>
    <allow send_destination="org.bluez" send_interface="org.freedesktop.DBus.Properties" send_member="Set"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.GattManager1" send_member="RegisterApplication"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.GattManager1" send_member="UnregisterApplication"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.LEAdvertisingManager1" send_member="RegisterAdvertisement"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.LEAdvertisingManager1" send_member="UnregisterAdvertisement"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.Device1" send_member="Disconnect"/>
  </policy>
  <policy user="flagship">
    <allow send_destination="org.bluez" send_interface="org.freedesktop.DBus.ObjectManager" send_member="GetManagedObjects"/>
    <allow send_destination="org.bluez" send_interface="org.freedesktop.DBus.Properties" send_member="Set"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.GattManager1" send_member="RegisterApplication"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.GattManager1" send_member="UnregisterApplication"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.LEAdvertisingManager1" send_member="RegisterAdvertisement"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.LEAdvertisingManager1" send_member="UnregisterAdvertisement"/>
    <allow send_destination="org.bluez" send_interface="org.bluez.Device1" send_member="Disconnect"/>
  </policy>
</busconfig>
`;

/**
 * The power button's event nodes (ACPI "Power Button", the Pi 5's `pwr_button`: the names
 * server-daemon powerKey.ts reads) go to their own group, readable by it only. Sorted after
 * udev's 50-udev-default.rules, which gives every input node to `input`. logind still reads them
 * as root.
 */
export const RETAIL_POWER_KEY_UDEV_RULE_PATH = "/etc/udev/rules.d/70-flagship-power-key.rules";
export const RETAIL_POWER_KEY_UDEV_RULE = `# Flagship retail box: the claim service reads the power button and no other input device.
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="Power Button", GROUP="flagship-powerkey", MODE="0640"
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="pwr_button", GROUP="flagship-powerkey", MODE="0640"
`;

/** The daemon joins the power key group for its own process only (not in /etc/group). */
export const RETAIL_DAEMON_DROP_IN_PATH = "/etc/systemd/system/flagship-daemon.service.d/50-retail-claim.conf";
export const RETAIL_DAEMON_DROP_IN = `# Flagship retail box (boot-chain retailHost.ts): the daemon starts once a claim's first boot is done
# (before that the claim service runs alone, unprivileged); it reads the power button, no bluetooth or input group.
[Unit]
ConditionPathExists=/var/lib/flagship-retail/first-boot-done

[Service]
SupplementaryGroups=flagship-powerkey
ExecStartPre=-+/bin/chown -R flagship:flagship /var/lib/flagship-retail
`;


export const RETAIL_CLAIM_HELPER_UNIT_PATH = "/etc/systemd/system/flagship-claim-helper.service";
/**
 * The claim helper: flagship-privd with only the claim's two root steps (privd policy.ts
 * validateRetailClaimRequest), on a socket only the claim account's group opens. Root, as the wipe
 * erases a block device and resets keyd, and the first boot restarts the box.
 */
export const RETAIL_CLAIM_HELPER_UNIT = `[Unit]
Description=Flagship retail claim helper (the claim service's two root steps)
ConditionPathExists=/etc/flagship/retail-image.json
ConditionPathExists=!/var/lib/flagship-retail/first-boot-done
Before=flagship-claim.service

[Service]
Type=simple
ExecStart=/usr/local/bin/node /opt/flagship/packages/privd/dist/main.js --profile retail-claim --socket /run/flagship-claim-helper/helper.sock --socket-group flagship-claim --audit /var/log/flagship-claim-helper/audit.log
RuntimeDirectory=flagship-claim-helper
RuntimeDirectoryMode=0755
LogsDirectory=flagship-claim-helper
LogsDirectoryMode=0750
UMask=0077
Restart=always
RestartSec=2
UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_ICU_DATA NODE_V8_COVERAGE NODE_REPL_EXTERNAL_MODULE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH MALLOC_CONF OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES SSL_CERT_FILE SSL_CERT_DIR
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
LimitCORE=0

[Install]
WantedBy=multi-user.target
`;

export const RETAIL_CLAIM_UNIT_PATH = "/etc/systemd/system/flagship-claim.service";
/**
 * The claim service of a box with no owner yet (server-daemon retailClaim/claimMain.ts). Its input is
 * whatever any phone nearby sends over Bluetooth, so it holds nothing it does not need: its own account,
 * no capabilities, a read-only system, its state folder alone writable, the power button and the
 * first console as its only devices, and sockets for D-Bus/keyd/the helper (AF_UNIX), the radio
 * (AF_BLUETOOTH), link state (AF_NETLINK) and the internet checks and remote claim (AF_INET/AF_INET6).
 * No MemoryDenyWriteExecute: V8's JIT needs it, and --jitless removes WebAssembly, which Node's own
 * fetch needs (privd unit.ts daemonHardeningDropIn). Both units drop privd's UNSAFE_ENV (a test keeps
 * the lists equal); the texts carry no interpolation, so the preseed engine bundle leaves them out.
 */
export const RETAIL_CLAIM_UNIT = `[Unit]
Description=Flagship retail claim service (a box with no owner yet)
ConditionPathExists=/etc/flagship/retail-image.json
ConditionPathExists=!/var/lib/flagship-retail/first-boot-done
Wants=flagship-keyd.service flagship-claim-helper.service bluetooth.service network-online.target
After=flagship-keyd.service flagship-claim-helper.service bluetooth.service network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=flagship-claim
Group=flagship-claim
SupplementaryGroups=flagship-keyd-clients flagship-powerkey
WorkingDirectory=/opt/flagship
ExecStartPre=+/bin/sh -c 'install -d -m 0700 -o flagship-claim -g flagship-claim /var/lib/flagship-retail && chown -R flagship-claim:flagship-claim /var/lib/flagship-retail'
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning packages/server-daemon/dist/retailClaim/claimMain.js
EnvironmentFile=-/etc/flagship/retail-claim.env
Environment=FLAGSHIP_DAEMON_UNPRIVILEGED=1
Environment=FLAGSHIP_PRIVD_SOCKET=/run/flagship-claim-helper/helper.sock
Environment=FLAGSHIP_KEYD_SOCKET=/run/flagship-keyd/keyd.sock
UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_ICU_DATA NODE_V8_COVERAGE NODE_REPL_EXTERNAL_MODULE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH MALLOC_CONF OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES SSL_CERT_FILE SSL_CERT_DIR
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ReadWritePaths=/var/lib/flagship-retail
ProtectHome=yes
PrivateTmp=yes
DevicePolicy=closed
DeviceAllow=char-input r
DeviceAllow=/dev/tty1 w
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @mount @debug @module @raw-io @reboot @swap @obsolete @clock @cpu-emulation
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK AF_BLUETOOTH
LimitCORE=0

[Install]
WantedBy=multi-user.target
`;

export const RETAIL_HOST_FILES: readonly RetailHostFile[] = [
  { path: BLUEZ_MAIN_CONF_PATH, content: BLUEZ_MAIN_CONF, mode: 0o644, reload: "bluetooth" },
  { path: BLUEZ_FRESH_IDENTITY_DROP_IN_PATH, content: BLUEZ_FRESH_IDENTITY_DROP_IN, mode: 0o644, reload: "bluetooth" },
  { path: LOGIND_DROP_IN_PATH, content: LOGIND_DROP_IN, mode: 0o644, reload: "logind" },
  { path: RETAIL_DBUS_POLICY_PATH, content: RETAIL_DBUS_POLICY, mode: 0o644, reload: "dbus" },
  { path: RETAIL_POWER_KEY_UDEV_RULE_PATH, content: RETAIL_POWER_KEY_UDEV_RULE, mode: 0o644, reload: "udev" },
  { path: RETAIL_DAEMON_DROP_IN_PATH, content: RETAIL_DAEMON_DROP_IN, mode: 0o644, reload: "systemd" },
  { path: RETAIL_CLAIM_HELPER_UNIT_PATH, content: RETAIL_CLAIM_HELPER_UNIT, mode: 0o644, reload: "systemd" },
  { path: RETAIL_CLAIM_UNIT_PATH, content: RETAIL_CLAIM_UNIT, mode: 0o644, reload: "systemd" },
];

/** Root shell lines that make the power key group and the claim account (idempotent). */
export function retailHostSetupScript(): string {
  return `getent group ${RETAIL_POWER_KEY_GROUP} >/dev/null || groupadd --system ${RETAIL_POWER_KEY_GROUP}
getent group ${RETAIL_CLAIM_USER} >/dev/null || groupadd --system ${RETAIL_CLAIM_USER}
id ${RETAIL_CLAIM_USER} >/dev/null 2>&1 || useradd --system --gid ${RETAIL_CLAIM_USER} --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ${RETAIL_CLAIM_USER}
`;
}
