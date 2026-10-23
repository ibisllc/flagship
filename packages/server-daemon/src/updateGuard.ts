import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileDurable } from "./durableFile.js";

/**
 * The update guard: a shell script systemd runs before every daemon start
 * (an ExecStartPre drop-in). It rolls back a staged update in the two cases the
 * daemon's own boot gate (updateHealthGate.ts) cannot reach, because both leave
 * code that may not start at all:
 *
 *   - the apply was interrupted (the box lost power, the VM was stopped, or the
 *     daemon died mid `npm ci`), so the marker still says `applying` and the
 *     tree is half checked out with half a node_modules;
 *   - the new code crashes before the gate runs, so the gate never counts a
 *     boot and the box would crash-loop on it forever.
 *
 * It needs only bash, git, jq and npm, never the checkout's node_modules. It
 * always exits 0 so a guard problem can never keep the daemon from starting.
 * The daemon installs (and refreshes) it at startup, like the health reporter.
 */
export const UPDATE_GUARD_SCRIPT_PATH = "/usr/local/sbin/flagship-update-guard.sh";
export const UPDATE_GUARD_DROPIN_PATH =
  "/etc/systemd/system/flagship-daemon.service.d/10-update-guard.conf";

/**
 * Starts a staged update may take before the guard rolls it back. Above the
 * gate's own budget (3 boots, then a 4th that rolls back) plus room for the
 * daemon's deliberate exit-0 restarts, so the gate keeps handling a release
 * that starts but never turns healthy.
 */
export const DEFAULT_GUARD_MAX_STARTS = 8;

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export function buildUpdateGuardScript(args: {
  repoPath: string;
  dataDir: string;
  maxStarts?: number;
}): string {
  if (!SAFE_PATH.test(args.repoPath)) throw new Error("unsafe repo path");
  if (!SAFE_PATH.test(args.dataDir)) throw new Error("unsafe data dir");
  const max = args.maxStarts ?? DEFAULT_GUARD_MAX_STARTS;
  if (!Number.isInteger(max) || max < 1) throw new Error("invalid maxStarts");
  return `#!/bin/bash
# Flagship update guard (installed by the daemon; see updateGuard.ts).
set -u
repo='${args.repoPath}'
marker='${args.dataDir}/update-pending.json'
starts_file='${args.dataDir}/update-guard-starts'
outcome='${args.dataDir}/update-outcome.json'
log() { echo "[update-guard] $*"; }

[ -f "$marker" ] || { rm -f "$starts_file"; exit 0; }
sha='^[0-9a-f]{40}$'
prev=$(jq -r '.previousCommit // empty' "$marker" 2>/dev/null)
target=$(jq -r '.targetCommit // empty' "$marker" 2>/dev/null)
stage=$(jq -r '.stage // "staged"' "$marker" 2>/dev/null)
attempts=$(jq -r '.bootAttempts // 0' "$marker" 2>/dev/null)
if ! [[ "$prev" =~ $sha && "$target" =~ $sha && "$attempts" =~ ^[0-9]+$ ]]; then
  # A marker that exists but can't be read was cut short by a power loss
  # mid-update (older daemons didn't fsync it). Fall back to the last commit
  # this box verified healthy.
  case "$(jq -r '.outcome // empty' "$outcome" 2>/dev/null)" in
    applied) prev=$(jq -r '.targetCommit // empty' "$outcome" 2>/dev/null) ;;
    rolled-back) prev=$(jq -r '.previousCommit // empty' "$outcome" 2>/dev/null) ;;
    *) prev= ;;
  esac
  if ! [[ "$prev" =~ $sha ]]; then
    log "unreadable marker and no known-good commit; leaving it to the daemon"
    exit 0
  fi
  target=$(git -C "$repo" rev-parse HEAD 2>/dev/null)
  [[ "$target" =~ $sha ]] || target=$prev
  stage=applying
  attempts=0
  log "unreadable marker; treating the update as interrupted"
fi
# Counted per target, so a count left by an earlier update never carries over.
read -r counted starts < "$starts_file" 2>/dev/null
[[ "\${counted:-}" = "$target" && "\${starts:-}" =~ ^[0-9]+$ ]] || starts=0
starts=$((starts + 1))
echo "$target $starts" > "$starts_file"

if [ "$stage" = "applying" ]; then
  log "update to $target was interrupted before it finished; rolling back to $prev"
elif [ "$starts" -gt ${max} ]; then
  log "$target started $((starts - 1)) times without being verified; rolling back to $prev"
else
  exit 0
fi

# Nothing else touches the checkout before the daemon starts, so a lock left
# by a git killed mid-checkout is stale. A power cut can also leave 0-byte
# files the index still calls clean: dropping the index makes reset rewrite
# every tracked file (same as restoreCheckout in updateConsumer.ts).
rm -f "$repo/.git/index.lock" "$repo/.git/index"
if ! git -C "$repo" reset -q --hard "$prev"; then
  log "reset to $prev failed; leaving it to the daemon"
  exit 0
fi
git -C "$repo" clean -fdq -- packages
cd "$repo" || exit 0
scope=(--include-workspace-root --workspace=packages/server-daemon)
# No npm install fallback: an exact lock that will not install is retried, never re-resolved.
npm ci --no-audit --no-fund "\${scope[@]}" || { log "npm ci failed; will retry next start"; exit 0; }
npx tsc -b packages/server-daemon || { log "rebuild failed; will retry next start"; exit 0; }
# Flush the restored tree before the marker that would retry it goes away.
sync
rm -f "$marker" "$starts_file"
printf '{"outcome":"rolled-back","at":%s,"previousCommit":"%s","targetCommit":"%s","bootAttempts":%s}' \\
  "$(( $(date +%s) * 1000 ))" "$prev" "$target" "$attempts" > "$outcome.tmp" && mv "$outcome.tmp" "$outcome"
sync
log "rolled back to $prev"
exit 0
`;
}

/**
 * The leading "-" makes systemd start the daemon even if the guard itself
 * fails. A rollback rebuild can take minutes, so the start timeout is raised
 * from systemd's 90 s default.
 */
export const UPDATE_GUARD_DROPIN = `[Service]
ExecStartPre=-${UPDATE_GUARD_SCRIPT_PATH}
TimeoutStartSec=45min
`;

export interface UpdateGuardInstallOptions {
  repoPath: string;
  dataDir: string;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  /** Only real boxes (systemd present) get the guard. */
  hasSystemd?: () => boolean;
  onLog?: (m: string) => void;
}

/** Write the guard + drop-in when they differ; they apply from the next start. */
export async function installUpdateGuard(opts: UpdateGuardInstallOptions): Promise<boolean> {
  const hasSystemd = opts.hasSystemd ?? (() => existsSync("/run/systemd/system"));
  if (!hasSystemd()) return false;
  const read = opts.read ?? (async (p) => (await readFile(p, "utf8").catch(() => null)));
  const write =
    opts.write ??
    (async (p, c, mode) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFileDurable(p, c, mode);
    });
  const files: Array<[string, string, number]> = [
    [UPDATE_GUARD_SCRIPT_PATH, buildUpdateGuardScript(opts), 0o700],
    [UPDATE_GUARD_DROPIN_PATH, UPDATE_GUARD_DROPIN, 0o644],
  ];
  let changed = false;
  for (const [path, content, mode] of files) {
    if ((await read(path)) !== content) {
      await write(path, content, mode);
      changed = true;
    }
  }
  if (changed) {
    await opts.run("systemctl", ["daemon-reload"]);
    opts.onLog?.("[self-update] update guard installed");
  }
  return changed;
}
