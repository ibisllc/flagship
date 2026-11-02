import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import { canonicalVoiciDraftsConsume, signVoiciDraftsConsume, verifyVoiciDraftsConsume } from "../src/voiciDraftsConsume.js";

const seed = new Uint8Array(32).fill(7);
const pub = Buffer.from(ed.getPublicKey(seed)).toString("hex");

describe("flagship/voici-drafts-consume/v1", () => {
  it("joins sorted op ids into the pinned bytes", () => {
    const c = { username: "alice", opIds: ["02".repeat(16), "01".repeat(16)], issuedAt: 1800000000000 };
    expect(new TextDecoder().decode(canonicalVoiciDraftsConsume(c))).toBe(
      `flagship/voici-drafts-consume/v1|alice|${"01".repeat(16)},${"02".repeat(16)}|1800000000000`,
    );
    const sig = signVoiciDraftsConsume(c, seed);
    expect(verifyVoiciDraftsConsume({ ...c, opIds: [...c.opIds].reverse() }, sig, pub)).toBe(true);
    expect(verifyVoiciDraftsConsume({ ...c, issuedAt: 1 }, sig, pub)).toBe(false);
  });

  it("refuses empty, repeated or malformed op ids", () => {
    for (const opIds of [[], ["01".repeat(16), "01".repeat(16)], ["XY"]]) {
      expect(() => canonicalVoiciDraftsConsume({ username: "alice", opIds, issuedAt: 1 })).toThrow();
    }
  });
});
