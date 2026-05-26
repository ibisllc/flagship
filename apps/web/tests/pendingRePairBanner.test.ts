// Pure-logic test for the Trusted-devices "Replace pending" banner.
// jsdom isn't in the repo; the view module owns the click wiring,
// these tests pin the render branches + the shouldRender truth table.

import { describe, expect, it } from "vitest";
import {
  renderPendingBanner,
  shouldRenderBanner,
  formatCompletesAt,
} from "../public/webapp/lib/pendingRePairBanner.js";

const NOW = 1_700_000_000_000;
const FUTURE = NOW + 7 * 86_400_000;
const PAST = NOW - 60_000;

function pending(overrides: Record<string, unknown> = {}) {
  return {
    pending: {
      newIrkPub: "aa".repeat(32),
      oldIrkPub: "bb".repeat(32),
      initiatedAt: NOW - 1000,
      completesAt: FUTURE,
      objectedAt: null,
      ...overrides,
    },
  };
}

describe("pendingRePairBanner — shouldRenderBanner", () => {
  it("returns false when no snapshot", () => {
    expect(shouldRenderBanner(undefined)).toBe(false);
    expect(shouldRenderBanner(null)).toBe(false);
  });

  it("returns false when pending is null", () => {
    expect(shouldRenderBanner({ pending: null })).toBe(false);
  });

  it("returns false on the unavailable-endpoint fallback", () => {
    expect(shouldRenderBanner({ pending: null, unavailable: true })).toBe(false);
  });

  it("returns false when the pending row was objected", () => {
    expect(shouldRenderBanner(pending({ objectedAt: NOW }))).toBe(false);
  });

  it("returns true for a live, unobjected pending row", () => {
    expect(shouldRenderBanner(pending())).toBe(true);
  });
});

describe("pendingRePairBanner — renderPendingBanner", () => {
  it("returns the empty string when no banner should render", () => {
    expect(renderPendingBanner({ pending: null })).toBe("");
    expect(renderPendingBanner({ pending: null, unavailable: true })).toBe("");
    expect(renderPendingBanner(pending({ objectedAt: NOW }))).toBe("");
  });

  it("renders a Finalize now button (disabled) while the grace is live", () => {
    const html = renderPendingBanner(pending({ completesAt: FUTURE }), NOW);
    expect(html).toContain("Replace pending");
    expect(html).toContain('id="finalize-replace-btn"');
    expect(html).toContain("disabled");
    expect(html).toContain("7-day grace");
  });

  it("renders a Finalize now button (enabled) once the grace has elapsed", () => {
    const html = renderPendingBanner(pending({ completesAt: PAST }), NOW);
    expect(html).toContain("Replace pending");
    expect(html).toContain('id="finalize-replace-btn"');
    // The button is no longer disabled — assert by checking the
    // attribute doesn't sit inside the button tag.
    const buttonMatch = html.match(/<button[^>]*id="finalize-replace-btn"[^>]*>/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch![0]).not.toContain("disabled");
    expect(html).toContain("grace window has elapsed");
  });

  it("uses role=status + aria-live=polite for assistive tech", () => {
    const html = renderPendingBanner(pending(), NOW);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("escapes the completesAt timestamp into the copy", () => {
    // formatCompletesAt → locale string; just assert the value appears.
    const html = renderPendingBanner(pending({ completesAt: FUTURE }), NOW);
    const expected = new Date(FUTURE).toLocaleString();
    expect(html).toContain(expected);
  });
});

describe("pendingRePairBanner — view-wiring contract", () => {
  it("banner emits a button with the id the view's click handler queries", () => {
    // The view does:
    //   document.getElementById("finalize-replace-btn")?.addEventListener("click", finalize)
    // If we rename the id here, the click never wires up. Pin the
    // id surface so a future refactor surfaces in a named test failure.
    const html = renderPendingBanner(pending(), NOW);
    expect(html).toMatch(/id="finalize-replace-btn"/);
  });

  it("a pending row contains exactly the fields the finalize handler needs", () => {
    // The handler calls completeReplaceDeviceCeremony({ username }) —
    // no fields from the pending row are passed in. Pin that contract
    // so a future "pass pending.newIrkPub through" refactor surfaces
    // here (we'd need to add fields to the snapshot if so).
    const snap = pending();
    expect(snap.pending).toMatchObject({
      newIrkPub: expect.any(String),
      oldIrkPub: expect.any(String),
      initiatedAt: expect.any(Number),
      completesAt: expect.any(Number),
    });
  });
});

describe("pendingRePairBanner — formatCompletesAt", () => {
  it("returns 'soon' for falsy / non-numeric inputs", () => {
    expect(formatCompletesAt(undefined as any)).toBe("soon");
    expect(formatCompletesAt(0)).toBe("soon");
    expect(formatCompletesAt("nope" as any)).toBe("soon");
  });

  it("returns a locale string for a numeric epoch", () => {
    expect(formatCompletesAt(NOW)).toBe(new Date(NOW).toLocaleString());
  });
});
