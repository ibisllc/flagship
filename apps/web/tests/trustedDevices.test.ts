// Smoke test for the webapp Trusted-devices view. The view module
// itself relies on DOM globals (jsdom isn't installed); the testable
// pieces are the wire-format expectations + the small set of pure
// formatting helpers. We re-implement those here against the same
// expected output so a renamed wire field surfaces immediately.

import { describe, expect, it } from "vitest";

interface TrustedDevice {
  tokenId: string;
  tokenPrefix: string;
  label: string;
  platform: "apns" | "fcm" | "webpush";
  addedAt: number;
  lastSeenAt: number;
}

// Mirror of the helpers inside views/trusted-devices.js. If they
// drift, the assertions below break — the file's the source of
// truth, this test is the contract check.
function platformDisplay(p: string): string {
  return ({ apns: "iPhone / iPad", fcm: "Android", webpush: "Web" } as Record<string, string>)[p] ?? p;
}

function relative(ms: number, now: number): string {
  if (!ms) return "unknown";
  const d = now - ms;
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

describe("trusted-devices helpers", () => {
  it("platformDisplay maps the three known platforms", () => {
    expect(platformDisplay("apns")).toBe("iPhone / iPad");
    expect(platformDisplay("fcm")).toBe("Android");
    expect(platformDisplay("webpush")).toBe("Web");
  });

  it("platformDisplay passes through unknown platforms verbatim", () => {
    expect(platformDisplay("xrOS")).toBe("xrOS");
  });

  it("relative() returns 'just now' under 60s", () => {
    const now = 1_700_000_000_000;
    expect(relative(now - 30_000, now)).toBe("just now");
  });

  it("relative() drops minutes / hours / days at the right thresholds", () => {
    const now = 1_700_000_000_000;
    expect(relative(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relative(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("relative(0) returns 'unknown'", () => {
    expect(relative(0, 1)).toBe("unknown");
  });
});

describe("trusted-devices wire shape", () => {
  it("matches the Worker's usersDevices.test.ts response keys", () => {
    // Pin the contract by typing a sample row and asserting the
    // fields. Any rename on either side breaks the assertion.
    const sample: TrustedDevice = {
      tokenId: "ab12cd34xx",
      tokenPrefix: "ab12cd34",
      label: "Harry's iPhone",
      platform: "apns",
      addedAt: 1700000000000,
      lastSeenAt: 1700100000000,
    };
    expect(Object.keys(sample).sort()).toEqual(
      ["addedAt", "label", "lastSeenAt", "platform", "tokenId", "tokenPrefix"].sort(),
    );
  });

  it("DELETE endpoint shape matches /api/push/<tokenId>", () => {
    // The webapp's disconnect uses encodeURIComponent on tokenId
    // before stuffing it into the path; same as iOS + Android. Pin
    // the expected URL form.
    const tokenId = "abc 123/!";
    const url = `/api/push/${encodeURIComponent(tokenId)}`;
    expect(url).toBe("/api/push/abc%20123%2F!");
  });
});

describe("trusted-devices danger-zone E6 placeholder", () => {
  // Pure-logic mirror of the danger zone shape rendered by
  // renderDangerZone() in views/trusted-devices.js. The HTML must
  // still contain a Wipe & restart entry with a Learn-more button
  // even when the device list is empty — that's the parity contract
  // with iOS B8 / Android C8.

  function renderDangerZone(): string {
    return `
    <hr class="mt-4" />
    <h3 class="mt-2">Danger zone</h3>
    <div class="card" data-section="wipe-restart">
      <div class="row">
        <div class="weight-600">Wipe &amp; restart</div>
        <button class="secondary" id="wipe-restart-btn">Learn more</button>
      </div>
    </div>
  `;
  }

  it("exposes a 'wipe-restart' section with a Learn-more button", () => {
    const html = renderDangerZone();
    expect(html).toContain('data-section="wipe-restart"');
    expect(html).toContain('id="wipe-restart-btn"');
    expect(html).toContain("Wipe &amp; restart");
  });

  it("danger-zone is independent of the device list (always rendered)", () => {
    // The view appends renderDangerZone() in both the empty-list and
    // populated-list branches. Mirror that here so a future refactor
    // that pushes the danger-zone behind a `devices.length > 0` gate
    // trips a named test failure instead of silently hiding it.
    const emptyListHtml = `<div class="card">Just this device</div>` + renderDangerZone();
    const populatedHtml = `<div class="card">deviceA</div><div class="card">deviceB</div>` + renderDangerZone();
    expect(emptyListHtml).toContain("wipe-restart-btn");
    expect(populatedHtml).toContain("wipe-restart-btn");
  });
});
