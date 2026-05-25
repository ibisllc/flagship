// Build an apkovl that drops the live-installer tool+disk gate into the stock
// Alpine standard ISO. This validates BOTH the recommended base AND the exact
// production drop mechanism (the burner uses buildApkovl the same way).
//
// Usage: npx tsx scripts/build-gate-apkovl.mjs <out.apkovl.tar.gz>
import { buildApkovl } from "../../installer-apkovl/src/buildApkovl.ts";
import { writeFileSync } from "node:fs";

const out = process.argv[2] || "/tmp/flagship.apkovl.tar.gz";
const enc = new TextEncoder();

const script = [
  "#!/bin/sh",
  "exec > /dev/console 2>&1",
  'echo "================ FLAGSHIP INSTALLER GATE (apkovl) ================"',
  'echo "uname: $(uname -srm)"',
  'echo "modloop entries mounted: $(mount | grep -c modloop)"',
  'echo "--- bring up network + apk add the live-installer tools (downloading phase) ---"',
  "setup-interfaces -a 2>/dev/null || true",
  "rc-service networking start 2>/dev/null || udhcpc -i eth0 2>/dev/null || true",
  'apk update >/dev/null 2>&1 && echo "apk update ok" || echo "apk update FAILED (offline)"',
  'apk add cryptsetup lvm2 sgdisk dosfstools e2fsprogs curl >/dev/null 2>&1 && echo "apk add tools ok" || echo "apk add FAILED"',
  'echo "--- tool gate (live installer needs these; node is NOT here) ---"',
  "for t in cryptsetup pvcreate vgcreate lvcreate sgdisk mkfs.ext4 mkfs.vfat curl; do",
  '  if command -v "$t" >/dev/null 2>&1; then echo "  ok      $t"; else echo "  MISSING $t"; fi',
  "done",
  'echo "--- install-target disks (storage drivers came from modloop) ---"',
  "for d in /sys/block/*; do",
  '  n=${d##*/}; case "$n" in loop*|ram*|sr*) continue;; esac',
  '  echo "  /dev/$n  $(cat $d/size 2>/dev/null) sectors"',
  "done",
  'echo "FLAGSHIP_GATE_OK"',
  "poweroff",
  "",
].join("\n");

const tar = buildApkovl({
  mtime: 0,
  files: [
    { name: "etc/local.d/99-flagship-gate.start", content: enc.encode(script), mode: 0o755 },
    { name: "etc/runlevels/default/local", content: new Uint8Array(0), mode: 0o644 },
  ],
});
writeFileSync(out, tar);
console.log("apkovl written:", out, tar.length, "bytes");
