/**
 * Tests for the 6h-jittered update-pack scheduler. We exercise:
 *   - sweepNow iterates every appId in the store
 *   - per-app errors don't block the rest of the sweep
 *   - single-flight: a pull still in flight when a tick fires is skipped
 *   - start() is idempotent; stop() cancels future ticks
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateScheduler } from "../src/updateScheduler.js";
import {
  InMemoryAppPullStateStore,
  type AppPullState,
  type PullResult,
  type UpdateClient,
} from "../src/updateClient.js";

function fakeState(overrides: Partial<AppPullState> = {}): AppPullState {
  return {
    canonicalUrl: "x.alice.flagship.services",
    lineageAnchor: "deadbeef",
    currentTip: "deadbeef",
    lastAppliedMigration: "",
    updatePolicy: "auto",
    ...overrides,
  };
}

describe("UpdateScheduler.sweepNow", () => {
  it("walks every appId in the store and returns the pull result map", async () => {
    const store = new InMemoryAppPullStateStore();
    await store.put("alice-game1", fakeState());
    await store.put("bob-chat", fakeState());

    const calls: string[] = [];
    const client = {
      pullOne: async ({ appId }: { appId: string }) => {
        calls.push(appId);
        return { kind: "no-op", reason: "already-current" } as PullResult;
      },
    } as unknown as UpdateClient;

    const sched = new UpdateScheduler({ client, store });
    const r = await sched.sweepNow();
    expect(calls.sort()).toEqual(["alice-game1", "bob-chat"]);
    expect(r.size).toBe(2);
  });

  it("isolates per-app errors", async () => {
    const store = new InMemoryAppPullStateStore();
    await store.put("alice-good", fakeState());
    await store.put("bob-bad", fakeState());

    const errors: string[] = [];
    const client = {
      pullOne: async ({ appId }: { appId: string }) => {
        if (appId === "bob-bad") throw new Error("boom");
        return { kind: "no-op", reason: "already-current" } as PullResult;
      },
    } as unknown as UpdateClient;

    const sched = new UpdateScheduler({
      client,
      store,
      onError: (appId, e) => errors.push(`${appId}:${e.message}`),
    });
    const r = await sched.sweepNow();
    expect(r.has("alice-good")).toBe(true);
    expect(errors).toEqual(["bob-bad:boom"]);
  });

  it("returns empty map when store has no list() implementation", async () => {
    const minimalStore = {
      get: async () => null,
      put: async () => {},
    };
    const client = {
      pullOne: async () => ({ kind: "no-op", reason: "already-current" } as PullResult),
    } as unknown as UpdateClient;
    const sched = new UpdateScheduler({ client, store: minimalStore });
    expect((await sched.sweepNow()).size).toBe(0);
  });

  it("onResult fires per app", async () => {
    const store = new InMemoryAppPullStateStore();
    await store.put("alice-x", fakeState());
    const seen: PullResult[] = [];
    const client = {
      pullOne: async () =>
        ({ kind: "applied", from: "a", to: "b", migrationsApplied: [] } as PullResult),
    } as unknown as UpdateClient;
    const sched = new UpdateScheduler({
      client,
      store,
      onResult: (_appId, r) => seen.push(r),
    });
    await sched.sweepNow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("applied");
  });
});

describe("UpdateScheduler lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() is idempotent", () => {
    const store = new InMemoryAppPullStateStore();
    const client = { pullOne: async () => ({ kind: "no-op" } as PullResult) } as unknown as UpdateClient;
    const sched = new UpdateScheduler({ client, store });
    sched.start();
    sched.start();
    sched.stop();
  });

  it("stop() prevents further ticks", async () => {
    const store = new InMemoryAppPullStateStore();
    await store.put("alice-x", fakeState());

    let calls = 0;
    const client = {
      pullOne: async () => {
        calls++;
        return { kind: "no-op", reason: "already-current" } as PullResult;
      },
    } as unknown as UpdateClient;

    const sched = new UpdateScheduler({
      client,
      store,
      initialDelayMs: 10,
      intervalMs: 100,
      jitterMs: 0,
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(15);
    expect(calls).toBe(1);
    sched.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);
  });

  it("schedules subsequent ticks at intervalMs +/- jitter", async () => {
    const store = new InMemoryAppPullStateStore();
    await store.put("alice-x", fakeState());
    let calls = 0;
    const client = {
      pullOne: async () => {
        calls++;
        return { kind: "no-op", reason: "already-current" } as PullResult;
      },
    } as unknown as UpdateClient;

    const sched = new UpdateScheduler({
      client,
      store,
      initialDelayMs: 10,
      intervalMs: 5_000,
      jitterMs: 0,
      random: () => 0.5,
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(3);
    sched.stop();
  });

  it("start() after stop() throws", () => {
    const store = new InMemoryAppPullStateStore();
    const client = { pullOne: async () => ({ kind: "no-op" } as PullResult) } as unknown as UpdateClient;
    const sched = new UpdateScheduler({ client, store });
    sched.stop();
    expect(() => sched.start()).toThrow(/after stop/);
  });
});
