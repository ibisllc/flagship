import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// v2 device-addressing — the webapp home view must render the
// DeviceCapabilityBlock chip + scope-gate the install / vibe-code
// actions, mirroring iOS HomeScreen (deviceChip + per-action
// enabled/disabled). The helpers live in lib/usersCheck.js; this suite
// pins that home.js actually CONSUMES them (the parity gap was that the
// helpers existed but no view rendered them).
describe("webapp device-capability rendering (parity with iOS HomeScreen)", () => {
  it("home.js imports the chip + scope-gate helpers from usersCheck.js", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('from "../lib/usersCheck.js"');
    expect(r.body).toContain("deviceCapabilityChipText");
    expect(r.body).toContain("applyScopeGateToButton");
    expect(r.body).toContain('from "../lib/profiles.js"');
  });

  it("home.js gates install-service + vibe-code on the active device's scopes", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/home.js" });
    expect(r.statusCode).toBe(200);
    // Both scope strings (matching DEVICE_SCOPES / the Worker wire) appear
    // as scope-gate arguments.
    expect(r.body).toContain('"install-service"');
    expect(r.body).toContain('"vibe-code"');
    // The chip render + the active-capability accessor are exported so
    // tests + future surfaces can reuse them.
    expect(r.body).toContain("export function activeDeviceCapability");
    expect(r.body).toContain("renderDeviceCapabilityChip");
  });

  it("the home Identity card has the chip slot", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="home-device-capability"');
  });

  it("style.css declares the device-cap-chip + restricted-button primitives", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/style.css" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(".device-cap-chip");
    expect(r.body).toContain("button[data-device-restricted]");
  });

  it("lib/usersCheck.js mirrors the canonical DEVICE_SCOPES list from protocol", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/usersCheck.js" });
    expect(r.statusCode).toBe(200);
    // Same order as packages/protocol/src/auth.ts DEVICE_SCOPES.
    for (const scope of [
      "browse",
      "install-service",
      "vibe-code",
      "add-device",
      "manage-services",
      "revoke-others",
      "demo-provision",
    ]) {
      expect(r.body).toContain(`"${scope}"`);
    }
    expect(r.body).toContain("export function deviceCapabilityChipText");
    expect(r.body).toContain("export function applyScopeGateToButton");
    expect(r.body).toContain("export function deviceCapabilityAllows");
  });
});
