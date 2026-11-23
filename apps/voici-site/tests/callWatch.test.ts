// Fail safe (owner rule: a calls failure never breaks messages or the page): the ring watch survives a failed
// thread fetch and keeps polling.
import { describe, expect, it, vi } from "vitest";

// messages.js reads the built qrEncoder.js; the ring watch needs none of it.
vi.mock("../src/messages.js", () => ({ openMessages: () => {}, visitorName: () => "" }));
import { callBackPoints, stopWatchingRings, watchRings } from "../src/call.js";

describe("watchRings", () => {
  it("keeps polling after a fetch throws", async () => {
    const timers: Array<() => void> = [];
    let fetches = 0;
    const ctx = {
      doc: { visibilityState: "visible" },
      win: { setTimeout: (f: () => void) => timers.push(f) },
      cfg: { apiBase: "https://flagshipserver.invalid" },
      lib: {
        fetchThread: async () => {
          fetches++;
          throw new Error("network down");
        },
        ringOf: () => null,
      },
    };
    watchRings(ctx as never, { pageId: "ab".repeat(16) } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(1);
    expect(timers).toHaveLength(1);
    timers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(2);
    expect(timers).toHaveLength(2);
    stopWatchingRings();
  });
});

// The call-back pop-up's explainer (owner wording 2026-11-23, adapted: a browser's call-back note names no account).
describe("callBackPoints", () => {
  it("names the page and this visitor's name, and explains anonymous calls only where they are offered", () => {
    const p = callBackPoints("brisk-quartz", "Visitor 4F3A", "anyone");
    expect(p).toHaveLength(4);
    expect(p[0]).toBe("brisk-quartz sees only your visitor name, Visitor 4F3A (or a nickname they gave you), never your account.");
    expect(p[1]).toContain("doesn't name your Flagship account");
    expect(p[2]).toBe("The note is deleted when you tap “Stop call-backs”, when brisk-quartz blocks you or removes the page, or 90 days after you last called them with call-back on.");
    expect(p[3]).toBe("Call anonymously leaves no note, and brisk-quartz can't call you back.");
    expect(p.join(" ")).not.toContain("voi.ci/");
  });

  it("says a visitor name when this browser isn't signed in, and drops the anonymous line on a callback-only page", () => {
    const p = callBackPoints("brisk-quartz", null, "callback");
    expect(p).toHaveLength(3);
    expect(p[0]).toBe("brisk-quartz sees only a visitor name (or a nickname they gave you), never your account.");
  });
});
