import { describe, expect, it } from "vitest";
import { canonicalBoxHealthReport, ed, hybridSigKeygen, hybridVerify, TAG_BOX_HEALTH } from "@flagship/protocol";
import { KeydClient, signBoxHealth } from "../src/index.js";
import { PQ_SEED, SEED, startInProcess } from "./helpers.js";

const REPORT = '{"v":1,"domain":"home.alice.flagship.services","at":1}';

describe("sign-health: the health timer's signatures (strict servers keep their health)", () => {
  it("signs a tagged health report with the STK and hybrid with its ML-DSA half", async () => {
    const k = await startInProcess({ pqSeed: PQ_SEED });
    const client = new KeydClient({ socketPath: k.sock, component: "health-timer" });
    try {
      await client.connect();
      const msg = canonicalBoxHealthReport(REPORT);
      const out = await signBoxHealth(client, msg);
      expect(ed.verify(Buffer.from(out.signature, "hex"), msg, ed.getPublicKey(SEED))).toBe(true);
      expect(out.hybrid).toBeDefined();
      const { publicKey } = hybridSigKeygen(SEED, PQ_SEED);
      expect(() => hybridVerify(publicKey, TAG_BOX_HEALTH, msg, Buffer.from(out.hybrid!, "hex"))).not.toThrow();
    } finally {
      client.close();
      await k.stop();
    }
  });

  it("gives a classical signature only when keyd has no ML-DSA key, and signs nothing but a health report", async () => {
    const k = await startInProcess();
    const client = new KeydClient({ socketPath: k.sock, component: "health-timer" });
    try {
      await client.connect();
      const out = await signBoxHealth(client, canonicalBoxHealthReport(REPORT));
      expect(out.hybrid).toBeUndefined();
      await expect(signBoxHealth(client, new TextEncoder().encode(`flagship/daemon-status/v1|${REPORT}`))).rejects.toThrow(/not a tagged box health report/);
    } finally {
      client.close();
      await k.stop();
    }
  });
});
