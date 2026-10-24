import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { checkMasterEvidence, deriveServiceMemberStableId, deriveServiceSecret } from "../src/index.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/identity-assertion/master-evidence.json"), "utf8"));
const swk = Uint8Array.from(Buffer.from(V.swk, "hex"));

describe("master needs the owner's evidence", () => {
  it("every case", () => {
    for (const s of V.stableIds) expect(deriveServiceMemberStableId(deriveServiceSecret(swk, s.app), Buffer.from(s.identityPubHex, "hex"))).toBe(s.stableId);
    for (const c of V.cases) {
      const got = checkMasterEvidence(c.msg, c.ev, c.anchors, V.now, (a, p) => deriveServiceMemberStableId(deriveServiceSecret(swk, a), p), (sig, m, p) =>
        ed25519.verify(Buffer.from(sig, "hex"), m, Buffer.from(p, "hex")),
      );
      expect(got ?? "ok", c.name).toBe(c.expect);
    }
  });
});
