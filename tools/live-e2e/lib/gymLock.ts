/**
 * The gym lock for standalone lanes (tools/live-e2e/lanes/*): the same file scripts/gym-release-run.sh,
 * release.sh and the UX session take, so a lane never runs beside a gym run (they share the gym Worker,
 * its release index, the UpCloud core quota and the flagship.services zone). Created with O_EXCL, like
 * the script's noclobber. A lane started BY gym-release-run.sh (which already holds the lock) passes
 * GYM_LOCK_HELD=1 and takes nothing.
 *
 *   FLAGSHIP_GYM_LOCK  overrides the path (default /private/tmp/claude-501/flagship-locks/gym.lock)
 */
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export const GYM_LOCK_PATH = process.env.FLAGSHIP_GYM_LOCK || "/private/tmp/claude-501/flagship-locks/gym.lock";

/** The one line the lock file holds (who, since when, which process): the format gym-release-run.sh writes. */
export function lockLine(holder: string, now: Date, pid: number): string {
  return `${holder} ${now.toISOString().replace(/\.\d{3}Z$/, "Z")} pid ${pid}\n`;
}

export interface GymLock {
  /** False when the caller already held it (GYM_LOCK_HELD=1): release() then does nothing. */
  readonly owned: boolean;
  release(): void;
}

/**
 * Takes the gym lock or throws with its holder's line. `held` (default: GYM_LOCK_HELD=1) means a parent
 * already holds it for this process tree.
 */
export function takeGymLock(holder: string, opts: { path?: string; held?: boolean } = {}): GymLock {
  const path = opts.path ?? GYM_LOCK_PATH;
  const held = opts.held ?? process.env.GYM_LOCK_HELD === "1";
  if (held) return { owned: false, release: () => undefined };
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let who = "unknown";
    try {
      who = readFileSync(path, "utf8").trim() || who;
    } catch {
      /* gone meanwhile */
    }
    throw new Error(`the gym lock is held (${path}): ${who}. Another gym run or lane is using the gym; never run two at once`);
  }
  writeSync(fd, lockLine(holder, new Date(), process.pid));
  closeSync(fd);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  };
  process.once("exit", release);
  return { owned: true, release };
}
