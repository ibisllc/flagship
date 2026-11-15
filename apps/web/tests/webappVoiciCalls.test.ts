// The webapp's side of voi.ci calls (apps/web/public/webapp/lib/voiciCalls.js, voiciOwner.js; docs/voici-calls.md
// §6, §8): the call-allow order and the sealed missed call, against packages/protocol/test-vectors/voici-calls/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { b64Decode, hexToBytes } from "../public/webapp/lib/voiciCore.js";
import { canonicalVoiciCallAllow, canonicalVoiciCallRequest, openVoiciMissedCall, signVoiciCallAllow, verifyVoiciCallAllow } from "../public/webapp/lib/voiciCalls.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors", "voici-calls", "vectors.json"), "utf8"));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const callId: string = V.request.signed.callId;

describe("webapp voi.ci calls (test-vectors/voici-calls)", () => {
  it("the call-allow order", () => {
    expect(dec(canonicalVoiciCallAllow(V.allow.order))).toBe(V.allow.canonical);
    expect(signVoiciCallAllow(V.allow.order, hexToBytes(V.keys.ownerSignSeed))).toBe(V.allow.signature);
    expect(verifyVoiciCallAllow(V.allow.order, V.allow.signature, V.keys.ownerSignPub)).toBe(true);
    expect(verifyVoiciCallAllow({ ...V.allow.order, op: "disallow" }, V.allow.signature, V.keys.ownerSignPub)).toBe(false);
    expect(() => canonicalVoiciCallAllow({ ...V.allow.order, op: "maybe" })).toThrow();
  });

  it("the request bytes, with and without media", () => {
    expect(dec(canonicalVoiciCallRequest(V.request.signed))).toBe(V.request.canonical);
    expect(dec(canonicalVoiciCallRequest(V.video.request.signed))).toBe(V.video.request.canonical);
  });

  it("a missed call opens and checks; a forged one, another call or an unknown CA does not", () => {
    const ctx = { pageId: V.keys.pageId, origin: V.constants.origin, caKeys: [V.keys.caPub] };
    const seed = hexToBytes(V.keys.inboxSeed);
    expect(openVoiciMissedCall(seed, callId, b64Decode(V.missedCall.sealed), ctx)).toEqual({ v: 1, ...V.missedCall.entry });
    expect(openVoiciMissedCall(seed, callId, b64Decode(V.missedCall.forgedSealed), ctx)).toBeNull();
    expect(openVoiciMissedCall(seed, "00".repeat(16), b64Decode(V.missedCall.sealed), ctx)).toBeNull();
    expect(openVoiciMissedCall(seed, callId, b64Decode(V.missedCall.sealed), { ...ctx, caKeys: [V.keys.devicePub] })).toBeNull();
  });
});
