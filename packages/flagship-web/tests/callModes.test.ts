// flagship-web's call modes (src/callModes.js) against packages/protocol/test-vectors/voici-call-modes/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as CM from "../src/callModes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "protocol", "test-vectors", "voici-call-modes", "vectors.json"), "utf8"));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("flagship-web call modes", () => {
  it("anonymous request bytes, conv and the work", async () => {
    expect(dec(CM.canonicalVoiciCallRequestAnon(V.anon.signed))).toBe(V.anon.canonical);
    expect(CM.voiciAnonConv(V.pageId, V.anon.browserPub)).toBe(V.anon.body.conv);
    expect(await CM.solveVoiciCallPow(V.pow.challenge, { slice: 500 })).toBe(V.pow.nonce);
  });

  it("ring-back order bytes and the ring hint", () => {
    expect(dec(CM.canonicalVoiciRingBack(V.ringBack.app.order))).toBe(V.ringBack.canonical);
    const o = V.ring.order;
    expect(CM.openVoiciRingHint(hexToBytes(V.ring.threadSeed), o.conv, o.ringId, o.hint)).toEqual(V.ring.hintPlain);
    expect(CM.openVoiciRingHint(hexToBytes(V.ring.threadSeed), o.conv, "00".repeat(16), o.hint)).toBeNull();
    expect(CM.ringOf({ ring: { ringId: o.ringId, hint: o.hint, media: "audio", until: 5 } })).toEqual({ ringId: o.ringId, hint: o.hint, media: "audio", until: 5 });
    expect(CM.ringOf({ ring: { ringId: "x", hint: o.hint, media: "audio", until: 5 } })).toBeNull();
  });

  it("reads the page's mode", () => {
    expect(CM.pageCallMode({ version: 2, acceptsCalls: 1, callsFrom: "anyone" })).toBe("anyone");
    expect(CM.pageCallMode({ version: 1, acceptsMessages: 1 })).toBeNull();
  });
});
