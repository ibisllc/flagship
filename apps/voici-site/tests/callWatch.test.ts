// Fail safe (owner rule: a calls failure never breaks messages or the page): the ring watch survives a failed
// thread fetch and keeps polling.
import { describe, expect, it, vi } from "vitest";

// messages.js reads the built qrEncoder.js; the ring watch needs none of it.
vi.mock("../src/messages.js", () => ({ openMessages: () => {} }));
import { stopWatchingRings, watchRings } from "../src/call.js";

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
