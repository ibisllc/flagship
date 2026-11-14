import { describe, expect, it } from "vitest";
import { installHostComponents, type HostComponentSteps } from "../src/hostComponents.js";

function steps(over: Partial<HostComponentSteps> = {}) {
  const calls: string[] = [];
  const s: HostComponentSteps = {
    keydRunning: false,
    keydRequired: false,
    tlsUpstreamSet: false,
    root: true,
    installKeyd: async () => (calls.push("keyd"), "installed"),
    afterKeyd: async (up) => void calls.push(`after:${up}`),
    installTlsd: async () => (calls.push("tlsd"), "installed"),
    installPrivd: async () => (calls.push("privd"), "switched"),
    ...over,
  };
  return { s, calls };
}

describe("a new box's host components", () => {
  it("puts keyd, the TLS frontend and privd in during one start and restarts once (was three restarts)", async () => {
    const { s, calls } = steps();
    const r = await installHostComponents(s);
    expect(calls).toEqual(["keyd", "after:true", "tlsd", "privd"]);
    expect(r.keydUp).toBe(true);
    expect(r.restartFor).toHaveLength(3);
  });

  it("does not restart a box that already has them", async () => {
    const { s, calls } = steps({
      keydRunning: true,
      tlsUpstreamSet: true,
      root: false,
      installKeyd: async () => {
        throw new Error("not called");
      },
    });
    const r = await installHostComponents(s);
    expect(calls).toEqual(["after:true"]);
    expect(r.restartFor).toEqual([]);
  });

  it("without keyd, neither the TLS frontend nor privd goes in", async () => {
    const { s, calls } = steps({ installKeyd: async () => "failed" });
    const r = await installHostComponents(s);
    expect(calls).toEqual(["after:false"]);
    expect(r).toEqual({ keydUp: false, restartFor: [] });
  });

  it("keyd required but missing: nothing is installed (the daemon refuses to start)", async () => {
    const { s, calls } = steps({ keydRequired: true });
    expect((await installHostComponents(s)).keydUp).toBe(false);
    expect(calls).toEqual(["after:false"]);
  });
});
