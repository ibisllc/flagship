// Lock & power-off — webapp client tests.
//
// Pins:
//   - canonical-bytes shape byte-for-byte AND signature-round-trip against
//     @flagship/protocol's signPhoneOrder (power-off), the envelope the
//     iOS / Android view-models ship and the daemon verifies.
//   - the POST shape (URL, headers, body keys + values) of /api/power.
//   - mode vocabulary guard ({off,restart}).
//   - locked-webapp guard (no umk / signWithIrk).
//   - the old dead-man switch is gone (the serving policy replaced it).

import { describe, expect, it, vi } from "vitest";
import * as lockAndPower from "../public/webapp/lib/lockAndPower.js";
import {
  canonicalPowerOffBytes,
  sendPowerOff,
  TAG_ORDER_POWER_OFF,
} from "../public/webapp/lib/lockAndPower.js";
import {
  signPhoneOrder,
  verifyPhoneOrder,
  ed,
  type PhoneOrder,
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
  });

  it("no longer signs the old dead-man orders", () => {
    for (const gone of ["setDeadManPolicy", "affirmDeadMan", "canonicalDeadManPolicyBytes", "canonicalDeadManAffirmBytes", "TAG_SET_DEADMAN_POLICY", "TAG_DEADMAN_AFFIRM", "DEADMAN_WINDOW_PRESETS", "fmtRemaining"]) {
      expect(gone in lockAndPower).toBe(false);
    }
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
