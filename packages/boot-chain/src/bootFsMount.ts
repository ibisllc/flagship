/**
 * Mounting the box's real boot partition (label FLAGSHIP_BOOT) from an initramfs script, for the
 * unlock log, the lock-once marker, the live owner key and the Wi-Fi log. Both premount scripts embed
 * this one function. At init-premount two things are not yet true: udev may not have made the
 * by-label link, and ext4 is not loaded (the root is not mounted yet, and a plain `mount` without a
 * type tries only the filesystems already in /proc/filesystems), so a bare `mount` of the label
 * failed on real boxes and the persistent log stayed empty (docs: RELEASE-0.3-JOURNAL B0).
 * FLAGSHIP_BOOT_NODE and FLAGSHIP_BOOT_WAIT_SECS exist for the tests.
 */
export const BOOT_FS_MOUNT_SH = [
  "# mount_boot_fs <mountpoint>: wait (bounded) for the FLAGSHIP_BOOT link, load ext4, mount it as ext4.",
  "mount_boot_fs() {",
  '    _bnode="${FLAGSHIP_BOOT_NODE:-/dev/disk/by-label/FLAGSHIP_BOOT}"',
  '    _bdead=$(( $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) + ${FLAGSHIP_BOOT_WAIT_SECS:-10} ))',
  '    while [ ! -e "$_bnode" ]; do',
  '        [ "$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)" -ge "$_bdead" ] && break',
  "        sleep 1",
  "    done",
  "    modprobe ext4 2>/dev/null || true",
  '    mount -t ext4 "$_bnode" "$1" 2>/dev/null',
  "}",
].join("\n");
