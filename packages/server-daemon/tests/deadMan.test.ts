import { describe, expect, it } from "vitest";
import {
  ed,
  signSetDeadManPolicy,
  signDeadManAffirmation,
  signPhoneOrder,
  type Keypair,
  type SetDeadManPolicy,
  type DeadManAffirmation,
  type PhoneOrder,
} from "@flagship/protocol";
import {
  DeadManController,
  executeLockAndPower,
  BootUnlockModeSuppressor,
  type AutoUnlockSuppressor,
  type HostPowerRunner,
} from "../src/deadMan.js";
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

/** Hand-driven interval seam: tests fire ticks explicitly. */
function fakeInterval() {
  const cbs: Array<() => void> = [];
  return {
    setIntervalImpl: (cb: () => void) => {
      cbs.push(cb);
      return cbs.length - 1;
    },
    clearIntervalImpl: () => {},
    tick: () => cbs.forEach((c) => c()),
    armed: () => cbs.length > 0,
  };
}

const NONCE_PATH = (n: number) => new Uint8Array(16).fill(n);

describe("executeLockAndPower", () => {
  it("suppresses BEFORE the host power action", async () => {
    const { events, suppressor, runner } = recorder();
    await executeLockAndPower({ mode: "off", suppressor, runner });
    expect(events).toEqual(["suppress", "power:off"]);
  });

  it("honors restart mode", async () => {
    const { events, suppressor, runner } = recorder();
    await executeLockAndPower({ mode: "restart", suppressor, runner });
    expect(events).toEqual(["suppress", "power:restart"]);
  });
});

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

describe("DeadManController", () => {
  const IRK = makeKey(50);

  function policyEnvelope(
    over: Partial<SetDeadManPolicy> = {},
    now = 1_000_000,
  ): { policy: SetDeadManPolicy; sig: Uint8Array } {
    const policy: SetDeadManPolicy = {
      serverId: SERVER,
      enabled: true,
      windowMs: 24 * 3600_000,
      graceMs: 6 * 3600_000,
      lockoutMode: "off",
      issuedAt: now,
      ...over,
    };
    return { policy, sig: signSetDeadManPolicy(policy, IRK) };
  }

  function affirmEnvelope(
    nonce: Uint8Array,
    now: number,
  ): { affirm: DeadManAffirmation; sig: Uint8Array } {
    const affirm: DeadManAffirmation = { serverId: SERVER, nonce, issuedAt: now };
    return { affirm, sig: signDeadManAffirmation(affirm, IRK) };
  }

  function mkController(opts?: { now?: () => number; statePath?: string }) {
    const { events, suppressor, runner } = recorder();
    const intv = fakeInterval();
    const tmp = opts?.statePath ?? `/tmp/flagship-deadman-test-${Math.random().toString(36).slice(2)}.json`;
    const ctl = new DeadManController({
      serverId: SERVER,
      irkPub: IRK.publicKey,
      suppressor,
      runner,
      statePath: tmp,
      now: opts?.now,
      setIntervalImpl: intv.setIntervalImpl,
      clearIntervalImpl: intv.clearIntervalImpl,
    });
    return { ctl, events, intv };
  }

  it("is OFF by default — no timer, no action", async () => {
    let now = 1_000_000;
    const { ctl, events, intv } = mkController({ now: () => now });
    await ctl.start();
    expect(intv.armed()).toBe(false);
    now += 100 * 24 * 3600_000;
    await ctl.checkOnce();
    expect(events).toEqual([]);
  });

  it("enabling a policy arms the timer and sets a fresh lease", async () => {
    let now = 1_000_000;
    const { ctl, intv } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({}, now);
    expect(await ctl.applyPolicy(policy, sig)).toBe(true);
    expect(intv.armed()).toBe(true);
    expect(ctl.leaseExpiry()).toBe(now + policy.windowMs);
  });

  it("a valid affirmation extends the lease", async () => {
    let now = 1_000_000;
    const { ctl } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 100 }, now);
    await ctl.applyPolicy(policy, sig);
    now += 500;
    const { affirm, sig: asig } = affirmEnvelope(NONCE_PATH(1), now);
    expect(await ctl.affirm(affirm, asig)).toBe(true);
    expect(ctl.leaseExpiry()).toBe(now + 1000);
  });

  it("a replayed affirmation nonce is refused", async () => {
    let now = 1_000_000;
    const { ctl } = mkController({ now: () => now });
    await ctl.start();
    await ctl.applyPolicy(...Object.values(policyEnvelope({}, now)) as [SetDeadManPolicy, Uint8Array]);
    const { affirm, sig } = affirmEnvelope(NONCE_PATH(7), now);
    expect(await ctl.affirm(affirm, sig)).toBe(true);
    // Same nonce again (even with a fresh signature object) is refused.
    expect(await ctl.affirm(affirm, sig)).toBe(false);
  });

  it("a stale affirmation is refused", async () => {
    let now = 1_000_000;
    const { ctl } = mkController({ now: () => now });
    await ctl.start();
    await ctl.applyPolicy(...Object.values(policyEnvelope({}, now)) as [SetDeadManPolicy, Uint8Array]);
    const stale = affirmEnvelope(NONCE_PATH(2), now - 10 * 60_000);
    expect(await ctl.affirm(stale.affirm, stale.sig)).toBe(false);
  });

  it("a wrong-key affirmation fails", async () => {
    let now = 1_000_000;
    const { ctl } = mkController({ now: () => now });
    await ctl.start();
    await ctl.applyPolicy(...Object.values(policyEnvelope({}, now)) as [SetDeadManPolicy, Uint8Array]);
    const attacker = makeKey(99);
    const affirm: DeadManAffirmation = { serverId: SERVER, nonce: NONCE_PATH(3), issuedAt: now };
    const badSig = signDeadManAffirmation(affirm, attacker);
    expect(await ctl.affirm(affirm, badSig)).toBe(false);
  });

  it("a wrong-key policy is rejected", async () => {
    let now = 1_000_000;
    const { ctl, intv } = mkController({ now: () => now });
    await ctl.start();
    const attacker = makeKey(98);
    const policy: SetDeadManPolicy = {
      serverId: SERVER,
      enabled: true,
      windowMs: 1000,
      graceMs: 0,
      lockoutMode: "off",
      issuedAt: now,
    };
    const badSig = signSetDeadManPolicy(policy, attacker);
    expect(await ctl.applyPolicy(policy, badSig)).toBe(false);
    expect(intv.armed()).toBe(false);
  });

  it("lease not expired ⇒ no action", async () => {
    let now = 1_000_000;
    const { ctl, events } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 100 }, now);
    await ctl.applyPolicy(policy, sig);
    now += 900; // still inside window+grace
    await ctl.checkOnce();
    expect(events).toEqual([]);
  });

  it("expired past grace ⇒ SUPPRESS before POWER (order asserted), mode off", async () => {
    let now = 1_000_000;
    const { ctl, events } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 100, lockoutMode: "off" }, now);
    await ctl.applyPolicy(policy, sig);
    now += 1101; // past windowMs(1000)+graceMs(100)
    await ctl.checkOnce();
    expect(events).toEqual(["suppress", "power:off"]);
  });

  it("expired past grace honors restart mode", async () => {
    let now = 1_000_000;
    const { ctl, events } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 0, lockoutMode: "restart" }, now);
    await ctl.applyPolicy(policy, sig);
    now += 1001;
    await ctl.checkOnce();
    expect(events).toEqual(["suppress", "power:restart"]);
  });

  it("does not re-fire while/after powering off", async () => {
    let now = 1_000_000;
    const { ctl, events } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 0 }, now);
    await ctl.applyPolicy(policy, sig);
    now += 2000;
    await ctl.checkOnce();
    await ctl.checkOnce();
    await ctl.checkOnce();
    expect(events).toEqual(["suppress", "power:off"]);
  });

  it("the timer tick drives enforcement", async () => {
    let now = 1_000_000;
    const { ctl, events, intv } = mkController({ now: () => now });
    await ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 0 }, now);
    await ctl.applyPolicy(policy, sig);
    intv.tick(); // inside window
    await Promise.resolve();
    expect(events).toEqual([]);
    now += 1001;
    intv.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["suppress", "power:off"]);
  });

  it("disabling the policy stops enforcement", async () => {
    let now = 1_000_000;
    const { ctl, events, intv } = mkController({ now: () => now });
    await ctl.start();
    await ctl.applyPolicy(...(Object.values(policyEnvelope({ windowMs: 1000, graceMs: 0 }, now)) as [SetDeadManPolicy, Uint8Array]));
    const off = policyEnvelope({ enabled: false }, now);
    expect(await ctl.applyPolicy(off.policy, off.sig)).toBe(true);
    expect(ctl.policy().enabled).toBe(false);
    now += 100 * 3600_000;
    // Neither a direct check nor a stray timer tick does anything once disabled.
    await ctl.checkOnce();
    intv.tick();
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  it("a disabled policy refuses affirmations", async () => {
    let now = 1_000_000;
    const { ctl } = mkController({ now: () => now });
    await ctl.start();
    const { affirm, sig } = affirmEnvelope(NONCE_PATH(9), now);
    expect(await ctl.affirm(affirm, sig)).toBe(false);
  });

  it("policy + lease persist across a restart (statePath)", async () => {
    let now = 1_000_000;
    const path = `/tmp/flagship-deadman-persist-${Math.random().toString(36).slice(2)}.json`;
    const first = mkControllerAt(path, () => now);
    await first.ctl.start();
    const { policy, sig } = policyEnvelope({ windowMs: 1000, graceMs: 0 }, now);
    await first.ctl.applyPolicy(policy, sig);
    const expiry = first.ctl.leaseExpiry();

    // Fresh controller, same statePath = simulated restart.
    const second = mkControllerAt(path, () => now);
    await second.ctl.start();
    expect(second.ctl.policy().enabled).toBe(true);
    expect(second.ctl.leaseExpiry()).toBe(expiry);
    expect(second.intv.armed()).toBe(true);

    // A nonce used before the restart is still refused after it.
    const { affirm, sig: asig } = affirmEnvelope(NONCE_PATH(4), now);
    expect(await first.ctl.affirm(affirm, asig)).toBe(true);
    const third = mkControllerAt(path, () => now);
    await third.ctl.start();
    expect(await third.ctl.affirm(affirm, asig)).toBe(false);
  });

  function mkControllerAt(statePath: string, nowFn: () => number) {
    const { events, suppressor, runner } = recorder();
    const intv = fakeInterval();
    const ctl = new DeadManController({
      serverId: SERVER,
      irkPub: IRK.publicKey,
      suppressor,
      runner,
      statePath,
      now: nowFn,
      setIntervalImpl: intv.setIntervalImpl,
      clearIntervalImpl: intv.clearIntervalImpl,
    });
    return { ctl, events, intv };
  }
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
