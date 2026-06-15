// #6 / #7 — webapp usage/allowance dashboard + over-allowance upgrade alert.
//
// Pure helpers (byte formatting, %, reset label, state→colour, alert copy)
// are unit-tested without a DOM; the card HTML + the fetch/render path get a
// thin DOM harness. The no-op-on-failure path is pinned: a failed / !ok /
// missing-endpoint fetch must leave the host empty so Home never breaks.

import { describe, expect, it, vi } from "vitest";
import {
  TIER_LABELS,
  PRO_URL,
  tierLabel,
  formatGB,
  formatUsedOfQuota,
  usedPercent,
  barWidthPercent,
  barTone,
  resetLabel,
  shouldShowUpgradeAlert,
  upgradeAlertCopy,
  normalizeAllowance,
  allowanceCardHtml,
  fetchAllowance,
  renderAllowanceCard,
} from "../public/webapp/lib/allowance.js";

const GB = 1024 * 1024 * 1024;

function okStatus(over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    username: "harry",
    tier: "free",
    period: "2026-06",
    usedBytes: 25 * GB,
    quotaBytes: 50 * GB,
    remainingBytes: 25 * GB,
    usedFraction: 0.5,
    overQuota: false,
    overageUsd: 0,
    state: "ok",
    hardCapped: false,
    ...over,
  };
}

describe("allowance — tier labels", () => {
  it("maps backend tiers to marketing labels", () => {
    expect(TIER_LABELS).toEqual({ free: "Free", hobby: "Pro", maker: "Pro Max" });
    expect(tierLabel("free")).toBe("Free");
    expect(tierLabel("hobby")).toBe("Pro");
    expect(tierLabel("maker")).toBe("Pro Max");
  });
  it("passes through an unknown tier without throwing", () => {
    expect(tierLabel("enterprise")).toBe("enterprise");
    expect(tierLabel(undefined)).toBe("");
  });
});

describe("allowance — byte formatting", () => {
  it("formats whole GB without a decimal", () => {
    expect(formatGB(50 * GB)).toBe("50 GB");
    expect(formatGB(250 * GB)).toBe("250 GB");
    expect(formatGB(1024 * GB)).toBe("1024 GB"); // 1 TB shown in GB
  });
  it("formats fractional GB to one decimal", () => {
    // 12.4 GB → exactly one decimal place
    expect(formatGB(12.4 * GB)).toBe("12.4 GB");
    expect(formatGB(0.5 * GB)).toBe("0.5 GB");
  });
  it("clamps negative / non-finite / zero to 0 GB", () => {
    expect(formatGB(0)).toBe("0 GB");
    expect(formatGB(-5)).toBe("0 GB");
    expect(formatGB(NaN)).toBe("0 GB");
    expect(formatGB(undefined as unknown as number)).toBe("0 GB");
  });
  it("builds the used-of-quota caption", () => {
    expect(formatUsedOfQuota(12.4 * GB, 50 * GB)).toBe("12.4 GB of 50 GB");
  });
});

describe("allowance — percentages", () => {
  it("rounds the displayed percent and does NOT clamp above 100", () => {
    expect(usedPercent(0.5)).toBe(50);
    expect(usedPercent(0.804)).toBe(80);
    expect(usedPercent(1.12)).toBe(112); // over-quota reads past 100
    expect(usedPercent(0)).toBe(0);
    expect(usedPercent(-1)).toBe(0);
    expect(usedPercent(NaN)).toBe(0);
  });
  it("clamps the BAR width to 0..100", () => {
    expect(barWidthPercent(0.5)).toBe(50);
    expect(barWidthPercent(1.5)).toBe(100);
    expect(barWidthPercent(-0.2)).toBe(0);
  });
});

describe("allowance — state → bar colour", () => {
  it("maps ok/approaching/over onto ok/warn/err", () => {
    expect(barTone("ok")).toBe("ok");
    expect(barTone("approaching")).toBe("warn");
    expect(barTone("over")).toBe("err");
    expect(barTone("nonsense")).toBe("ok");
  });
});

describe("allowance — reset label", () => {
  it("reports the 1st of the NEXT month", () => {
    expect(resetLabel("2026-06")).toBe("Resets 1 Jul");
    expect(resetLabel("2026-01")).toBe("Resets 1 Feb");
  });
  it("rolls December into January", () => {
    expect(resetLabel("2026-12")).toBe("Resets 1 Jan");
  });
  it("returns empty for a malformed period", () => {
    expect(resetLabel("")).toBe("");
    expect(resetLabel("June")).toBe("");
    expect(resetLabel(undefined)).toBe("");
  });
});

describe("allowance — upgrade alert (#7) copy selection", () => {
  it("shows for approaching + over, not ok", () => {
    expect(shouldShowUpgradeAlert("ok")).toBe(false);
    expect(shouldShowUpgradeAlert("approaching")).toBe(true);
    expect(shouldShowUpgradeAlert("over")).toBe(true);
  });

  it("approaching → soft nudge carrying the % used", () => {
    const c = upgradeAlertCopy({ state: "approaching", usedFraction: 0.85 });
    expect(c).not.toBeNull();
    expect(c!.tone).toBe("warn");
    expect(c!.message).toBe(
      "You've used 85% of your bandwidth this month. Upgrade to Pro for more.",
    );
    expect(c!.cta).toBe("Upgrade to Pro");
  });

  it("over + hardCapped (free) → paused-traffic copy", () => {
    const c = upgradeAlertCopy({ state: "over", hardCapped: true, usedFraction: 1.1 });
    expect(c!.tone).toBe("err");
    expect(c!.message).toBe(
      "You've hit your free bandwidth cap — public traffic is paused until next month or until you upgrade.",
    );
    expect(c!.cta).toBe("Upgrade to Pro");
  });

  it("over + !hardCapped (paid) → overage copy, Pro Max CTA", () => {
    const c = upgradeAlertCopy({ state: "over", hardCapped: false, usedFraction: 1.05 });
    expect(c!.tone).toBe("err");
    expect(c!.message).toBe(
      "You're over your plan's bandwidth — overage applies. Consider Pro Max.",
    );
    expect(c!.cta).toBe("Upgrade to Pro Max");
  });

  it("ok → no alert", () => {
    expect(upgradeAlertCopy({ state: "ok" })).toBeNull();
  });
});

describe("allowance — normalize", () => {
  it("returns null when not ok:true", () => {
    expect(normalizeAllowance(null)).toBeNull();
    expect(normalizeAllowance({ ok: false })).toBeNull();
    expect(normalizeAllowance({})).toBeNull();
  });
  it("passes through a well-formed payload", () => {
    const a = normalizeAllowance(okStatus({ state: "approaching", usedFraction: 0.9 }));
    expect(a).not.toBeNull();
    expect(a!.tier).toBe("free");
    expect(a!.state).toBe("approaching");
    expect(a!.usedFraction).toBe(0.9);
  });
  it("derives remaining + fraction when absent", () => {
    const a = normalizeAllowance({
      ok: true,
      tier: "hobby",
      usedBytes: 100 * GB,
      quotaBytes: 250 * GB,
    });
    expect(a!.remainingBytes).toBe(150 * GB);
    expect(a!.usedFraction).toBeCloseTo(0.4, 5);
    expect(a!.state).toBe("ok");
  });
  it("coerces an unknown state to ok", () => {
    const a = normalizeAllowance(okStatus({ state: "weird" }));
    expect(a!.state).toBe("ok");
  });
});

describe("allowance — card HTML (#6)", () => {
  it("renders tier, GB bar, percent, remaining + reset", () => {
    const a = normalizeAllowance(
      okStatus({ usedBytes: 12.4 * GB, quotaBytes: 50 * GB, usedFraction: 0.248 }),
    )!;
    const html = allowanceCardHtml(a);
    expect(html).toContain("Free");
    expect(html).toContain("12.4 GB of 50 GB");
    expect(html).toContain("25% used"); // 0.248 → 25
    expect(html).toContain("remaining");
    expect(html).toContain("Resets 1 Jul");
    expect(html).toContain("allowance-bar-fill--ok");
    // No upgrade alert in the ok state.
    expect(html).not.toContain("data-allowance-upgrade");
  });

  it("colours the bar amber when approaching + shows the upgrade alert", () => {
    const a = normalizeAllowance(
      okStatus({ state: "approaching", usedFraction: 0.85 }),
    )!;
    const html = allowanceCardHtml(a);
    expect(html).toContain("allowance-bar-fill--warn");
    expect(html).toContain("allowance-alert--warn");
    expect(html).toContain("85% of your bandwidth");
    expect(html).toContain(`href="${PRO_URL}"`);
    expect(html).toContain("data-allowance-upgrade");
  });

  it("colours the bar red + shows the hard-cap alert when over + hardCapped", () => {
    const a = normalizeAllowance(
      okStatus({ state: "over", overQuota: true, hardCapped: true, usedFraction: 1.1 }),
    )!;
    const html = allowanceCardHtml(a);
    expect(html).toContain("allowance-bar-fill--err");
    expect(html).toContain("allowance-alert--err");
    expect(html).toContain("public traffic is paused");
    expect(html).toContain(`href="${PRO_URL}"`);
  });
});

describe("allowance — fetch", () => {
  it("hits the public /allowance endpoint and normalizes", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => okStatus({ state: "over", hardCapped: true }),
    })) as unknown as typeof fetch;
    const a = await fetchAllowance("harry", { fetch: fetchMock, comBase: "https://x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://x/api/users/harry/allowance",
      { cache: "no-store" },
    );
    expect(a!.state).toBe("over");
    expect(a!.hardCapped).toBe(true);
  });

  it("returns null on a non-ok HTTP response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchAllowance("harry", { fetch: fetchMock })).toBeNull();
  });

  it("returns null on a thrown fetch (offline / CORS / missing endpoint)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await fetchAllowance("harry", { fetch: fetchMock })).toBeNull();
  });

  it("returns null for an empty username without fetching", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    expect(await fetchAllowance("", { fetch: fetchMock })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("allowance — render into a host (no-op on failure)", () => {
  function fakeHost() {
    let html = "";
    return {
      get innerHTML() {
        return html;
      },
      set innerHTML(v: string) {
        html = v;
      },
    } as unknown as HTMLElement;
  }

  it("paints the card when the fetch succeeds", async () => {
    const host = fakeHost();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => okStatus({ state: "approaching", usedFraction: 0.82 }),
    })) as unknown as typeof fetch;
    const a = await renderAllowanceCard(host, "harry", { fetch: fetchMock });
    expect(a!.state).toBe("approaching");
    expect(host.innerHTML).toContain("allowance-card");
    expect(host.innerHTML).toContain("data-allowance-upgrade");
  });

  it("leaves the host EMPTY when the fetch fails (Home never breaks)", async () => {
    const host = fakeHost();
    host.innerHTML = "<div>stale</div>";
    const fetchMock = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const a = await renderAllowanceCard(host, "harry", { fetch: fetchMock });
    expect(a).toBeNull();
    expect(host.innerHTML).toBe("");
  });

  it("no-ops with a null host", async () => {
    expect(await renderAllowanceCard(null, "harry")).toBeNull();
  });
});
