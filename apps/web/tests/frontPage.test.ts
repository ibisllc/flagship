// Owner-assignable apex ("front page") — webapp client tests.
//
// Pins:
//   - canonical-bytes shape byte-for-byte AND signature round-trip against
//     @flagship/protocol's signPhoneOrder (set-front-page) — the same
//     envelope the iOS / Android view-models ship + the daemon verifies.
//   - the CROSS-PLATFORM pinned vector (packages/protocol/tests/
//     setFrontPage.test.ts pins this same signature).
//   - the POST shape (URL, headers, body keys + values) for /api/front-page.
//   - the GET readers (/api/front-page, /api/services → picker options).
//   - label vocabulary guards (dns shape, no "|", "" = clear).
//   - locked-webapp guard (no umk / signWithIrk).

import { describe, expect, it, vi } from "vitest";
import {
  canonicalSetFrontPageBytes,
  getFrontPage,
  listFrontPageOptions,
  sendSetFrontPage,
  TAG_ORDER_SET_FRONT_PAGE,
} from "../public/webapp/lib/frontPage.js";
import { ed, signPhoneOrder, verifyPhoneOrder, type PhoneOrder } from "@flagship/protocol";

const POD = "https://home.harry.flagship.services";
const SERVER_ID = "home.harry.flagship.services";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fixedKey() {
  const priv = new Uint8Array(32).fill(7);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function signerFor(priv: Uint8Array) {
  return async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, priv);
}

describe("canonicalSetFrontPageBytes", () => {
  it("matches @flagship/protocol byte-for-byte", () => {
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER_ID,
      label: "photos",
      issuedAt: 1700,
    };
    const key = fixedKey();
    const sig = signPhoneOrder(order, key);
    const bytes = canonicalSetFrontPageBytes({ serverId: SERVER_ID, label: "photos", issuedAt: 1700 });
    expect(ed.verify(sig, bytes, key.publicKey)).toBe(true);
  });

  it("CROSS-PLATFORM PINNED VECTOR — same signature the protocol suite pins", () => {
    // serverId home.alice…, label photos, issuedAt 1700, seed-7 key.
    const key = fixedKey();
    const bytes = canonicalSetFrontPageBytes({
      serverId: "home.alice.flagship.services",
      label: "photos",
      issuedAt: 1700,
    });
    expect(bytesToHex(ed.sign(bytes, key.privateKey))).toBe(
      "bc57770c09c3f54d9acdb628bd4767142ea035d944c88e7de340c10df84a67b9aa62800fdb597624a3f49ccec222d2c4" +
        "6ff64eadaa80111964946240a2fc9405",
    );
  });

  it("empty label (clear) canonicalizes with an empty field", () => {
    const bytes = canonicalSetFrontPageBytes({ serverId: SERVER_ID, label: "", issuedAt: 9 });
    expect(new TextDecoder().decode(bytes)).toBe(
      `${TAG_ORDER_SET_FRONT_PAGE}|${SERVER_ID}||9`,
    );
  });

  it("rejects non-dns labels and pipes", () => {
    expect(() => canonicalSetFrontPageBytes({ serverId: SERVER_ID, label: "a|b", issuedAt: 1 })).toThrow();
    expect(() => canonicalSetFrontPageBytes({ serverId: SERVER_ID, label: "Bad_Label", issuedAt: 1 })).toThrow();
    expect(() => canonicalSetFrontPageBytes({ serverId: SERVER_ID, label: "-x", issuedAt: 1 })).toThrow();
  });
});

describe("sendSetFrontPage", () => {
  it("POSTs the IRK-signed envelope the daemon verifies", async () => {
    const key = fixedKey();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, label: "photos" }) } as Response;
    });
    const r = await sendSetFrontPage(
      {
        baseUrl: POD,
        label: "photos",
        umk: new Uint8Array(32),
        signWithIrk: signerFor(key.privateKey),
      },
      { fetch: f as unknown as typeof fetch, now: () => 1700 },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${POD}/api/front-page`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.request).toEqual({
      type: "set-front-page",
      serverId: SERVER_ID,
      label: "photos",
      issuedAt: 1700,
    });
    // The signature the webapp built verifies as a protocol PhoneOrder.
    const sig = Uint8Array.from(
      (body.signature as string).match(/.{2}/g)!.map((h: string) => parseInt(h, 16)),
    );
    expect(verifyPhoneOrder(body.request as PhoneOrder, sig, key.publicKey)).toBe(true);
  });

  it("requires an unlocked webapp", async () => {
    await expect(
      sendSetFrontPage({ baseUrl: POD, label: "x", umk: null as never, signWithIrk: null as never }),
    ).rejects.toThrow(/unlock/i);
  });

  it("surfaces a non-200 with its status code", async () => {
    const key = fixedKey();
    const f = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => '{"error":"unknown service label"}',
    }));
    await expect(
      sendSetFrontPage(
        { baseUrl: POD, label: "ghost", umk: new Uint8Array(32), signWithIrk: signerFor(key.privateKey) },
        { fetch: f as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "422" });
  });
});

describe("readers", () => {
  it("getFrontPage returns the daemon's {label, active}", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toBe(`${POD}/api/front-page`);
      return { ok: true, json: async () => ({ label: "photos", active: true }) } as Response;
    });
    expect(await getFrontPage({ baseUrl: POD }, { fetch: f as unknown as typeof fetch })).toEqual({
      label: "photos",
      active: true,
    });
  });

  it("listFrontPageOptions projects /api/services into picker options", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toBe(`${POD}/api/services`);
      return {
        ok: true,
        json: async () => ({
          apps: [
            { urlLabel: "photos", name: "Photos", slug: "photos", extra: 1 },
            { urlLabel: "blog", name: "Blog" },
          ],
        }),
      } as Response;
    });
    expect(await listFrontPageOptions({ baseUrl: POD }, { fetch: f as unknown as typeof fetch })).toEqual([
      { urlLabel: "photos", name: "Photos" },
      { urlLabel: "blog", name: "Blog" },
    ]);
  });
});
