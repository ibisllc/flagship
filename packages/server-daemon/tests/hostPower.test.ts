import { afterEach, describe, expect, it, vi } from "vitest";
import { ed, signPhoneOrder, type Keypair, type PhoneOrder } from "@flagship/protocol";
import {
  executeLockAndPower,
  BootUnlockModeSuppressor,
  type AutoUnlockSuppressor,
  type BootSuspender,
  type HostPowerRunner,
} from "../src/hostPower.js";
import { buildOrdersHandler } from "../src/orders.js";
import { readFile, mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

/** Records the ORDER of operations so suppress-before-power is testable. */
function recorder() {
  const events: string[] = [];
  const suppressor: AutoUnlockSuppressor = {
    suppress: async () => {
      events.push("suppress");
    },
  };
  const runner: HostPowerRunner = {
    power: async (mode) => {
      events.push(`power:${mode}`);
    },
  };
  return { events, suppressor, runner };
}


describe("executeLockAndPower", () => {
  it("suppresses BEFORE the host power action", async () => {
    const { events, suppressor, runner } = recorder();
    await executeLockAndPower({ mode: "off", suppressor, runner });
    expect(events).toEqual(["suppress", "power:off"]);
  });

  it("honors restart mode once the lock is confirmed", async () => {
    const { events, suppressor, runner } = recorder();
    const suspender = confirming(events);
    const r = await executeLockAndPower({ mode: "restart", suppressor, runner, suspender, reason: "manual-lock" });
    expect(events).toEqual(["suppress", "suspend:manual-lock", "power:restart"]);
    expect(r).toEqual({ mode: "restart", requestedMode: "restart", suspension: "confirmed" });
  });

  it("turns a restart into a shutdown when the lock cannot be confirmed (SEC-LOCK-001)", async () => {
    const { events, suppressor, runner } = recorder();
    const r = await executeLockAndPower({ mode: "restart", suppressor, runner, suspender: failing(events), reason: "manual-lock" });
    expect(events).toEqual(["suppress", "suspend:manual-lock", "power:off"]);
    expect(r).toEqual({ mode: "off", requestedMode: "restart", suspension: "unconfirmed" });
  });

  it("shuts down instead of restarting when the lock marker cannot be written (an unprivileged daemon cannot write /boot)", async () => {
    const { events, runner } = recorder();
    const suppressor: AutoUnlockSuppressor = {
      suppress: async () => {
        throw new Error("EACCES: permission denied, open '/boot/flagship-lock-once.tmp'");
      },
    };
    const r = await executeLockAndPower({ mode: "restart", suppressor, runner, suspender: confirming(events), reason: "manual-lock" });
    expect(events).toEqual(["suspend:manual-lock", "power:off"]);
    expect(r.mode).toBe("off");
    expect(r.requestedMode).toBe("restart");
  });

  it("never restarts when there is no way to lock the boot worker", async () => {
    const { events, suppressor, runner } = recorder();
    const r = await executeLockAndPower({ mode: "restart", suppressor, runner });
    expect(events).toEqual(["suppress", "power:off"]);
    expect(r.suspension).toBe("unavailable");
  });

  it("locks before it powers off, and gives up waiting on a stuck boot worker within seconds", async () => {
    vi.useFakeTimers();
    const { events, suppressor, runner } = recorder();
    const stuck: BootSuspender = { suspend: () => new Promise(() => {}) };
    const done = executeLockAndPower({ mode: "off", suppressor, runner, suspender: stuck, reason: "dead-man" });
    await vi.advanceTimersByTimeAsync(3_001);
    const r = await done;
    expect(events).toEqual(["suppress", "power:off"]);
    expect(r.suspension).toBe("unconfirmed");
  });

  it("a suspender that throws still lets the box shut down", async () => {
    const { events, suppressor, runner } = recorder();
    const r = await executeLockAndPower({ mode: "off", suppressor, runner, suspender: { suspend: async () => { throw new Error("boom"); } } });
    expect(events).toEqual(["suppress", "power:off"]);
    expect(r.suspension).toBe("unconfirmed");
  });
});

afterEach(() => vi.useRealTimers());

function confirming(events: string[]): BootSuspender {
  return { suspend: async (reason) => (events.push(`suspend:${reason}`), { confirmed: true as const }) };
}
function failing(events: string[]): BootSuspender {
  return { suspend: async (reason) => (events.push(`suspend:${reason}`), { confirmed: false as const, why: "unreachable" }) };
}

describe("power-off no longer rides the PSK orders path", () => {
  function envelope(order: PhoneOrder, psk: Keypair) {
    return {
      request: { ...order },
      signature: bytesToHex(signPhoneOrder(order, psk)),
    };
  }
  function req(body: unknown) {
    return {
      method: "POST",
      path: "/api/orders-from-user",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body)),
    };
  }

  it("buildOrdersHandler does not dispatch a power-off (moved to /api/power)", async () => {
    const psk = makeKey(3);
    const handler = buildOrdersHandler({ serverFqdn: SERVER, pskPub: psk.publicKey, executor: {} });
    const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode: "off", issuedAt: Date.now() };
    const res = await handler(req(envelope(order, psk)));
    expect(res.status).toBe(400);
    expect(JSON.parse(String(res.body)).error).toBe("unknown or malformed order");
  });
});


describe("BootUnlockModeSuppressor — ONE-SHOT lock marker, not a persistent flip", () => {
  it("writes a one-shot marker file and never touches the baseline mode file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flagship-lockonce-"));
    // The box's BASELINE mode file — a manual lock must NOT mutate this.
    const baselinePath = join(dir, "flagship-boot-unlock-mode");
    await writeFile(baselinePath, "auto\n");
    const markerPath = join(dir, "flagship-lock-once");

    const suppressor = new BootUnlockModeSuppressor(markerPath);
    await suppressor.suppress();

    // The one-shot marker exists with the approve-once token.
    expect((await readFile(markerPath, "utf8")).trim()).toBe("approve-once");
    // The baseline mode file is UNTOUCHED — still "auto", so the next boot
    // (after the marker is consumed) reverts to the box's chosen baseline.
    expect((await readFile(baselinePath, "utf8")).trim()).toBe("auto");
  });

  it("is idempotent (re-suppressing leaves a single valid marker)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flagship-lockonce-"));
    const markerPath = join(dir, "flagship-lock-once");
    const suppressor = new BootUnlockModeSuppressor(markerPath);
    await suppressor.suppress();
    await suppressor.suppress();
    expect((await readFile(markerPath, "utf8")).trim()).toBe("approve-once");
    // No leftover temp file beside it.
    await expect(stat(`${markerPath}.tmp`)).rejects.toThrow();
  });
});

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
