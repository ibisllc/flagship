import { describe, expect, it } from "vitest";
import { canonicalPushRelayRequest, ed, isPushRelayCategory, type PushRelayRequest } from "@flagship/protocol";
import { buildOwnerWake } from "../src/ownerWake.js";
import type { SendPushRelayOptions } from "../src/relaySos.js";
import { sendPushRelay } from "../src/relaySos.js";

const stk = new Uint8Array(32).fill(9);
const signer = { signAsBox: (m: Uint8Array) => ed.sign(m, stk) } as unknown as SendPushRelayOptions["signer"];

describe("waking the owner when a build needs them", () => {
  it("sends one content-free generic push, at most once a minute", async () => {
    const sent: SendPushRelayOptions[] = [];
    let t = 1_000_000;
    const wake = buildOwnerWake({
      owner: () => "harry",
      signer,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      now: () => t,
      send: async (o) => (sent.push(o), true),
    });
    expect(await wake()).toBe(true);
    expect(await wake()).toBe(false);
    t += 60_000;
    expect(await wake()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.category).toBe("generic");
    expect(isPushRelayCategory(sent[0]!.category)).toBe(true);
    expect(sent[0]!.targetUsername).toBe("harry");
    expect(sent[0]!.sealedPayloadHex).toBeUndefined();
  });

  it("stays quiet before the box knows its owner or .com", async () => {
    const sent: unknown[] = [];
    const send = async (o: SendPushRelayOptions) => (sent.push(o), true);
    expect(await buildOwnerWake({ owner: () => null, signer, controlPlaneBaseUrl: "https://x", send })()).toBe(false);
    expect(await buildOwnerWake({ owner: () => "harry", signer, controlPlaneBaseUrl: undefined, send })()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("puts only the category and an opaque marker on the wire, STK-signed", async () => {
    let body: { request: PushRelayRequest; signature: string } | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const wake = buildOwnerWake({
      owner: () => "harry",
      signer,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      send: (o) => sendPushRelay({ ...o, fetchImpl }),
    });
    expect(await wake()).toBe(true);
    expect(Object.keys(body!.request).sort()).toEqual(["category", "issuedAt", "sealedPayloadHex", "targetUsername"]);
    expect(body!.request.category).toBe("generic");
    expect(body!.request.sealedPayloadHex).toBe("00".repeat(32));
    const sig = Uint8Array.from(Buffer.from(body!.signature, "hex"));
    expect(ed.verify(sig, canonicalPushRelayRequest(body!.request), ed.getPublicKey(stk))).toBe(true);
  });
});
