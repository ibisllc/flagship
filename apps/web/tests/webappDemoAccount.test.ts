// A demo account is detected from the account (its persisted demoServer
// block), hides the key-backed Settings rows, and "delete" / "sign out" /
// "remove device" all mean an explained remove-from-this-browser —
// parity with iOS AppState.isDemoAccount (53cc82fa).
import { describe, expect, it, vi } from "vitest";
import {
  DEMO_HIDDEN_SETTINGS_IDS,
  DEMO_REMOVE_COPY,
  applyDemoSettingsRestrictions,
  confirmAndRemoveDemo,
  isDemoProfile,
} from "../public/webapp/lib/demoAccount.js";

function fakeDoc(ids: string[]) {
  const els = new Map(
    ids.map((id) => {
      const classes = new Set<string>();
      return [id, {
        classList: {
          toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c: string) => classes.has(c),
        },
      }];
    }),
  );
  return { getElementById: (id: string) => els.get(id) ?? null, els };
}

function deps(confirmed: boolean) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      username: "bright-maple",
      confirm: vi.fn(async () => confirmed),
      resetDevice: vi.fn(async () => { calls.push("resetDevice"); }),
      profileRemove: vi.fn((slot: string) => { calls.push(`remove:${slot}`); }),
      forgetProfile: vi.fn((name: string) => { calls.push(`forget:${name}`); }),
      lockSession: vi.fn(() => { calls.push("lock"); }),
      stopRenewals: vi.fn(() => { calls.push("stopRenewals"); }),
      setSubtitle: vi.fn(),
      show: vi.fn((v: string) => { calls.push(`show:${v}`); }),
    },
  };
}

describe("webapp demo account", () => {
  it("is detected from the profile's demoServer block, not a toggle", () => {
    expect(isDemoProfile({ demoServer: { fqdn: "home.bright-maple.flagship.services" } })).toBe(true);
    expect(isDemoProfile({ demoServer: null })).toBe(false);
    expect(isDemoProfile(null)).toBe(false);
  });

  it("hides exactly the rows iOS hides, and restores them for a real account", () => {
    expect([...DEMO_HIDDEN_SETTINGS_IDS]).toEqual([
      "settings-tab-recovery",
      "settings-tab-backup-key",
      "settings-tab-trusted-devices",
    ]);
    const doc = fakeDoc([...DEMO_HIDDEN_SETTINGS_IDS, "settings-tab-providers"]);
    applyDemoSettingsRestrictions(true, doc);
    for (const id of DEMO_HIDDEN_SETTINGS_IDS) {
      expect(doc.els.get(id)!.classList.contains("hidden")).toBe(true);
    }
    expect(doc.els.get("settings-tab-providers")!.classList.contains("hidden")).toBe(false);
    applyDemoSettingsRestrictions(false, doc);
    for (const id of DEMO_HIDDEN_SETTINGS_IDS) {
      expect(doc.els.get(id)!.classList.contains("hidden")).toBe(false);
    }
  });

  it("removes the demo from this browser only after the explained confirm", async () => {
    const { calls, d } = deps(true);
    expect(await confirmAndRemoveDemo(d)).toBe(true);
    expect(d.confirm).toHaveBeenCalledWith(DEMO_REMOVE_COPY);
    expect(DEMO_REMOVE_COPY.okLabel).toBe("Remove from this browser");
    expect(calls).toEqual([
      "stopRenewals",
      "resetDevice",
      "remove:sessionId",
      "remove:sessionToken",
      "remove:podBaseUrl",
      "remove:username",
      "forget:bright-maple",
      "lock",
      "show:view-bootstrap",
    ]);
  });

  it("touches nothing when the confirm is declined", async () => {
    const { calls, d } = deps(false);
    expect(await confirmAndRemoveDemo(d)).toBe(false);
    expect(calls).toEqual([]);
  });
});
