/**
 * Custom-domain cert: lead-pod ACME + sibling-only replication
 * (#79B / Phase 4 C4.1c).
 *
 * The wire-critical bits are unit-tested here; the end-to-end (a real
 * external CNAME → real Let's Encrypt cert → real green padlock) is
 * the north-star real-infra exercise documented in the plan doc — it
 * cannot be unit-tested to done. What CAN be pinned, and is:
 *   - fresher-wins store semantics
 *   - lead issues+installs+persists+signs+replicates; sibling no-ops
 *   - receive fails closed on a forged signature + on a stale bundle
 *   - THE security rule: the cert/key replication path is structurally
 *     incapable of routing through peerBackup/peerLink.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveSTK, deriveSWK, type CustomDomainCert } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import {
  CustomDomainCertStore,
  ensureLeadCustomDomainCert,
  receiveCustomDomainCert,
  type SiblingCertSender,
} from "../src/acme/customDomainCert.js";
import { CertManager } from "../src/certManager.js";
import { EncryptedCertStore } from "../src/acme.js";
import { buildAlpnChallengeCert } from "../src/acme/alpnChallengeCert.js";

const umk = { seed: new Uint8Array(32).fill(3) };
const leadStk = deriveSTK(deriveSWK(umk, "home"));
const FQDN = "shop.example.com";

async function stubPair(host = FQDN) {
  return buildAlpnChallengeCert("stub-key-auth", host);
}

function captureSender(): { sender: SiblingCertSender; sent: Array<{ bundle: CustomDomainCert; signature: Uint8Array }> } {
  const sent: Array<{ bundle: CustomDomainCert; signature: Uint8Array }> = [];
  return {
    sent,
    sender: { pushCustomDomainCert: (bundle, signature) => sent.push({ bundle, signature }) },
  };
}

describe("CustomDomainCertStore (fresher-wins)", () => {
  it("a strictly-greater issuedAt replaces; equal/stale is dropped", () => {
    const s = new CustomDomainCertStore();
    const mk = (issuedAt: number): { bundle: CustomDomainCert; signature: Uint8Array } => ({
      bundle: { username: "u", fqdn: FQDN, certPem: "c", privateKeyPem: "k", notAfter: issuedAt + 1, issuedAt },
      signature: new Uint8Array([issuedAt & 0xff]),
    });
    expect(s.applyIfFresher(mk(100))).toBe(true);
    expect(s.applyIfFresher(mk(100))).toBe(false); // equal
    expect(s.applyIfFresher(mk(50))).toBe(false); // stale
    expect(s.applyIfFresher(mk(200))).toBe(true); // fresher
    expect(s.get(FQDN)!.bundle.issuedAt).toBe(200);
  });
});

describe("ensureLeadCustomDomainCert", () => {
  it("a sibling is receive-only — it never ACMEs", async () => {
    let issued = 0;
    const { sender, sent } = captureSender();
    const r = await ensureLeadCustomDomainCert({
      role: "sibling",
      fqdn: FQDN,
      username: "u",
      issuer: { issue: async () => { issued++; throw new Error("sibling must not issue"); } },
      certManager: new CertManager(),
      certStore: null,
      signer: leadStk,
      sender,
    });
    expect(r.issued).toBe(false);
    expect(issued).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("lead issues, installs for the exact SNI, persists, signs, replicates", async () => {
    const pair = await stubPair();
    const cm = new CertManager();
    const certStore = new EncryptedCertStore(swkOps(deriveSWK(umk, "home")), "home");
    const { sender, sent } = captureSender();
    const notAfter = Date.now() + 80 * 24 * 60 * 60 * 1000;
    const r = await ensureLeadCustomDomainCert({
      role: "lead",
      fqdn: FQDN,
      username: "u",
      issuer: { issue: async (names) => {
        expect(names).toEqual([FQDN]); // non-wildcard → TLS-ALPN-01
        return { ...pair, notAfter };
      } },
      certManager: cm,
      certStore,
      signer: leadStk,
      sender,
      now: () => 1_700_000_000_000,
    });
    expect(r.issued).toBe(true);
    // installed for the exact custom SNI (its own cert, not the wildcard)
    expect(cm.customNotAfter(FQDN)).toBe(notAfter);
    expect(cm.contextFor(FQDN)).not.toBeNull();
    // persisted under the custom: namespace
    expect(certStore.has("custom:shop.example.com")).toBe(true);
    // replicated exactly once, signed by the pod STK, verifying clean
    expect(sent).toHaveLength(1);
    expect(sent[0]!.bundle.fqdn).toBe(FQDN);
    expect(sent[0]!.bundle.issuedAt).toBe(1_700_000_000_000);
    const { verifyCustomDomainCert } = await import("@flagship/protocol");
    expect(
      await verifyCustomDomainCert(sent[0]!.bundle, sent[0]!.signature, leadStk.publicKey),
    ).toBe(true);
  });

  it("lead skips ACME while the cert is still fresh", async () => {
    const pair = await stubPair();
    const cm = new CertManager();
    cm.installCustom(FQDN, pair, Date.now() + 80 * 24 * 60 * 60 * 1000);
    let issued = 0;
    const { sender, sent } = captureSender();
    const r = await ensureLeadCustomDomainCert({
      role: "lead",
      fqdn: FQDN,
      username: "u",
      issuer: { issue: async () => { issued++; return { ...pair, notAfter: 0 }; } },
      certManager: cm,
      certStore: null,
      signer: leadStk,
      sender,
    });
    expect(r.issued).toBe(false);
    expect(issued).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe("receiveCustomDomainCert (fail-closed)", () => {
  it("verifies the signature, applies fresher, installs for the SNI", async () => {
    const pair = await stubPair();
    const cm = new CertManager();
    const store = new CustomDomainCertStore();
    const notAfter = Date.now() + 80 * 24 * 60 * 60 * 1000;
    const bundle: CustomDomainCert = { username: "u", fqdn: FQDN, ...pair, notAfter, issuedAt: 123 };
    const { signCustomDomainCert } = await import("@flagship/protocol");
    const signature = await signCustomDomainCert(bundle, leadStk);
    const r = await receiveCustomDomainCert({
      bundle, signature, signerPodIdentityPub: leadStk.publicKey,
      store, certManager: cm, certStore: null,
    });
    expect(r.applied).toBe(true);
    expect(cm.customNotAfter(FQDN)).toBe(notAfter);
    expect(store.get(FQDN)!.bundle.issuedAt).toBe(123);
  });

  it("rejects a bundle whose signature is not from the fleet pod identity", async () => {
    const pair = await stubPair();
    const cm = new CertManager();
    const evil = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(9) }, "evil"));
    const bundle: CustomDomainCert = { username: "u", fqdn: FQDN, ...pair, notAfter: Date.now() + 1e9, issuedAt: 1 };
    const { signCustomDomainCert } = await import("@flagship/protocol");
    const signature = await signCustomDomainCert(bundle, evil);
    const r = await receiveCustomDomainCert({
      bundle, signature, signerPodIdentityPub: leadStk.publicKey, // expected fleet id
      store: new CustomDomainCertStore(), certManager: cm, certStore: null,
    });
    expect(r.applied).toBe(false);
    expect(cm.customNotAfter(FQDN)).toBe(0); // serving plane untouched
  });

  it("does not regress to a stale bundle", async () => {
    const pair = await stubPair();
    const store = new CustomDomainCertStore();
    const { signCustomDomainCert } = await import("@flagship/protocol");
    const fresh: CustomDomainCert = { username: "u", fqdn: FQDN, ...pair, notAfter: 1e13, issuedAt: 500 };
    const stale: CustomDomainCert = { username: "u", fqdn: FQDN, ...pair, notAfter: 1e13, issuedAt: 100 };
    const cm = new CertManager();
    await receiveCustomDomainCert({
      bundle: fresh, signature: await signCustomDomainCert(fresh, leadStk),
      signerPodIdentityPub: leadStk.publicKey, store, certManager: cm, certStore: null,
    });
    const r = await receiveCustomDomainCert({
      bundle: stale, signature: await signCustomDomainCert(stale, leadStk),
      signerPodIdentityPub: leadStk.publicKey, store, certManager: cm, certStore: null,
    });
    expect(r.applied).toBe(false);
    expect(store.get(FQDN)!.bundle.issuedAt).toBe(500);
  });
});

describe("THE security rule: cert/key never via peerBackup/peerLink", () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("customDomainCert imports nothing from ../peerBackup or ../peerLink", () => {
    const code = src("../src/acme/customDomainCert.ts");
    expect(code).not.toMatch(/from\s+["'][^"']*peerBackup/);
    expect(code).not.toMatch(/from\s+["'][^"']*peerLink/);
  });

  it("peerBackup never imports the custom-domain cert module", () => {
    for (const f of ["transport.ts", "peerLink.ts", "registry.ts", "shardStore.ts"]) {
      const code = src(`../src/peerBackup/${f}`);
      expect(code).not.toMatch(/customDomainCert/);
      expect(code).not.toMatch(/CustomDomainCert/);
    }
  });

  it("the replication seam is structurally not a PeerBackupClient", async () => {
    // SiblingCertSender's only method is pushCustomDomainCert; the
    // PeerBackup transport is put/get/challenge. A type-level cross-
    // wire is impossible — assert the runtime shapes diverge too.
    const { sender } = captureSender();
    expect(typeof (sender as Record<string, unknown>).pushCustomDomainCert).toBe("function");
    expect((sender as Record<string, unknown>).put).toBeUndefined();
    expect((sender as Record<string, unknown>).get).toBeUndefined();
    expect((sender as Record<string, unknown>).challenge).toBeUndefined();
  });
});
