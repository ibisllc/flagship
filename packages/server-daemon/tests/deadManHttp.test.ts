import { describe, expect, it } from "vitest";
import {
  ed,
  signSetDeadManPolicy,
  signDeadManAffirmation,
  type Keypair,
  type SetDeadManPolicy,
  type DeadManAffirmation,
} from "@flagship/protocol";
import { DeadManController, type AutoUnlockSuppressor, type HostPowerRunner } from "../src/deadMan.js";
import { buildDeadManHttp } from "../src/deadManHttp.js";

const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const noopSuppressor: AutoUnlockSuppressor = { suppress: async () => {} };
const noopRunner: HostPowerRunner = { power: async () => {} };

function mkController(irkPub: Uint8Array, now: () => number) {
  return new DeadManController({
    serverId: SERVER,
    irkPub,
    suppressor: noopSuppressor,
    runner: noopRunner,
    statePath: `/tmp/flagship-deadman-http-${Math.random().toString(36).slice(2)}.json`,
    now,
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => {},
  });
}

function req(path: string, body: unknown) {
  return {
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

describe("buildDeadManHttp", () => {
  const IRK = makeKey(60);
  const now = 5_000_000;

  it("returns null for unrelated paths", async () => {
    const ctl = mkController(IRK.publicKey, () => now);
    const handle = buildDeadManHttp(ctl);
    expect(await handle(req("/api/something-else", {}))).toBeNull();
  });

  it("accepts a valid signed policy and then a valid affirmation", async () => {
    const ctl = mkController(IRK.publicKey, () => now);
    await ctl.start();
    const handle = buildDeadManHttp(ctl);

    const policy: SetDeadManPolicy = {
      serverId: SERVER,
      enabled: true,
      windowMs: 1000,
      graceMs: 0,
      lockoutMode: "off",
      issuedAt: now,
    };
    const pres = await handle(
      req("/api/deadman/policy", {
        request: { ...policy },
        signature: bytesToHex(signSetDeadManPolicy(policy, IRK)),
      }),
    );
    expect(pres!.status).toBe(200);
    expect(ctl.policy().enabled).toBe(true);

    const affirm: DeadManAffirmation = {
      serverId: SERVER,
      nonce: new Uint8Array(16).fill(1),
      issuedAt: now,
    };
    const ares = await handle(
      req("/api/deadman/affirm", {
        request: { serverId: SERVER, nonce: bytesToHex(affirm.nonce), issuedAt: now },
        signature: bytesToHex(signDeadManAffirmation(affirm, IRK)),
      }),
    );
    expect(ares!.status).toBe(200);
    expect(ctl.leaseExpiry()).toBe(now + 1000);
  });

  it("rejects a wrong-key policy with 403", async () => {
    const ctl = mkController(IRK.publicKey, () => now);
    await ctl.start();
    const handle = buildDeadManHttp(ctl);
    const attacker = makeKey(61);
    const policy: SetDeadManPolicy = {
      serverId: SERVER,
      enabled: true,
      windowMs: 1000,
      graceMs: 0,
      lockoutMode: "off",
      issuedAt: now,
    };
    const res = await handle(
      req("/api/deadman/policy", {
        request: { ...policy },
        signature: bytesToHex(signSetDeadManPolicy(policy, attacker)),
      }),
    );
    expect(res!.status).toBe(403);
    expect(ctl.policy().enabled).toBe(false);
  });

  it("rejects malformed bodies with 400", async () => {
    const ctl = mkController(IRK.publicKey, () => now);
    const handle = buildDeadManHttp(ctl);
    const res = await handle(req("/api/deadman/policy", { nope: true }));
    expect(res!.status).toBe(400);
  });
});
