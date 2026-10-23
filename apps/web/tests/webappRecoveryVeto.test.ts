import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import { canonicalRePairVetoBytes, renderRecoveryReview, shouldRenderRecoveryReview, submitRecoveryVeto } from "../public/webapp/lib/recoveryVeto.js";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/re-pair-veto/vectors.json", import.meta.url), "utf8"));

describe("re-pair veto canonical bytes (shared vectors)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const r = c.request;
      const bytes = canonicalRePairVetoBytes({ username: r.username, newIrkPubHex: r.newIrkPub, initiatedAt: r.initiatedAt, completesAt: r.completesAt, vetoerPubHex: r.vetoerPub, issuedAt: r.issuedAt });
      expect(new TextDecoder().decode(bytes)).toBe(c.canonical);
    });
  }
});

describe("the recovery card", () => {
  const live = { pending: { newIrkPub: "aa", initiatedAt: 1, completesAt: 9_000_000_000_000, objectedAt: null } };
  it("shows to an admin for a live attempt only", () => {
    expect(shouldRenderRecoveryReview(live, true)).toBe(true);
    expect(shouldRenderRecoveryReview(live, false)).toBe(false);
    expect(shouldRenderRecoveryReview({ pending: { ...live.pending, objectedAt: 5 } }, true)).toBe(false);
    expect(shouldRenderRecoveryReview({ pending: null }, true)).toBe(false);
  });
  it("carries the physical-safety sentence and says the new device has no authority", () => {
    const html = renderRecoveryReview(live, true);
    expect(html).toContain("If this is unusual, please check on the physical safety of your device and server.");
    expect(html).toContain("no admin authority");
    expect(html).toContain("reject-recovery-btn");
  });
});

describe("submitRecoveryVeto", () => {
  it("signs the attempt's bytes with the admin root and posts them", async () => {
    let sent: { url: string; body: any } | null = null;
    const seed = new Uint8Array(32).fill(1);
    await submitRecoveryVeto(
      { username: "Alice", pending: { newIrkPub: "bb", initiatedAt: 10, completesAt: 20 }, adminRootSeed: seed },
      {
        origin: "https://c.example",
        now: () => 30,
        adminRootPubHex: async () => "cc",
        signWithAdminRoot: async (_s: Uint8Array, bytes: Uint8Array) => new TextEncoder().encode(new TextDecoder().decode(bytes).length.toString()),
        fetch: (async (url: string, init: { body: string }) => {
          sent = { url, body: JSON.parse(init.body) };
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(sent!.url).toBe("https://c.example/api/users/Alice/re-pair/veto");
    expect(sent!.body.request).toMatchObject({ newIrkPub: "bb", initiatedAt: 10, completesAt: 20, vetoerPub: "cc", issuedAt: 30 });
  });
  it("needs the admin key and reports a lost race plainly", async () => {
    await expect(submitRecoveryVeto({ username: "a", pending: {}, adminRootSeed: null })).rejects.toThrow(/administrator/);
    await expect(
      submitRecoveryVeto({ username: "a", pending: { newIrkPub: "bb", initiatedAt: 1, completesAt: 2 }, adminRootSeed: new Uint8Array(32) }, {
        adminRootPubHex: async () => "cc",
        signWithAdminRoot: async () => new Uint8Array(64),
        fetch: (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/already cancelled or finished/);
  });
});
