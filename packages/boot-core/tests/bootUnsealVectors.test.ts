// The worker gate's verdicts on the box's signed requests in
// packages/protocol/test-vectors/boot-unseal: fresh, expired, from the future,
// replayed, aimed at another server or route, signed by another box, tampered.
// The Rust flagship-boot crate checks the same cases with its oracle.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gate } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";

const V = JSON.parse(
  readFileSync(new URL("../../protocol/test-vectors/boot-unseal/vectors.json", import.meta.url), "utf8"),
);

const directory = {
  async boxStkForDomain(d: string) {
    if (d.toLowerCase() === V.boxes.A.serverDomain) return V.boxes.A.pubHex;
    if (d.toLowerCase() === V.boxes.B.serverDomain) return V.boxes.B.pubHex;
    return null;
  },
  async ownerIrkForDomain() {
    return null;
  },
  async activeBootDelegatesForDomain() {
    return [];
  },
  async usernameForDomain() {
    return null;
  },
} as unknown as DirectoryClient;

describe("boot-unseal vectors: the worker gate", () => {
  for (const c of V.gateCases) {
    it(c.name, async () => {
      const nonces = new InMemoryNonceStore();
      const deps = { directory, nonces, now: () => c.now };
      const header = V.headers[c.header];
      const required = { role: "box" as const, ...c.route };
      let r = await gate(deps, required, header);
      if (c.replay) {
        expect(r.ok).toBe(true);
        r = await gate(deps, required, header);
      }
      if (c.expect.ok) {
        expect(r.ok).toBe(true);
      } else {
        expect(r).toEqual({ ok: false, status: c.expect.status, error: c.expect.error });
      }
    });
  }
});
