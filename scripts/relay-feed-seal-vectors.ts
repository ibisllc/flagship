#!/usr/bin/env -S npx tsx
/**
 * Writes packages/control-plane/tests/vectors/relay-feed-seal.json: the relay feed encryption vectors
 * (docs/architecture-v2/relay-mesh.md §4.5.1) the TS test and the Rust relay (chunk D) both check.
 *   npx tsx scripts/relay-feed-seal-vectors.ts packages/control-plane/tests/vectors/relay-feed-seal.json
 */
import { writeFileSync } from "node:fs";
import { ed } from "@flagship/protocol";
import { deriveMeshEpochKey, sealRelayFeedObject, sealRelayMeshKeys } from "@flagship/control-plane";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const apex = "flagship.services";
const meshSeed = "33".repeat(32);
const relaySeed = new Uint8Array(32).fill(0x61);
const relayKey = hex(ed.getPublicKey(relaySeed));
const k1 = deriveMeshEpochKey(meshSeed, apex, 1);
const k2 = deriveMeshEpochKey(meshSeed, apex, 2);
const headPlain = JSON.stringify({ head: { servicesApex: apex, sequence: 0, tipSha256: "0".repeat(64), directoryVersion: 1, issuedAt: 1793491200000 }, signature: "ab".repeat(64) });
const pagePlain = JSON.stringify({ page: 3, entries: [] });
const head = await sealRelayFeedObject({ servicesApex: apex, object: "head", page: null, epoch: 2, key: k2, plaintext: headPlain, nonce: new Uint8Array(12).fill(7) });
const page = await sealRelayFeedObject({ servicesApex: apex, object: "log", page: 3, epoch: 1, key: k1, plaintext: pagePlain, nonce: new Uint8Array(12).fill(9) });
const keys = sealRelayMeshKeys({ servicesApex: apex, relayId: "iad1", relayKey, current: 2, epochs: [{ epoch: 1, key: k1 }, { epoch: 2, key: k2 }] });
const v = {
  description: "relay feed encryption (docs/architecture-v2/relay-mesh.md §4.5.1; packages/control-plane/src/relayFeedSeal.ts). Feed objects are deterministic given the nonce; the key file's seals are random, so only opening is checked.",
  servicesApex: apex,
  meshKeySeed: meshSeed,
  epochKeys: [{ epoch: 1, key: hex(k1) }, { epoch: 2, key: hex(k2) }],
  sealed: [
    { name: "head, epoch 2", aad: `flagship/relay-feed-sealed/v1|${apex}|head||2`, key: hex(k2), nonce: "07".repeat(12), plaintext: headPlain, object: head },
    { name: "log page 3, epoch 1", aad: `flagship/relay-feed-sealed/v1|${apex}|log|3|1`, key: hex(k1), nonce: "09".repeat(12), plaintext: pagePlain, object: page },
  ],
  meshKeys: { relayId: "iad1", relaySeed: hex(relaySeed), relayKey, document: keys, expect: { current: 2, keys: { "1": hex(k1), "2": hex(k2) } } },
  negative: [
    { name: "head opened as a log page", object: head, expect: { servicesApex: apex, object: "log", page: 0 }, reason: "wrong-place" },
    { name: "page claimed for another slot (AAD mismatch)", object: { ...page, page: 4 }, expect: { servicesApex: apex, object: "log", page: 4 }, reason: "undecryptable" },
    { name: "epoch relabelled", object: { ...page, epoch: 2 }, expect: { servicesApex: apex, object: "log", page: 3 }, reason: "undecryptable" },
    { name: "another apex", object: head, expect: { servicesApex: "gym.flagship.services", object: "head", page: null }, reason: "wrong-place" },
  ],
};
writeFileSync(process.argv[2]!, JSON.stringify(v, null, 2) + "\n");
