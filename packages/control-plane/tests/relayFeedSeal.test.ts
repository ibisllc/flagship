/**
 * The relay feed's encryption layer (docs/architecture-v2/relay-mesh.md §4.5.1) against its shared vectors
 * (tests/vectors/relay-feed-seal.json, written by scripts/relay-feed-seal-vectors.ts; the Rust relay checks the same).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveMeshEpochKey,
  openRelayFeedObject,
  openRelayMeshKeys,
  relayFeedAad,
  sealRelayFeedObject,
  sealRelayMeshKeys,
  type RelayFeedObject,
  type RelayFeedSealed,
} from "../src/relayFeedSeal.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const V = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors", "relay-feed-seal.json"), "utf8")) as {
  servicesApex: string;
  meshKeySeed: string;
  epochKeys: Array<{ epoch: number; key: string }>;
  sealed: Array<{ name: string; aad: string; key: string; nonce: string; plaintext: string; object: RelayFeedSealed }>;
  meshKeys: { relayId: string; relaySeed: string; relayKey: string; document: unknown; expect: { current: number; keys: Record<string, string> } };
  negative: Array<{ name: string; object: unknown; expect: { servicesApex: string; object: RelayFeedObject; page: number | null }; reason: string }>;
};
const keyFor = (e: number) => {
  const k = V.epochKeys.find((x) => x.epoch === e);
  return k ? unhex(k.key) : null;
};

describe("relay feed seal vectors", () => {
  it("derives every epoch key from the seed", () => {
    for (const k of V.epochKeys) expect(hex(deriveMeshEpochKey(V.meshKeySeed, V.servicesApex, k.epoch))).toBe(k.key);
  });

  for (const s of V.sealed) {
    it(`seals and opens: ${s.name}`, async () => {
      expect(new TextDecoder().decode(relayFeedAad(V.servicesApex, s.object.object, s.object.page, s.object.epoch))).toBe(s.aad);
      const again = await sealRelayFeedObject({
        servicesApex: V.servicesApex, object: s.object.object, page: s.object.page, epoch: s.object.epoch, key: unhex(s.key), plaintext: s.plaintext, nonce: unhex(s.nonce),
      });
      expect(again).toEqual(s.object);
      expect(await openRelayFeedObject(s.object, { servicesApex: V.servicesApex, object: s.object.object, page: s.object.page }, keyFor)).toEqual({ ok: true, plaintext: s.plaintext, epoch: s.object.epoch });
    });
  }

  for (const n of V.negative) {
    it(`refuses: ${n.name}`, async () => {
      expect(await openRelayFeedObject(n.object, n.expect, keyFor)).toEqual({ ok: false, reason: n.reason });
    });
  }

  it("opens the sealed key file with the relay's seed, and only for that relay", () => {
    const m = V.meshKeys;
    const opened = openRelayMeshKeys(m.document, unhex(m.relaySeed), { servicesApex: V.servicesApex, relayId: m.relayId });
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.current).toBe(m.expect.current);
    expect(Object.fromEntries([...opened.keys].map(([e, k]) => [String(e), hex(k)]))).toEqual(m.expect.keys);
    expect(openRelayMeshKeys(m.document, new Uint8Array(32).fill(1), { servicesApex: V.servicesApex, relayId: m.relayId })).toEqual({ ok: false, reason: "no-current-key" });
    expect(openRelayMeshKeys(m.document, unhex(m.relaySeed), { servicesApex: V.servicesApex, relayId: "ams1" })).toEqual({ ok: false, reason: "wrong-relay" });
  });

  it("a key line sealed for one relay or epoch does not open as another", () => {
    const m = V.meshKeys;
    // Filed under epoch 2 but sealed as epoch 1's line: skipped, so epoch 2 has no key.
    const doc = sealRelayMeshKeys({ servicesApex: V.servicesApex, relayId: m.relayId, relayKey: m.relayKey, current: 1, epochs: [{ epoch: 1, key: keyFor(1)! }] });
    const relabelled = { ...doc, current: 2, epochs: [{ epoch: 2, sealed: doc.epochs[0]!.sealed }] };
    expect(openRelayMeshKeys(relabelled, unhex(m.relaySeed), { servicesApex: V.servicesApex, relayId: m.relayId })).toEqual({ ok: false, reason: "no-current-key" });
  });
});
