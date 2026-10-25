/**
 * The boot chain drill's on-box half (drill.sh bundles it and runs it as root on a throwaway Debian
 * 13 VM). It drives the real refresh (server-daemon bootChainRefresh.ts) against the real
 * initramfs-tools and GRUB, with the release's real unlock hook and premount:
 *
 *   install      the pieces an installer of release v1 leaves, and the initrd built from them
 *   release <v>  put release v's unseal helper in the drill's release tree
 *   refresh <v>  one run of the refresh for release v; prints its outcome as JSON
 *
 * v1 is the generator's output. v2 approves one more boot host (the drill's /boot/flagship-boot-host),
 * so which premount ran shows in the unlock log: v1 stops at "not https on an approved host", v2 gets
 * past it to "no crypto_LUKS partition". v3 is v2 plus an init-premount that panics, a boot chain
 * that builds, passes its checks and cannot boot.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { APPROVED_BOOT_HOSTS, bootChainScripts, type BootChainInputs, type BootChainScript } from "@flagship/boot-chain";
import { realBootChainSystem, releaseInitrdExpectations, runBootChainRefresh, type Piece } from "../../packages/server-daemon/src/bootChainRefresh.js";

const RELEASE = "/opt/flagship-drill-release";
const DRILL_HOST = "boot.drill.flagship.example";
const PANIC_PATH = "/etc/initramfs-tools/scripts/init-premount/flagship-drill-panic";
const PANIC_SCRIPT = `#!/bin/sh
PREREQ=""
prereqs() { echo "$PREREQ"; }
case "$1" in prereqs) prereqs; exit 0;; esac
. /scripts/functions
mkdir -p /run/drillmnt
for _i in 1 2 3 4 5 6 7 8 9 10; do [ -e /dev/disk/by-label/FLAGSHIP_BOOT ] && break; sleep 1; done
if mount /dev/disk/by-label/FLAGSHIP_BOOT /run/drillmnt; then
  echo "trial boot panicked at uptime $(cut -d' ' -f1 /proc/uptime)" >> /run/drillmnt/flagship-drill-panic.log
  umount /run/drillmnt
fi
panic "flagship drill: this boot chain is broken on purpose"
`;

const variants: Record<string, (i: BootChainInputs) => BootChainScript[]> = {
  v1: (i) => bootChainScripts({ ...i, approvedHosts: APPROVED_BOOT_HOSTS }),
  v2: (i) => bootChainScripts({ ...i, approvedHosts: [...i.approvedHosts.filter((h) => h !== DRILL_HOST), DRILL_HOST] }),
  v3: (i) => [...variants.v2!(i), { path: PANIC_PATH, content: PANIC_SCRIPT, mode: 0o755 }],
};

function helper(v: string): string {
  return `#!/bin/sh\necho "flagship-unseal drill ${v}"\n`;
}

function put(path: string, content: string, mode: number): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

function expectations(pieces: Piece[]) {
  const extra = pieces.filter((p) => p.path === PANIC_PATH).map((p) => ({ path: "scripts/init-premount/flagship-drill-panic", size: p.data.length }));
  return [...releaseInitrdExpectations(pieces.filter((p) => p.path !== PANIC_PATH)), ...extra];
}

const [cmd, v = "v1"] = process.argv.slice(2);
if (cmd === "install") {
  for (const s of variants.v1!({ approvedHosts: APPROVED_BOOT_HOSTS })) put(s.path, s.content, s.mode);
  put("/boot/flagship-unseal", helper("v1"), 0o755);
  put("/boot/flagship-boot-key.pem", "-----BEGIN PRIVATE KEY-----\ndrill\n-----END PRIVATE KEY-----\n", 0o600);
  put("/boot/server-domain", "home.drill.flagship.services\n", 0o644);
  put("/boot/flagship-boot-host", `https://${DRILL_HOST}\n`, 0o644);
  put("/boot/flagship-boot-unlock-mode", "approve\n", 0o644);
  put("/boot/flagship-owner-key.pub", "00\n", 0o644);
  const out = execFileSync("/usr/sbin/update-initramfs", ["-u"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (out.includes("flagship-unlock hook:")) throw new Error(out);
  console.log(JSON.stringify({ installed: "v1" }));
} else if (cmd === "release") {
  put(`${RELEASE}/installer/flagship-unseal`, helper(v), 0o755);
  console.log(JSON.stringify({ release: v }));
} else if (cmd === "refresh") {
  const r = await runBootChainRefresh(realBootChainSystem((m) => console.error(m)), { releaseRoot: RELEASE, scripts: variants[v]!, expectations });
  console.log(JSON.stringify(r));
} else {
  console.error("usage: harness.mjs install | release <v> | refresh <v>");
  process.exit(2);
}
