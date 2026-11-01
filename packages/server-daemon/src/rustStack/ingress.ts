/**
 * The Rust ingress in place of flagship-tlsd, when the owner's proxy setting is `rust`
 * (rustStack/ownership.ts, flagship-ingress proxy.rs). A drop-in for flagship-tlsd.service keeps
 * that unit (its user, group, sandbox and the daemon's ordering) and swaps the program:
 *
 *   pre      (root, ExecStartPre) Rust only when this release pins flagship-ingress, the binary's
 *            SHA-256 equals the pin, and it has not failed three runs in a row; writes the choice
 *            and the proxy's arguments (the decision socket, the app networks it may dial).
 *   run      (the tlsd user) execs the choice: the Rust ingress with the proxy, or the Go tlsd.
 *   stopped  (root, ExecStopPost) counts a failed run (systemd's verdict); a run longer than two
 *            minutes starts the count again.
 *
 * A broken ingress therefore falls back to the Go frontend by itself, and the owner can still
 * reach the box to turn the setting off. Without the setting (or off arch-v2) the drop-in is
 * removed and flagship-tlsd runs exactly as before.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KEYD_SOCKET, TLS_UPSTREAM_SOCKET, TLSD_PORT } from "@flagship/keyd/unit";
import { writeFileDurable } from "../durableFile.js";
import type { ArchV2Config } from "../engine/engine.js";
import { isAppNetwork, loadOwnership, type RustOwnership } from "./ownership.js";
import { RUST_BIN_DIR_REL, RUST_PINS_REL, RUST_RUN_DIR, RUST_STATE_DIR } from "./units.js";

export const TLSD_RUST_DROPIN_PATH = "/etc/systemd/system/flagship-tlsd.service.d/40-rust-ingress.conf";
export const INGRESS_EXEC_PATH = "/usr/local/sbin/flagship-ingress-exec";
export const DECIDE_SOCKET = "/run/flagship-tls/decide.sock";
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export function ingressExecScript(releasePath = "/opt/flagship", runDir = RUST_RUN_DIR, stateDir = RUST_STATE_DIR): string {
  if (!SAFE_PATH.test(releasePath) || !SAFE_PATH.test(runDir) || !SAFE_PATH.test(stateDir)) throw new Error("unsafe path");
  return `#!/bin/bash
# Flagship: the Rust ingress in place of flagship-tlsd (installed by the daemon; rustStack/ingress.ts).
set -u
cmd="\${1:-}"; shift || true
run='${runDir}'
state='${stateDir}'
bin='${releasePath}/${RUST_BIN_DIR_REL}/flagship-ingress'
go='${releasePath}/installer/flagship-tlsd'
pins='${releasePath}/${RUST_PINS_REL}'
max=3
stable=120
now=$(date +%s)
case "$cmd" in
pre)
    mkdir -p "$run" && chmod 0755 "$run"
    want=$(jq -r '.binaries["flagship-ingress"] // empty' "$pins" 2>/dev/null || true)
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || want=""
    crashes=$(cat "$run/ingress.crashes" 2>/dev/null || echo 0)
    [[ "$crashes" =~ ^[0-9]+$ ]] || crashes=$max
    choice=rust; reason=pinned; have=""
    if [ ! -x "$bin" ]; then choice=ts; reason=no-binary
    elif [ -z "$want" ]; then choice=ts; reason=unpinned
    else
        have=$(sha256sum "$bin" | cut -d' ' -f1)
        if [ "$want" != "$have" ]; then choice=ts; reason=hash-mismatch
        elif [ "$crashes" -ge "$max" ]; then choice=ts; reason=failed-to-start
        fi
    fi
    # The proxy's arguments outlive a reboot in the state directory; the tlsd user reads this copy.
    cp "$state/ingress.args" "$run/ingress.args" 2>/dev/null || choice=ts reason=no-arguments
    echo "$choice" > "$run/ingress.choice"
    echo "$now" > "$run/ingress.started"
    jq -cn --arg ch "$choice" --arg r "$reason" --arg s "$have" --argjson at "$now" '{component:"ingress",choice:$ch,reason:$r,sha256:$s,at:$at}' > "$run/ingress.status"
    chmod 0644 "$run/ingress.choice" "$run/ingress.started" "$run/ingress.status" "$run/ingress.args" 2>/dev/null || true
    echo "[rust-path] ingress: $choice ($reason)"
    ;;
run)
    if [ "$(cat "$run/ingress.choice" 2>/dev/null)" = rust ] && [ -r "$run/ingress.args" ]; then
        read -r -a extra < "$run/ingress.args"
        exec "$bin" "$@" "\${extra[@]}"
    fi
    exec "$go" "$@"
    ;;
stopped)
    [ "$(cat "$run/ingress.choice" 2>/dev/null)" = rust ] || exit 0
    [ "\${SERVICE_RESULT:-success}" = success ] && exit 0
    started=$(cat "$run/ingress.started" 2>/dev/null || echo 0)
    [[ "$started" =~ ^[0-9]+$ ]] || started=0
    crashes=$(cat "$run/ingress.crashes" 2>/dev/null || echo 0)
    [[ "$crashes" =~ ^[0-9]+$ ]] || crashes=0
    if [ $((now - started)) -gt "$stable" ]; then crashes=0; fi
    echo $((crashes + 1)) > "$run/ingress.crashes"
    echo "[rust-path] ingress stopped (\${SERVICE_RESULT:-?}); failed runs: $((crashes + 1))"
    ;;
*)
    echo "usage: flagship-ingress-exec pre|run|stopped [args]" >&2; exit 2 ;;
esac
exit 0
`;
}

/** The proxy's own arguments: the decision socket and the app networks it may dial. */
export function ingressArgs(allow: readonly string[]): string {
  const nets = allow.filter(isAppNetwork);
  if (nets.length === 0) throw new Error("no app network for the Rust proxy");
  return `--proxy-decide ${DECIDE_SOCKET} --proxy-allow ${nets.join(",")}\n`;
}

export function tlsdRustDropIn(allow: readonly string[]): string {
  const nets = allow.filter(isAppNetwork);
  if (nets.length === 0) throw new Error("no app network for the Rust proxy");
  return `# Written by the Flagship daemon (rustStack/ingress.ts): the Rust ingress and its app proxy,
# flagship-tlsd as the fallback. The tlsd unit's user and sandbox stay; the proxy may also dial
# the app networks.
[Service]
ExecStartPre=+${INGRESS_EXEC_PATH} pre
ExecStart=
ExecStart=${INGRESS_EXEC_PATH} run --listen 127.0.0.1:${TLSD_PORT} --keyd ${KEYD_SOCKET} --upstream ${TLS_UPSTREAM_SOCKET}
ExecStopPost=+${INGRESS_EXEC_PATH} stopped
${nets.map((n) => `IPAddressAllow=${n}`).join("\n")}
`;
}

export interface IngressDeps {
  repoPath: string;
  config: ArchV2Config;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  ownership?: () => RustOwnership;
  fileExists?: (path: string) => boolean;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  runDir?: string;
  stateDir?: string;
  onLog?: (m: string) => void;
}

export type IngressOutcome = "on" | "off" | "unchanged" | "failed";

/** Put the Rust ingress in or take it out to match the owner's proxy setting. Never throws. */
export async function syncRustIngress(d: IngressDeps): Promise<IngressOutcome> {
  const exists = d.fileExists ?? existsSync;
  const read = d.read ?? (async (p: string) => await readFile(p, "utf8").catch(() => null));
  const write =
    d.write ??
    (async (p: string, c: string, mode: number) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFileDurable(p, c, mode);
    });
  const remove = d.remove ?? (async (p: string) => await rm(p, { force: true }));
  const log = d.onLog ?? (() => {});
  try {
    const own = (d.ownership ?? loadOwnership)();
    const tlsdThere = exists("/etc/systemd/system/flagship-tlsd.service");
    const want = tlsdThere && d.config.rust === "on" && own.proxy === "rust" && own.proxyAllow.some(isAppNetwork);
    if (!want) {
      if ((await read(TLSD_RUST_DROPIN_PATH)) === null) return "unchanged";
      await remove(TLSD_RUST_DROPIN_PATH);
      await d.run("systemctl", ["daemon-reload"]);
      await d.run("systemctl", ["restart", "--no-block", "flagship-tlsd.service"]);
      log("[rust-path] app traffic back on the TS proxy behind flagship-tlsd");
      return "off";
    }
    const runDir = d.runDir ?? RUST_RUN_DIR;
    const stateDir = d.stateDir ?? RUST_STATE_DIR;
    const files: Array<[string, string, number]> = [
      [INGRESS_EXEC_PATH, ingressExecScript(d.repoPath, runDir, stateDir), 0o755],
      [join(stateDir, "ingress.args"), ingressArgs(own.proxyAllow), 0o600],
      [TLSD_RUST_DROPIN_PATH, tlsdRustDropIn(own.proxyAllow), 0o644],
    ];
    let changed = false;
    for (const [p, c, m] of files) {
      if ((await read(p)) !== c) {
        await write(p, c, m);
        changed = true;
      }
    }
    if (!changed) return "unchanged";
    await d.run("systemctl", ["daemon-reload"]);
    await d.run("systemctl", ["restart", "--no-block", "flagship-tlsd.service"]);
    log("[rust-path] app traffic on the Rust ingress's proxy (flagship-tlsd as its fallback)");
    return "on";
  } catch (e) {
    log(`[rust-path] the Rust ingress could not be set up: ${(e as Error).message}`);
    return "failed";
  }
}
