// The webapp's ports of two shared vector sets the Rust and TypeScript implementations also read:
// packages/protocol/test-vectors/service-invite (the invite messages the webapp signs) and the `root` cases of
// packages/protocol/test-vectors/entitlements (the RootEntitlement carrier boot approval signs). The other
// entitlement kinds are box and relay records the webapp never builds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalAcceptBytes,
  canonicalCreateBytes,
  canonicalRedeemBytes,
  canonicalRevokeBytes,
  serviceInviteSecretHash,
} from "../public/webapp/lib/serviceInvite.js";
import { _internal } from "../public/webapp/lib/bootApproval.js";

const vectors = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
const b = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (x: Uint8Array): string => Buffer.from(x).toString("hex");
const text = (x: Uint8Array): string => new TextDecoder().decode(x);

describe("service-invite vectors (webapp port)", () => {
  const V = vectors("packages/protocol/test-vectors/service-invite/vectors.json");
  const seed = (name: string) => new Uint8Array(32).fill(V.keys[name].seedByte);
  const create = (c: any) => ({
    inviteId: c.inviteId,
    authorAID: b(c.authorAID),
    serviceRef: c.serviceRef,
    secretHash: c.secretHash,
    encryptedBundle: c.encryptedBundle,
    issuedAt: c.issuedAt,
    ...(c.maxRedemptions !== undefined ? { maxRedemptions: c.maxRedemptions } : {}),
    ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
  });

  it("create, redeem, accept and revoke give the canonical strings and the TypeScript signer's signatures", () => {
    for (const c of V.create) {
      const bytes = canonicalCreateBytes(create(c));
      expect(text(bytes), c.name).toBe(c.canonical);
      expect(hex(ed25519.sign(bytes, seed("irk"))), c.name).toBe(c.signature);
    }
    for (const r of V.redeem) {
      const bytes = canonicalRedeemBytes({ secretHash: r.secretHash, visitorAID: b(r.visitorAID), redeemedAt: r.redeemedAt });
      expect(text(bytes)).toBe(r.canonical);
      expect(hex(ed25519.sign(bytes, seed("friend")))).toBe(r.signature);
    }
    for (const a of V.accept) {
      const bytes = canonicalAcceptBytes({ inviteId: a.inviteId, serviceRef: a.serviceRef, contactAID: b(a.contactAID), acceptedAt: a.acceptedAt });
      expect(text(bytes)).toBe(a.canonical);
      expect(hex(ed25519.sign(bytes, seed("contact")))).toBe(a.signature);
    }
    for (const r of V.revoke) {
      const bytes = canonicalRevokeBytes({ inviteId: r.inviteId, issuedAt: r.issuedAt });
      expect(text(bytes)).toBe(r.canonical);
      expect(hex(ed25519.sign(bytes, seed("irk")))).toBe(r.signature);
    }
  });

  it("the secret hash", async () => {
    for (const s of V.secretHash) expect(await serviceInviteSecretHash(b(s.secretHex))).toBe(s.expect);
  });

  it("refuses every invalid message", () => {
    for (const c of V.invalid) {
      if (c.op === "create") expect(() => canonicalCreateBytes(create(c)), c.name).toThrow();
      else expect(() => canonicalRedeemBytes({ secretHash: c.secretHash, visitorAID: b(c.visitorAID), redeemedAt: c.redeemedAt }), c.name).toThrow();
    }
  });
});

describe("entitlements vectors, root cases (webapp port)", () => {
  const roots = vectors("packages/protocol/test-vectors/entitlements/vectors.json").cases.filter((c: any) => c.kind === "root");

  it("the carrier signs the canonical RootEntitlement, and refuses a separator or control character", async () => {
    expect(roots.length).toBeGreaterThanOrEqual(5);
    for (const c of roots) {
      const signed: Uint8Array[] = [];
      const signWithIrk = async (_umk: unknown, bytes: Uint8Array) => {
        signed.push(bytes);
        return new Uint8Array(64);
      };
      const run = _internal.buildEntitlementCarrier({ ...c.input, signWithIrk, umk: null });
      if (c.canonical === null) {
        await expect(run, c.name).rejects.toThrow();
        expect(signed).toHaveLength(0);
        continue;
      }
      const carrier = JSON.parse(Buffer.from(await run, "hex").toString("utf8"));
      expect(text(signed[0]!), c.name).toBe(c.canonical);
      expect(carrier.rootEntitlement).toEqual({ username: c.input.username, podPubKey: c.input.podPubKeyHex, podCanonical: c.input.podCanonical, issuedAt: c.input.issuedAt });
      expect(ed25519.verify(b(c.signatureHex), signed[0]!, b(c.signerPubHex)), c.name).toBe(c.verifies);
    }
  });
});
