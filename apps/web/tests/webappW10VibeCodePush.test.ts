/**
 * W10 — service worker `push` event routes a `vibecode-needs-you`
 * payload to the vibe-code chat surface (not the unlock-approvals
 * view). Run by sandboxing the SW source the same way
 * serviceWorkerLifecycle.test.ts does.
 *
 * The expected behavior:
 *   - The handler reads `event.data.json()`, sees kind === "vibecode-needs-you",
 *     and calls registration.showNotification with a tag of the form
 *     `flagship-vibecode-<sessionId>` plus a data.deepLink that includes
 *     `?view=vibecode-chat` (or the payload's own deepLink string).
 *   - The unlock-approval branch is NOT exercised.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SW_PATH = join(__dirname, "../public/webapp/service-worker.js");

function buildSandbox() {
  const listeners = new Map<string, Function[]>();
  const shown: Array<{ title: string; opts: Record<string, unknown> }> = [];
  const self: any = {
    location: { origin: "https://web.flagshipserver.com" },
    addEventListener: (type: string, cb: Function) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    skipWaiting: () => {},
    clients: {
      claim: () => {},
      matchAll: async () => [],
      openWindow: async () => undefined,
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
    self,
    addEventListener: self.addEventListener,
    fetch: self.fetch,
    Response,
    URL,
    Headers,
    Map,
    Set,
    Date,
    Promise,
    Error,
    Array,
    Object,
    JSON,
    console: { log: () => {}, warn: () => {} },
    setTimeout,
    clearTimeout,
    Request,
    crypto,
    caches: {
      open: async () => ({
        put: async () => {},
      }),
      keys: async () => [],
      delete: async () => {},
      match: async () => undefined,
    },
  };
  vm.createContext(ctx);
  const src = readFileSync(SW_PATH, "utf8");
  vm.runInContext(src, ctx, { filename: "service-worker.js" });
  return { listeners, shown };
}

function makePushEvent(payload: unknown) {
  const promises: Promise<unknown>[] = [];
  return {
    data: payload === undefined
      ? undefined
      : { json: () => payload },
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    _drain: () => Promise.all(promises),
  };
}

describe("W10 — service worker routes vibecode-needs-you push", () => {
  it("renders a notification tagged with the sessionId + carries a vibecode-chat deepLink", async () => {
    const { listeners, shown } = buildSandbox();
    const pushCbs = listeners.get("push") ?? [];
    expect(pushCbs.length).toBeGreaterThan(0);
    const event = makePushEvent({
      kind: "vibecode-needs-you",
      sessionId: "sess-w10-abc",
      appId: "alice-todos",
      request: "requestEnvVar",
      deepLink: "flagship://vibecode/sess-w10-abc",
    });
    for (const cb of pushCbs) cb(event);
    await event._drain();
    expect(shown.length).toBe(1);
    const n = shown[0]!;
    expect(n.title).toBe("Flagship");
    expect(n.opts.tag).toBe("flagship-vibecode-sess-w10-abc");
    const data = n.opts.data as { kind: string; sessionId: string; deepLink: string };
    expect(data.kind).toBe("vibecode-needs-you");
    expect(data.sessionId).toBe("sess-w10-abc");
    // The payload supplied its own deepLink — the SW must honor it
    // (so a Universal-Link / app-link routes the iOS / Android client
    // to the same surface).
    expect(data.deepLink).toBe("flagship://vibecode/sess-w10-abc");
  });

  it("falls back to a ?view=vibecode-chat deepLink when the payload omits one", async () => {
    const { listeners, shown } = buildSandbox();
    const pushCbs = listeners.get("push") ?? [];
    const event = makePushEvent({
      kind: "vibecode-needs-you",
      sessionId: "sess-no-link",
      request: "talkToUser",
    });
    for (const cb of pushCbs) cb(event);
    await event._drain();
    expect(shown.length).toBe(1);
    const data = shown[0]!.opts.data as { deepLink: string };
    expect(data.deepLink).toContain("view=vibecode-chat");
    expect(data.deepLink).toContain("sessionId=sess-no-link");
  });

  it("leaves the unlock-approval push path intact for the existing payload", async () => {
    const { listeners, shown } = buildSandbox();
    const pushCbs = listeners.get("push") ?? [];
    const event = makePushEvent({
      kind: "unlock-request",
      serverFqdn: "home.alice.flagship.services",
    });
    for (const cb of pushCbs) cb(event);
    await event._drain();
    expect(shown.length).toBe(1);
    const n = shown[0]!;
    expect(n.opts.tag).toBe("flagship-unlock-request");
    const data = n.opts.data as { deepLink: string };
    expect(data.deepLink).toContain("view=unlock-approvals");
  });
});
