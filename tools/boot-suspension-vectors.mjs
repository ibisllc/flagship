// Writes packages/protocol/test-vectors/boot-suspension/vectors.json.
// Run: node --import tsx tools/boot-suspension-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import {
  applyBootSuspension, canonicalBootSuspension, signBootSuspension, initialSuspension,
} from "../packages/protocol/src/bootSuspension.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = (n) => new Uint8Array(32).fill(n);
const ownerSeed = seed(7), boxSeed = seed(0x0b);
const ownerPub = ed.getPublicKey(ownerSeed), boxPub = ed.getPublicKey(boxSeed);
const D = "home.alice.flagship.services";
const T0 = 1760000000000;

const mk = (o) => ({ serverDomain: D, seq: 0, ...o });
const steps = [
  ["owner suspends (manual lock) at epoch 1", mk({ epoch: 1, action: "suspend", reason: "manual-lock", signer: "owner", issuedAt: T0 }), T0, { ok: true, suspended: true, epoch: 1, seq: 0 }],
  ["owner resumes at epoch 2", mk({ epoch: 2, action: "resume", reason: "owner-resume", signer: "owner", issuedAt: T0 + 1000 }), T0 + 1000, { ok: true, suspended: false, epoch: 2, seq: 0 }],
  ["owner replay of the old suspend is stale", mk({ epoch: 1, action: "suspend", reason: "manual-lock", signer: "owner", issuedAt: T0 }), T0 + 2000, { ok: false, code: "stale-epoch" }],
  ["owner cannot skip an epoch", mk({ epoch: 4, action: "suspend", reason: "owner-suspend", signer: "owner", issuedAt: T0 + 3000 }), T0 + 3000, { ok: false, code: "future-epoch" }],
  ["box suspends (dead-man) in epoch 2 as seq 1", mk({ epoch: 2, seq: 1, action: "suspend", reason: "dead-man", signer: "box", issuedAt: T0 + 4000 }), T0 + 4000, { ok: true, suspended: true, epoch: 2, seq: 1 }],
  ["box retry of the same seq changes nothing", mk({ epoch: 2, seq: 1, action: "suspend", reason: "dead-man", signer: "box", issuedAt: T0 + 5000 }), T0 + 5000, { ok: true, suspended: true, epoch: 2, seq: 1 }],
  ["box cannot resume", mk({ epoch: 2, seq: 2, action: "resume", reason: "dead-man", signer: "box", issuedAt: T0 + 6000 }), T0 + 6000, { ok: false, code: "box-cannot-resume" }],
  ["box cannot advance the epoch", mk({ epoch: 3, seq: 1, action: "suspend", reason: "dead-man", signer: "box", issuedAt: T0 + 7000 }), T0 + 7000, { ok: false, code: "future-epoch" }],
  ["box cannot claim an owner reason", mk({ epoch: 2, seq: 2, action: "suspend", reason: "owner-suspend", signer: "box", issuedAt: T0 + 8000 }), T0 + 8000, { ok: false, code: "box-reason" }],
  ["owner resumes at epoch 3", mk({ epoch: 3, action: "resume", reason: "owner-resume", signer: "owner", issuedAt: T0 + 20000 }), T0 + 20000, { ok: true, suspended: false, epoch: 3, seq: 0 }],
  ["box seq cannot jump", mk({ epoch: 3, seq: 5, action: "suspend", reason: "manual-lock", signer: "box", issuedAt: T0 + 30000 }), T0 + 30000, { ok: false, code: "seq-jump" }],
  ["a stale order is refused", mk({ epoch: 4, action: "suspend", reason: "owner-suspend", signer: "owner", issuedAt: T0 }), T0 + 30000 + 6 * 60000, { ok: false, code: "stale-order" }],
];

let state = null;
const out = [];
for (const [name, order, now, expect] of steps) {
  const priv = order.signer === "owner" ? ownerSeed : boxSeed;
  const sig = hex(signBootSuspension(order, priv));
  const r = applyBootSuspension(state, order, sig, now);
  if (r.ok) state = r.state;
  const got = r.ok ? { ok: true, suspended: r.state.suspended, epoch: r.state.epoch, seq: r.state.seq } : { ok: false, code: r.code };
  if (JSON.stringify(got) !== JSON.stringify(expect)) throw new Error(`${name}: expected ${JSON.stringify(expect)} got ${JSON.stringify(got)}`);
  out.push({ name, order, now, canonical: new TextDecoder().decode(canonicalBootSuspension(order)), signatureHex: sig, expect });
}
mkdirSync("packages/protocol/test-vectors/boot-suspension", { recursive: true });
writeFileSync("packages/protocol/test-vectors/boot-suspension/vectors.json", JSON.stringify({
  about: "Durable boot suspension. The owner signs with the account key and always starts a new epoch (current + 1); the box signs with its STK, may only suspend, only inside the current epoch, as seq = current + 1. Steps are applied in order from an empty state; each lists the time the boot worker saw it and the expected outcome. Seeds are 32 repeated bytes (owner 0x07, box 0x0b). Ed25519 signatures are deterministic.",
  ownerSeedHex: hex(ownerSeed), ownerPubHex: hex(ownerPub), boxSeedHex: hex(boxSeed), boxPubHex: hex(boxPub),
  initial: initialSuspension(D),
  steps: out,
}, null, 2) + "\n");
console.log("wrote", out.length, "steps");
