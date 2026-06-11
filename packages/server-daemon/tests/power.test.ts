import { describe, expect, it } from "vitest";
import { ed, signPhoneOrder, type Keypair, type PhoneOrder } from "@flagship/protocol";
import type { AutoUnlockSuppressor, HostPowerRunner } from "../src/deadMan.js";
import { buildPowerHttp } from "../src/deadManHttp.js";

const SERVER = "home.alice.flagship.services";
const NOW = 5_000_000;

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function req(body: unknown) {
  return {
    method: "POST",
    path: "/api/power",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

/** Records the order of suppress() vs power() so we can assert ordering. */
function recordingFakes() {
  const trace: string[] = [];
  const suppressor: AutoUnlockSuppressor = {
    suppress: async () => void trace.push("suppress"),
  };
  const runner: HostPowerRunner = {
    power: async (mode) => void trace.push(`power:${mode}`),
  };
  return { trace, suppressor, runner };
}

const IRK = makeKey(70);

function mkHandler(fakes: { suppressor: AutoUnlockSuppressor; runner: HostPowerRunner }) {
  return buildPowerHttp({
    serverId: SERVER,
    ownerIrkPub: IRK.publicKey,
    suppressor: fakes.suppressor,
    runner: fakes.runner,
    now: () => NOW,
  });
}

function powerOrder(mode: "off" | "restart"): PhoneOrder {
  return { type: "power-off", serverId: SERVER, mode, issuedAt: NOW };
}

describe("buildPowerHttp", () => {
  it("returns null for unrelated paths", async () => {
    const handle = mkHandler(recordingFakes());
    expect(await handle({ ...req({}), path: "/api/other" })).toBeNull();
  });

  for (const mode of ["off", "restart"] as const) {
    it(`accepts a valid IRK-signed power-off {${mode}} and suppresses BEFORE power`, async () => {
      const fakes = recordingFakes();
      const handle = mkHandler(fakes);
      const order = powerOrder(mode);
      const res = await handle(
        req({ request: { ...order }, signature: bytesToHex(signPhoneOrder(order, IRK)) }),
      );
      expect(res!.status).toBe(200);
      expect(JSON.parse(String(res!.body)).mode).toBe(mode);
      expect(fakes.trace).toEqual(["suppress", `power:${mode}`]);
    });
  }

  it("rejects a wrong-key signature with 403 (no power action)", async () => {
    const fakes = recordingFakes();
    const handle = mkHandler(fakes);
    const attacker = makeKey(71);
    const order = powerOrder("off");
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signPhoneOrder(order, attacker)) }),
    );
    expect(res!.status).toBe(403);
    expect(fakes.trace).toEqual([]);
  });

  it("rejects a stale issuedAt with 403 (no power action)", async () => {
    const fakes = recordingFakes();
    const handle = mkHandler(fakes);
    const order: PhoneOrder = {
      type: "power-off",
      serverId: SERVER,
      mode: "off",
      issuedAt: NOW - 10 * 60_000,
    };
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signPhoneOrder(order, IRK)) }),
    );
    expect(res!.status).toBe(403);
    expect(fakes.trace).toEqual([]);
  });

  it("rejects a tampered mode with 403 (signature no longer matches)", async () => {
    const fakes = recordingFakes();
    const handle = mkHandler(fakes);
    const order = powerOrder("off");
    const sig = bytesToHex(signPhoneOrder(order, IRK));
    const res = await handle(req({ request: { ...order, mode: "restart" }, signature: sig }));
    expect(res!.status).toBe(403);
    expect(fakes.trace).toEqual([]);
  });

  it("rejects a serverId mismatch with 403", async () => {
    const fakes = recordingFakes();
    const handle = mkHandler(fakes);
    const order: PhoneOrder = { type: "power-off", serverId: "evil.bob.flagship.services", mode: "off", issuedAt: NOW };
    const res = await handle(
      req({ request: { ...order }, signature: bytesToHex(signPhoneOrder(order, IRK)) }),
    );
    expect(res!.status).toBe(403);
    expect(fakes.trace).toEqual([]);
  });

  it("405 for non-POST", async () => {
    const handle = mkHandler(recordingFakes());
    const res = await handle({ ...req({}), method: "GET" });
    expect(res!.status).toBe(405);
  });
});
