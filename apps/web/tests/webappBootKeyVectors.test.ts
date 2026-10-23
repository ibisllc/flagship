// The browser adopts a box's boot-only key only through a binding the pinned STK signed
// (lib/bootKey.js). Same cases as the TS, Swift, Kotlin and Rust ports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedBootKeyFor } from "../public/webapp/lib/bootKey.js";

const v = JSON.parse(readFileSync(join(__dirname, "../../../packages/protocol/test-vectors/boot-key/vectors.json"), "utf8"));

type Case = { name: string; wire: unknown; expect: { serverDomain: string; stkPubHex: string }; bootKeyPubHex: string | null };

describe("boot-key binding vectors (webapp)", () => {
  for (const c of v.binding.cases as Case[]) {
    it(c.name, async () => {
      const fetch = async () => new Response(JSON.stringify(c.wire), { status: 200 });
      const got = await sharedBootKeyFor(c.expect.serverDomain, c.expect.stkPubHex.toLowerCase(), { fetch, comBase: "https://flagshipserver.com" });
      expect(got).toBe(c.bootKeyPubHex === null ? null : c.bootKeyPubHex.toLowerCase());
    });
  }
});
