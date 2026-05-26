// P11 — Wipe & restart webapp ceremony.
//
// Pins:
//   - canonical-bytes shape byte-for-byte against @flagship/protocol's
//     `canonicalWipeRestart` (the same envelope the iOS view-model
//     ships) — both in the literal "join(|)" shape and via a real
//     verifyWipeRestart round-trip with the derived OLD IRK.
//   - the POST shape (URL, headers, body keys + values incl. the
//     16-byte idempotencyKey shape).
//   - the error mapping for 412 / 429 / 409 / 403 / 400.
//   - the SHA-256 commit to wrappedUmkBytes (so the Worker's
//     `newWrappedUmkHashHex` recomputation matches).

import { describe, expect, it, vi } from "vitest";
import {
  canonicalWipeRestartBytes,
  newIdempotencyKey,
  newUmkSeed,
  runWipeRestartCeremony,
  sha256Hex,
  TAG_WIPE_RESTART,
} from "../public/webapp/lib/wipeRestartCeremony.js";
import { verifyWipeRestart, type WipeRestart } from "@flagship/protocol";

const USERNAME = "harry";

const FIXED_UMK = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_UMK[i] = (i * 11 + 5) & 0xff;

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Test stub for the passkey enrollment delegate. Returns a fixed
 *  credentialId + a wrap that's just the new UMK XOR'd with the
 *  credentialId bytes (NOT real crypto — the test pins the wire
 *  contract, not the wrap math; the Worker only hashes the bytes). */
function makeEnrollStub() {
  const credentialIdHex = "deadbeef".repeat(4); // 32 hex chars
  const wrappedUmkBytes = new Uint8Array(48); // arbitrary "wrap" payload
  for (let i = 0; i < wrappedUmkBytes.length; i++) wrappedUmkBytes[i] = i;
  const wrappedUmkB64 = Buffer.from(wrappedUmkBytes).toString("base64");
  return vi.fn(async (_umk: Uint8Array, _user: string) => ({
    credentialIdHex,
    wrappedUmkB64,
    wrappedUmkBytes,
  }));
}

describe("P11 — canonical-bytes shape", () => {
  it("uses the protocol's TAG_WIPE_RESTART", () => {
    expect(TAG_WIPE_RESTART).toBe("flagship/wipe-restart/v1");
  });

  it("composes the exact byte sequence with all 7 pieces joined by |", () => {
    const got = new TextDecoder().decode(
      canonicalWipeRestartBytes({
        username: USERNAME,
        oldIrkPubHex: "aa".repeat(32),
        newIrkPubHex: "bb".repeat(32),
        newCredentialIdHex: "CCDD",
        newWrappedUmkHashHex: "EEFF",
        issuedAt: 1700000000000,
      }),
    );
    expect(got).toBe(
      "flagship/wipe-restart/v1|harry|" +
        "aa".repeat(32) +
        "|" +
        "bb".repeat(32) +
        "|ccdd|eeff|1700000000000",
    );
  });

  it("lowercases the credentialId + wrappedUmkHash to match Worker canon", () => {
    const bytes = new TextDecoder().decode(
      canonicalWipeRestartBytes({
        username: USERNAME,
        oldIrkPubHex: "aa".repeat(32),
        newIrkPubHex: "bb".repeat(32),
        newCredentialIdHex: "ABcd1234",
        newWrappedUmkHashHex: "FEDC",
        issuedAt: 1,
      }),
    );
    expect(bytes).toContain("|abcd1234|");
    expect(bytes).toContain("|fedc|");
  });
});

describe("P11 — POST shape (happy path)", () => {
  it("POSTs to /api/users/:u/wipe-restart with the documented body keys", async () => {
    let captured: { url: string; init: any } | null = null;
    const fakeFetch = vi.fn(async (url: string, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === "etag" ? '"fresh-1"' : null) },
        json: async () => ({
          ok: true,
          auditSeq: 42,
          newIrkPub: "cc".repeat(32),
          revokedGrantIds: [],
        }),
        text: async () => "",
      };
    });
    const enroll = makeEnrollStub();
    const fixedIdempotency = "a".repeat(32);

    const result = await runWipeRestartCeremony(
      {
        username: USERNAME,
        umk: FIXED_UMK,
        ifMatch: "etag-1",
        enrollPasskey: enroll,
      },
      {
        fetch: fakeFetch as any,
        origin: "https://flagshipserver.com",
        now: () => 1700000000000,
        newUmk: () => {
          const u = new Uint8Array(32);
          for (let i = 0; i < 32; i++) u[i] = (i * 3 + 1) & 0xff;
          return u;
        },
        newIdempotencyKey: () => fixedIdempotency,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.auditSeq).toBe(42);
    expect(result.newCredentialIdHex).toBe("deadbeef".repeat(4));
    expect(result.newWrappedUmkB64).toBeDefined();
    expect(result.newUmk).toBeInstanceOf(Uint8Array);
    expect(result.newUmk.length).toBe(32);
    expect(result.freshEtag).toBe('"fresh-1"');

    expect(enroll).toHaveBeenCalledTimes(1);
    expect(captured!.url).toBe("https://flagshipserver.com/api/users/harry/wipe-restart");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers["content-type"]).toBe("application/json");
    expect(captured!.init.headers["if-match"]).toBe("etag-1");

    const body = JSON.parse(captured!.init.body);
    expect(body.request.username).toBe(USERNAME);
    expect(body.request.oldIrkPub).toMatch(/^[0-9a-f]{64}$/);
    expect(body.request.newIrkPub).toMatch(/^[0-9a-f]{64}$/);
    expect(body.request.newCredentialId).toBe("deadbeef".repeat(4));
    expect(typeof body.request.newWrappedUmk).toBe("string");
    expect(body.request.issuedAt).toBe(1700000000000);
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(body.idempotencyKey).toBe(fixedIdempotency);
    expect(body.idempotencyKey).toMatch(/^[0-9a-fA-F]{32}$/);
  });

  it("signs canonical bytes that VERIFY under the derived OLD IRK pub", async () => {
    // The OLD IRK signs; verifying against the body's oldIrkPub
    // (which is what the Worker uses to verify the displaced identity).
    let captured: { url: string; init: any } | null = null;
    const fakeFetch = vi.fn(async (url: string, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, auditSeq: 1, newIrkPub: "cc".repeat(32), revokedGrantIds: [] }),
        text: async () => "",
      };
    });
    const enroll = makeEnrollStub();
    await runWipeRestartCeremony(
      { username: USERNAME, umk: FIXED_UMK, ifMatch: null, enrollPasskey: enroll },
      {
        fetch: fakeFetch as any,
        origin: "https://flagshipserver.com",
        now: () => 1700000000000,
        newUmk: () => {
          const u = new Uint8Array(32);
          for (let i = 0; i < 32; i++) u[i] = (i * 3 + 1) & 0xff;
          return u;
        },
        newIdempotencyKey: () => "a".repeat(32),
      },
    );
    const body = JSON.parse(captured!.init.body);
    // The Worker computes newWrappedUmkHashHex from the base64-decoded
    // wrappedUmk bytes. Reproduce here for the verify.
    const wrappedBytes = Uint8Array.from(Buffer.from(body.request.newWrappedUmk, "base64"));
    const wrappedHash = await sha256Hex(wrappedBytes);
    const claim: WipeRestart = {
      username: body.request.username,
      oldIrkPub: hexToBytes(body.request.oldIrkPub),
      newIrkPub: hexToBytes(body.request.newIrkPub),
      newCredentialIdHex: body.request.newCredentialId,
      newWrappedUmkHashHex: wrappedHash,
      issuedAt: body.request.issuedAt,
    };
    const sig = hexToBytes(body.signature);
    expect(verifyWipeRestart(claim, sig, claim.oldIrkPub)).toBe(true);
  });

  it("commits SHA-256(wrappedUmkBytes) — not base64 chars — to the canonical bytes", async () => {
    // Pin the protocol detail: the Worker base64-decodes the
    // newWrappedUmk string and hashes the BYTES; the webapp must
    // hash the SAME bytes (NOT the base64 string).
    const wrappedBytes = new Uint8Array(48);
    for (let i = 0; i < 48; i++) wrappedBytes[i] = (i * 17) & 0xff;
    const wrappedB64 = Buffer.from(wrappedBytes).toString("base64");
    const expected = await sha256Hex(wrappedBytes);
    // Reproduce what the webapp does internally — the canonical bytes
    // carry `expected`, not sha256(wrappedB64).
    const bytes = new TextDecoder().decode(
      canonicalWipeRestartBytes({
        username: USERNAME,
        oldIrkPubHex: "aa".repeat(32),
        newIrkPubHex: "bb".repeat(32),
        newCredentialIdHex: "abcd",
        newWrappedUmkHashHex: expected,
        issuedAt: 1,
      }),
    );
    expect(bytes).toContain(expected);
    // And sanity: hashing the base64 string would NOT equal `expected`.
    const sha256OfB64 = await sha256Hex(new TextEncoder().encode(wrappedB64));
    expect(sha256OfB64).not.toBe(expected);
  });
});

describe("P11 — error mapping", () => {
  function mockOnce(status: number, body: any) {
    return vi.fn(async () => ({
      ok: false,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }));
  }

  const deps = {
    origin: "https://flagshipserver.com",
    now: () => 1700000000000,
    newUmk: () => new Uint8Array(32).fill(9),
    newIdempotencyKey: () => "a".repeat(32),
  };

  it("maps 412 with currentEtag", async () => {
    const fakeFetch = mockOnce(412, { error: "etag", currentEtag: "etag-2" });
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: FIXED_UMK, ifMatch: "etag-1", enrollPasskey: makeEnrollStub() },
        { ...deps, fetch: fakeFetch as any },
      ),
    ).rejects.toMatchObject({ code: "412", currentEtag: "etag-2" });
  });

  it("maps 429 with retryAfterMs", async () => {
    const fakeFetch = mockOnce(429, { error: "rate", retryAfterMs: 3600000 });
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: FIXED_UMK, ifMatch: null, enrollPasskey: makeEnrollStub() },
        { ...deps, fetch: fakeFetch as any },
      ),
    ).rejects.toMatchObject({ code: "429", retryAfterMs: 3600000 });
  });

  it("maps 409 to 'another rotation completed first'", async () => {
    const fakeFetch = mockOnce(409, { error: "concurrent" });
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: FIXED_UMK, ifMatch: null, enrollPasskey: makeEnrollStub() },
        { ...deps, fetch: fakeFetch as any },
      ),
    ).rejects.toMatchObject({ code: "409" });
  });

  it("maps 403 to 'rejected'", async () => {
    const fakeFetch = mockOnce(403, { error: "stale" });
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: FIXED_UMK, ifMatch: null, enrollPasskey: makeEnrollStub() },
        { ...deps, fetch: fakeFetch as any },
      ),
    ).rejects.toMatchObject({ code: "403" });
  });

  it("maps 400 to 'bad request'", async () => {
    const fakeFetch = mockOnce(400, { error: "malformed" });
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: FIXED_UMK, ifMatch: null, enrollPasskey: makeEnrollStub() },
        { ...deps, fetch: fakeFetch as any },
      ),
    ).rejects.toMatchObject({ code: "400" });
  });

  it("refuses to run without a 32-byte umk", async () => {
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: new Uint8Array(20), ifMatch: null, enrollPasskey: makeEnrollStub() },
        { ...deps, fetch: vi.fn() as any },
      ),
    ).rejects.toMatchObject({ code: "400" });
  });

  it("rejects an enrolPasskey that returns a malformed result", async () => {
    const badEnroll = vi.fn(async () => ({
      credentialIdHex: "ab",
      wrappedUmkB64: "abc",
      wrappedUmkBytes: "not-a-uint8array" as any,
    }));
    await expect(
      runWipeRestartCeremony(
        { username: USERNAME, umk: FIXED_UMK, ifMatch: null, enrollPasskey: badEnroll },
        { ...deps, fetch: vi.fn() as any },
      ),
    ).rejects.toMatchObject({ code: "400" });
  });
});

describe("P11 — utilities", () => {
  it("newIdempotencyKey produces 32 hex chars", () => {
    const k = newIdempotencyKey();
    expect(k).toMatch(/^[0-9a-f]{32}$/);
  });

  it("newUmkSeed produces a 32-byte Uint8Array", () => {
    const u = newUmkSeed();
    expect(u).toBeInstanceOf(Uint8Array);
    expect(u.length).toBe(32);
  });
});
