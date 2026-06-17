// Maintainer-trust verify (lib/maintainerTrust.js) — the browser-JS port of
// @ibisllc/maintainers' pin → chain → authorizedCaKeys + the Flagship blessing
// check. Pinned to fixtures generated from the REAL @ibisllc/maintainers
// package (apps/web/tests/fixtures/maintainerTrust.webapp.vectors.json), so
// the port is verified against byte-identical maintainers-produced data.
//
// We also cross-check live against @ibisllc/maintainers itself (same inputs,
// same verdict) so a drift in either direction is caught.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  authorizedCaKeys as mAuthorizedCaKeys,
  verifyMandateChainFromPin as mVerifyChain,
  mandatePinHash as mMandatePinHash,
} from "@ibisllc/maintainers";

const MOD_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/maintainerTrust.js"),
).href;

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/maintainerTrust.webapp.vectors.json"), "utf8"),
);

async function loadTrust() {
  return import(MOD_URL);
}

const NOW_MS = Date.parse(VECTORS.clientNow);

describe("maintainerTrust — canonical bytes match @ibisllc/maintainers", () => {
  it("mandatePinHash equals the package's pin for the fixture root", async () => {
    const t = await loadTrust();
    const root = VECTORS.mandates[0];
    const ours = await t.mandatePinHash(root);
    expect(ours).toBe(VECTORS.pin);
    expect(ours).toBe(mMandatePinHash(root));
  });
});

describe("maintainerTrust — forward chain + authorizedCaKeys", () => {
  it("verifies the chain forward from the pin and authorizes the hot CA key", async () => {
    const t = await loadTrust();
    const chain = await t.verifyMandateChainFromPin(VECTORS.pin, VECTORS.mandates);
    expect(chain.rootError).toBeUndefined();
    expect(chain.validMandates).toHaveLength(1);

    const keys = await t.authorizedCaKeys(VECTORS.caEndorsements, chain, NOW_MS);
    expect(keys).toEqual([VECTORS.keys.hotCaPub]);

    // Cross-check against the real package at the same clock.
    const mChain = mVerifyChain(VECTORS.pin, VECTORS.mandates);
    expect(mAuthorizedCaKeys(VECTORS.caEndorsements, mChain, new Date(NOW_MS))).toEqual([
      VECTORS.keys.hotCaPub,
    ]);
  });

  it("uses the CLIENT clock — a lease lapsed at now authorizes nothing", async () => {
    const t = await loadTrust();
    const chain = await t.verifyMandateChainFromPin(VECTORS.pin, VECTORS.mandates);
    const farFuture = Date.parse("2030-01-01T00:00:00Z");
    expect(await t.authorizedCaKeys(VECTORS.caEndorsements, chain, farFuture)).toEqual([]);
  });

  it("fails closed on an empty pin (no-pin)", async () => {
    const t = await loadTrust();
    const chain = await t.verifyMandateChainFromPin("", VECTORS.mandates);
    expect(chain.rootError).toBe("no-pin");
    expect(await t.authorizedCaKeys(VECTORS.caEndorsements, chain, NOW_MS)).toEqual([]);
  });

  it("fails closed on a pin that matches no mandate (pin-not-in-log)", async () => {
    const t = await loadTrust();
    const chain = await t.verifyMandateChainFromPin("00".repeat(32), VECTORS.mandates);
    expect(chain.rootError).toBe("pin-not-in-log");
  });
});

describe("maintainerTrust — byte-identity vs the AUTHORITATIVE cross-platform fixture", () => {
  // The single source of truth (Worker A) lives in @flagship/protocol. The
  // guarantee that matters across TS/JS/Swift/Kotlin is *identical canonical
  // bytes*: assert the webapp port emits EXACTLY the authoritative strings for
  // the same envelopes. (Per-surface verdict labels are internal diagnostics
  // and need not match; the canonical bytes — what gets signed — must.)
  const AUTH = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../packages/protocol/tests/fixtures/maintainerTrust.vectors.json"),
      "utf8",
    ),
  );

  it("canonicalMandate matches the authoritative bytes", async () => {
    const t = await loadTrust();
    const bytes = t.canonicalMandate(AUTH.rootMandate);
    expect(new TextDecoder().decode(bytes)).toBe(AUTH.canonical.mandate);
  });

  it("canonicalCaEndorsement matches the authoritative bytes", async () => {
    const t = await loadTrust();
    const bytes = t.canonicalCaEndorsement(AUTH.caEndorsement);
    expect(new TextDecoder().decode(bytes)).toBe(AUTH.canonical.caEndorsement);
  });

  it("verifyComBlessing agrees with the authoritative verdict on every case", async () => {
    const t = await loadTrust();
    // trusted case
    const good = await t.verifyComBlessing(AUTH.blessingResponse, AUTH.epochsMs.NOW, AUTH.pinnedMandateHash);
    expect(good.trusted).toBe(AUTH.expectedVerdict.trusted);
    expect(good.caPubkey).toBe(AUTH.expectedVerdict.caPubkey);
    // every negative case (each carries its own nowMs + baked pin)
    for (const c of AUTH.negativeCases) {
      const r = await t.verifyComBlessing(c.response, c.nowMs, c.pin);
      expect(r.trusted).toBe(c.expectedVerdict.trusted); // verdict parity (label may differ)
    }
  });
});

describe("maintainerTrust — verifyComBlessing (the full verdict)", () => {
  for (const c of VECTORS.cases) {
    it(c.name, async () => {
      const t = await loadTrust();
      const r = await t.verifyComBlessing(c.blessing, NOW_MS, VECTORS.pin);
      expect(r.trusted).toBe(c.expect.trusted);
      expect(r.reason).toBe(c.expect.reason);
    });
  }

  it("ignores the server-asserted `now` (uses the client clock)", async () => {
    const t = await loadTrust();
    // Trusted blessing, but the server claims a `now` far in the future where
    // the lease has lapsed. The verdict must still be trusted at CLIENT_NOW.
    const good = VECTORS.cases.find((c: { expect: { trusted: boolean } }) => c.expect.trusted);
    const tampered = { ...good.blessing, now: "2031-01-01T00:00:00.000Z" };
    const r = await t.verifyComBlessing(tampered, NOW_MS, VECTORS.pin);
    expect(r.trusted).toBe(true);
  });

  it("a network/absent blessing yields no verdict (no-blessing), NOT untrusted-by-network", async () => {
    const t = await loadTrust();
    expect((await t.verifyComBlessing(null, NOW_MS, VECTORS.pin)).reason).toBe("no-blessing");
    expect((await t.verifyComBlessing(undefined, NOW_MS, VECTORS.pin)).reason).toBe("no-blessing");
  });

  it("a rogue .com cannot self-anchor: a chain at ITS OWN pin is rejected against the baked pin", async () => {
    const t = await loadTrust();
    // The rogue serves a self-consistent chain anchored at a DIFFERENT pin
    // (its own root). Verified against the BAKED pin, the served root isn't
    // found → no authority → untrusted.
    const good = VECTORS.cases.find((c: { expect: { trusted: boolean } }) => c.expect.trusted);
    const r = await t.verifyComBlessing(good.blessing, NOW_MS, "11".repeat(32));
    expect(r.trusted).toBe(false);
    expect(r.reason).toBe("no-authorized-ca-keys");
  });
});
