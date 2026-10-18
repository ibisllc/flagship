import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The live gym found a renamed app never reached a gym box: the daemon never passed a base
// URL to the AliasReconciler, so every box polled production's flagshipserver.com for its
// aliases whatever control plane it had registered with. This pins the wiring in the entry.
describe("the alias poll follows the box's control plane", () => {
  const src = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
  it("passes the control plane base URL to the service platform's alias reconciler", () => {
    const block = src.slice(src.indexOf("servicePlatform: {"));
    expect(block).toMatch(/aliasReconcilerComBase:\s*env\.controlPlaneBaseUrl/);
  });
  it("the runtime still defaults to production only when nothing is passed", () => {
    const rt = readFileSync(join(__dirname, "../src/runtime.ts"), "utf8");
    expect(rt).toContain('reconcileBase ?? "https://flagshipserver.com"');
  });
});
