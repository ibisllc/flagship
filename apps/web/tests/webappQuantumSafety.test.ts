// The webapp's Quantum-safe protection view (views/quantum-safety.js): view only, verified replay.
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  canonicalAssurancePolicyChange,
  canonicalPqKeyBinding,
  hybridSigKeygen,
  hybridSign,
  legacyPolicyState,
  type AssurancePolicyChange,
} from "../../../packages/protocol/src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const view = () => import(pathToFileURL(resolve(__dirname, "../public/webapp/views/quantum-safety.js")).href);
const bind = () => import(pathToFileURL(resolve(__dirname, "../public/webapp/lib/pqBinding.js")).href);

describe("webapp quantum-safe protection view", () => {
  const { publicKey, secretKey } = hybridSigKeygen(new Uint8Array(32).fill(5), new Uint8Array(32).fill(6));
  const root = hex(publicKey.subarray(0, 32));
  const st = { role: "admin-root" as const, subjectId: "alice", ed25519PubHex: root, mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: 1 };
  const wire = { v: 1, ...st, signature: hex(hybridSign(secretKey, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
  const scope = { kind: "installation" as const, id: "home.alice.flagship.services" };
  const s0 = legacyPolicyState(scope);
  const change: AssurancePolicyChange = {
    account: "alice", scope, prior: "compatibility", next: "strict", generation: 1, prevDigest: s0.headDigest,
    affectedPeersDigest: "0".repeat(64), acknowledgedLoss: ["browser-without-pq-authentication"], signerKind: "admin-root",
    signerKeyId: root, suite: "hybrid-ed25519-mldsa65/v1", issuedAt: 10,
  };
  const chain = [{ change, signature: { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(hybridSign(secretKey, "flagship/assurance-policy/v1", canonicalAssurancePolicyChange(change))) } }];

  it("replays a strict change under the admin root's binding and reports the browser answer", async () => {
    const v = await view();
    const b = (await bind()).verifyPqKeyBinding(wire, { role: "admin-root", subjectId: "alice", ed25519PubHex: root, now: 10 });
    const r = v.replayServed(scope, chain, root, b);
    expect(r.state.profile).toBe("strict");
    expect(v.describePolicy(r.state, r.headLoss, true).line).toMatch(/^Strict\. Browsers can still reach it/);
    // Without the binding nothing verifies: the browser never shows strict on its own say-so.
    expect(v.replayServed(scope, chain, root, null).state.generation).toBe(0);
  });

  it("says the browser cannot change strict, and is wired into Settings and the shell", async () => {
    expect((await view()).WEB_CANNOT_CHANGE).toMatch(/holds no post-quantum key/);
    const html = readFileSync(resolve(__dirname, "../public/webapp/index.html"), "utf8");
    expect(html).toContain('id="settings-tab-quantum-safety"');
    expect(html).toContain('id="view-quantum-safety"');
    expect(readFileSync(resolve(__dirname, "../public/webapp/service-worker.js"), "utf8")).toContain('"/views/quantum-safety.js"');
  });
});
