import { describe, expect, it } from "vitest";
import { classifyGuardJournal, rustRolledBack } from "../lib/updateGuard.js";

const PREV = "a".repeat(40);
const BAD = "b".repeat(40);
const ts = (s: string) => `Nov 02 20:01:0${s.length % 10} home flagship-update-guard.sh[812]: ${s}`;

describe("classifyGuardJournal / rustRolledBack", () => {
  it("credits the Rust updater when it counted the starts and rolled back", () => {
    const ev = classifyGuardJournal([
      ts("[update-guard] pending update, start 1"),
      "unrelated daemon line",
      ts("[update-guard] pending update, start 8"),
      ts(`[update-guard] rolled back to ${PREV}`),
    ]);
    expect(ev.rustStarts).toBe(8);
    expect(ev.rolledBackTo).toBe(PREV);
    expect(rustRolledBack(ev, PREV)).toEqual({ ok: true, by: "flagship-updater" });
  });

  it("refuses the bash fallback's roll-back", () => {
    const ev = classifyGuardJournal([
      ts(`[update-guard] ${BAD} started 8 times without being verified; rolling back to ${PREV}`),
      ts(`[update-guard] rolled back to ${PREV}`),
    ]);
    expect(ev.bashRolledBack).toBe(true);
    const v = rustRolledBack(ev, PREV);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/bash fallback/);
  });

  it("refuses an interrupted-apply roll-back by bash too", () => {
    const ev = classifyGuardJournal([ts(`[update-guard] update to ${BAD} was interrupted before it finished; rolling back to ${PREV}`)]);
    expect(ev.bashRolledBack).toBe(true);
    expect(ev.rolledBackTo).toBeNull();
  });

  it("names a roll-back to the wrong release, a failed switch, and silence", () => {
    expect(rustRolledBack(classifyGuardJournal([ts("[update-guard] pending update, start 3"), ts(`[update-guard] rolled back to ${BAD}`)]), PREV)).toMatchObject({ ok: false });
    expect(rustRolledBack(classifyGuardJournal([ts(`[update-guard] switching back to ${PREV} failed (io); leaving it to the daemon`)]), PREV)).toMatchObject({ ok: false, why: "a guard could not switch back" });
    expect(rustRolledBack(classifyGuardJournal(["nothing here"]), PREV)).toMatchObject({ ok: false, why: "no update-guard line in the journal" });
  });

  it("wants the Rust start counting even when only a roll-back line is there", () => {
    const v = rustRolledBack(classifyGuardJournal([ts(`[update-guard] rolled back to ${PREV}`)]), PREV);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/never counted/);
  });
});
