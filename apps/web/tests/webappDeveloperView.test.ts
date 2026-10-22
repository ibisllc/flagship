// Developer console — webapp view (apps/web/public/webapp/views/developer.js).
//
// Coverage:
//   1. Static surface: the view file is reachable, registers the view, hits the
//      /api/developer/sales endpoint, exports the standard view contract, and is
//      precached by the service worker.
//   2. index.html exposes the section + refresh/back controls + an entry button.
//   3. app.js + router.js wire the view (import/init, sub-view tab, alias).
//   4. Pure helpers: formatCents / formatCutPct / render* produce the documented
//      HTML.
//   5. fetchDeveloperSales signs the canonical read proof, puts issuedAt + hex
//      sig on the query string, and returns the parsed JSON.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function fetchAsset(url: string) {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url });
  expect(r.statusCode).toBe(200);
  return r.body;
}

async function loadView() {
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const path = resolve(__dirname, "..", "public", "webapp", "views", "developer.js");
  return await import(pathToFileURL(path).href + bust);
}

const SALES = {
  ok: true,
  creator: "alice",
  currency: "usd",
  cut_bps: 1500,
  totals: {
    gross_cents: 10000,
    cut_cents: 1500,
    net_cents: 8500,
    sale_count: 4,
    payout_owed_cents: 8500,
    install_count: 12,
  },
  listings: [
    {
      listing_id: "l1", creator: "alice", slug: "notes", name: "Notes",
      status: "published", price_usd_cents: 500, is_paid: true, scan_grade: "A",
      install_count: 9, gross_cents: 10000, cut_cents: 1500, net_cents: 8500, sale_count: 4,
    },
    {
      listing_id: "l2", creator: "alice", slug: "free-thing", name: "Free Thing",
      status: "published", price_usd_cents: 0, is_paid: false, scan_grade: null,
      install_count: 3, gross_cents: 0, cut_cents: 0, net_cents: 0, sale_count: 0,
    },
  ],
  sales: [
    { sale_key: "s1", listing_id: "l1", buyer: "bob", gross_cents: 500, cut_cents: 75, net_cents: 425, currency: "usd", at: 1 },
  ],
};

describe("developer view — static surface", () => {
  it("is reachable and registers the view", async () => {
    const body = await fetchAsset("/webapp/views/developer.js");
    expect(body).toContain('registerView("view-developer")');
  });

  it("exports the standard view contract + signs against the documented endpoint", async () => {
    const body = await fetchAsset("/webapp/views/developer.js");
    expect(body).toContain("export function initDeveloperView");
    expect(body).toContain("export async function enterDeveloper");
    expect(body).toContain("export async function renderDeveloper");
    expect(body).toContain("export async function fetchDeveloperSales");
    expect(body).toContain("/api/developer/sales/");
    expect(body).toContain("flagship/developer-sales-read/v1");
    expect(body).toContain("signWithIrk");
  });

  it("is precached by the service worker", async () => {
    const body = await fetchAsset("/webapp/service-worker.js");
    expect(body).toContain("/views/developer.js");
  });
});

describe("developer view — shell wiring", () => {
  it("index.html carries the section + controls + entry button", async () => {
    const html = await fetchAsset("/webapp/");
    expect(html).toContain('id="view-developer"');
    expect(html).toContain('id="developer-content"');
    expect(html).toContain('id="developer-refresh"');
    expect(html).toContain('id="developer-back"');
    expect(html).toContain('id="services-list-open-developer"');
  });

  it("app.js imports + inits + tabs the view", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain("initDeveloperView");
    expect(body).toContain("enterDeveloper");
    expect(body).toContain('"view-developer": "apps"');
  });

  it("router.js aliases developer → view-developer", async () => {
    const body = await fetchAsset("/webapp/lib/router.js");
    expect(body).toContain('developer: "view-developer"');
  });
});

describe("developer view — pure helpers", () => {
  it("formatCents renders dollars (incl. zero + negative)", async () => {
    const mod = await loadView();
    expect(mod.formatCents(10000)).toBe("$100.00");
    expect(mod.formatCents(425)).toBe("$4.25");
    expect(mod.formatCents(0)).toBe("$0.00");
    expect(mod.formatCents(-500)).toBe("-$5.00");
    expect(mod.formatCents(undefined)).toBe("$0.00");
  });

  it("formatCutPct renders basis points as a percent", async () => {
    const mod = await loadView();
    expect(mod.formatCutPct(1500)).toBe("15%");
    expect(mod.formatCutPct(1250)).toBe("12.5%");
    expect(mod.formatCutPct(0)).toBe("0%");
  });

  it("renderTotalsHtml surfaces payout owed + cut % + gross", async () => {
    const mod = await loadView();
    const html = mod.renderTotalsHtml(SALES.totals, SALES.cut_bps);
    expect(html).toContain("payout owed");
    expect(html).toContain("$85.00"); // net / payout
    expect(html).toContain("$100.00"); // gross
    expect(html).toContain("15%"); // platform cut
    expect(html).toContain("12 installs");
  });

  it("renderListingRowHtml shows name, price, installs, sales, money, scan grade", async () => {
    const mod = await loadView();
    const paid = mod.renderListingRowHtml(SALES.listings[0]);
    expect(paid).toContain("Notes");
    expect(paid).toContain("$5.00");
    expect(paid).toContain('data-listing="l1"');
    expect(paid).toContain("scan A");
    const free = mod.renderListingRowHtml(SALES.listings[1]);
    expect(free).toContain("free");
    expect(free).toContain("ungraded");
  });

  it("renderSalesListHtml lists buyers + net, empty ⇒ ''", async () => {
    const mod = await loadView();
    expect(mod.renderSalesListHtml(SALES.sales)).toContain("bob");
    expect(mod.renderSalesListHtml([])).toBe("");
  });

  it("canonicalDeveloperSalesBytes is the exact wire contract", async () => {
    const mod = await loadView();
    const bytes = mod.canonicalDeveloperSalesBytes("alice", 1700);
    expect(new TextDecoder().decode(bytes)).toBe("flagship/developer-sales-read/v1|alice|1700");
  });
});

describe("developer view — fetchDeveloperSales (sign + fetch)", () => {
  it("signs the canonical proof and passes issuedAt + hex sig as query params", async () => {
    const mod = await loadView();
    const sign = vi.fn(async () => new Uint8Array(64).fill(0xab));
    let seenUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => SALES };
    });
    const out = await mod.fetchDeveloperSales(
      { creator: "alice", umk: new Uint8Array(32), signWithIrk: sign },
      { fetch: fetchImpl, origin: "", now: () => 1700 },
    );
    expect(out.creator).toBe("alice");
    expect(out.totals.payout_owed_cents).toBe(8500);
    // The signer saw the exact canonical bytes.
    const signedBytes = sign.mock.calls[0]![1] as Uint8Array;
    expect(new TextDecoder().decode(signedBytes)).toBe("flagship/developer-sales-read/v1|alice|1700");
    // The URL carries the signed proof.
    expect(seenUrl).toBe(`/api/developer/sales/alice?issuedAt=1700&sig=${"ab".repeat(64)}`);
  });

  it("throws without an unlocked umk (no fetch, no sign)", async () => {
    const mod = await loadView();
    const sign = vi.fn();
    const fetchImpl = vi.fn();
    await expect(
      mod.fetchDeveloperSales(
        { creator: "alice", umk: null, signWithIrk: sign },
        { fetch: fetchImpl },
      ),
    ).rejects.toThrow(/unlock/);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a non-ok backend response", async () => {
    const mod = await loadView();
    await expect(
      mod.fetchDeveloperSales(
        { creator: "alice", umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64) },
        { fetch: async () => ({ ok: false, status: 403, text: async () => "nope" }), now: () => 1 },
      ),
    ).rejects.toThrow(/403/);
  });
});
