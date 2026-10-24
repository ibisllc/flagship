// The webapp's PQ half of security notices (lib/securityNotice.js) against
// packages/protocol/test-vectors/security-notice/pq-vectors.json, and its baked pin against
// the protocol package's RELEASE_PQ_PIN.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_PQ_PIN } from "../../../packages/protocol/src/releasePqPin.js";

const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/security-notice/pq-vectors.json"), "utf8"));
const load = () => import(pathToFileURL(resolve(__dirname, "../public/webapp/lib/securityNotice.js")).href);
const pin = () => import(pathToFileURL(resolve(__dirname, "../public/webapp/lib/releasePqPin.js")).href);

describe("webapp security notice: PQ half", () => {
  for (const c of V.cases) {
    it(`${c.name}: ${c.expect.emptyPin} / ${c.expect.pinned}`, async () => {
      const sn = await load();
      const verdict = async (keyIds: string[]) => {
        const n = sn.parseSecurityNotice(c.notice);
        if (!n) return "malformed";
        const v = await sn.verifySecurityNotice(n, V.authorityKeys, keyIds);
        return v.ok ? "ok" : v.reason;
      };
      expect(await verdict([])).toBe(c.expect.emptyPin);
      expect(await verdict(V.pinnedKeyIds)).toBe(c.expect.pinned);
    });
  }

  it("bakes the same release key ids as the protocol pin", async () => {
    expect([...(await pin()).RELEASE_PQ_KEY_IDS]).toEqual([...RELEASE_PQ_PIN.keyIds]);
  });
});
