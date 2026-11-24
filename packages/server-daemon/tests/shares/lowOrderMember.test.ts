/**
 * A share's member key must be usable: a small-order or non-canonical Ed25519
 * key lets anyone sign as that co-manager, so the box refuses the grant up
 * front (test-vectors/ed25519-low-order).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ServerShareGrant } from "@flagship/protocol";
import { ShareStore } from "../../src/shares/shareStore.js";

const BOX = "home.harry.flagship.services";
const V = JSON.parse(
  readFileSync(new URL("../../../protocol/test-vectors/ed25519-low-order/vectors.json", import.meta.url), "utf8"),
) as { rejectPublicKeysHex: string[] };

describe("share grant with a low-order member key", () => {
  it("is refused with bad-public-key for every vector key", async () => {
    const store = new ShareStore(null, {
      serverDomain: BOX,
      verifyOwnerGrant: () => true,
      verifyAcceptAdmin: () => ({ ok: true }),
      now: () => 1,
    });
    for (const k of V.rejectPublicKeysHex) {
      const grant = { serverDomain: BOX, shareId: "0".repeat(32), memberPubHex: k, level: "manage", issuedAt: 1 } as unknown as ServerShareGrant;
      const r = await store.put(grant, "00".repeat(64));
      expect(r, k).toMatchObject({ ok: false, status: 400, code: "bad-public-key" });
    }
  });
});
