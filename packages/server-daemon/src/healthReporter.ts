import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HYBRID_SIG_LEN, TAG_BOX_HEALTH } from "@flagship/protocol";

/**
 * The box health reporter: a systemd timer, separate from the daemon, that
 * signs a fixed-field report with the box identity key about once a minute and
 * posts it to `.com` (control-plane serverHealth.ts). Separate on purpose: it
 * keeps reporting while the daemon is crash-looping or killed for memory, which
 * is exactly when an owner needs to know why a server went quiet. The daemon
 * installs (and refreshes) the units at startup, so an existing box picks the
 * reporter up with its next update. Only numbers and enums leave the box.
 *
 * It signs `flagship/box-health/v1|<report>` (protocol boxHealth.ts), never the bare JSON: once a server has sent a
 * tagged report (or a heartbeat at boxLevel >= 3), `.com` refuses its untagged ones.
 *
 * It asks keyd first (`flagship-keyd sign-health`, keyd healthSign.ts): the STK signs, and keyd's ML-DSA half adds
 * a hybrid `pqSignature`, which a strict installation requires (`.com` refuses a classical-only report there). keyd
 * is its own unit, so a failing daemon does not stop it; when keyd cannot answer (not installed, down, or the
 * checkout's node_modules broken) the timer falls back to the boot key (or the STK PEM), classical only.
 */
export const HEALTH_SCRIPT_PATH = "/usr/local/sbin/flagship-health-report.sh";
export const HEALTH_SERVICE_PATH = "/etc/systemd/system/flagship-health.service";
export const HEALTH_TIMER_PATH = "/etc/systemd/system/flagship-health.timer";

const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/;
const SAFE_DOMAIN = /^[a-z0-9.-]+$/;

/**
 * The key the timer signs with. A box with a boot key keeps no STK on /boot
 * (packages/protocol/src/bootKey.ts), and the timer runs outside keyd on
 * purpose, so it signs with the boot key; `.com` accepts it through the
 * stored binding. A box without one (demo, unencrypted) still has the STK PEM.
 */
export const BOOT_KEY_PEM_PATH = "/boot/flagship-boot-key.pem";
export function healthKeyPath(exists: (p: string) => boolean = existsSync): string {
  return exists(BOOT_KEY_PEM_PATH) ? BOOT_KEY_PEM_PATH : "/boot/identity.pem";
}

/** The keyd client the timer runs (the keyd unit's own node and checkout, keydInstall.ts). */
export const HEALTH_NODE_PATH = "/usr/local/bin/node";
export const HEALTH_KEYD_ENTRY = "/opt/flagship/packages/keyd/dist/main.js";
export const HEALTH_KEYD_SOCKET = "/run/flagship-keyd/keyd.sock";

export function buildHealthReportScript(args: {
  controlPlaneBaseUrl: string;
  serverDomain: string;
  keyPath?: string;
  nodePath?: string;
  keydEntry?: string;
  keydSocket?: string;
  /** curl config naming the outbound proxy (docs/outbound-proxy.md), used when present. */
  proxyCurlrcPath?: string;
}): string {
  const base = args.controlPlaneBaseUrl.replace(/\/+$/, "");
  const domain = args.serverDomain.toLowerCase();
  if (!SAFE_URL.test(base)) throw new Error("unsafe control-plane URL");
  if (!SAFE_DOMAIN.test(domain)) throw new Error("unsafe server domain");
  const key = args.keyPath ?? healthKeyPath();
  const node = args.nodePath ?? HEALTH_NODE_PATH;
  const entry = args.keydEntry ?? HEALTH_KEYD_ENTRY;
  const socket = args.keydSocket ?? HEALTH_KEYD_SOCKET;
  for (const p of [key, node, entry, socket]) if (!/^\/[A-Za-z0-9._\/-]+$/.test(p)) throw new Error("unsafe key path");
  const curlrc = args.proxyCurlrcPath ?? "/var/flagship/outbound-proxy.curlrc";
  if (!/^\/[A-Za-z0-9._/-]+$/.test(curlrc)) throw new Error("unsafe proxy config path");
  return `#!/bin/bash
# Flagship box health report (installed by the daemon; see healthReporter.ts).
set -u
num() { case "\${1:-}" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
mem_total=$(num "$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)")
mem_avail=$(num "$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)")
swap_used=$(num "$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{print int((t-f)/1024)}' /proc/meminfo)")
oom=$(num "$(awk '/^oom_kill /{print $2}' /proc/vmstat)")
uptime_s=$(num "$(cut -d. -f1 /proc/uptime)")
state=$(systemctl show -p ActiveState --value flagship-daemon 2>/dev/null)
case "$state" in active|activating|deactivating|inactive|failed|reloading) ;; *) state=inactive ;; esac
restarts=$(num "$(systemctl show -p NRestarts --value flagship-daemon 2>/dev/null)")
last_exit=$(num "$(systemctl show -p ExecMainStatus --value flagship-daemon 2>/dev/null)")
tunnel=false
ss -Htn state established '( dport = :8443 )' 2>/dev/null | grep -q . && tunnel=true
disk=$(num "$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')")
at=$(( $(date +%s) * 1000 ))
report="{\\"v\\":1,\\"domain\\":\\"${domain}\\",\\"at\\":$at,\\"uptimeS\\":$uptime_s,\\"memTotalMB\\":$mem_total,\\"memAvailMB\\":$mem_avail,\\"swapUsedMB\\":$swap_used,\\"oomKills\\":$oom,\\"daemon\\":{\\"state\\":\\"$state\\",\\"restarts\\":$restarts,\\"lastExit\\":$last_exit},\\"tunnel\\":$tunnel,\\"diskUsedPct\\":$disk}"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s|%s' '${TAG_BOX_HEALTH}' "$report" > "$tmp"
sig=""
pq=""
if [ -S ${socket} ] && [ -x ${node} ] && [ -f ${entry} ]; then
  signed=$(timeout 20 ${node} ${entry} sign-health "$tmp" 2>/dev/null) || signed=""
  sig=$(printf '%s' "$signed" | jq -r '.signature // empty' 2>/dev/null) || sig=""
  pq=$(printf '%s' "$signed" | jq -r '.hybrid // empty' 2>/dev/null) || pq=""
  case "$sig" in *[!0-9a-f]*) sig="" ;; esac
  case "$pq" in *[!0-9a-f]*) pq="" ;; esac
  [ \${#pq} -eq ${HYBRID_SIG_LEN * 2} ] || pq=""
fi
if [ \${#sig} -ne 128 ]; then
  pq=""
  sig=$(openssl pkeyutl -sign -inkey ${key} -rawin -in "$tmp" | xxd -p | tr -d '\\n')
fi
[ \${#sig} -eq 128 ] || exit 0
if [ -n "$pq" ]; then
  body=$(jq -cn --arg r "$report" --arg s "$sig" --arg p "$pq" '{report:$r, signature:$s, pqSignature:{suite:"hybrid-ed25519-mldsa65/v1", signature:$p}}')
else
  body=$(jq -cn --arg r "$report" --arg s "$sig" '{report:$r, signature:$s}')
fi
proxy=()
[ -r ${curlrc} ] && proxy=(-K ${curlrc})
curl \${proxy[@]+"\${proxy[@]}"} -fsS --connect-timeout 5 --max-time 15 -X POST -H 'content-type: application/json' \\
  --data "$body" "${base}/api/server/${domain}/health" >/dev/null 2>&1 || true
`;
}

export const HEALTH_SERVICE_UNIT = `[Unit]
Description=Flagship box health report
After=network-online.target

[Service]
Type=oneshot
ExecStart=${HEALTH_SCRIPT_PATH}
`;

export const HEALTH_TIMER_UNIT = `[Unit]
Description=Flagship box health report, every minute

[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
`;

export interface HealthReporterInstallOptions {
  controlPlaneBaseUrl: string;
  serverDomain: string;
  proxyCurlrcPath?: string;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  /** Only real boxes (systemd present) get the units. */
  hasSystemd?: () => boolean;
  onLog?: (m: string) => void;
}

/** Write the reporter + units when they differ, then enable the timer. */
export async function installHealthReporter(opts: HealthReporterInstallOptions): Promise<boolean> {
  const hasSystemd = opts.hasSystemd ?? (() => existsSync("/run/systemd/system"));
  if (!hasSystemd()) return false;
  const read = opts.read ?? (async (p) => (await readFile(p, "utf8").catch(() => null)));
  const write =
    opts.write ??
    (async (p, c, mode) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, c, { mode });
    });
  const files: Array<[string, string, number]> = [
    [HEALTH_SCRIPT_PATH, buildHealthReportScript(opts), 0o700],
    [HEALTH_SERVICE_PATH, HEALTH_SERVICE_UNIT, 0o644],
    [HEALTH_TIMER_PATH, HEALTH_TIMER_UNIT, 0o644],
  ];
  let changed = false;
  for (const [path, content, mode] of files) {
    if ((await read(path)) !== content) {
      await write(path, content, mode);
      changed = true;
    }
  }
  if (changed) await opts.run("systemctl", ["daemon-reload"]);
  await opts.run("systemctl", ["enable", "--now", "flagship-health.timer"]);
  if (changed) opts.onLog?.("[health] box health reporter installed");
  return changed;
}
