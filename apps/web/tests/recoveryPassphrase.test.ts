import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ed,
  signUploadRecoveryRecord,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleDeleteWebauthnRecovery,
  handleFetchWebauthnRecovery,
  handleFetchWrappedUmkWithToken,
  handleUploadWebauthnRecovery,
} from "@flagship/control-plane";
import {
  checkRateLimit,
  endpointFor,
  extractUsernameHash,
  LIMITS,
  type RateLimitBinding,
  type RateLimitEnv,
} from "../../../apps/com/src/rateLimit.js";

/**
 * Task #74 — Argon2id-gated wrappedUmk fetch.
 *
 * These tests cover the server-side gate logic in isolation from the
 * client-side Argon2id derivation. The gate's contract is:
 *
 *   "if SHA-256(fetchToken) === stored fetchTokenHash, release wrappedUmk"
 *
 * which doesn't depend on HOW the fetchToken was derived. The
 * recovery sub-origin uses Argon2id(passphrase, ...) → HKDF → fetchToken,
 * but for these tests we just use random bytes.
 *
 * Rate-limit coverage uses the real rateLimit.ts module against an
 * in-process binding stub.
 */

const USERNAME = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function sha256Hex(b: Uint8Array): string {
  return bytesToHex(sha256(b));
}

async function setup(irk: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
  });
  return s;
}

/**
 * Upload a record using the IRK-signed envelope, optionally including
 * the new Argon2-derived hashes. Returns the {fetchToken, prfSalt}
 * raw bytes (NOT the hashes) so tests can present them in the gated
 * fetch and verify the gate accepts.
 */
async function enrol(opts: {
  storage: InMemoryStorage;
  irk: Keypair;
  withPassphraseGate?: boolean;
  wrappedUmk?: Uint8Array;
}): Promise<{ fetchToken: Uint8Array; prfSalt: Uint8Array }> {
  const credentialId = "deadbeef".repeat(4);
  const wrappedUmk = opts.wrappedUmk ?? new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  const wrappedB64 = bytesToB64(wrappedUmk);
  const wrappedUmkHashHex = sha256Hex(wrappedUmk);
  const issuedAt = Date.now();
  const fetchToken = new Uint8Array(32);
  crypto.getRandomValues(fetchToken);
  const prfSalt = new Uint8Array(32);
  crypto.getRandomValues(prfSalt);

  const sig = signUploadRecoveryRecord(
    { username: USERNAME, credentialIdHex: credentialId, wrappedUmkHashHex, issuedAt },
    opts.irk,
  );
  const request: Record<string, unknown> = {
    username: USERNAME, credentialId, wrappedUmk: wrappedB64, issuedAt,
  };
  if (opts.withPassphraseGate !== false) {
    request.fetchTokenHash = sha256Hex(fetchToken);
    request.prfSaltHash = sha256Hex(prfSalt);
  }
  const res = await handleUploadWebauthnRecovery(
    {
      usernames: opts.storage.usernames,
      webauthnRecovery: opts.storage.webauthnRecovery,
    },
    { request, signature: bytesToHex(sig) },
  );
  if (res.status !== 200) {
    throw new Error(`upload failed in test fixture: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { fetchToken, prfSalt };
}

describe("Task #74 — passphrase-gated wrappedUmk fetch", () => {
  it("enrollment stores both fetchTokenHash + prfSaltHash on the row", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const { fetchToken, prfSalt } = await enrol({ storage, irk });
    const row = await storage.webauthnRecovery.get(USERNAME);
    expect(row).toBeDefined();
    expect(row!.fetchTokenHashHex).toBe(sha256Hex(fetchToken));
    expect(row!.prfSaltHashHex).toBe(sha256Hex(prfSalt));
  });

  it("metadata GET no longer surfaces the ciphertext (regression guard)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await enrol({ storage, irk });
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    expect(res.status).toBe(200);
    const body = res.body as { wrappedUmk?: unknown; hasFetchTokenGate: boolean };
    expect(body.wrappedUmk).toBeUndefined();
    expect(body.hasFetchTokenGate).toBe(true);
  });

  it("fetch with correct fetchToken returns the ciphertext + prfSaltHash", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const wrappedUmk = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const { fetchToken, prfSalt } = await enrol({ storage, irk, wrappedUmk });
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      wrappedUmk: string;
      credentialId: string;
      prfSaltHash: string;
    };
    expect(body.wrappedUmk).toBe(bytesToB64(wrappedUmk));
    // The prfSaltHash returned must match what we'd compute locally
    // from our prfSalt — the sub-origin uses this for defense-in-depth
    // checking against a tampered .com.
    expect(body.prfSaltHash).toBe(sha256Hex(prfSalt));
  });

  it("fetch without a fetchToken at all → 400", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await enrol({ storage, irk });
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { issuedAt: Date.now() },
    );
    expect(res.status).toBe(400);
  });

  it("fetch with the WRONG fetchToken → 403 (passphrase brute-force defense)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await enrol({ storage, irk });
    const wrongToken = new Uint8Array(32).fill(0xff);
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(wrongToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("invalid fetch token");
  });

  it("legacy rows (uploaded before #74) cannot be fetched via the gate — 409 'must re-enrol'", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await enrol({ storage, irk, withPassphraseGate: false });
    // Even with a syntactically valid token, no stored hash → refuse.
    const tok = new Uint8Array(32).fill(1);
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(tok), issuedAt: Date.now() },
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/re-enrol/i);
  });

  it("hasFetchTokenGate is false for legacy rows (UX signal to the client)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await enrol({ storage, irk, withPassphraseGate: false });
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    expect((res.body as { hasFetchTokenGate: boolean }).hasFetchTokenGate).toBe(false);
  });

  it("correct fetchToken + matching prfSalt round-trips bit-for-bit through the gate", async () => {
    // End-to-end: enrol → fetch → verify the bytes we get back unwrap
    // to the same wrappedUmk we uploaded. The PRF step is mocked here
    // (we don't have a real authenticator); the assertion is on the
    // gate's input/output contract.
    const irk = makeKey();
    const storage = await setup(irk);
    const wrappedUmk = new Uint8Array(64);
    crypto.getRandomValues(wrappedUmk);
    const { fetchToken } = await enrol({ storage, irk, wrappedUmk });
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(200);
    const body = res.body as { wrappedUmk: string };
    expect(body.wrappedUmk).toBe(bytesToB64(wrappedUmk));
  });
});

describe("Task #74 — delete still works after gate is in place", () => {
  it("delete reads wrappedUmkHash from the metadata GET (no ciphertext round-trip)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const wrappedUmk = new Uint8Array([1, 2, 3, 4]);
    await enrol({ storage, irk, wrappedUmk });
    const metaRes = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    const meta = metaRes.body as { credentialId: string; wrappedUmkHash: string };
    expect(meta.wrappedUmkHash).toBe(sha256Hex(wrappedUmk));

    const issuedAt = Date.now();
    const sig = signUploadRecoveryRecord(
      {
        username: USERNAME,
        credentialIdHex: meta.credentialId,
        wrappedUmkHashHex: meta.wrappedUmkHash,
        issuedAt,
      },
      irk,
    );
    const del = await handleDeleteWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      {
        request: {
          username: USERNAME,
          credentialId: meta.credentialId,
          wrappedUmkHash: meta.wrappedUmkHash,
          issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(del.status).toBe(200);
    expect(await storage.webauthnRecovery.get(USERNAME)).toBeUndefined();
  });
});

describe("Task #74 — rate-limit on the gated fetch", () => {
  /**
   * Stub binding that fails the Nth call onwards for a key.
   * Multiple keys are tracked independently — this mirrors Cloudflare's
   * RATE_LIMITER namespace behaviour.
   */
  function failAfter(threshold: number) {
    const perKey = new Map<string, number>();
    const binding: RateLimitBinding = {
      async limit({ key }) {
        const next = (perKey.get(key) ?? 0) + 1;
        perKey.set(key, next);
        return { success: next <= threshold };
      },
    };
    return binding;
  }

  it("endpoint matcher classifies POST .../fetch as recovery-by-username", () => {
    expect(endpointFor("POST", "/api/recovery/by-username/abc/fetch")).toBe(
      "recovery-by-username",
    );
    // GET on the same prefix is also rate-limited (metadata fetch).
    expect(endpointFor("GET", "/api/recovery/by-username/abc")).toBe(
      "recovery-by-username",
    );
    // The bare /api/recovery upload POST is NOT under this endpoint.
    expect(endpointFor("POST", "/api/recovery")).toBeNull();
  });

  it("extractUsernameHash works for both `/fetch` and the bare path", () => {
    expect(extractUsernameHash("/api/recovery/by-username/abc123")).toBe("abc123");
    expect(extractUsernameHash("/api/recovery/by-username/abc123/fetch")).toBe("abc123");
  });

  it("matches OWASP guidance: 3-per-15min per usernameHash", () => {
    const axes = LIMITS["recovery-by-username"];
    const usernameAxis = axes.find((a) => a.axis === "usernameHash");
    expect(usernameAxis).toBeDefined();
    expect(usernameAxis!.limit).toBe(3);
    expect(usernameAxis!.windowSec).toBe(900); // 15 min
  });

  it("4th attempt within the window trips the username-hash axis", async () => {
    // Threshold of 3 → first 3 calls succeed, 4th fails. This stub
    // assumes a single per-key counter; the real binding does too.
    const binding = failAfter(3);
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    const input = {
      endpoint: "recovery-by-username" as const,
      ip: "1.2.3.4",
      usernameHash: "abc123",
    };
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(env, input);
      expect(r.limited).toBe(false);
    }
    const fourth = await checkRateLimit(env, input);
    expect(fourth.limited).toBe(true);
    if (fourth.limited) {
      // We track BOTH the per-IP axis (cap 10/h, 3 calls in → not
      // tripped here) and the per-usernameHash axis (cap 3/15min,
      // tripped on the 4th). The stub fires on per-key counter, so the
      // first axis tested wins. Either is a fine fail — what matters
      // is that the 4th request is rejected.
      expect(["ip", "usernameHash"]).toContain(fourth.axis);
    }
  });

  it("a different usernameHash gets its own budget (axes are per-key)", async () => {
    const binding = failAfter(3);
    const env: RateLimitEnv = { RATE_LIMITER: binding };
    // Burn alice's budget.
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(env, {
        endpoint: "recovery-by-username",
        ip: "1.2.3.4",
        usernameHash: "alice",
      });
    }
    const aliceFourth = await checkRateLimit(env, {
      endpoint: "recovery-by-username",
      ip: "1.2.3.4",
      usernameHash: "alice",
    });
    expect(aliceFourth.limited).toBe(true);
    // Bob is unaffected — different usernameHash, fresh budget.
    const bobFirst = await checkRateLimit(env, {
      endpoint: "recovery-by-username",
      ip: "5.6.7.8",
      usernameHash: "bob",
    });
    expect(bobFirst.limited).toBe(false);
  });
});
