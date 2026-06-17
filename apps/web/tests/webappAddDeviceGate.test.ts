import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { SAS_CONFIRM_GATE_MS } from "../public/webapp/views/add-device.js";

// L10 — the add-device "codes match" Confirm has an anti-double-tap gate that
// mirrors iOS AddDeviceViewModel's 600ms `gateExpired` window (Android mirrors
// it via ConfirmSas.gateExpired). The SAS compare itself exists on every
// surface; this is the belt-and-suspenders delay so a reflexive double-tap
// carried over from the previous screen can't confirm a code the human hasn't
// actually compared.
describe("webapp add-device SAS-confirm gate (parity with iOS/Android)", () => {
  it("uses the same ~600ms anti-double-tap window iOS uses", () => {
    expect(SAS_CONFIRM_GATE_MS).toBe(600);
  });

  it("holds Confirm disabled for the gate window after the SAS appears", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/add-device.js" });
    expect(r.statusCode).toBe(200);
    const body = r.body;
    // The confirm button starts disabled when the SAS arrives, and a timer
    // un-gates it after the window (not enabled immediately as before).
    expect(body).toContain("SAS_CONFIRM_GATE_MS");
    expect(body).toContain("setTimeout");
    // The onSas handler holds it disabled first, then arms the delayed enable.
    expect(body).toContain("btn.disabled = true");
    // Only un-gate if the same SAS panel is still on screen (not torn down).
    expect(body).toContain('$("add-device-confirm") === btn');
  });
});
