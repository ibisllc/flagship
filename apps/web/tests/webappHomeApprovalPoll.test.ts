import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { APPROVAL_POLL_MS, stopApprovalPoll } from "../public/webapp/views/home.js";

// L9 — webapp parity with iOS BootApprovalWatcher (~5s `/pods` loop while Home
// is on screen) + Android's matching LaunchedEffect poll on HomeTab. The webapp
// used to fetch the awaiting-approval set ONCE per renderHome(); now it arms a
// 5s interval while Home is visible so a box that starts waiting AFTER the paint
// surfaces its "Approve unlock" affordance on its own, and the interval is
// cleared the moment we navigate away (flagship:view-shown) + on lock.
describe("webapp home boot-approval poll (parity with iOS/Android)", () => {
  it("polls on the same ~5s cadence iOS/Android use", () => {
    // iOS BootApprovalWatcher.pollInterval == 5s; Android delay(5_000).
    expect(APPROVAL_POLL_MS).toBe(5_000);
  });

  it("stopApprovalPoll is idempotent (safe to call with no live timer)", () => {
    // Leaving Home / locking calls this; a double-clear must not throw.
    expect(() => {
      stopApprovalPoll();
      stopApprovalPoll();
    }).not.toThrow();
  });

  it("home.js arms a recurring approval poll and clears it on navigate-away + lock", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    expect(r.statusCode).toBe(200);
    const body = r.body;
    // The poll itself: a setInterval over the awaiting-approval set fetch.
    expect(body).toContain("setInterval");
    expect(body).toContain("fetchAwaitingApprovalSet");
    expect(body).toContain("startApprovalPoll");
    // Armed from renderHome with THIS tick's set (churn-free seed).
    expect(body).toContain("startApprovalPoll(awaitingApproval)");
    // Cleared on any non-Home view + folded into the lock-time teardown.
    expect(body).toContain('ev.detail?.id !== "view-home"');
    expect(body).toContain("stopApprovalPoll");
    // Repaint only while Home is still the active view + only on a real change.
    expect(body).toContain('currentViewId() === "view-home"');
    expect(body).toContain("approvalPollLastSig");
  });
});
