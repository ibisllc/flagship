import { describe, expect, it } from "vitest";
import { buildRestartCoordinator } from "../src/restartCoordinator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("restart coordinator", () => {
  it("restarts at once when nothing is in flight", () => {
    let exits = 0;
    const c = buildRestartCoordinator({ exit: () => exits++ });
    c.request("CGK provisioned");
    expect(exits).toBe(1);
  });

  it("waits for an in-flight consume-once claim to persist before restarting", async () => {
    // The hosted-box failure: the CGK consumer asked to restart 19 ms after the
    // entitlement deposit was read but before it was written to disk.
    const events: string[] = [];
    const c = buildRestartCoordinator({ exit: () => events.push("exit") });
    const persisted = deferred();
    const claim = c.guard(async () => {
      events.push("deposit consumed");
      await persisted.promise;
      events.push("entitlement persisted");
    });
    c.request("CGK provisioned");
    expect(events).toEqual(["deposit consumed"]);
    persisted.resolve();
    await claim;
    expect(events).toEqual(["deposit consumed", "entitlement persisted", "exit"]);
  });

  it("coalesces several requests and overlapping claims into one restart", async () => {
    let exits = 0;
    const c = buildRestartCoordinator({ exit: () => exits++ });
    const a = deferred();
    const b = deferred();
    const first = c.guard(() => a.promise);
    const second = c.guard(() => b.promise);
    c.request("SWK provisioned");
    c.request("CGK provisioned");
    a.resolve();
    await first;
    expect(exits).toBe(0);
    b.resolve();
    await second;
    expect(exits).toBe(1);
    c.request("again");
    expect(exits).toBe(1);
  });

  it("still restarts when a guarded claim throws", async () => {
    let exits = 0;
    const c = buildRestartCoordinator({ exit: () => exits++ });
    c.request("x");
    expect(exits).toBe(1);
    const c2 = buildRestartCoordinator({ exit: () => exits++ });
    const failing = c2.guard(async () => {
      c2.request("CGK provisioned");
      throw new Error("network");
    });
    await expect(failing).rejects.toThrow("network");
    expect(exits).toBe(2);
  });
});
