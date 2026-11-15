// The host files a retail image ships for the claim service (docs/retail-box-setup.md §7.2, §7.5,
// §11.1). One definition for both writers: the image builder (flagship-builder retailImage.ts) puts
// them on the image, and the daemon puts back any that went missing (server-daemon
// retailClaim/daemon.ts ensureRetailHostConfig). Never on a VM appliance or a USB install.
//
// Least privilege: the claim service runs inside the daemon (the `flagship` user once privd is in).
// It is NOT added to the `bluetooth` group, which may call anything on org.bluez (pairing agents,
// connecting to other devices, adapter settings), nor to `input`, which reads every keyboard. It
// gets the seven BlueZ calls the claim peripheral makes (bluez.ts) and read access to the power
// button's event nodes only.

/** The account the daemon runs as (privd unit.ts DAEMON_USER). */
export const RETAIL_CLAIM_USER = "flagship";
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
export const RETAIL_DBUS_POLICY = `<!-- Flagship retail claim service: only the BlueZ calls it makes (boot-chain retailHost.ts). -->
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="${RETAIL_CLAIM_USER}">
${RETAIL_BLUEZ_CALLS.map(([i, m]) => `    <allow send_destination="org.bluez" send_interface="${i}" send_member="${m}"/>`).join("\n")}
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
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="Power Button", GROUP="${RETAIL_POWER_KEY_GROUP}", MODE="0640"
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="pwr_button", GROUP="${RETAIL_POWER_KEY_GROUP}", MODE="0640"
`;

/** The daemon joins the power key group for its own process only (not in /etc/group). */
export const RETAIL_DAEMON_DROP_IN_PATH = "/etc/systemd/system/flagship-daemon.service.d/50-retail-claim.conf";
export const RETAIL_DAEMON_DROP_IN = `# Flagship retail box: read the power button (boot-chain retailHost.ts). No bluetooth or input group.
[Service]
SupplementaryGroups=${RETAIL_POWER_KEY_GROUP}
`;

export const RETAIL_HOST_FILES: readonly RetailHostFile[] = [
  { path: BLUEZ_MAIN_CONF_PATH, content: BLUEZ_MAIN_CONF, mode: 0o644, reload: "bluetooth" },
  { path: BLUEZ_FRESH_IDENTITY_DROP_IN_PATH, content: BLUEZ_FRESH_IDENTITY_DROP_IN, mode: 0o644, reload: "bluetooth" },
  { path: LOGIND_DROP_IN_PATH, content: LOGIND_DROP_IN, mode: 0o644, reload: "logind" },
  { path: RETAIL_DBUS_POLICY_PATH, content: RETAIL_DBUS_POLICY, mode: 0o644, reload: "dbus" },
  { path: RETAIL_POWER_KEY_UDEV_RULE_PATH, content: RETAIL_POWER_KEY_UDEV_RULE, mode: 0o644, reload: "udev" },
  { path: RETAIL_DAEMON_DROP_IN_PATH, content: RETAIL_DAEMON_DROP_IN, mode: 0o644, reload: "systemd" },
];

/** Root shell lines that make the power key group (idempotent). */
export function retailHostSetupScript(): string {
  return `getent group ${RETAIL_POWER_KEY_GROUP} >/dev/null || groupadd --system ${RETAIL_POWER_KEY_GROUP}\n`;
}
