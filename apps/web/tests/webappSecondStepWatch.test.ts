import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSecondStepWatch, opensApprovals } from "../public/webapp/lib/secondStepWatch.js";

const HOME = "home.alice.flagship.services";
const pod = (over: Record<string, unknown> = {}) => ({ serverDomain: HOME, pendingRequests: [] as unknown[], ...over });
const entitlement = { id: "ab".repeat(32), type: "entitlement", issuedAt: 1, expiresAt: 2 };
const unlock = { id: "cd".repeat(32), type: "unlock-key", issuedAt: 1, expiresAt: 2 };

describe("a new server's second approval (Windows acceptance, 2026-11-06)", () => {
  it("is reported once, after the first-boot unlock was approved", () => {
    const w = createSecondStepWatch({ windowMs: 600_000 });
    expect(w.arrived([pod({ pendingRequests: [entitlement] })], 0)).toEqual([]);
    w.arm("Home.Alice.flagship.services", 1_000);
    expect(w.arrived([pod({ pendingRequests: [unlock] })], 2_000)).toEqual([]);
    expect(w.arrived([pod({ pendingRequests: [entitlement] })], 81_000)).toEqual([HOME]);
    expect(w.arrived([pod({ pendingRequests: [entitlement] })], 90_000)).toEqual([]);
  });

  it("forgets a server whose second step never came", () => {
    const w = createSecondStepWatch({ windowMs: 600_000 });
    w.arm(HOME, 0);
    expect(w.arrived([pod({ pendingRequests: [entitlement] })], 600_001)).toEqual([]);
  });

  it("the approvals arm it and the shell brings them back when it arrives", () => {
    const view = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "boot-approval.js"), "utf8");
    expect(view).toMatch(/req\.purpose === "unlock-key"[^\n]*secondStepWatch\.arm\(req\.serverDomain\)/);
    const app = readFileSync(resolve(__dirname, "..", "public", "webapp", "app.js"), "utf8");
    expect(app).toMatch(/secondStepWatch\.arrived\([\s\S]{0,200}enterBootApproval\(\)/);
  });

  it("a fresh server's Home row waiting for an approval opens the approvals; a running one keeps its page", () => {
    expect(opensApprovals("HOME.alice.flagship.services", [pod({ pendingRequests: [unlock] })])).toBe(true);
    expect(opensApprovals(HOME, [pod()])).toBe(false);
    expect(opensApprovals(HOME, [pod({ pendingRequests: [unlock], lastReported: 5 })])).toBe(false);
    expect(opensApprovals(HOME, [])).toBe(false);
  });
});
