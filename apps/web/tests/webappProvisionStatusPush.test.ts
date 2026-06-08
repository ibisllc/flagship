/**
 * Service worker `push` event parses the SINGLE canonical provision-status
 * payload (design §2.3) — the same shape iOS + Android parse. Recognised by
 * `category === "provision-status"` (or `meta.kind`), reads `meta.phase` as a
 * canonical ProvisionStatusPhase, renders ONE notification tagged
 * `flagship-provision-status`, and deep-links to the install-progress view.
 *
 * Sandboxes the SW source the same way webappW10VibeCodePush.test.ts does.
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
      open: async () => ({ put: async () => {} }),
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
    data: payload === undefined ? undefined : { json: () => payload },
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    _drain: () => Promise.all(promises),
  };
}

/** The canonical payload (design §2.3) — what fanOutStatusPush emits and what
 *  iOS / Android parse byte-for-byte. */
function canonicalProvisionStatusPayload(phase: string, detail?: string) {
  return {
    category: "provision-status",
    title: "Your server is live",
    body: "Your server is live and ready to use.",
    deepLink: "flagship://install-progress",
    meta: {
      kind: "provision-status",
      serial: "01HXAFORDER0001",
      phase,
      ...(detail ? { detail } : {}),
    },
  };
}

describe("service worker — canonical provision-status push", () => {
  it("renders ONE notification from the canonical payload + carries meta.phase", async () => {
    const { listeners, shown } = buildSandbox();
    const pushCbs = listeners.get("push") ?? [];
    expect(pushCbs.length).toBeGreaterThan(0);

    const event = makePushEvent(canonicalProvisionStatusPayload("live"));
    for (const cb of pushCbs) cb(event);
    await event._drain();

    expect(shown.length).toBe(1);
    const n = shown[0]!;
    // Title + body come straight from the payload (one source of copy).
    expect(n.title).toBe("Your server is live");
    expect(n.opts.body).toBe("Your server is live and ready to use.");
    expect(n.opts.tag).toBe("flagship-provision-status");
    const data = n.opts.data as { kind: string; phase: string; deepLink: string };
    expect(data.kind).toBe("provision-status");
    expect(data.phase).toBe("live");
    expect(data.deepLink).toBe("flagship://install-progress");
  });

  it("carries the error detail through for the terminal error phase", async () => {
    const { listeners, shown } = buildSandbox();
    const pushCbs = listeners.get("push") ?? [];
    const event = makePushEvent({
      ...canonicalProvisionStatusPayload("error", "disk write failed"),
      title: "Setup hit a problem",
      body: "Setup failed: disk write failed",
    });
    for (const cb of pushCbs) cb(event);
    await event._drain();
    expect(shown.length).toBe(1);
    expect(shown[0]!.opts.body).toBe("Setup failed: disk write failed");
    const data = shown[0]!.opts.data as { phase: string };
    expect(data.phase).toBe("error");
  });

  it("recognises the payload by meta.kind even without a top-level category", async () => {
    const { listeners, shown } = buildSandbox();
    const pushCbs = listeners.get("push") ?? [];
    const payload = canonicalProvisionStatusPayload("sealing");
    delete (payload as any).category;
    const event = makePushEvent(payload);
    for (const cb of pushCbs) cb(event);
    await event._drain();
    expect(shown.length).toBe(1);
    expect(shown[0]!.opts.tag).toBe("flagship-provision-status");
    expect((shown[0]!.opts.data as { phase: string }).phase).toBe("sealing");
  });
});
