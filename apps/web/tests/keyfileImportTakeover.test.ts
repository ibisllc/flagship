// H6 — `.flagshipkey` import must run the TAKEOVER re-pair (the security fix).
//
// Pins the testable core of lib/keyfileImportTakeover.js: a keyfile import is a
// TAKEOVER, so it MUST initiate the re-pair (POST /api/users/:u/re-pair) so the
// account's other devices are alerted + can object during the grace window —
// mirroring iOS/Android `KeyfileImportViewModel`. The webapp used to install a
// fresh local identity with NO server-side takeover at all.
//
// Asserts: the re-pair IS POSTed, and it ROTATES the IRK — old = the registered
// key, new = a fresh rotated device key (old != new, new != the registered key)
// so the control-plane re-pair handler accepts it. (It used to send old == new,
// which the handler rejects with 400 "newIrkPub equals current IRK" — keyfile
// recovery was dead on the webapp + iOS; Android already rotated. Found by the
// gym account-recovery e2e, 2026-06-18.) Also: the canonical bytes carry the
// `flagship/re-pair-initiate/v1` tag, the NEW (rotated) key signs, a 401+totpProof
// maps to the second-factor guidance (route to sign-in), and the admin profile
// is recorded.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadLib() {
  const path = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "keyfileImportTakeover.js",
  );
  return import(pathToFileURL(path).href);
}

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// v1 (registered) vs the rotated device key. A keyfile import rotates: old = v1,
// new = the next version, so they MUST differ.
const OLD_PUB = new Uint8Array(32).fill(0xa1);
const NEW_PUB = new Uint8Array(32).fill(0xb2);

function fakeArgs(overrides: Record<string, any> = {}) {
  const calls: Record<string, any> = { profiles: [], signedBytes: null, signedVersion: null };
  const seed = new Uint8Array(32).fill(7);
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(200, {
      ok: true,
      completesAt: 1000,
      graceMs: 500,
      accountType: "single",
    }),
  );
  const args = {
    username: "harry",
    seed,
    // OLD = the registered (v1) key under the recovered seed.
    deriveIrkFromSeed: vi.fn(async (_s: Uint8Array) => ({ publicKey: OLD_PUB })),
    // NEW = a fresh ROTATED device key (the real keystore's deriveIrkVersioned).
    deriveIrkVersioned: vi.fn(async (_s: Uint8Array, _v: number) => ({ publicKey: NEW_PUB })),
    // The NEW (rotated) key signs — record which version + bytes it signed.
    signWithIrkVersioned: vi.fn(async (_s: Uint8Array, version: number, bytes: Uint8Array) => {
      calls.signedBytes = bytes;
      calls.signedVersion = version;
      return new Uint8Array(64).fill(0xcc);
    }),
    bytesToHex: toHex,
    addProfile: vi.fn((p: object) => calls.profiles.push(p)),
    now: () => 1234567,
    fetch: fetchMock as any,
    ...overrides,
  };
  return { args, calls, seed, fetchMock };
}

describe("keyfileImportTakeover — INITIATES the takeover re-pair (H6)", () => {
  it("POSTs /re-pair ROTATING the IRK (old = registered, new = rotated; old != new)", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    const { args, fetchMock } = fakeArgs();

    const out = await runKeyfileImportTakeover(args);

    // The re-pair endpoint MUST have been called — this is the security fix.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/users/harry/re-pair");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    // ROTATION: old = the registered key, new = the rotated device key. The
    // handler rejects old==new ("nothing to swap"), so they MUST differ.
    expect(body.request.oldIrkPub).toBe(toHex(OLD_PUB));
    expect(body.request.newIrkPub).toBe(toHex(NEW_PUB));
    expect(body.request.newIrkPub).not.toBe(body.request.oldIrkPub);
    expect(body.request.username).toBe("harry");
    expect(body.request.issuedAt).toBe(1234567);
    expect(body.signature).toBe(toHex(new Uint8Array(64).fill(0xcc)));
    // No totpProof: a keyfile decrypt is single-device proof, like mobile.
    expect(body.totpProof).toBeUndefined();

    // Returns the grace fields for the countdown + the admin label + the rotated
    // version the completion step must finalize.
    expect(out.rePair.completesAt).toBe(1000);
    expect(out.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(out.newIrkVersion).toBeGreaterThanOrEqual(2);
  });

  it("signs the flagship/re-pair-initiate/v1 canonical bytes with the NEW (rotated) key", async () => {
    const { runKeyfileImportTakeover, TAG_RE_PAIR_INITIATE } = await loadLib();
    const { args, calls } = fakeArgs();
    const out = await runKeyfileImportTakeover(args);
    const signed = new TextDecoder().decode(calls.signedBytes);
    expect(TAG_RE_PAIR_INITIATE).toBe("flagship/re-pair-initiate/v1");
    // Canonical order: tag | username | newPub | oldPub | issuedAt.
    expect(signed).toBe(
      ["flagship/re-pair-initiate/v1", "harry", toHex(NEW_PUB), toHex(OLD_PUB), 1234567].join("|"),
    );
    // The signer used the rotated version, not v1.
    expect(calls.signedVersion).toBe(out.newIrkVersion);
  });

  it("records the device as the admin profile", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    const { args, calls } = fakeArgs();
    await runKeyfileImportTakeover(args);
    expect(calls.profiles).toHaveLength(1);
    expect(calls.profiles[0]).toMatchObject({
      cloudName: "harry",
      accountId: "harry",
      deviceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });
});

describe("keyfileImportTakeover — second-factor 401 routes to sign-in (#52 parity)", () => {
  it("maps a 401+totpProof to SecondFactorRequiredError with the mobile copy", async () => {
    const { runKeyfileImportTakeover, SecondFactorRequiredError, SECOND_FACTOR_GUIDANCE } =
      await loadLib();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: "missing totpProof" }));
    const { args } = fakeArgs({ fetch: fetchMock as any });

    await expect(runKeyfileImportTakeover(args)).rejects.toBeInstanceOf(
      SecondFactorRequiredError,
    );
    // The exact guidance must match iOS/Android so the three surfaces agree.
    expect(SECOND_FACTOR_GUIDANCE).toContain('"I already have an account"');
  });

  it("maps a 401 with credentialRequired[] to the same sentinel", async () => {
    const { runKeyfileImportTakeover, SecondFactorRequiredError } = await loadLib();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { credentialRequired: ["totp", "recovery-code"] }));
    const { args } = fakeArgs({ fetch: fetchMock as any });
    await expect(runKeyfileImportTakeover(args)).rejects.toBeInstanceOf(
      SecondFactorRequiredError,
    );
  });

  it("rethrows a non-credential failure unchanged (no silent skip)", async () => {
    const { runKeyfileImportTakeover, SecondFactorRequiredError } = await loadLib();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, "boom"));
    const { args } = fakeArgs({ fetch: fetchMock as any });
    const err = await runKeyfileImportTakeover(args).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SecondFactorRequiredError);
  });
});

describe("keyfileImportTakeover — guards", () => {
  it("rejects a missing username", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    const { args } = fakeArgs({ username: "" });
    await expect(runKeyfileImportTakeover(args)).rejects.toThrow(/missing username/);
  });

  it("rejects a malformed seed (not 32 bytes)", async () => {
    const { runKeyfileImportTakeover } = await loadLib();
    const { args } = fakeArgs({ seed: new Uint8Array(16) });
    await expect(runKeyfileImportTakeover(args)).rejects.toThrow(/malformed/);
  });
});
