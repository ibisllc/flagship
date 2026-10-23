import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalOfflineSecrets,
  canonicalPublisherTrust,
  canonicalRePairVeto,
  canonicalCompanionDelegation,
  canonicalWatchBootDelegate,
  openWatchBootKey,
  verifyWatchBootDelegate,
  verifyCompanionDelegation,
  restoredAccessApproveCanonicalBytes,
  verifyRestoredAccessApprove,
  ed,
  verifyOfflineSecrets,
  verifyPublisherTrust,
  verifyRePairVeto,
} from "../src/index.js";

const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("shared vectors: offline-secrets", () => {
  const v = read("../test-vectors/offline-secrets/vectors.json");
  it("the canonical bytes are the vector's", () => {
    expect(new TextDecoder().decode(canonicalOfflineSecrets(v.cases[0].sibling))).toBe(v.canonicalOfGood);
  });
  it("every case gets the verdict the vector names", () => {
    const order = { ...v.order, userPub: unhex(v.order.userPub) };
    for (const c of v.cases) {
      const verdict = verifyOfflineSecrets(c.sibling, c.swkHex, order);
      expect(verdict.ok ? "ok" : verdict.reason, c.name).toBe(c.expect);
    }
  });
});

describe("shared vectors: publisher-trust", () => {
  const v = read("../test-vectors/publisher-trust/vectors.json");
  it("the canonical bytes and the signature are the vector's", () => {
    expect(new TextDecoder().decode(canonicalPublisherTrust(v.trust))).toBe(v.canonical);
    expect(verifyPublisherTrust(v.trust, v.signatureHex, unhex(v.ownerPubHex))).toBe(true);
    expect(ed.getPublicKey(unhex(v.ownerSeedHex))).toEqual(unhex(v.ownerPubHex));
  });
  it("a different change does not verify under the same signature", () => {
    expect(verifyPublisherTrust({ ...v.trust, newEpoch: v.trust.newEpoch + 1 }, v.signatureHex, unhex(v.ownerPubHex))).toBe(false);
  });
});

describe("shared vectors: re-pair-veto", () => {
  const v = read("../test-vectors/re-pair-veto/vectors.json");
  for (const c of v.cases) {
    it(c.name, () => {
      const r = { username: c.request.username, newIrkPub: unhex(c.request.newIrkPub), initiatedAt: c.request.initiatedAt, completesAt: c.request.completesAt, vetoerPub: unhex(c.request.vetoerPub), issuedAt: c.request.issuedAt };
      expect(new TextDecoder().decode(canonicalRePairVeto(r))).toBe(c.canonical);
      expect(verifyRePairVeto(r, unhex(c.signatureHex))).toBe(c.valid);
    });
  }
});

describe("shared vectors: restored-access-approve", () => {
  const v = read("../test-vectors/restored-access-approve/vectors.json");
  it("the canonical bytes and the signature are the vector's", () => {
    expect(new TextDecoder().decode(restoredAccessApproveCanonicalBytes(v.order))).toBe(v.canonical);
    expect(verifyRestoredAccessApprove(v.order, unhex(v.signatureHex), unhex(v.adminPubHex))).toBe(true);
  });
  it("every other app or draft fails the same signature", () => {
    for (const c of v.invalid) {
      expect(new TextDecoder().decode(restoredAccessApproveCanonicalBytes(c.order)), c.name).toBe(c.canonical);
      expect(verifyRestoredAccessApprove(c.order, unhex(v.signatureHex), unhex(v.adminPubHex)), c.name).toBe(false);
    }
  });
});

describe("shared vectors: companion-delegation", () => {
  const v = read("../test-vectors/companion-delegation/vectors.json");
  it("the canonical bytes (ops sorted) and the signature are the vector's", () => {
    expect(new TextDecoder().decode(canonicalCompanionDelegation(v.delegation))).toBe(v.canonical);
    expect(verifyCompanionDelegation(v.delegation, unhex(v.signatureHex), unhex(v.adminPubHex))).toBe(true);
  });
  it("every other session, app, operation set or window fails the same signature", () => {
    for (const c of v.invalid) {
      expect(new TextDecoder().decode(canonicalCompanionDelegation(c.delegation)), c.name).toBe(c.canonical);
      expect(verifyCompanionDelegation(c.delegation, unhex(v.signatureHex), unhex(v.adminPubHex)), c.name).toBe(false);
    }
  });
  it("a malformed delegation is refused", () => {
    expect(() => canonicalCompanionDelegation({ ...v.delegation, ops: [] })).toThrow();
    expect(() => canonicalCompanionDelegation({ ...v.delegation, ops: ["root"] })).toThrow();
    expect(() => canonicalCompanionDelegation({ ...v.delegation, expiresAt: v.delegation.issuedAt })).toThrow();
    expect(() => canonicalCompanionDelegation({ ...v.delegation, serviceRef: "a|b" })).toThrow();
  });
});

describe("shared vectors: watch-boot-delegate", () => {
  const v = read("../test-vectors/watch-boot-delegate/vectors.json");
  const unsigned = (d: Record<string, unknown>) => ({ serverDomain: d.serverDomain, delegatePubHex: d.delegatePubHex, decryptPubHex: d.decryptPubHex, keySha256Hex: d.keySha256Hex, issuedAt: d.issuedAt, expiresAt: d.expiresAt }) as never;
  it("the canonical bytes, the signature and the sealed copy are the vector's", () => {
    expect(new TextDecoder().decode(canonicalWatchBootDelegate(unsigned(v.deposit)))).toBe(v.canonical);
    expect(verifyWatchBootDelegate(unsigned(v.deposit), unhex(v.deposit.signatureHex), unhex(v.accountPubHex))).toBe(true);
    expect(Buffer.from(openWatchBootKey(v.deposit, unhex(v.decryptPrivHex))).toString("hex")).toBe(v.diskKeyHex);
  });
  it("every other server, watch, decryption key, key digest or window fails the same signature", () => {
    for (const c of v.invalid) {
      expect(new TextDecoder().decode(canonicalWatchBootDelegate(c.delegate)), c.name).toBe(c.canonical);
      expect(verifyWatchBootDelegate(c.delegate, unhex(v.deposit.signatureHex), unhex(v.accountPubHex)), c.name).toBe(false);
    }
  });
});

describe("shared vectors: chat-approval", () => {
  const v = read("../test-vectors/chat-approval/vectors.json");
  it("matches canonical bytes and signatures, and refuses the malformed orders", async () => {
    const { canonicalChatApproval, verifyChatApproval } = await import("../src/chatWire.js");
    const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
    for (const o of v.orders) {
      expect(new TextDecoder().decode(canonicalChatApproval(o.order))).toBe(o.canonical);
      expect(verifyChatApproval(o.order, unhex(o.signatureHex), unhex(v.pubHex))).toBe(true);
    }
    for (const r of v.refused) expect(() => canonicalChatApproval(r.order), r.name).toThrow();
  });
});

describe("shared vectors: ai-repair-consent", () => {
  const v = read("../test-vectors/ai-repair-consent/vectors.json");
  it("matches canonical bytes and signatures, and refuses the malformed orders", async () => {
    const { canonicalAiRepairConsent, verifyAiRepairConsent } = await import("../src/aiRepairConsent.js");
    const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
    for (const o of v.orders) {
      expect(new TextDecoder().decode(canonicalAiRepairConsent(o.order))).toBe(o.canonical);
      expect(verifyAiRepairConsent(o.order, unhex(o.signatureHex), unhex(v.pubHex))).toBe(true);
    }
    for (const r of v.refused) expect(() => canonicalAiRepairConsent(r.order), r.name).toThrow();
  });
});

describe("shared vectors: server-wildcard-grant", () => {
  const v = read("../test-vectors/server-wildcard-grant/vectors.json");
  it("matches canonical bytes and signatures, binds the server and its key, and refuses the malformed grants", async () => {
    const { canonicalServerWildcardGrant, verifyServerWildcardGrant } = await import("../src/serverWildcardGrant.js");
    const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
    for (const g of v.grants) {
      expect(new TextDecoder().decode(canonicalServerWildcardGrant(g.grant))).toBe(g.canonical);
      expect(verifyServerWildcardGrant(g.grant, unhex(g.signatureHex), unhex(v.pubHex))).toBe(true);
    }
    for (const c of v.invalid) expect(verifyServerWildcardGrant(c.grant, unhex(v.grants[0].signatureHex), unhex(v.pubHex)), c.name).toBe(false);
    for (const r of v.refused) expect(() => canonicalServerWildcardGrant(r.grant), r.name).toThrow();
  });
});

describe("shared vectors: enrollment", () => {
  const v = read("../test-vectors/enrollment/vectors.json");
  it("matches the proof and its canonical bytes, binds server, key and install code, and the six-digit codes", async () => {
    const { canonicalEnrollmentProof, enrollmentProofHex, serverCode, verifyEnrollmentProof } = await import("../src/enrollment.js");
    const secret = Uint8Array.from(v.secretHex.match(/../g)!.map((x: string) => parseInt(x, 16)));
    for (const p of v.proofs) {
      expect(new TextDecoder().decode(canonicalEnrollmentProof(p.statement))).toBe(p.canonical);
      expect(enrollmentProofHex(secret, p.statement)).toBe(p.proofHex);
    }
    for (const c of v.invalid) expect(verifyEnrollmentProof(secret, c.statement, v.proofs[0].proofHex), c.name).toBe(false);
    for (const c of v.codes) expect(serverCode(c.stkPubHex)).toBe(c.code);
    const { serverSeenMacHex } = await import("../src/enrollment.js");
    const studioKey = Uint8Array.from(v.studioConfirmKeyHex.match(/../g)!.map((x: string) => parseInt(x, 16)));
    for (const s of v.seen) expect(serverSeenMacHex(studioKey, s.serverDomain, s.stkPubHex)).toBe(s.macHex);
  });
});

describe("shared vectors: browser-grant", () => {
  const v = read("../test-vectors/browser-grant/vectors.json");
  it("matches canonical bytes and signatures, and refuses the malformed answers", async () => {
    const { canonicalBrowserGrantAnswer, verifyBrowserGrantAnswer } = await import("../src/browserGrant.js");
    const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
    for (const a of v.answers) {
      expect(new TextDecoder().decode(canonicalBrowserGrantAnswer(a.answer))).toBe(a.canonical);
      expect(verifyBrowserGrantAnswer(a.answer, unhex(a.signatureHex), unhex(v.pubHex))).toBe(true);
    }
    for (const r of v.refused) expect(() => canonicalBrowserGrantAnswer(r.answer), r.name).toThrow();
  });
});
