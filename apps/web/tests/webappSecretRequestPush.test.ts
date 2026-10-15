/**
 * The service worker's boot/unlock approval push: `.com` sends the owner's
 * devices `{ kind: "secret-request", serverFqdn, purpose, … }` (RFC 8291
 * encrypted). The notification names no server, like the phone apps', and a
 * click opens the approvals view (`?view=boot-approval`), which the cold-start
 * dispatcher routes to `enterBootApproval`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SW_PATH = join(__dirname, "../public/webapp/service-worker.js");
const DEEP_LINK_PATH = join(__dirname, "../public/webapp/lib/deepLink.js");

function buildSandbox() {
  const listeners = new Map<string, Function[]>();
  const shown: Array<{ title: string; opts: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self: any = {
    location: { origin: "https://webapp.flagshipserver.com" },
    addEventListener: (type: string, cb: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    },
    skipWaiting: () => {},
    clients: {
      claim: () => {},
      matchAll: async () => [],
      openWindow: async (url: string) => { opened.push(url); },
    },
    registration: {
      showNotification: (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
    fetch: async () => new Response(null, { status: 200 }),
  };
  const ctx: any = {
    self, addEventListener: self.addEventListener, fetch: self.fetch, Response, URL, Headers, Map, Set, Date,
    Promise, Error, Array, Object, JSON, console: { log: () => {}, warn: () => {} }, setTimeout, clearTimeout,
    Request, crypto,
    caches: { open: async () => ({ put: async () => {} }), keys: async () => [], delete: async () => {}, match: async () => undefined },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(SW_PATH, "utf8"), ctx, { filename: "service-worker.js" });
  return { listeners, shown, opened };
}

function fire(listeners: Map<string, Function[]>, type: string, event: Record<string, unknown>) {
  const promises: Promise<unknown>[] = [];
  const e = { ...event, waitUntil: (p: Promise<unknown>) => promises.push(p) };
  for (const cb of listeners.get(type) ?? []) cb(e);
  return Promise.all(promises);
}

describe("service worker — secret-request push", () => {
  it("shows a server-free approval notice that opens the approvals view", async () => {
    const { listeners, shown, opened } = buildSandbox();
    const payload = { kind: "secret-request", serverFqdn: "home.alice.flagship.services", purpose: "unlock-key" };
    await fire(listeners, "push", { data: { json: () => payload } });
    expect(shown).toHaveLength(1);
    const n = shown[0]!;
    expect(n.title).toBe("Flagship");
    expect(n.opts.body).toBe("A server is waiting for your approval.");
    expect(JSON.stringify(n.opts)).not.toContain("alice");

    await fire(listeners, "notificationclick", { notification: { close: () => {}, data: n.opts.data } });
    expect(opened).toEqual(["https://webapp.flagshipserver.com/?view=boot-approval"]);
  });

  it("routes the phone apps' https approvals link to the same view", async () => {
    const { listeners, opened } = buildSandbox();
    await fire(listeners, "notificationclick", {
      notification: { close: () => {}, data: { deepLink: "https://flagshipserver.com/app/secret-requests" } },
    });
    expect(opened).toEqual(["https://webapp.flagshipserver.com/?view=boot-approval"]);
  });

  it("the cold-start dispatcher opens the approvals view for ?view=boot-approval", () => {
    const src = readFileSync(DEEP_LINK_PATH, "utf8");
    expect(src).toMatch(/q\.view === "view-boot-approval"[\s\S]{0,160}enterBootApproval\(\)/);
  });
});

describe("service worker — category-only account notices", () => {
  for (const [category, body] of [
    ["cert-alert", "One of your servers needs your attention."],
    ["server-registered", "A new server was added to your account."],
  ] as const) {
    it(`${category} gets its own text and opens Home`, async () => {
      const { listeners, shown, opened } = buildSandbox();
      await fire(listeners, "push", { data: { json: () => ({ category }) } });
      expect(shown).toHaveLength(1);
      expect(shown[0]!.opts.body).toBe(body);
      await fire(listeners, "notificationclick", { notification: { close: () => {}, data: shown[0]!.opts.data } });
      expect(opened).toEqual(["https://webapp.flagshipserver.com/"]);
    });
  }
});
