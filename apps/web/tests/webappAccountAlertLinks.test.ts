// Account alerts' in-app links open the screen they name, as on the phones
// (67a895f3): certificate watch (`account/security`) and two-factor
// (`settings/two-factor`) open account security; a quarantined device
// (`account/devices`) and a re-pair (`account/re-pair`) open the device list.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SW_PATH = join(__dirname, "../public/webapp/service-worker.js");
const DEEP_LINK_PATH = join(__dirname, "../public/webapp/lib/deepLink.js");

function clickOpens(deepLink: string): Promise<string[]> {
  const listeners = new Map<string, Function[]>();
  const opened: string[] = [];
  const self: any = {
    location: { origin: "https://webapp.flagshipserver.com" },
    addEventListener: (type: string, cb: Function) => listeners.set(type, [...(listeners.get(type) ?? []), cb]),
    clients: { claim: () => {}, matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
    registration: { showNotification: async () => {} },
  };
  const ctx: any = {
    self, addEventListener: self.addEventListener, URL, Response, Request, Headers, Map, Set, Date, Promise, Error,
    Array, Object, JSON, console: { log: () => {}, warn: () => {} }, setTimeout, clearTimeout, crypto,
    fetch: async () => new Response(null, { status: 200 }),
    caches: { open: async () => ({ put: async () => {} }), keys: async () => [], delete: async () => {}, match: async () => undefined },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(SW_PATH, "utf8"), ctx, { filename: "service-worker.js" });
  const waits: Promise<unknown>[] = [];
  const event = { notification: { close: () => {}, data: { deepLink } }, waitUntil: (p: Promise<unknown>) => waits.push(p) };
  for (const cb of listeners.get("notificationclick") ?? []) cb(event);
  return Promise.all(waits).then(() => opened);
}

describe("account alert links in the webapp", () => {
  for (const [route, view] of [
    ["account/security", "account-security"],
    ["settings/two-factor", "account-security"],
    ["account/devices", "trusted-devices"],
    ["account/re-pair", "trusted-devices"],
  ] as const) {
    it(`${route} opens ${view}`, async () => {
      expect(await clickOpens(`https://flagshipserver.com/app/${route}`)).toEqual([
        `https://webapp.flagshipserver.com/?view=${view}`,
      ]);
      expect(await clickOpens(`flagship://${route}`)).toEqual([`https://webapp.flagshipserver.com/?view=${view}`]);
    });
  }

  it("the cold-start dispatcher shows both views", () => {
    const src = readFileSync(DEEP_LINK_PATH, "utf8");
    expect(src).toMatch(/q\.view === "view-account-security" \|\| q\.view === "view-trusted-devices"\) \{[\s\S]{0,120}show\(q\.view\)/);
  });
});
