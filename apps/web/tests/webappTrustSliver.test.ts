// The persistent red trust sliver (lib/trustSliver.js) — the pure label/slug
// + line-dedup contract (the DOM render is the thin half). Pins the shared
// cross-surface contract: one line per failing certHash, slug = first 8 hex,
// and the exact "Control server certificate expired · <slug>" /
// "Relay certificate expired · <slug>" labels.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MOD_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/trustSliver.js"),
).href;

async function loadSliver() {
  return import(MOD_URL);
}

const HASH_A = "abcdef0123456789".repeat(4); // 64 hex
const HASH_B = "0123456789abcdef".repeat(4);

describe("trustSliver — slug + label shapes", () => {
  it("slug is the first 8 hex of the cert-hash", async () => {
    const s = await loadSliver();
    expect(s.certSlug(HASH_A)).toBe("abcdef01");
    expect(s.certSlug("")).toBe("");
  });

  it("control-class label", async () => {
    const s = await loadSliver();
    expect(s.trustLineLabel({ certClass: "control", certHash: HASH_A })).toBe(
      "Control server certificate expired · abcdef01",
    );
  });

  it("relay-class label", async () => {
    const s = await loadSliver();
    expect(s.trustLineLabel({ certClass: "relay", certHash: HASH_B })).toBe(
      "Relay certificate expired · 01234567",
    );
  });

  it("an unknown class defaults to control", async () => {
    const s = await loadSliver();
    expect(s.trustLineLabel({ certClass: "weird", certHash: HASH_A })).toBe(
      "Control server certificate expired · abcdef01",
    );
  });
});

describe("trustSliver — line dedup", () => {
  it("one line per distinct certHash, first class wins", async () => {
    const s = await loadSliver();
    const lines = s.trustSliverLines([
      { certClass: "control", certHash: HASH_A },
      { certClass: "relay", certHash: HASH_A }, // dup hash → dropped
      { certClass: "relay", certHash: HASH_B },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      certHash: HASH_A,
      certClass: "control",
      slug: "abcdef01",
      label: "Control server certificate expired · abcdef01",
    });
    expect(lines[1]).toMatchObject({
      certHash: HASH_B,
      certClass: "relay",
      slug: "01234567",
      label: "Relay certificate expired · 01234567",
    });
  });

  it("preserves the overridden flag and skips empty/missing hashes", async () => {
    const s = await loadSliver();
    const lines = s.trustSliverLines([
      { certClass: "control", certHash: HASH_A, overridden: true },
      { certClass: "control", certHash: "" },
      null,
      undefined,
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].overridden).toBe(true);
  });

  it("empty input ⇒ no lines", async () => {
    const s = await loadSliver();
    expect(s.trustSliverLines([])).toEqual([]);
    expect(s.trustSliverLines(undefined)).toEqual([]);
  });
});

describe("trustSliver — hide under the lock screen (M7)", () => {
  it("LOCKED ⇒ zero lines even with failing certs (iOS app.isUnlocked gate)", async () => {
    const s = await loadSliver();
    const certs = [{ certClass: "control", certHash: HASH_A }];
    // Unlocked shows the failing cert; locked suppresses it entirely.
    expect(s.visibleTrustLines(true, certs)).toHaveLength(1);
    expect(s.visibleTrustLines(false, certs)).toEqual([]);
  });

  it("LOCKED ⇒ zero lines regardless of how many certs fail", async () => {
    const s = await loadSliver();
    const certs = [
      { certClass: "control", certHash: HASH_A },
      { certClass: "relay", certHash: HASH_B },
    ];
    expect(s.visibleTrustLines(true, certs)).toHaveLength(2);
    expect(s.visibleTrustLines(false, certs)).toEqual([]);
  });
});

describe("trustSliver — override badge copy (L11)", () => {
  it('says "continuing", NOT "accepted" (matches iOS/Android)', async () => {
    const s = await loadSliver();
    expect(s.TRUST_OVERRIDE_LABEL).toBe("continuing");
    expect(s.TRUST_OVERRIDE_LABEL).not.toBe("accepted");
  });
});
