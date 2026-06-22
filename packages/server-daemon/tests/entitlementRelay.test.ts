/**
 * Entitlement-via-relay (docs/security-phone-as-unlock-endpoint.md §4, §9).
 *
 * The daemon, finding no entitlement bundle on disk, asks the user's phone
 * (through `.com`'s blind mailbox) to IRK-sign a RootEntitlement for this
 * box. These tests cover:
 *   - the SecretRequest is posted with the right purpose/nonce/STK + a
 *     signature that verifies under the box STK;
 *   - the happy path: the phone's carrier (the EntitlementBundle on-disk
 *     JSON, hex-encoded) is decoded, verified under the owner IRK, bound
 *     to this box's STK + canonical, persisted, and returned;
 *   - the carrier-decode + RootEntitlement-verify rejections (forged sig,
 *     wrong STK, wrong canonical, junk hex) all return null (→ fall back);
 *   - fallback-to-existing on timeout (no reply in the window) returns
 *     null without throwing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ed,
  mintDevEntitlements,
  verifySecretRequest,
  type Keypair,
} from "@flagship/protocol";
import {
  defaultEntitlementBundlePath,
  loadEntitlementBundle,
  serializeEntitlementBundle,
} from "../src/entitlementBundleStore.js";
import {
  buildEntitlementSecretRequest,
  claimEntitlementDeposit,
  decodeAndVerifyEntitlementCarrier,
  fetchEntitlementViaRelay,
} from "../src/entitlementRelay.js";

function makeKeypair(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const USERNAME = "alice";
const DOMAIN = "home.alice.flagship.services";
const CONTROL = "https://flagshipserver.com";

/** Build the carrier hex EXACTLY as the mobile agent does: the bundle's
 *  on-disk JSON, UTF-8 bytes, hex-encoded. */
function carrierHexFor(bundle: ReturnType<typeof mintDevEntitlements>): string {
  const json = serializeEntitlementBundle(bundle);
  return bytesToHex(new TextEncoder().encode(json));
}

/** A scripted fetch double: matches on URL+method and returns a Response-
 *  like object. POST always 200; GET returns the queued replies in order. */
function scriptedFetch(replies: Array<{ status: number; json?: unknown; text?: string }>): {
  fetchImpl: typeof fetch;
  posts: Array<{ url: string; body: unknown }>;
} {
  const posts: Array<{ url: string; body: unknown }> = [];
  let getIdx = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return mkResponse({ status: 200, json: { ok: true } });
    }
    const r = replies[getIdx] ?? { status: 404, json: { error: "no reply ready" } };
    getIdx += 1;
    return mkResponse(r);
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

function mkResponse(r: { status: number; json?: unknown; text?: string }) {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.json ?? {},
    text: async () => r.text ?? JSON.stringify(r.json ?? {}),
  } as unknown as Response;
}

describe("entitlementRelay — SecretRequest", () => {
  it("signs an entitlement SecretRequest the box STK verifies", () => {
    const stk = makeKeypair(0x22);
    const nonce = new Uint8Array(32).fill(0x07);
    const { request, signatureHex } = buildEntitlementSecretRequest({
      serverDomain: DOMAIN,
      identity: stk,
      nonce,
      issuedAt: 1_700_000_000_000,
    });
    expect(request.purpose).toBe("entitlement");
    expect(request.serverDomain).toBe(DOMAIN);
    expect(bytesToHex(request.stkPub)).toBe(bytesToHex(stk.publicKey));
    expect(bytesToHex(request.nonce)).toBe(bytesToHex(nonce));
    const sig = Uint8Array.from(
      signatureHex.match(/../g)!.map((h) => parseInt(h, 16)),
    );
    expect(verifySecretRequest(request, sig, stk.publicKey)).toBe(true);
  });
});

describe("entitlementRelay — carrier decode + verify", () => {
  let irk: Keypair;
  let stk: Keypair;
  beforeEach(() => {
    irk = makeKeypair(0x11);
    stk = makeKeypair(0x22);
  });

  it("decodes + verifies a well-formed carrier bound to this box", () => {
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    const got = decodeAndVerifyEntitlementCarrier({
      sealedHex: carrierHexFor(bundle),
      ownerIrkPub: irk.publicKey,
      serverDomain: DOMAIN,
      stkPub: stk.publicKey,
    });
    expect(got.rootEntitlement.podCanonical).toBe(DOMAIN);
    expect(bytesToHex(got.rootEntitlement.podPubKey)).toBe(bytesToHex(stk.publicKey));
  });

  it("rejects a carrier signed by the WRONG IRK (not a trust anchor)", () => {
    const wrongIrk = makeKeypair(0x99);
    const bundle = mintDevEntitlements({
      irk: wrongIrk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    expect(() =>
      decodeAndVerifyEntitlementCarrier({
        sealedHex: carrierHexFor(bundle),
        ownerIrkPub: irk.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }),
    ).toThrow(/signature does not verify/);
  });

  it("rejects a carrier minted for a DIFFERENT STK", () => {
    const otherStk = makeKeypair(0x33);
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: otherStk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    expect(() =>
      decodeAndVerifyEntitlementCarrier({
        sealedHex: carrierHexFor(bundle),
        ownerIrkPub: irk.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }),
    ).toThrow(/podPubKey/);
  });

  it("rejects a carrier minted for a DIFFERENT canonical", () => {
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: "evil.alice.flagship.services",
    });
    expect(() =>
      decodeAndVerifyEntitlementCarrier({
        sealedHex: carrierHexFor(bundle),
        ownerIrkPub: irk.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }),
    ).toThrow(/podCanonical/);
  });

  it("rejects non-hex / non-JSON carriers", () => {
    expect(() =>
      decodeAndVerifyEntitlementCarrier({
        sealedHex: "zzzz",
        ownerIrkPub: irk.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }),
    ).toThrow(/not valid hex/);
    const notJson = bytesToHex(new TextEncoder().encode("not json at all"));
    expect(() =>
      decodeAndVerifyEntitlementCarrier({
        sealedHex: notJson,
        ownerIrkPub: irk.publicKey,
        serverDomain: DOMAIN,
        stkPub: stk.publicKey,
      }),
    ).toThrow(/not valid JSON|rootEntitlement/);
  });
});

describe("entitlementRelay — full handshake", () => {
  let dir: string;
  let irk: Keypair;
  let stk: Keypair;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagship-entrelay-"));
    irk = makeKeypair(0x11);
    stk = makeKeypair(0x22);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("posts the request then persists the verified bundle on reply", async () => {
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    const path = defaultEntitlementBundlePath(dir);
    // First poll 404 (no reply yet), then 200 with the carrier.
    const { fetchImpl, posts } = scriptedFetch([
      { status: 404, json: { error: "no reply ready" } },
      {
        status: 200,
        json: {
          serverDomain: DOMAIN,
          requestNonceHex: bytesToHex(new Uint8Array(32).fill(0xab)),
          purpose: "entitlement",
          sealed: carrierHexFor(bundle),
          issuedAt: 1,
        },
      },
    ]);
    const result = await fetchEntitlementViaRelay({
      serverDomain: DOMAIN,
      identity: stk,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: path,
      windowMs: 60_000,
      fetchImpl,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      randomNonce: () => new Uint8Array(32).fill(0xab),
    });
    expect(result).not.toBeNull();
    expect(result!.rootEntitlement.podCanonical).toBe(DOMAIN);

    // The POST carried the right purpose + nonce + STK.
    expect(posts).toHaveLength(1);
    const sentBody = posts[0]!.body as { request: Record<string, unknown> };
    expect(sentBody.request.purpose).toBe("entitlement");
    expect(sentBody.request.nonce).toBe(bytesToHex(new Uint8Array(32).fill(0xab)));
    expect(sentBody.request.stkPub).toBe(bytesToHex(stk.publicKey));

    // It was persisted + re-loadable.
    const onDisk = await loadEntitlementBundle(path);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.rootEntitlement.podCanonical).toBe(DOMAIN);
    // The persisted bytes match the carrier JSON exactly.
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(JSON.parse(serializeEntitlementBundle(bundle)));
  });

  it("returns null (→ fall back) on timeout with no reply, without throwing", async () => {
    const path = defaultEntitlementBundlePath(dir);
    let t = 0;
    // Always 404; the clock advances each poll so the window closes.
    const { fetchImpl } = scriptedFetch(
      Array.from({ length: 100 }, () => ({ status: 404 as const })),
    );
    const result = await fetchEntitlementViaRelay({
      serverDomain: DOMAIN,
      identity: stk,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: path,
      windowMs: 30_000,
      pollBaseMs: 5_000,
      pollMaxMs: 5_000,
      fetchImpl,
      sleep: async () => {},
      now: () => {
        t += 6_000;
        return t;
      },
      randomNonce: () => new Uint8Array(32).fill(0x01),
    });
    expect(result).toBeNull();
    expect(await loadEntitlementBundle(path)).toBeNull();
  });

  it("returns null when the POST itself is rejected", async () => {
    const path = defaultEntitlementBundlePath(dir);
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return mkResponse({ status: 403, text: "stkPub does not match the registered server" });
      }
      return mkResponse({ status: 404 });
    }) as unknown as typeof fetch;
    const result = await fetchEntitlementViaRelay({
      serverDomain: DOMAIN,
      identity: stk,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: path,
      windowMs: 30_000,
      fetchImpl,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      randomNonce: () => new Uint8Array(32).fill(0x01),
    });
    expect(result).toBeNull();
  });

  it("returns null on a forged/mismatched carrier in the reply (→ fall back)", async () => {
    const wrongIrk = makeKeypair(0x99);
    const forged = mintDevEntitlements({
      irk: wrongIrk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    const path = defaultEntitlementBundlePath(dir);
    const { fetchImpl } = scriptedFetch([
      {
        status: 200,
        json: {
          serverDomain: DOMAIN,
          requestNonceHex: bytesToHex(new Uint8Array(32).fill(0x01)),
          purpose: "entitlement",
          sealed: carrierHexFor(forged),
          issuedAt: 1,
        },
      },
    ]);
    const result = await fetchEntitlementViaRelay({
      serverDomain: DOMAIN,
      identity: stk,
      ownerIrkPub: irk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: path,
      windowMs: 30_000,
      fetchImpl,
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      randomNonce: () => new Uint8Array(32).fill(0x01),
    });
    expect(result).toBeNull();
    // Nothing persisted — a forged reply never lands on disk.
    expect(await loadEntitlementBundle(path)).toBeNull();
  });
});

describe("entitlementRelay — claimEntitlementDeposit (phone-deposited, claimed before relay)", () => {
  let dir: string;
  let irk: Keypair;
  let stk: Keypair;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagship-edep-"));
    irk = makeKeypair(0x11);
    stk = makeKeypair(0x22);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("claims + verifies a deposited entitlement and persists it (single approval path)", async () => {
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    const { fetchImpl } = scriptedFetch([{ status: 200, json: { sealed: carrierHexFor(bundle) } }]);
    const path = defaultEntitlementBundlePath(dir);
    const got = await claimEntitlementDeposit({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      stkPub: stk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: path,
      fetchImpl,
      sleep: async () => {},
    });
    expect(got).not.toBeNull();
    expect(got!.rootEntitlement.podCanonical).toBe(DOMAIN);
    expect(await loadEntitlementBundle(path)).not.toBeNull();
  });

  it("returns null when no deposit is present, so the caller falls back to the relay", async () => {
    const { fetchImpl } = scriptedFetch([]); // every GET → 404
    const got = await claimEntitlementDeposit({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      stkPub: stk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: defaultEntitlementBundlePath(dir),
      attempts: 2,
      fetchImpl,
      sleep: async () => {},
    });
    expect(got).toBeNull();
  });

  it("rejects a carrier bound to a DIFFERENT STK (→ null, never a brick)", async () => {
    const wrongStk = makeKeypair(0x33);
    const bundle = mintDevEntitlements({
      irk,
      podPubKey: wrongStk.publicKey,
      username: USERNAME,
      podCanonical: DOMAIN,
    });
    const { fetchImpl } = scriptedFetch([{ status: 200, json: { sealed: carrierHexFor(bundle) } }]);
    const path = defaultEntitlementBundlePath(dir);
    const got = await claimEntitlementDeposit({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      stkPub: stk.publicKey,
      controlPlaneBaseUrl: CONTROL,
      entitlementBundlePath: path,
      fetchImpl,
      sleep: async () => {},
    });
    expect(got).toBeNull();
    expect(await loadEntitlementBundle(path)).toBeNull();
  });
});
