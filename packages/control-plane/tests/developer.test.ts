import { describe, expect, it } from "vitest";
import {
  InMemoryMarketplaceStorage,
  InMemoryUsernameStorage,
  InMemoryAppSalesStorage,
  InMemoryServerStorage,
} from "@flagship/storage";
import type { MarketplaceListingRecord } from "@flagship/storage";
import { ed, signDeveloperSalesRead, type Keypair } from "@flagship/protocol";
import { handleDeveloperSales } from "../src/developer.js";

const NOW = Date.UTC(2026, 6, 1);

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function kp(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function listing(over: Partial<MarketplaceListingRecord> = {}): MarketplaceListingRecord {
  return {
    creator: "acme", slug: "notes", name: "Notes", tagline: "t", descriptionMd: "d",
    category: "productivity", tagsCsv: "notes", canonicalUrl: "https://notes.acme.flagship.services",
    manifestHashHex: "00".repeat(32), manifestJson: "{}", screenshotKeysJson: "[]", status: "listed",
    rankScore: 1, installCount: 0, publicDistribution: true, listedAt: NOW, updatedAt: NOW,
    irkSignatureHex: "ab".repeat(32), ...over,
  };
}

async function ctx() {
  const marketplace = new InMemoryMarketplaceStorage();
  const usernames = new InMemoryUsernameStorage();
  const sales = new InMemoryAppSalesStorage();
  const irk = kp(3);
  await usernames.put({ username: "acme", irkPubHex: hex(irk.publicKey), claimedAt: NOW });
  await marketplace.upsert(listing({ slug: "notes", priceUsdCents: 1000, installCount: 12, scanGrade: "A" }));
  await marketplace.upsert(listing({ slug: "draw", priceUsdCents: 0, installCount: 3 }));
  await sales.record({ saleKey: "e1", listingId: "acme--notes", creatorAccount: "acme", buyerAccount: "bob", grossCents: 1000, cutCents: 150, netCents: 850, currency: "usd", stripeEventId: "e1", at: NOW });
  await sales.record({ saleKey: "e2", listingId: "acme--notes", creatorAccount: "acme", buyerAccount: "carol", grossCents: 1000, cutCents: 150, netCents: 850, currency: "usd", stripeEventId: "e2", at: NOW + 1 });
  return { marketplace, usernames, sales, irk };
}

function signedQuery(irk: Keypair, issuedAt = NOW) {
  const sig = signDeveloperSalesRead({ creator: "acme", issuedAt }, irk);
  return { issuedAt: String(issuedAt), sig: hex(sig) };
}

describe("handleDeveloperSales (#15 developer console)", () => {
  it("returns the ledger + rollups for a valid creator signature", async () => {
    const { marketplace, usernames, sales, irk } = await ctx();
    const q = signedQuery(irk);
    const res = await handleDeveloperSales({ sales, marketplace, usernames, now: () => NOW }, "acme", q.issuedAt, q.sig);
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.totals).toMatchObject({
      gross_cents: 2000, cut_cents: 300, net_cents: 1700, sale_count: 2,
      payout_owed_cents: 1700, install_count: 15,
    });
    expect(body.sales).toHaveLength(2);
    // per-listing rollup: notes has the 2 paid sales; draw has none.
    const notes = body.listings.find((l: any) => l.slug === "notes");
    const draw = body.listings.find((l: any) => l.slug === "draw");
    expect(notes).toMatchObject({ gross_cents: 2000, net_cents: 1700, sale_count: 2, install_count: 12, is_paid: true, scan_grade: "A" });
    expect(draw).toMatchObject({ gross_cents: 0, sale_count: 0, install_count: 3, is_paid: false });
  });

  it("rejects a missing or bad signature", async () => {
    const { marketplace, usernames, sales } = await ctx();
    const bad = signedQuery(kp(99)); // not acme's key
    const res = await handleDeveloperSales({ sales, marketplace, usernames, now: () => NOW }, "acme", bad.issuedAt, bad.sig);
    expect(res.status).toBe(403);
    const noSig = await handleDeveloperSales({ sales, marketplace, usernames, now: () => NOW }, "acme", String(NOW), null);
    expect(noSig.status).toBe(400);
  });

  it("rejects a stale request", async () => {
    const { marketplace, usernames, sales, irk } = await ctx();
    const q = signedQuery(irk, NOW - 10 * 60_000);
    const res = await handleDeveloperSales({ sales, marketplace, usernames, now: () => NOW }, "acme", q.issuedAt, q.sig);
    expect(res.status).toBe(403);
  });

  it("404s an unregistered creator", async () => {
    const { marketplace, sales, irk } = await ctx();
    const usernames = new InMemoryUsernameStorage(); // empty
    const q = signedQuery(irk);
    const res = await handleDeveloperSales({ sales, marketplace, usernames, now: () => NOW }, "acme", q.issuedAt, q.sig);
    expect(res.status).toBe(404);
  });

  it("accepts a non-revoked server identity of the creator's account", async () => {
    const { marketplace, usernames, sales } = await ctx();
    const servers = new InMemoryServerStorage();
    const srv = kp(31);
    await servers.put({ serverDomain: "notes.acme.flagship.services", username: "acme", identityPubKeyHex: hex(srv.publicKey), registeredAt: NOW });
    const q = signedQuery(srv);
    const res = await handleDeveloperSales({ sales, marketplace, usernames, servers, now: () => NOW }, "acme", q.issuedAt, q.sig);
    expect(res.status).toBe(200);
  });
});
