// TrustException signing + verify + .com sync (lib/trustException.js) and the
// override orchestrator (lib/trustOverride.js). The signing uses the REAL
// WebCrypto Ed25519 (the webapp's device key path), so the canonical bytes +
// self-sig verify roundtrip is genuine, not mocked.

import { describe, expect, it, beforeEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

const EX_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/trustException.js"),
).href;
const OV_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/trustOverride.js"),
).href;
const TRUST_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/serverTrust.js"),
).href;

async function loadEx() {
  return import(EX_URL);
}
async function loadOv() {
  return import(OV_URL);
}
async function loadTrust() {
  return import(TRUST_URL);
}

const CERT_HASH = "ab".repeat(32); // 64 hex

// A deterministic device keypair via WebCrypto Ed25519 (export raw pub).
async function deviceKey() {
  const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, rawPub };
}

// Build the injected signing seam: deriveIrk returns {publicKey}, signWithIrk
// signs the canonical bytes under the same key.
function signingDeps(dev: { kp: CryptoKeyPair; rawPub: Uint8Array }) {
  return {
    deriveIrk: async () => ({ publicKey: dev.rawPub }),
    signWithIrk: async (_umk: unknown, canonical: Uint8Array) =>
      new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, dev.kp.privateKey, canonical)),
    verifyEd25519: async (pub: Uint8Array, sig: Uint8Array, msg: Uint8Array) => {
      try {
        const k = await webcrypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
        return await webcrypto.subtle.verify({ name: "Ed25519" }, k, sig, msg);
      } catch {
        return false;
      }
    },
  };
}

describe("trustException — canonical bytes", () => {
  it("tag + field order is flagship/trust-exception/v1|certClass|certHash|grantedAt|grantedByDevicePub", async () => {
    const ex = await loadEx();
    const bytes = ex.canonicalTrustException({
      certClass: "control",
      certHash: CERT_HASH,
      grantedAt: 1234,
      grantedByDevicePub: "cd".repeat(32),
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      `flagship/trust-exception/v1|control|${CERT_HASH}|1234|${"cd".repeat(32)}`,
    );
  });

  it("rejects '|' / control chars in a field", async () => {
    const ex = await loadEx();
    expect(() =>
      ex.canonicalTrustException({
        certClass: "con|trol",
        certHash: CERT_HASH,
        grantedAt: 1,
        grantedByDevicePub: "cd".repeat(32),
      }),
    ).toThrow();
  });
});

describe("trustException — sign + self-verify roundtrip", () => {
  it("builds a well-formed envelope that self-verifies", async () => {
    const ex = await loadEx();
    const dev = await deviceKey();
    const deps = signingDeps(dev);
    const env = await ex.buildSignedTrustException(
      { umk: new Uint8Array(32), certClass: "control", certHash: CERT_HASH, grantedAt: 999 },
      deps,
    );
    expect(env).toMatchObject({
      kind: "TrustException",
      version: 1,
      certClass: "control",
      certHash: CERT_HASH,
      grantedAt: 999,
    });
    expect(env.signatures).toHaveLength(1);
    expect(env.grantedByDevicePub).toBe(env.signatures[0].pubkey);
    expect(await ex.verifyTrustExceptionSelfSig(env, deps)).toBe(true);
  });

  it("a tampered cert-hash fails self-verify", async () => {
    const ex = await loadEx();
    const dev = await deviceKey();
    const deps = signingDeps(dev);
    const env = await ex.buildSignedTrustException(
      { umk: new Uint8Array(32), certClass: "control", certHash: CERT_HASH },
      deps,
    );
    const tampered = { ...env, certHash: "ff".repeat(32) };
    expect(await ex.verifyTrustExceptionSelfSig(tampered, deps)).toBe(false);
  });

  it("rejects a non-64-hex certHash at build time", async () => {
    const ex = await loadEx();
    const dev = await deviceKey();
    await expect(
      ex.buildSignedTrustException(
        { umk: new Uint8Array(32), certClass: "control", certHash: "short" },
        signingDeps(dev),
      ),
    ).rejects.toThrow();
  });
});

describe("trustException — .com sync", () => {
  it("POST hits /api/users/:u/trust-exceptions with the envelope", async () => {
    const ex = await loadEx();
    let hitUrl = "";
    let hitBody = "";
    const fetch = async (u: string, init: { body: string }) => {
      hitUrl = u;
      hitBody = init.body;
      return { ok: true, status: 200 };
    };
    const env = { kind: "TrustException", certHash: CERT_HASH };
    const r = await ex.postTrustException("alice", env, { fetch });
    expect(r.ok).toBe(true);
    expect(hitUrl).toBe("https://flagshipserver.com/api/users/alice/trust-exceptions");
    expect(JSON.parse(hitBody).certHash).toBe(CERT_HASH);
  });

  it("GET returns only self-verifying exceptions", async () => {
    const ex = await loadEx();
    const dev = await deviceKey();
    const deps = signingDeps(dev);
    const good = await ex.buildSignedTrustException(
      { umk: new Uint8Array(32), certClass: "control", certHash: CERT_HASH },
      deps,
    );
    const forged = { ...good, certHash: "ee".repeat(32) }; // sig won't match
    const fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ exceptions: [good, forged] }),
    });
    const verified = await ex.fetchTrustExceptions("alice", { ...deps, fetch });
    expect(verified).toHaveLength(1);
    expect(verified[0].certHash).toBe(CERT_HASH);
  });

  it("a network failure on GET returns [] (best-effort)", async () => {
    const ex = await loadEx();
    const fetch = async () => {
      throw new Error("offline");
    };
    expect(await ex.fetchTrustExceptions("alice", { fetch })).toEqual([]);
  });
});

function makeKv() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string) => m.get(k),
    put: async (k: string, v: unknown) => void m.set(k, v),
  };
}

describe("trustOverride — grant + persist + apply + post", () => {
  beforeEach(async () => {
    (await loadTrust()).serverTrust._reset();
  });

  it("signs, persists, marks overridden, and POSTs", async () => {
    const ov = await loadOv();
    const t = await loadTrust();
    const dev = await deviceKey();
    const kv = makeKv();
    let posted = false;
    const deps = {
      ...signingDeps(dev),
      kv,
      profileId: "p1",
      fetch: async () => {
        posted = true;
        return { ok: true, status: 200 };
      },
    };

    const { ex, posted: postResult } = await ov.grantTrustException(
      { umk: new Uint8Array(32), certClass: "control", certHash: CERT_HASH, username: "alice" },
      deps,
    );
    expect(ex.certHash).toBe(CERT_HASH);
    expect(postResult.ok).toBe(true);
    expect(posted).toBe(true);
    // Persisted locally...
    expect(await ov.loadLocalExceptions(deps)).toHaveLength(1);
    // ...and marked overridden in the live store.
    expect(t.serverTrust.isOverridden(CERT_HASH)).toBe(true);
  });

  it("skips the POST when no username is supplied (still persists + applies)", async () => {
    const ov = await loadOv();
    const t = await loadTrust();
    const dev = await deviceKey();
    const deps = { ...signingDeps(dev), kv: makeKv(), profileId: "p2" };
    const { posted } = await ov.grantTrustException(
      { umk: new Uint8Array(32), certClass: "control", certHash: CERT_HASH },
      deps,
    );
    expect(posted.ok).toBe(false);
    expect(t.serverTrust.isOverridden(CERT_HASH)).toBe(true);
  });
});

describe("trustOverride — boot apply (fleet-wide one-acceptance)", () => {
  beforeEach(async () => {
    (await loadTrust()).serverTrust._reset();
  });

  it("re-applies local exceptions and pulls+applies the verified directory set", async () => {
    const ex = await loadEx();
    const ov = await loadOv();
    const t = await loadTrust();
    const dev = await deviceKey();
    const deps0 = signingDeps(dev);

    // A locally-persisted exception (this device accepted it earlier).
    const kv = makeKv();
    const localEx = await ex.buildSignedTrustException(
      { umk: new Uint8Array(32), certClass: "control", certHash: CERT_HASH },
      deps0,
    );
    await ov.persistLocalException(localEx, { kv, profileId: "p3" });

    // A DIFFERENT cert accepted on another device, served by .com.
    const otherHash = "12".repeat(32);
    const remoteEx = await ex.buildSignedTrustException(
      { umk: new Uint8Array(32), certClass: "relay", certHash: otherHash },
      deps0,
    );
    const deps = {
      ...deps0,
      kv,
      profileId: "p3",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ exceptions: [remoteEx] }) }),
    };

    await ov.loadAndApplyExceptions("alice", deps);
    expect(t.serverTrust.isOverridden(CERT_HASH)).toBe(true); // local
    expect(t.serverTrust.isOverridden(otherHash)).toBe(true); // remote
    // The remote one was also persisted locally for next boot.
    const persisted = await ov.loadLocalExceptions({ kv, profileId: "p3" });
    expect(persisted.map((e: { certHash: string }) => e.certHash).sort()).toEqual(
      [CERT_HASH, otherHash].sort(),
    );
  });
});
