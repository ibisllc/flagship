import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalChatApproval, chatAnswerBody } from "../public/webapp/lib/chatApproval.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/chat-approval/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("web chat-approval", () => {
  it("matches the shared vector: canonical bytes and signatures", () => {
    for (const o of v.orders) {
      const bytes = canonicalChatApproval(o.order);
      expect(new TextDecoder().decode(bytes)).toBe(o.canonical);
      expect(ed25519.verify(hex(o.signatureHex), bytes, hex(v.pubHex))).toBe(true);
    }
  });
  it("refuses the malformed orders", () => {
    for (const r of v.refused) expect(() => canonicalChatApproval(r.order), r.name).toThrow();
  });
  it("builds the answer body the box checks", async () => {
    const body = await chatAnswerBody(v.orders[0].order, () => hex(v.orders[0].signatureHex));
    expect(body).toMatchObject({ requestId: v.orders[0].order.requestId, kind: "incoming", decision: "allow", signature: v.orders[0].signatureHex });
  });
});
