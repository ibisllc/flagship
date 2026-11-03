/**
 * Finding the box's own disks from an initramfs script: the boot partition (label FLAGSHIP_BOOT, for
 * the unlock log, the lock-once marker, the live owner key and the Wi-Fi log) and the encrypted root.
 *
 * Both are pinned by the UUIDs the unlock hook recorded when it built the initrd (from /etc/fstab's
 * /boot line and /etc/crypttab's entry: DISK_UUID_RECORD_SH). A plugged-in stick labelled
 * FLAGSHIP_BOOT, a second LUKS disk, or two devices claiming the same UUID are never used. Before this
 * the premounts took any FLAGSHIP_BOOT-labelled ext4 and the first crypto_LUKS partition blkid listed.
 *
 * At init-premount two more things are not yet true: udev may not have made the device yet, and ext4
 * is not loaded (the root is not mounted yet, and a plain `mount` without a type tries only the
 * filesystems already in /proc/filesystems; RELEASE-0.3-JOURNAL B0). FLAGSHIP_BOOT_WAIT_SECS exists
 * for the tests.
 */

/** Where the hook records the UUIDs inside the initrd (read from the initrd, never from a disk). */
export const BOOT_FS_UUID_FILE = "boot/flagship-boot-fs-uuid";
export const LUKS_UUID_FILE = "boot/flagship-luks-uuid";

export const BOOT_FS_MOUNT_SH = [
  "# pinned_uuid <file>: the UUID the unlock hook recorded in the initrd, or fail.",
  "pinned_uuid() {",
  '    [ -r "$1" ] || return 1',
  "    _pu=\"$(tr -d ' \\n\\r' < \"$1\" 2>/dev/null || true)\"",
  '    case "$_pu" in',
  "        ''|*[!0-9A-Fa-f-]*) return 1;;",
  "    esac",
  '    echo "$_pu"',
  "}",
  "# device_by_uuid <uuid> <type> <wait secs>: the ONE block device with this UUID, which must be of",
  "# this type; waits (bounded) for it to appear. 1 = not found, 2 = more than one, 3 = wrong type.",
  "device_by_uuid() {",
  '    _dbdead=$(( $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + ${FLAGSHIP_BOOT_WAIT_SECS:-$3} ))',
  "    while :; do",
  '        _dbdevs="$(blkid -t UUID="$1" -o device 2>/dev/null || true)"',
  "        _dbn=\"$(printf '%s\\n' \"$_dbdevs\" | grep -c '^/' || true)\"",
  '        if [ "$_dbn" -gt 1 ]; then return 2; fi',
  '        if [ "$_dbn" = 1 ]; then',
  '            [ "$(blkid -s TYPE -o value "$_dbdevs" 2>/dev/null || true)" = "$2" ] || return 3',
  '            echo "$_dbdevs"',
  "            return 0",
  "        fi",
  '        [ "$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999999)" -ge "$_dbdead" ] && return 1',
  "        sleep 1",
  "    done",
  "}",
  "# mount_boot_fs <mountpoint>: the boot partition recorded at install (by UUID, ext4), mounted as ext4.",
  "mount_boot_fs() {",
  `    _buuid="$(pinned_uuid "\${R:-}/${BOOT_FS_UUID_FILE}")" || return 1`,
  '    _bnode="$(device_by_uuid "$_buuid" ext4 10)" || return 1',
  "    modprobe ext4 2>/dev/null || true",
  '    mount -t ext4 "$_bnode" "$1" 2>/dev/null',
  "}",
].join("\n");

/**
 * The unlock hook's part (initramfs build time, on the installed system): record into the initrd the
 * UUID of the filesystem /etc/fstab mounts at /boot and of the device /etc/crypttab's first entry
 * opens. `flagship_record_disk_uuids <fstab> <crypttab> <destdir>` fails (non-zero, one line on stderr)
 * when either can't be resolved, and the hook then fails the build: an initrd that can't find its own
 * disks must never replace a working one. Runs on every initrd build (install, appliance
 * specialisation, kernel updates, the boot-chain refresh), so it always follows the disk it is on.
 */
export const DISK_UUID_RECORD_SH = [
  "# flagship_uuid_of <fstab/crypttab source>: the filesystem or LUKS UUID it names.",
  "flagship_uuid_of() {",
  '    case "$1" in',
  '        UUID=*) _fu="${1#UUID=}";;',
  '        /dev/*) _fu="$(blkid -s UUID -o value "$1" 2>/dev/null || true)";;',
  '        *=*) _fd="$(findfs "$1" 2>/dev/null || true)"; [ -n "$_fd" ] || return 1; _fu="$(blkid -s UUID -o value "$_fd" 2>/dev/null || true)";;',
  "        *) return 1;;",
  "    esac",
  "    _fu=\"$(printf '%s' \"$_fu\" | tr -d '\"')\"",
  '    case "$_fu" in',
  "        ''|*[!0-9A-Fa-f-]*) return 1;;",
  "    esac",
  '    echo "$_fu"',
  "}",
  "flagship_record_disk_uuids() {",
  "    _bsrc=\"$(awk '$1 !~ /^#/ && $2 == \"/boot\" { print $1; exit }' \"$1\" 2>/dev/null || true)\"",
  '    _buuid="$(flagship_uuid_of "$_bsrc")" || { echo "no UUID for the /boot filesystem in $1 (${_bsrc:-no /boot line})" >&2; return 1; }',
  "    _csrc=\"$(awk '$1 !~ /^#/ && NF >= 2 { print $2; exit }' \"$2\" 2>/dev/null || true)\"",
  '    _cuuid="$(flagship_uuid_of "$_csrc")" || { echo "no UUID for the encrypted root in $2 (${_csrc:-no entry})" >&2; return 1; }',
  '    mkdir -p "$3/boot"',
  `    printf '%s\\n' "$_buuid" > "$3/${BOOT_FS_UUID_FILE}"`,
  `    printf '%s\\n' "$_cuuid" > "$3/${LUKS_UUID_FILE}"`,
  "}",
].join("\n");
