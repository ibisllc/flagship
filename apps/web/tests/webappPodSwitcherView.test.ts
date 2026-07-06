import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * Webapp pod-switcher view wiring — the "server-list dropdown" chip row used
 * to scope by server, now on BOTH the Services and Activity pages.
 *
 * These assert the SHIPPED source text (the same served-file contract the
 * other webapp view tests use):
 *   - the switcher renders an "All servers" first option (data-pod-switch="")
 *   - selection is the teal `is-selected` background ONLY — no "✓" tick
 *   - the leader pod gets the small flag marker (icons.flagIcon)
 *   - the Activity page now has the SAME switcher (it had none before)
 * The pure selection/leader/all logic is covered in podSwitcher.test.ts.
 */
describe("webapp pod-switcher — Services page", () => {
  it("renders the switcher with a leader flag and NO checkmark tick", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/services-list.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("buildPodSwitcherModel");
    expect(r.body).toContain("data-pod-switch");
    // Leader marker present.
    expect(r.body).toContain("flagIcon");
    expect(r.body).toContain("pod-switcher-leader");
    // Selection is the teal class only — the literal " ✓" tick is GONE.
    expect(r.body).not.toContain("✓");
  });

  it("aggregates across pods for the 'All servers' (empty base URL) scope", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/services-list.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("fetchAppsAcrossPods");
    expect(r.body).toContain("screensFetchFrom");
  });
});

describe("webapp pod-switcher — Activity page (new)", () => {
  it("the Activity view now builds + renders the same switcher", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/activity.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("buildPodSwitcherModel");
    expect(r.body).toContain("activityPodSwitcherHtml");
    expect(r.body).toContain("wireActivityPodSwitcher");
    expect(r.body).toContain("data-pod-switch");
    // Same conventions as Services: leader flag, no tick.
    expect(r.body).toContain("flagIcon");
    expect(r.body).not.toContain("✓");
  });
});

describe("webapp pod-switcher — api helper", () => {
  it("exposes screensFetchFrom for explicit per-pod fan-out", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/api.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export async function screensFetchFrom");
  });
});

describe("webapp pod-switcher — flag icon export", () => {
  it("icons.js exports a functional leader flag SVG", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/icons.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export const flagIcon");
    // The swallowtail flag path the task specified.
    expect(r.body).toContain("M6.8 4");
  });
});
