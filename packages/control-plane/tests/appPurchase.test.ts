import { describe, expect, it } from "vitest";
import { InMemoryMarketplaceStorage, InMemoryUsernameStorage } from "@flagship/storage";
import type { AppPurchaseRecord, AppPurchaseStorage, MarketplaceListingRecord } from "@flagship/storage";
import {
  grantAppPurchase,
  isEntitledToInstall,
  isPaidListing,
  handleListUserPurchases,
  handleAdminSetAppPrice,
  handleAdminGrantPurchase,
  MAX_APP_PRICE_CENTS,
} from "../src/appPurchase.js";
import { handleMarketplaceInstall } from "../src/marketplace.js";

const NOW = Date.UTC(2026, 5, 14);

function fakePurchases(): AppPurchaseStorage & { rows: AppPurchaseRecord[] } {
  const rows: AppPurchaseRecord[] = [];
  return {
    rows,
    async grant(rec) {
      if (rows.some((r) => r.username === rec.username && r.creator === rec.creator && r.slug === rec.slug)) {
        return false;
      }
      rows.push({ ...rec });
      return true;
    },
    async has(u, c, s) {
      return rows.some((r) => r.username === u && r.creator === c && r.slug === s);
    },
    async listForUser(u) {
      return rows.filter((r) => r.username === u);
    },
  };
}

function listing(over: Partial<MarketplaceListingRecord> = {}): MarketplaceListingRecord {
  return {
    creator: "acme",
    slug: "notes",
    name: "Notes",
    tagline: "take notes",
    descriptionMd: "# Notes",
    category: "productivity",
    tagsCsv: "notes",
    canonicalUrl: "https://notes.acme.flagship.services",
    manifestHashHex: "00".repeat(32),
    screenshotKeysJson: "[]",
    status: "listed",
    rankScore: 1,
    installCount: 0,
    publicDistribution: true,
    listedAt: NOW,
    updatedAt: NOW,
    irkSignatureHex: "ab".repeat(32),
    ...over,
  };
}

async function seed(over: Partial<MarketplaceListingRecord> = {}) {
  const marketplace = new InMemoryMarketplaceStorage();
  await marketplace.upsert(listing(over));
  return marketplace;
}

function deps(marketplace: InMemoryMarketplaceStorage, purchases = fakePurchases()) {
  return { marketplace, purchases, now: () => NOW };
}

describe("isPaidListing", () => {
  it("free unless a positive price is set", () => {
    expect(isPaidListing({ priceUsdCents: undefined })).toBe(false);
    expect(isPaidListing({ priceUsdCents: 0 })).toBe(false);
    expect(isPaidListing({ priceUsdCents: 500 })).toBe(true);
  });
});

describe("grantAppPurchase", () => {
  it("grants ownership idempotently", async () => {
    const d = deps(await seed({ priceUsdCents: 500 }));
    const first = await grantAppPurchase(d, { username: "alice", creator: "acme", slug: "notes", source: "stripe" });
    expect(first.granted).toBe(true);
    const again = await grantAppPurchase(d, { username: "alice", creator: "acme", slug: "notes", source: "stripe" });
    expect(again.granted).toBe(false); // already owned
    expect(d.purchases.rows.length).toBe(1);
  });

  it("rejects a bad username or an unknown listing", async () => {
    const d = deps(await seed({ priceUsdCents: 500 }));
    await expect(grantAppPurchase(d, { username: "x", creator: "acme", slug: "notes", source: "admin" })).rejects.toThrow(/username/);
    await expect(grantAppPurchase(d, { username: "alice", creator: "acme", slug: "ghost", source: "admin" })).rejects.toThrow(/listing not found/);
  });
});

describe("isEntitledToInstall", () => {
  it("free app: always entitled; paid app: only when owned", async () => {
    const freeMk = await seed();
    expect(await isEntitledToInstall(deps(freeMk), listing(), null)).toBe(true);

    const paidMk = await seed({ priceUsdCents: 500 });
    const d = deps(paidMk);
    expect(await isEntitledToInstall(d, listing({ priceUsdCents: 500 }), "alice")).toBe(false);
    await grantAppPurchase(d, { username: "alice", creator: "acme", slug: "notes", source: "admin" });
    expect(await isEntitledToInstall(d, listing({ priceUsdCents: 500 }), "alice")).toBe(true);
    expect(await isEntitledToInstall(d, listing({ priceUsdCents: 500 }), null)).toBe(false); // anon can't own paid
  });
});

describe("handleMarketplaceInstall — paid gate (#14)", () => {
  const usernames = new InMemoryUsernameStorage();

  it("free app installs unconditionally and bumps the count", async () => {
    const marketplace = await seed();
    const res = await handleMarketplaceInstall({ marketplace, usernames, purchases: fakePurchases() }, "acme", "notes");
    expect(res.status).toBe(200);
    expect((await marketplace.get("acme", "notes"))!.installCount).toBe(1);
  });

  it("paid app without a purchase returns 402 + the price; no install recorded", async () => {
    const marketplace = await seed({ priceUsdCents: 500 });
    const res = await handleMarketplaceInstall(
      { marketplace, usernames, purchases: fakePurchases() },
      "acme",
      "notes",
      "alice",
    );
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ paid: true, price_usd_cents: 500 });
    expect((await marketplace.get("acme", "notes"))!.installCount).toBe(0);
  });

  it("paid app WITH a purchase installs", async () => {
    const marketplace = await seed({ priceUsdCents: 500 });
    const purchases = fakePurchases();
    await grantAppPurchase({ marketplace, purchases, now: () => NOW }, { username: "alice", creator: "acme", slug: "notes", source: "stripe" });
    const res = await handleMarketplaceInstall({ marketplace, usernames, purchases }, "acme", "notes", "alice");
    expect(res.status).toBe(200);
    expect((res.body as { owned?: boolean }).owned).toBe(true);
    expect((await marketplace.get("acme", "notes"))!.installCount).toBe(1);
  });

  it("without a purchases store wired, even a priced listing installs free (pre-#14 behaviour)", async () => {
    const marketplace = await seed({ priceUsdCents: 500 });
    const res = await handleMarketplaceInstall({ marketplace, usernames }, "acme", "notes", "alice");
    expect(res.status).toBe(200);
  });
});

describe("handleListUserPurchases", () => {
  it("400 on a bad username; lists what the user owns", async () => {
    const d = deps(await seed({ priceUsdCents: 500 }));
    expect((await handleListUserPurchases(d, "no")).status).toBe(400);
    await grantAppPurchase(d, { username: "alice", creator: "acme", slug: "notes", source: "stripe" });
    const res = await handleListUserPurchases(d, "Alice");
    expect(res.status).toBe(200);
    expect((res.body as { purchases: unknown[] }).purchases).toHaveLength(1);
    expect((res.body as any).purchases[0]).toMatchObject({ creator: "acme", slug: "notes", source: "stripe" });
  });
});

describe("admin price + grant handlers", () => {
  it("setAppPrice validates, caps, and 404s an unknown listing", async () => {
    const d = deps(await seed());
    expect((await handleAdminSetAppPrice(d, "acme", "notes", { priceUsdCents: -1 })).status).toBe(400);
    expect((await handleAdminSetAppPrice(d, "acme", "notes", { priceUsdCents: MAX_APP_PRICE_CENTS + 1 })).status).toBe(400);
    expect((await handleAdminSetAppPrice(d, "acme", "ghost", { priceUsdCents: 500 })).status).toBe(404);

    const ok = await handleAdminSetAppPrice(d, "acme", "notes", { priceUsdCents: 500 });
    expect(ok.status).toBe(200);
    expect((await d.marketplace.get("acme", "notes"))!.priceUsdCents).toBe(500);
    // 0 makes it free again.
    await handleAdminSetAppPrice(d, "acme", "notes", { priceUsdCents: 0 });
    expect((await d.marketplace.get("acme", "notes"))!.priceUsdCents).toBeUndefined();
  });

  it("grantPurchase comps a user", async () => {
    const d = deps(await seed({ priceUsdCents: 500 }));
    expect((await handleAdminGrantPurchase(d, "acme", "notes", {})).status).toBe(400);
    const res = await handleAdminGrantPurchase(d, "acme", "notes", { username: "alice", ref: "support#42" });
    expect(res.status).toBe(200);
    expect(await d.purchases.has("alice", "acme", "notes")).toBe(true);
  });
});
