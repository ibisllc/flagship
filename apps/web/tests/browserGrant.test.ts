import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalBrowserGrantAnswer } from "../public/webapp/lib/browserGrant.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/browser-grant/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("web browser-grant", () => {
  it("matches the shared vector and refuses the malformed answers", async () => {
    for (const a of v.answers) {
      const bytes = await canonicalBrowserGrantAnswer(a.answer);
      expect(new TextDecoder().decode(bytes)).toBe(a.canonical);
      expect(ed25519.verify(hex(a.signatureHex), bytes, hex(v.pubHex))).toBe(true);
    }
    for (const r of v.refused) await expect(canonicalBrowserGrantAnswer(r.answer), r.name).rejects.toThrow();
  });
});
