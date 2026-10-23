import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBootKeyBinding, decideBoxKeyPin, verifyBootKeyBinding } from "../src/boxKeyPin.js";

const v = JSON.parse(
  readFileSync(join(__dirname, "../test-vectors/box-key-pin/vectors.json"), "utf8"),
);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("box key pin (shared vectors)", () => {
  it("decides first / match / mismatch / invalid as the vectors say", () => {
    for (const d of v.decisions) expect(decideBoxKeyPin(d.pinned, d.reported)).toBe(d.verdict);
  });

  it("accepts a boot-key binding only under the pinned STK, for the named server", () => {
    const b = v.bootKeyBinding;
    expect(new TextDecoder().decode(canonicalBootKeyBinding(b.binding))).toBe(b.canonical);
    const stk = bytes(v.stkPubHex);
    expect(verifyBootKeyBinding(b.binding, bytes(b.signatureHex), stk, v.serverDomain)).toBe(b.expect.signatureUnderPinnedStk);
    expect(verifyBootKeyBinding(b.binding, bytes(b.signedByOtherKeyHex), stk, v.serverDomain)).toBe(b.expect.signedByOtherKeyUnderPinnedStk);
    expect(verifyBootKeyBinding(b.binding, bytes(b.signatureHex), bytes(v.otherPubHex), v.serverDomain)).toBe(b.expect.signatureUnderOtherKey);
    expect(verifyBootKeyBinding(b.binding, bytes(b.signatureHex), stk, b.expect.otherServerDomain)).toBe(b.expect.signatureForOtherServer);
  });
});
