// "Update this server" — webapp client of the dual-signed in-place update
// (docs/server-update-mechanism.md).
//
//   1. PINNED cross-platform vector: the webapp's canonical bytes AND the
//      signature under the 32×0x07 admin seed match the TS source of truth
//      (packages/protocol/tests/serverUpdateVector.test.ts) byte-for-byte.
//   2. depositUpdateOrder builds the exact `{auth, authSignature, deposit,
//      order, signature}` body handlePostUpdateDeposit expects, and the order
//      verifies under @flagship/protocol's verifyUpdateOrder.
//   3. The signing GATE routes `flagship/server-update/v1` to the ADMIN master
//      root (SENSITIVE_TAGS membership) while the co-signed mailbox auth stays
//      on the membership IRK — the two-key contract of the deposit lane.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { deriveIRK, verifyUpdateOrder, type UpdateOrder } from "@flagship/protocol";

async function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href);
}
const loadServerUpdate = () => load("lib/serverUpdate.js");
const loadAdminRoot = () => load("lib/adminRoot.js");
const loadKeystore = () => load("keystore.js");

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function fromHex(s: string): Uint8Array {
  return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
}
const td = new TextDecoder();

// The pinned cross-platform vector — TS is the source of truth.
const VECTOR: UpdateOrder = {
  serverDomain: "home.alice.flagship.services",
  targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
  fromCommit: "1234567890abcdef1234567890abcdef12345678",
  nonce: "00112233445566778899aabbccddeeff",
  issuedAt: 1700,
};
const VECTOR_CANONICAL =
  "flagship/server-update/v1|home.alice.flagship.services|" +
  "9f2c1ab3de4567890abcdef1234567890abcdef1|1234567890abcdef1234567890abcdef12345678|" +
  "00112233445566778899aabbccddeeff|1700";
const VECTOR_SIG_HEX =
  "c9c0085c9e50a9d27a8e130045bf302e5ee350f519d07df66fc03e1e7345737de299ba92448b5a05315f1ae9183f42d40eae90e9f6f0f30a78de5e2ea8e1690d";

describe("webapp UpdateOrder canonical bytes — pinned cross-platform vector", () => {
  it("canonical string matches the TS source of truth exactly", async () => {
    const { canonicalUpdateOrderBytes } = await loadServerUpdate();
    expect(td.decode(canonicalUpdateOrderBytes(VECTOR))).toBe(VECTOR_CANONICAL);
  });

  it("signing under the 32×0x07 admin seed reproduces the pinned signature", async () => {
    const { canonicalUpdateOrderBytes } = await loadServerUpdate();
    const adminSeed = new Uint8Array(32).fill(0x07);
    const sig = ed25519.sign(canonicalUpdateOrderBytes(VECTOR), adminSeed);
    expect(toHex(sig)).toBe(VECTOR_SIG_HEX);
    // And the protocol verifier accepts the webapp-built bytes' signature.
    expect(
      verifyUpdateOrder(VECTOR, sig, ed25519.getPublicKey(adminSeed)),
    ).toBe(true);
  });

  it("rejects a '|' or control char in any string field", async () => {
    const { canonicalUpdateOrderBytes } = await loadServerUpdate();
    expect(() => canonicalUpdateOrderBytes({ ...VECTOR, targetCommit: "a|b" })).toThrow();
    expect(() => canonicalUpdateOrderBytes({ ...VECTOR, fromCommit: "a\nb" })).toThrow();
    expect(() => canonicalUpdateOrderBytes({ ...VECTOR, nonce: "a|b" })).toThrow();
  });
});

describe("webapp depositUpdateOrder — deposit body + order signature", () => {
  const TARGET = "9f2c1ab3de4567890abcdef1234567890abcdef1";
  const FROM = "1234567890abcdef1234567890abcdef12345678";

  it("POSTs {auth,authSignature,deposit,order,signature}; the order verifies under the signer", async () => {
    const { depositUpdateOrder } = await loadServerUpdate();

    const seed = new Uint8Array(32).fill(0x44);
    const irk = deriveIRK({ seed } as never);
    const ownerIrkPub = irk.publicKey;
    // Sign with the derived membership IRK (what the legacy signer does).
    const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) =>
      ed25519.sign(bytes, irk.privateKey.slice(0, 32));

    const serverDomain = "kitchen.harry.flagship.services";
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return {
        ok: true,
        json: async () => ({ ok: true, expiresAt: 1_750_000_100_000 }),
      } as unknown as Response;
    });

    await depositUpdateOrder(
      {
        serverDomain,
        targetCommit: TARGET,
        fromCommit: FROM,
        username: "harry",
        umk: seed,
        irkPubHex: toHex(ownerIrkPub),
        signWithIrk,
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        comBase: "https://com",
        now: () => 1_750_000_000_000,
      },
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(`https://com/api/server/${serverDomain}/update`);
    const body = captured!.body as {
      auth: { username: string; phoneIrkPub: string; issuedAt: number; expiresAt: number };
      authSignature: string;
      deposit: { serverDomain: string; requestNonceHex: string };
      order: UpdateOrder;
      signature: string;
    };
    // Mailbox auth wrapper — minted at send time, IRK-bound.
    expect(body.auth.username).toBe("harry");
    expect(body.auth.phoneIrkPub).toBe(toHex(ownerIrkPub));
    expect(body.auth.issuedAt).toBe(1_750_000_000_000);
    expect(body.auth.expiresAt).toBe(1_750_000_120_000);
    expect(typeof body.authSignature).toBe("string");
    // Deposit addressing — a fresh 32-byte request nonce.
    expect(body.deposit.serverDomain).toBe(serverDomain);
    expect(body.deposit.requestNonceHex).toMatch(/^[0-9a-f]{64}$/);
    // The order itself — commits verbatim, fresh nonce, send-time issuedAt.
    expect(body.order.serverDomain).toBe(serverDomain);
    expect(body.order.targetCommit).toBe(TARGET);
    expect(body.order.fromCommit).toBe(FROM);
    expect(body.order.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(body.order.issuedAt).toBe(1_750_000_000_000);
    // The signature verifies under @flagship/protocol (byte-identical canon).
    expect(verifyUpdateOrder(body.order, fromHex(body.signature), ownerIrkPub)).toBe(true);
    // Negative control: a different key must NOT verify.
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x66));
    expect(verifyUpdateOrder(body.order, fromHex(body.signature), otherPub)).toBe(false);
  });

  it("refuses a malformed targetCommit and a missing box-reported fromCommit", async () => {
    const { depositUpdateOrder } = await loadServerUpdate();
    const base = {
      serverDomain: "kitchen.harry.flagship.services",
      username: "harry",
      umk: new Uint8Array(32),
      irkPubHex: "ab".repeat(32),
      signWithIrk: async () => new Uint8Array(64),
    };
    await expect(
      depositUpdateOrder({ ...base, targetCommit: "deadbeef", fromCommit: "12".repeat(20) }),
    ).rejects.toThrow(/targetCommit/);
    await expect(
      depositUpdateOrder({ ...base, targetCommit: "9f".repeat(20), fromCommit: null }),
    ).rejects.toThrow(/current version/);
  });
});

describe("signing gate — flagship/server-update/v1 routes to the admin root", () => {
  it("is a SENSITIVE tag", async () => {
    const { SENSITIVE_TAGS, canonicalTag } = await loadAdminRoot();
    expect(SENSITIVE_TAGS.has("flagship/server-update/v1")).toBe(true);
    expect(canonicalTag(new TextEncoder().encode(VECTOR_CANONICAL))).toBe(
      "flagship/server-update/v1",
    );
  });

  it("an update order signs with the ADMIN root when present; mailbox auth stays IRK", async () => {
    const ks = await loadKeystore();
    const { makeSensitiveSigner } = await loadAdminRoot();

    const umk = new Uint8Array(32).fill(3);
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const adminPub = ks.hexToBytes(await ks.adminRootPubHex(adminSeed));
    const irk = await ks.deriveIrkFromSeed(umk);
    const sign = makeSensitiveSigner(adminSeed, (u: Uint8Array, b: Uint8Array) =>
      ks.signWithIrk(u, b),
    );

    // The ORDER: admin-root signed, NOT IRK.
    const orderBytes = new TextEncoder().encode(VECTOR_CANONICAL);
    const orderSig = await sign(umk, orderBytes);
    expect(await ks.verifyWithEd25519Pub(adminPub, orderSig, orderBytes)).toBe(true);
    expect(await ks.verifyWithEd25519Pub(irk.publicKey, orderSig, orderBytes)).toBe(false);

    // The co-signed mailbox AUTH: IRK signed, NOT admin root.
    const authBytes = new TextEncoder().encode(
      "flagship/device-endpoint-claim/v1|harry|webapp|deadbeef|1|2|nonce",
    );
    const authSig = await sign(umk, authBytes);
    expect(await ks.verifyWithEd25519Pub(irk.publicKey, authSig, authBytes)).toBe(true);
    expect(await ks.verifyWithEd25519Pub(adminPub, authSig, authBytes)).toBe(false);
  });
});
