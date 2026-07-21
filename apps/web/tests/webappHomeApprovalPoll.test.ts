import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { APPROVAL_POLL_MS, stopApprovalPoll } from "../public/webapp/views/home.js";

// Home live updates now ride the app-scope LiveSync canal (one /stream
// long-poll) instead of Home's own 5s `/pods` approval interval. The repaint
// is driven by a LiveSync SUBSCRIPTION (re-render on a real snapshot change,
// only while Home is the active view), dropped on navigate-away + lock. The
// `APPROVAL_POLL_MS` cadence constant is retained (iOS/Android still poll on it
// as their fallback), and `stopApprovalPoll` is kept as the lock-time teardown
// hook other modules call — it now drops the LiveSync subscription.
describe("webapp home live updates (LiveSync canal, parity with iOS/Android)", () => {
  it("retains the ~5s cadence reference iOS/Android use as their fallback", () => {
    // iOS BootApprovalWatcher.pollInterval == 5s; Android delay(5_000).
    expect(APPROVAL_POLL_MS).toBe(5_000);
  });

  it("stopApprovalPoll is idempotent (safe to call with no live subscription)", () => {
    // Leaving Home / locking calls this; a double-clear must not throw.
    expect(() => {
      stopApprovalPoll();
      stopApprovalPoll();
    }).not.toThrow();
  });

  it("home.js subscribes to LiveSync and clears it on navigate-away + lock", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    expect(r.statusCode).toBe(200);
    const body = r.body;
    // The standalone setInterval approval poll is GONE — LiveSync is the canal.
    expect(body).toContain("liveSync.subscribe");
    expect(body).toContain("armHomeLiveSync");
    // Repaint only while Home is still the active view + only on a real change.
    expect(body).toContain('currentViewId() === "view-home"');
    expect(body).toContain("homeLiveSyncLastSig");
    // Cleared on any non-Home view + folded into the lock-time teardown.
    expect(body).toContain('ev.detail?.id !== "view-home"');
    expect(body).toContain("stopApprovalPoll");
    // No more Home-owned `/pods` polling interval.
    expect(body).not.toContain("setInterval(() => {\n    void pollApprovalsOnce");
  });
});
