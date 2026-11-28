/**
 * The box's consume-once deposit lanes over the real route: a stranger who knows a box's name must not read (and so
 * use up) what was deposited for it. Each read needs the box's own read token, the update lane included (boxes send
 * it there from release c9eb06aa on).
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane } from "../src/controlPlaneRoutes.js";
import { buildWorld, ORIGIN } from "../../../scripts/cpuHarness.js";

const GATED = ["swk-deposit", "cgk-deposit", "pairing-deposit", "entitlement-deposit", "update"] as const;

describe("deposit lanes: reads need the box's own token", () => {
  for (const lane of GATED) {
    it(`${lane}: anonymous 401, the box's own token is let through`, async () => {
      const w = await buildWorld();
      try {
        const url = `${ORIGIN}/api/server/${encodeURIComponent(w.servers[0]!.domain)}/${lane}`;
        const anon = await tryControlPlane(new Request(url), w.env);
        expect(anon!.status).toBe(401);
        const own = await tryControlPlane(new Request(url, { headers: { authorization: `Bearer ${w.boxReadToken}` } }), w.env);
        expect(own!.status).not.toBe(401);
        expect(own!.status).not.toBe(403);
        // Another box of the account may not read this one's lane with its own token.
        const otherUrl = `${ORIGIN}/api/server/${encodeURIComponent(w.servers[1]!.domain)}/${lane}`;
        const other = await tryControlPlane(new Request(otherUrl, { headers: { authorization: `Bearer ${w.boxReadToken}` } }), w.env);
        expect([401, 403]).toContain(other!.status);
      } finally {
        w.close();
      }
    });
  }

});
