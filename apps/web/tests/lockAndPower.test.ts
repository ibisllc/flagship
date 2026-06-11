// Lock & power-off + dead-man heartbeat-lock — webapp client tests.
//
// Pins:
//   - canonical-bytes shape byte-for-byte AND signature-round-trip against
//     @flagship/protocol's signPhoneOrder (power-off) /
//     signSetDeadManPolicy / signDeadManAffirmation (the same envelopes the
//     iOS / Android view-models ship + the daemon verifies).
//   - the POST shapes (URL, headers, body keys + values) for all three
//     endpoints: /api/power, /api/deadman/policy, /api/deadman/affirm.
//   - mode/lockout vocabulary guards ({off,restart}).
//   - locked-webapp guard (no umk / signWithIrk).
//   - the fresh 16-byte affirmation nonce + leaseExpiry surfacing.
//   - fmtRemaining countdown formatting.

import { describe, expect, it, vi } from "vitest";
import {
  canonicalPowerOffBytes,
  canonicalDeadManPolicyBytes,
  canonicalDeadManAffirmBytes,
  sendPowerOff,
  setDeadManPolicy,
  affirmDeadMan,
  fmtRemaining,
  DEADMAN_WINDOW_PRESETS,
  DEADMAN_TIGHTEN_PRESET,
  DEADMAN_DEFAULT_PRESET,
  TAG_ORDER_POWER_OFF,
  TAG_SET_DEADMAN_POLICY,
  TAG_DEADMAN_AFFIRM,
} from "../public/webapp/lib/lockAndPower.js";
import {
  signPhoneOrder,
  verifyPhoneOrder,
  signSetDeadManPolicy,
  verifySetDeadManPolicy,
  signDeadManAffirmation,
  verifyDeadManAffirmation,
  ed,
  type PhoneOrder,
  type SetDeadManPolicy,
  type DeadManAffirmation,
} from "@flagship/protocol";

const POD = "https://home.harry.flagship.services";
const SERVER_ID = "home.harry.flagship.services";

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
function fixedKey() {
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) priv[i] = (i * 7 + 1) & 0xff;
  const pub = ed.getPublicKey(priv);
  return { priv, pub };
}

// ---------------------------------------------------------------------------
// Canonical-bytes parity
// ---------------------------------------------------------------------------

describe("lock&power — canonical-bytes tags", () => {
  it("mirror the protocol tags", () => {
    expect(TAG_ORDER_POWER_OFF).toBe("flagship/order/power-off/v1");
    expect(TAG_SET_DEADMAN_POLICY).toBe("flagship/set-deadman-policy/v1");
    expect(TAG_DEADMAN_AFFIRM).toBe("flagship/deadman-affirm/v1");
  });
});

describe("power-off — canonical-bytes parity with @flagship/protocol", () => {
  for (const mode of ["off", "restart"] as const) {
    it(`composes the exact byte string (${mode}) and verifies under signPhoneOrder`, () => {
      const issuedAt = 1700000000000;
      const got = new TextDecoder().decode(
        canonicalPowerOffBytes({ serverId: SERVER_ID, mode, issuedAt }),
      );
      expect(got).toBe(`flagship/order/power-off/v1|${SERVER_ID}|${mode}|${issuedAt}`);

      const { priv, pub } = fixedKey();
      const order: PhoneOrder = { type: "power-off", serverId: SERVER_ID, mode, issuedAt };
      const sig = signPhoneOrder(order, { privateKey: priv, publicKey: pub });
      // The webapp's canonical bytes MUST verify under the protocol signer.
      expect(ed.verify(sig, canonicalPowerOffBytes({ serverId: SERVER_ID, mode, issuedAt }), pub)).toBe(true);
      expect(verifyPhoneOrder(order, sig, pub)).toBe(true);
    });
  }

  it("rejects an invalid mode at canonicalization", () => {
    expect(() => canonicalPowerOffBytes({ serverId: SERVER_ID, mode: "halt" as any, issuedAt: 1 })).toThrow();
  });
});

describe("set-deadman-policy — canonical-bytes parity with @flagship/protocol", () => {
  for (const enabled of [true, false]) {
    for (const lockoutMode of ["off", "restart"] as const) {
      it(`composes exact bytes + verifies (enabled=${enabled}, lockout=${lockoutMode})`, () => {
        const policy = {
          serverId: SERVER_ID,
          enabled,
          windowMs: 86_400_000,
          graceMs: 21_600_000,
          lockoutMode,
          issuedAt: 1700000000000,
        };
        const got = new TextDecoder().decode(canonicalDeadManPolicyBytes(policy));
        expect(got).toBe(
          `flagship/set-deadman-policy/v1|${SERVER_ID}|${enabled ? "1" : "0"}|86400000|21600000|${lockoutMode}|1700000000000`,
        );
        const { priv, pub } = fixedKey();
        const p: SetDeadManPolicy = policy;
        const sig = signSetDeadManPolicy(p, { privateKey: priv, publicKey: pub });
        expect(ed.verify(sig, canonicalDeadManPolicyBytes(policy), pub)).toBe(true);
        expect(verifySetDeadManPolicy(p, sig, pub)).toBe(true);
      });
    }
  }

  it("rejects an invalid lockout mode", () => {
    expect(() =>
      canonicalDeadManPolicyBytes({
        serverId: SERVER_ID,
        enabled: true,
        windowMs: 1,
        graceMs: 0,
        lockoutMode: "wipe" as any,
        issuedAt: 1,
      }),
    ).toThrow();
  });
});

describe("deadman-affirm — canonical-bytes parity with @flagship/protocol", () => {
  it("composes the exact byte string and verifies under signDeadManAffirmation", () => {
    const nonce = new Uint8Array(16);
    for (let i = 0; i < 16; i++) nonce[i] = (i * 11 + 3) & 0xff;
    const nonceHex = bytesToHex(nonce);
    const issuedAt = 1700000000000;
    const got = new TextDecoder().decode(
      canonicalDeadManAffirmBytes({ serverId: SERVER_ID, nonceHex, issuedAt }),
    );
    expect(got).toBe(`flagship/deadman-affirm/v1|${SERVER_ID}|${nonceHex}|${issuedAt}`);

    const { priv, pub } = fixedKey();
    const affirm: DeadManAffirmation = { serverId: SERVER_ID, nonce, issuedAt };
    const sig = signDeadManAffirmation(affirm, { privateKey: priv, publicKey: pub });
    expect(ed.verify(sig, canonicalDeadManAffirmBytes({ serverId: SERVER_ID, nonceHex, issuedAt }), pub)).toBe(true);
    expect(verifyDeadManAffirmation(affirm, sig, pub)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST shapes
// ---------------------------------------------------------------------------

function captureFetch(responseBody: any = { ok: true }) {
  const captured: { url: string; init: any }[] = [];
  const fetchFn = vi.fn(async (url: string, init: any) => {
    captured.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody),
      json: async () => responseBody,
    };
  });
  return { captured, fetchFn };
}

// Real Ed25519 signer over the canonical bytes the lib hands it, so the
// posted signature actually verifies under the protocol pubkey.
const realSigner = (priv: Uint8Array) => async (_umk: Uint8Array, bytes: Uint8Array) =>
  ed.sign(bytes, priv);

describe("sendPowerOff — POST shape", () => {
  it("POSTs an IRK-signed power-off order to <pod>/api/power", async () => {
    const { captured, fetchFn } = captureFetch({ ok: true, mode: "restart" });
    const { priv, pub } = fixedKey();
    const res = await sendPowerOff(
      { baseUrl: POD, mode: "restart", umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
      { fetch: fetchFn as any, bytesToHex, now: () => 1700000000000 },
    );
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("restart");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`${POD}/api/power`);
    expect(captured[0]!.init.method).toBe("POST");
    expect(captured[0]!.init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(captured[0]!.init.body);
    expect(body.request).toEqual({
      type: "power-off",
      serverId: SERVER_ID,
      mode: "restart",
      issuedAt: 1700000000000,
    });
    // The posted signature must verify against the canonical bytes.
    expect(
      ed.verify(
        hexToBytes(body.signature),
        canonicalPowerOffBytes({ serverId: SERVER_ID, mode: "restart", issuedAt: 1700000000000 }),
        pub,
      ),
    ).toBe(true);
  });

  it("refuses on a locked webapp (no umk)", async () => {
    await expect(
      sendPowerOff({ baseUrl: POD, mode: "off" } as any, {}),
    ).rejects.toMatchObject({ code: "400" });
  });

  it("rejects an unknown mode before POSTing", async () => {
    const { fetchFn } = captureFetch();
    await expect(
      sendPowerOff(
        { baseUrl: POD, mode: "halt" as any, umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64) },
        { fetch: fetchFn as any },
      ),
    ).rejects.toMatchObject({ code: "400" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a non-2xx pod response to the status code", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403, text: async () => "nope", json: async () => ({}) }));
    const { priv } = fixedKey();
    await expect(
      sendPowerOff(
        { baseUrl: POD, mode: "off", umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
        { fetch: fetchFn as any, bytesToHex },
      ),
    ).rejects.toMatchObject({ code: "403" });
  });

  it("maps a network failure to code=network", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); });
    const { priv } = fixedKey();
    await expect(
      sendPowerOff(
        { baseUrl: POD, mode: "off", umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
        { fetch: fetchFn as any, bytesToHex },
      ),
    ).rejects.toMatchObject({ code: "network" });
  });
});

describe("setDeadManPolicy — POST shape", () => {
  it("POSTs an IRK-signed policy to <pod>/api/deadman/policy", async () => {
    const { captured, fetchFn } = captureFetch({ ok: true, enabled: true });
    const { priv, pub } = fixedKey();
    const res = await setDeadManPolicy(
      {
        baseUrl: POD,
        enabled: true,
        windowMs: 86_400_000,
        graceMs: 21_600_000,
        lockoutMode: "off",
        umk: new Uint8Array(32),
        signWithIrk: realSigner(priv),
      },
      { fetch: fetchFn as any, bytesToHex, now: () => 1700000000000 },
    );
    expect(res.ok).toBe(true);
    expect(captured[0]!.url).toBe(`${POD}/api/deadman/policy`);
    const body = JSON.parse(captured[0]!.init.body);
    expect(body.request).toEqual({
      serverId: SERVER_ID,
      enabled: true,
      windowMs: 86_400_000,
      graceMs: 21_600_000,
      lockoutMode: "off",
      issuedAt: 1700000000000,
    });
    expect(
      ed.verify(hexToBytes(body.signature), canonicalDeadManPolicyBytes(body.request), pub),
    ).toBe(true);
  });

  it("refuses on a locked webapp", async () => {
    await expect(
      setDeadManPolicy({ baseUrl: POD, enabled: true, windowMs: 1, graceMs: 0, lockoutMode: "off" } as any, {}),
    ).rejects.toMatchObject({ code: "400" });
  });

  it("rejects a bad lockout mode / non-positive window", async () => {
    const { priv } = fixedKey();
    await expect(
      setDeadManPolicy(
        { baseUrl: POD, enabled: true, windowMs: 1, graceMs: 0, lockoutMode: "wipe" as any, umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
        { bytesToHex },
      ),
    ).rejects.toMatchObject({ code: "400" });
    await expect(
      setDeadManPolicy(
        { baseUrl: POD, enabled: true, windowMs: 0, graceMs: 0, lockoutMode: "off", umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
        { bytesToHex },
      ),
    ).rejects.toMatchObject({ code: "400" });
  });
});

describe("affirmDeadMan — POST shape + nonce + leaseExpiry", () => {
  it("mints a fresh 16-byte nonce, POSTs it hex, and surfaces leaseExpiry", async () => {
    const { captured, fetchFn } = captureFetch({ ok: true, leaseExpiry: 1700000086400000 });
    const { priv, pub } = fixedKey();
    const fixedNonce = new Uint8Array(16);
    for (let i = 0; i < 16; i++) fixedNonce[i] = (i + 1) & 0xff;
    const res = await affirmDeadMan(
      { baseUrl: POD, umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
      { fetch: fetchFn as any, bytesToHex, now: () => 1700000000000, randomBytes: () => fixedNonce },
    );
    expect(res.leaseExpiry).toBe(1700000086400000);
    const body = JSON.parse(captured[0]!.init.body);
    expect(captured[0]!.url).toBe(`${POD}/api/deadman/affirm`);
    expect(body.request.serverId).toBe(SERVER_ID);
    expect(body.request.nonce).toBe(bytesToHex(fixedNonce));
    expect(body.request.nonce).toHaveLength(32); // 16 bytes hex
    expect(body.request.issuedAt).toBe(1700000000000);
    expect(
      ed.verify(
        hexToBytes(body.signature),
        canonicalDeadManAffirmBytes({ serverId: SERVER_ID, nonceHex: body.request.nonce, issuedAt: 1700000000000 }),
        pub,
      ),
    ).toBe(true);
  });

  it("produces a different nonce on each real call", async () => {
    const { captured, fetchFn } = captureFetch({ ok: true, leaseExpiry: 1 });
    const { priv } = fixedKey();
    for (let i = 0; i < 2; i++) {
      await affirmDeadMan(
        { baseUrl: POD, umk: new Uint8Array(32), signWithIrk: realSigner(priv) },
        { fetch: fetchFn as any, bytesToHex },
      );
    }
    const n0 = JSON.parse(captured[0]!.init.body).request.nonce;
    const n1 = JSON.parse(captured[1]!.init.body).request.nonce;
    expect(n0).not.toBe(n1);
  });

  it("refuses on a locked webapp", async () => {
    await expect(affirmDeadMan({ baseUrl: POD } as any, {})).rejects.toMatchObject({ code: "400" });
  });
});

// ---------------------------------------------------------------------------
// Window presets + countdown formatting
// ---------------------------------------------------------------------------

describe("window presets", () => {
  it("default is 24h/6h grace; tighten is the shortest", () => {
    expect(DEADMAN_DEFAULT_PRESET.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(DEADMAN_DEFAULT_PRESET.graceMs).toBe(6 * 60 * 60 * 1000);
    expect(DEADMAN_TIGHTEN_PRESET).toBe(DEADMAN_WINDOW_PRESETS[DEADMAN_WINDOW_PRESETS.length - 1]);
    expect(DEADMAN_TIGHTEN_PRESET.windowMs).toBeLessThan(DEADMAN_DEFAULT_PRESET.windowMs);
  });

  it("offers 24h/8h/1h/15m + a short tighten preset", () => {
    expect(DEADMAN_WINDOW_PRESETS.map((p) => p.id)).toEqual(["24h", "8h", "1h", "15m", "5m"]);
  });
});

describe("fmtRemaining", () => {
  it("formats hours/minutes/seconds and 'expired'", () => {
    const now = 1_000_000;
    expect(fmtRemaining(now + 3_661_000, now)).toBe("1h 1m 1s left");
    expect(fmtRemaining(now + 65_000, now)).toBe("1m 5s left");
    expect(fmtRemaining(now + 5_000, now)).toBe("5s left");
    expect(fmtRemaining(now - 1, now)).toBe("expired");
    expect(fmtRemaining(undefined as any, now)).toBe("—");
  });
});
