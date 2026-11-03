/**
 * Reading the update guard's lines in a box's daemon journal (plan G1): who rolled a broken release back.
 *
 * The guard (`/usr/local/sbin/flagship-update-guard.sh`, ExecStartPre of flagship-daemon) hands over to the
 * Rust `/usr/local/sbin/flagship-updater guard` when that binary is installed; the bash below it is only the
 * fallback (packages/server-daemon/src/updateGuard.ts). Both print `[update-guard] …` into the daemon
 * unit's journal, but in different words:
 *
 *   Rust (rust/crates/flagship-updater/src/cli.rs "guard"):
 *     [update-guard] pending update, start <n>
 *     [update-guard] rolled back to <sha>
 *   bash fallback:
 *     [update-guard] <sha> started <n> times without being verified; rolling back to <sha>
 *     [update-guard] update to <sha> was interrupted before it finished; rolling back to <sha>
 *     [update-guard] rolled back to <sha>
 *
 * So the Rust updater did the roll-back when its start counting is there and no bash "rolling back to"
 * line is.
 */
const PREFIX = /\[update-guard\]\s*/;
const RUST_COUNT = /\[update-guard\]\s*pending update, start (\d+)/;
const ROLLED = /\[update-guard\]\s*rolled back to ([0-9a-f]{40})/;
const BASH_ROLLING = /\[update-guard\]\s*(?:[0-9a-f]{40} started \d+ times without being verified|update to [0-9a-f]{40} was interrupted before it finished); rolling back to ([0-9a-f]{40})/;
const FAILED = /\[update-guard\]\s*switching back to ([0-9a-f]{40}) failed/;

export interface GuardEvidence {
  /** The highest start count the Rust guard printed (0: it printed none). */
  rustStarts: number;
  /** The release the last "rolled back to" line names, or null. */
  rolledBackTo: string | null;
  /** The bash fallback announced a roll-back itself. */
  bashRolledBack: boolean;
  /** A guard said it could not switch back. */
  switchFailed: boolean;
  /** Every guard line, in order (for the record). */
  lines: string[];
}

export function classifyGuardJournal(journal: readonly string[]): GuardEvidence {
  const ev: GuardEvidence = { rustStarts: 0, rolledBackTo: null, bashRolledBack: false, switchFailed: false, lines: [] };
  for (const line of journal) {
    if (!PREFIX.test(line)) continue;
    ev.lines.push(line);
    const c = RUST_COUNT.exec(line);
    if (c) ev.rustStarts = Math.max(ev.rustStarts, Number(c[1]));
    const r = ROLLED.exec(line);
    if (r) ev.rolledBackTo = r[1]!;
    if (BASH_ROLLING.test(line)) ev.bashRolledBack = true;
    if (FAILED.test(line)) ev.switchFailed = true;
  }
  return ev;
}

export type GuardVerdict =
  | { ok: true; by: "flagship-updater" }
  | { ok: false; why: string };

/** Did the Rust updater (not the bash fallback) roll the box back to `expected`? */
export function rustRolledBack(ev: GuardEvidence, expected: string): GuardVerdict {
  if (ev.switchFailed) return { ok: false, why: "a guard could not switch back" };
  if (!ev.rolledBackTo) return { ok: false, why: ev.lines.length ? "no \"rolled back to\" line" : "no update-guard line in the journal" };
  if (ev.rolledBackTo !== expected) return { ok: false, why: `rolled back to ${ev.rolledBackTo.slice(0, 12)}, not ${expected.slice(0, 12)}` };
  if (ev.bashRolledBack) return { ok: false, why: "the bash fallback rolled it back: the guard did not hand over to flagship-updater" };
  if (ev.rustStarts === 0) return { ok: false, why: "no \"pending update, start N\" line: the Rust guard never counted the starts" };
  return { ok: true, by: "flagship-updater" };
}
