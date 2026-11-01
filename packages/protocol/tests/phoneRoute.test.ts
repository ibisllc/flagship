import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import {
  barePhoneAccount,
  canonicalCertificateOrder,
  canonicalRouteClaim,
  checkRouteClaim,
  csrSha256Hex,
  emptyPhoneRouteEntry,
  ledgerAcquire,
  ledgerRelease,
  ledgerRenew,
  liveEntry,
  phoneCertNeedsOrder,
  phoneCsr,
  phoneCsrInfo,
  phoneEndpointCheck,
  phoneRouteEligibility,
  signDeviceCapabilityGrant,
  verifyServingRecord,
  ed,
  PHONE_ROUTE_LEASE_MS,
  type AdminGrantView,
  type PhoneRouteEntry,
} from "../src/index.js";

const V = JSON.parse(readFileSync(fileURLToPath(new URL("../test-vectors/phone-route/vectors.json", import.meta.url)), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const dec = new TextDecoder();

describe("phone-route vectors (drift guard: the file is what Swift and Kotlin read)", () => {
  it("bare names", () => {
    for (const b of V.bare) expect(barePhoneAccount(b.sni, b.apex)).toBe(b.account);
  });

  it("the claim's bytes, signature and refusals", () => {
    expect(dec.decode(canonicalRouteClaim(V.claim.record))).toBe(V.claim.canonical);
    expect(verifyServingRecord("route-claim", V.claim.record, V.claim.signature, V.signerPub)).toBe(true);
    for (const c of V.claim.cases) {
      const r = checkRouteClaim({ claim: c.claim, signature: c.signature, ...c.session });
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
  });

  it("the phone's certificate order", () => {
    expect(dec.decode(canonicalCertificateOrder(V.certificateOrder.record))).toBe(V.certificateOrder.canonical);
    expect(verifyServingRecord("certificate-order", V.certificateOrder.record, V.certificateOrder.signature, V.signerPub)).toBe(true);
    expect(V.certificateOrder.record.csrSha256).toBe(V.csr.csrSha256);
  });

  it("the CSR: info bytes, assembly and signature", () => {
    const pub = unhex(V.csr.publicKeyUncompressed);
    expect(hex(p256.getPublicKey(unhex(V.csr.privateKey), false))).toBe(V.csr.publicKeyUncompressed);
    const info = phoneCsrInfo(pub, V.csr.hostname);
    expect(hex(info)).toBe(V.csr.infoHex);
    const csr = phoneCsr(info, unhex(V.csr.signatureDerHex));
    expect(hex(csr)).toBe(V.csr.csrHex);
    expect(csrSha256Hex(csr)).toBe(V.csr.csrSha256);
    expect(p256.verify(unhex(V.csr.signatureDerHex), info, pub, { format: "der" })).toBe(true);
    expect(() => phoneCsrInfo(pub, "*.alice.flagship.services")).toThrow();
  });

  it("the ledger steps", () => {
    let e: PhoneRouteEntry = emptyPhoneRouteEntry();
    for (const l of V.ledger) {
      const s = l.step;
      const holder = { relayId: s.relayId, sessionId: s.sessionId, phoneRoutePub: V.signerPub };
      const r =
        s.op === "acquire" ? ledgerAcquire(e, s.generation, holder, s.now) : s.op === "renew" ? ledgerRenew(e, s.generation, s.sessionId, s.now) : ledgerRelease(e, s.generation, s.sessionId);
      expect(r.ok ? "ok" : r.code).toBe(l.result);
      expect(r.entry).toEqual(l.entry);
      e = r.entry;
    }
  });

  it("certificate reuse and the endpoint policy", () => {
    for (const c of V.certReuse) expect(phoneCertNeedsOrder(c)).toBe(c.order);
    for (const c of V.endpoint) expect(phoneEndpointCheck(c.request, c.context), c.name).toBe(c.verdict);
  });
});

describe("ledger", () => {
  const h = (s: string) => ({ relayId: "r", sessionId: s, phoneRoutePub: "aa".repeat(32) });

  it("a lapsed lease has no holder but keeps its generation", () => {
    const a = ledgerAcquire(emptyPhoneRouteEntry(), 1, h("s1"), 0);
    expect(a.ok).toBe(true);
    const live = liveEntry(a.entry, PHONE_ROUTE_LEASE_MS);
    expect(live).toEqual({ generation: 1, holder: null, leaseUntil: 0 });
    // A late acquire by the lapsed session must still use the next generation.
    expect(ledgerAcquire(a.entry, 1, h("s1"), PHONE_ROUTE_LEASE_MS + 1).ok).toBe(false);
  });

  it("supersede reports the previous live holder", () => {
    const a = ledgerAcquire(emptyPhoneRouteEntry(), 1, h("s1"), 0);
    const b = ledgerAcquire(a.entry, 2, h("s2"), 10);
    expect(b.ok && b.superseded?.sessionId).toBe("s1");
  });
});

describe("eligibility: only an admin-root-granted admin device", () => {
  const seed = (n: number) => new Uint8Array(32).fill(n);
  const adminRoot = seed(1);
  const adminPub = hex(ed.getPublicKey(adminRoot));
  const phone = hex(ed.getPublicKey(seed(2)));
  const member = hex(ed.getPublicKey(seed(3)));
  const now = 1_800_000_000_000;
  const view = (pub: string, scopes: string[], signer: Uint8Array, signerRoot: "admin-root" | "membership"): AdminGrantView => {
    const grant = { grantId: "g".repeat(32), username: "alice", deviceId: "d".repeat(32), devicePubKey: unhex(pub), scopes: scopes as never, issuedAt: now - 1000, expiresAt: now + 86_400_000 };
    return { grant, signatureHex: hex(signDeviceCapabilityGrant(grant, { privateKey: signer, publicKey: ed.getPublicKey(signer) })), signerRoot };
  };

  it("admits the admin device, refuses the admin root itself, a member device and a membership-signed admin grant", () => {
    const grants = [view(phone, ["admin"], adminRoot, "admin-root"), view(member, ["admin"], seed(9), "membership")];
    expect(phoneRouteEligibility(phone, "alice", adminPub, grants, now)).toMatchObject({ ok: true });
    expect(phoneRouteEligibility(adminPub, "alice", adminPub, grants, now).ok).toBe(false);
    expect(phoneRouteEligibility(member, "alice", adminPub, grants, now).ok).toBe(false);
    expect(phoneRouteEligibility(phone, "alice", null, grants, now).ok).toBe(false);
    expect(phoneRouteEligibility(phone, "alice", adminPub, [{ ...grants[0]!, revokedAt: now }], now).ok).toBe(false);
  });
});
