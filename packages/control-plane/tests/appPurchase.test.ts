import { describe, expect, it } from "vitest";
import { InMemoryMarketplaceStorage, InMemoryUsernameStorage, InMemoryAppSalesStorage, InMemoryServerStorage } from "@flagship/storage";
import type { AppPurchaseRecord, AppPurchaseStorage, MarketplaceListingRecord } from "@flagship/storage";
import { ed, signSetAppPrice, type Keypair, type SetAppPriceRequest } from "@flagship/protocol";
import {
  grantAppPurchase,
  isEntitledToInstall,
  isPaidListing,
  handleListUserPurchases,
  handleAdminSetAppPrice,
  handleCreatorSetAppPrice,
  handleAdminGrantPurchase,
  computeCut,
  parseCutBps,
  DEFAULT_MARKETPLACE_CUT_BPS,
  MAX_APP_PRICE_CENTS,
} from "../src/appPurchase.js";
import { handleMarketplaceInstall } from "../src/marketplace.js";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function makeKp(seed = 7): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

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

describe("revenue cut (#15)", () => {
  it("computeCut floors the cut (creator-favorable) and defaults to 15%", () => {
    expect(computeCut(1000)).toEqual({ cutCents: 150, netCents: 850 }); // 15% default
    expect(computeCut(1000, 3000)).toEqual({ cutCents: 300, netCents: 700 });
    expect(computeCut(999, 1500)).toEqual({ cutCents: 149, netCents: 850 }); // floor(149.85)=149
    expect(computeCut(0, 1500)).toEqual({ cutCents: 0, netCents: 0 });
    expect(computeCut(1000, 0)).toEqual({ cutCents: 0, netCents: 1000 }); // 0% cut
  });
  it("parseCutBps clamps garbage / out-of-range to the default", () => {
    expect(parseCutBps(undefined)).toBe(DEFAULT_MARKETPLACE_CUT_BPS);
    expect(parseCutBps("")).toBe(DEFAULT_MARKETPLACE_CUT_BPS);
    expect(parseCutBps("abc")).toBe(DEFAULT_MARKETPLACE_CUT_BPS);
    expect(parseCutBps("-1")).toBe(DEFAULT_MARKETPLACE_CUT_BPS);
    expect(parseCutBps("10001")).toBe(DEFAULT_MARKETPLACE_CUT_BPS);
    expect(parseCutBps("2000")).toBe(2000);
  });

  it("a stripe grant writes an idempotent app_sales row keyed on the event id", async () => {
    const marketplace = await seed({ priceUsdCents: 1000 });
    const purchases = fakePurchases();
    const sales = new InMemoryAppSalesStorage();
    const d = { marketplace, purchases, sales, cutBps: 2000, now: () => NOW };
    const res = await grantAppPurchase(d, {
      username: "alice", creator: "acme", slug: "notes", source: "stripe", stripeEventId: "evt_9",
    });
    expect(res.saleRecorded).toBe(true);
    const rows = await sales.listForCreator("acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      saleKey: "evt_9", listingId: "acme--notes", buyerAccount: "alice",
      grossCents: 1000, cutCents: 200, netCents: 800, currency: "usd", stripeEventId: "evt_9",
    });
    // Same event redelivered ⇒ purchase already owned ⇒ no second sale.
    const again = await grantAppPurchase(d, {
      username: "alice", creator: "acme", slug: "notes", source: "stripe", stripeEventId: "evt_9",
    });
    expect(again.granted).toBe(false);
    expect(await sales.listForCreator("acme")).toHaveLength(1);
  });

  it("an admin comp does NOT write a sale (no revenue), a voucher does", async () => {
    const marketplace = await seed({ priceUsdCents: 500 });
    const sales = new InMemoryAppSalesStorage();
    const comp = await grantAppPurchase(
      { marketplace, purchases: fakePurchases(), sales, now: () => NOW },
      { username: "alice", creator: "acme", slug: "notes", source: "admin" },
    );
    expect(comp.saleRecorded).toBe(false);
    expect(await sales.listForCreator("acme")).toHaveLength(0);

    const vouch = await grantAppPurchase(
      { marketplace, purchases: fakePurchases(), sales, now: () => NOW },
      { username: "bob", creator: "acme", slug: "notes", source: "voucher" },
    );
    expect(vouch.saleRecorded).toBe(true);
    expect((await sales.listForCreator("acme"))[0]!.saleKey).toBe("voucher:acme:notes:bob");
  });

  it("a free listing never writes a sale even with a sales store wired", async () => {
    const marketplace = await seed(); // no price
    const sales = new InMemoryAppSalesStorage();
    const res = await grantAppPurchase(
      { marketplace, purchases: fakePurchases(), sales, now: () => NOW },
      { username: "alice", creator: "acme", slug: "notes", source: "stripe", stripeEventId: "evt_x" },
    );
    expect(res.saleRecorded).toBe(false);
    expect(await sales.listForCreator("acme")).toHaveLength(0);
  });
});

describe("handleCreatorSetAppPrice (#15 self-serve pricing)", () => {
  async function ctx(seed = 7) {
    const marketplace = await seed0();
    const usernames = new InMemoryUsernameStorage();
    const irk = makeKp(seed);
    await usernames.put({ username: "acme", irkPubHex: hex(irk.publicKey), claimedAt: NOW });
    return { marketplace, usernames, irk };
  }
  async function seed0() {
    const marketplace = new InMemoryMarketplaceStorage();
    await marketplace.upsert(listing());
    return marketplace;
  }
  function signed(irk: Keypair, over: Partial<SetAppPriceRequest> = {}) {
    const req: SetAppPriceRequest = { creator: "acme", slug: "notes", priceUsdCents: 500, issuedAt: NOW, ...over };
    return { request: req, signature: hex(signSetAppPrice(req, irk)) };
  }

  it("a valid creator-signed request sets the price", async () => {
    const { marketplace, usernames, irk } = await ctx();
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, now: () => NOW }, "acme", "notes", signed(irk));
    expect(res.status).toBe(200);
    expect((await marketplace.get("acme", "notes"))!.priceUsdCents).toBe(500);
  });

  it("0 makes the app free", async () => {
    const { marketplace, usernames, irk } = await ctx();
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, now: () => NOW }, "acme", "notes", signed(irk, { priceUsdCents: 0 }));
    expect(res.status).toBe(200);
    expect((await marketplace.get("acme", "notes"))!.priceUsdCents).toBeUndefined();
  });

  it("rejects a wrong signer (not the creator)", async () => {
    const { marketplace, usernames } = await ctx(7);
    const attacker = makeKp(9);
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, now: () => NOW }, "acme", "notes", signed(attacker));
    expect(res.status).toBe(403);
    expect((await marketplace.get("acme", "notes"))!.priceUsdCents).toBeUndefined();
  });

  it("caps at MAX_APP_PRICE_CENTS", async () => {
    const { marketplace, usernames, irk } = await ctx();
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, now: () => NOW }, "acme", "notes", signed(irk, { priceUsdCents: MAX_APP_PRICE_CENTS + 1 }));
    expect(res.status).toBe(400);
  });

  it("rejects a request whose signed creator/slug differs from the route", async () => {
    const { marketplace, usernames, irk } = await ctx();
    const env = signed(irk, { slug: "other" });
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, now: () => NOW }, "acme", "notes", env);
    expect(res.status).toBe(400);
  });

  it("rejects a stale request", async () => {
    const { marketplace, usernames, irk } = await ctx();
    const env = signed(irk, { issuedAt: NOW - 10 * 60_000 });
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, now: () => NOW }, "acme", "notes", env);
    expect(res.status).toBe(403);
  });

  it("accepts a non-revoked server identity key of the creator's account", async () => {
    const { marketplace, usernames } = await ctx();
    const servers = new InMemoryServerStorage();
    const srvKey = makeKp(21);
    await servers.put({
      serverDomain: "notes.acme.flagship.services",
      username: "acme",
      identityPubKeyHex: hex(srvKey.publicKey),
      registeredAt: NOW,
    });
    const res = await handleCreatorSetAppPrice({ marketplace, usernames, servers, now: () => NOW }, "acme", "notes", signed(srvKey));
    expect(res.status).toBe(200);
    expect((await marketplace.get("acme", "notes"))!.priceUsdCents).toBe(500);
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
