// #91 — AI-chat alerts: foreground long-poll → local notification → sliver.
//
// The logic that matters lives in lib/aiChatAlerts.js (the testable half):
// which envelopes from the box's phone-alert queue (GET /api/phone/alerts) we
// act on, what we feed the operations sliver, the once-per-tool notification
// dedup, and the ACK/cursor advance. This is the webapp mirror of the iOS
// AiChatAlertPollTests / Android AiChatAlertPollTest — the cases line up.
//
// We exercise the REAL shipping module via the same pathToFileURL + dynamic
// import seam the other webapp lib tests use; every external dep (the
// /api/phone/alerts fetcher, the operations center, the notifier) is injected,
// so there's no DOM, no Notification API, and no network.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MOD_URL = pathToFileURL(
  resolve(__dirname, "../public/webapp/lib/aiChatAlerts.js"),
).href;

async function load() {
  return import(MOD_URL);
}

// A minimal stand-in for the ActiveOperationsCenter that records upserts —
// we only assert that the right build op (id + deep-link target) was fed.
function fakeOps() {
  const upserts: Array<{ id: string; subject: string; onServer: string | null; target: any }> = [];
  return {
    upserts,
    upsertBuild(id: string, subject: string, onServer: string | null, target: any) {
      upserts.push({ id, subject, onServer, target });
    },
    removeBuild() {
      /* not used by the alert feeder */
    },
  };
}

// A fetcher that returns a queued response for the alerts GET and records the
// ACK POST. `events` is what the alerts GET yields; the ack body is captured.
function fakeFetcher(events: any[]) {
  const calls: Array<{ path: string; init?: any }> = [];
  const fetcher = async (path: string, init?: any) => {
    calls.push({ path, init });
    if (path.startsWith("/api/phone/alerts?")) {
      return { events, size: events.length };
    }
    if (path === "/api/phone/alerts/ack") {
      return { ok: true, size: 0 };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { fetcher, calls };
}

function aiChatEnvelope(id: number, sessionId: string, request: string, toolUseId: string) {
  return {
    id,
    emittedAt: 1000 + id,
    alert: { kind: "ai-chat-needs-you", serviceId: sessionId, request, toolUseId },
  };
}

describe("aiChatAlerts — notification copy", () => {
  it("is value-free and driven only by the tool kind", async () => {
    const { aiChatAlertBody } = await load();
    expect(aiChatAlertBody({ request: "requestEnvVar" })).toBe(
      "The AI needs an environment variable to continue.",
    );
    expect(aiChatAlertBody({ request: "talkToUser" })).toBe("The AI is asking you a question.");
    // Unknown / missing → the question copy (never leaks anything).
    expect(aiChatAlertBody({})).toBe("The AI is asking you a question.");
  });
});

describe("aiChatAlerts — drainAiChatAlertsOnce", () => {
  it("feeds the sliver, notifies, ACKs the range, and advances the cursor", async () => {
    const { drainAiChatAlertsOnce } = await load();
    const ops = fakeOps();
    const { fetcher, calls } = fakeFetcher([
      aiChatEnvelope(7, "sess-a", "talkToUser", "tool-1"),
    ]);
    const notified: any[] = [];

    const r = await drainAiChatAlertsOnce({
      since: 0,
      fetcher,
      operations: ops,
      notify: (a: any) => notified.push(a),
    });

    expect(r).toMatchObject({ cursor: 7, handled: 1 });
    expect(r.alerts.map((a: any) => a.serviceId)).toEqual(["sess-a"]);
    // Operations sliver got a build op keyed by the session, pointing at chat.
    expect(ops.upserts).toHaveLength(1);
    expect(ops.upserts[0]?.id).toBe("sess-a");
    expect(ops.upserts[0]?.target).toEqual({
      view: "view-vibecode-chat",
      params: { sessionId: "sess-a" },
    });
    // One local notification raised.
    expect(notified).toHaveLength(1);
    expect(notified[0].serviceId).toBe("sess-a");
    // The GET used the cursor, and the range was ACK'd through id 7.
    expect(calls[0]?.path).toBe("/api/phone/alerts?since=0");
    const ack = calls.find((c) => c.path === "/api/phone/alerts/ack");
    expect(ack).toBeTruthy();
    expect(JSON.parse(ack!.init.body)).toEqual({ throughId: 7 });
  });

  it("ignores non-AI-chat envelopes but still advances + ACKs the cursor", async () => {
    const { drainAiChatAlertsOnce } = await load();
    const ops = fakeOps();
    const notified: any[] = [];
    const { fetcher, calls } = fakeFetcher([
      { id: 3, emittedAt: 1, alert: { kind: "browser-input-needed", serviceId: "x", tabId: "t", domain: "d", inputKind: "password", screenshotRef: "s" } },
      aiChatEnvelope(4, "sess-b", "requestEnvVar", "tool-9"),
    ]);

    const r = await drainAiChatAlertsOnce({
      since: 0,
      fetcher,
      operations: ops,
      notify: (a: any) => notified.push(a),
    });

    // Only the AI-chat one was acted on, but the cursor covers both (so the
    // browser alert isn't re-drained by THIS loop — its own surface handles it).
    expect(r.handled).toBe(1);
    expect(r.cursor).toBe(4);
    expect(ops.upserts).toHaveLength(1);
    expect(ops.upserts[0]?.id).toBe("sess-b");
    expect(notified).toHaveLength(1);
    const ack = calls.find((c) => c.path === "/api/phone/alerts/ack");
    expect(JSON.parse(ack!.init.body)).toEqual({ throughId: 4 });
  });

  it("no events → no ACK, no notify, cursor unchanged", async () => {
    const { drainAiChatAlertsOnce } = await load();
    const ops = fakeOps();
    const notified: any[] = [];
    const { fetcher, calls } = fakeFetcher([]);

    const r = await drainAiChatAlertsOnce({
      since: 12,
      fetcher,
      operations: ops,
      notify: (a: any) => notified.push(a),
    });

    expect(r).toEqual({ cursor: 12, handled: 0, alerts: [] });
    expect(ops.upserts).toHaveLength(0);
    expect(notified).toHaveLength(0);
    expect(calls.some((c) => c.path === "/api/phone/alerts/ack")).toBe(false);
  });

  it("a throwing notifier does not wedge the drain (op still fed, range ACK'd)", async () => {
    const { drainAiChatAlertsOnce } = await load();
    const ops = fakeOps();
    const { fetcher, calls } = fakeFetcher([
      aiChatEnvelope(2, "sess-c", "talkToUser", "tool-1"),
    ]);

    const r = await drainAiChatAlertsOnce({
      since: 0,
      fetcher,
      operations: ops,
      notify: () => {
        throw new Error("notifier blew up");
      },
    });

    expect(r.handled).toBe(1);
    expect(ops.upserts).toHaveLength(1);
    expect(calls.some((c) => c.path === "/api/phone/alerts/ack")).toBe(true);
  });
});

describe("aiChatAlerts — the server an alert came from", () => {
  it("tags the sliver op and the notification with the box that was drained", async () => {
    const { drainAiChatAlertsOnce, makeAiChatNotifier } = await load();
    const ops = fakeOps();
    const shown: any[] = [];
    const { fetcher } = fakeFetcher([aiChatEnvelope(9, "sess-c", "requestEnvVar", "tool-3")]);
    await drainAiChatAlertsOnce({
      since: 0,
      fetcher,
      operations: ops,
      server: "office.alice.flagship.services",
      notify: makeAiChatNotifier({ show: (n: any) => shown.push(n) }),
    });
    expect(ops.upserts[0]?.target).toEqual({
      view: "view-vibecode-chat",
      params: { sessionId: "sess-c", server: "office.alice.flagship.services" },
    });
    expect(shown[0]).toMatchObject({ sessionId: "sess-c", server: "office.alice.flagship.services" });
  });

  it("the notification's link names the session and its server", async () => {
    const { aiChatDeepLink } = await load();
    expect(aiChatDeepLink({ sessionId: "s 1", server: "home.alice.flagship.services" })).toBe(
      "/?view=vibecode-chat&sessionId=s%201&server=home.alice.flagship.services",
    );
    expect(aiChatDeepLink({ sessionId: "s1" })).toBe("/?view=vibecode-chat&sessionId=s1");
  });

  it("the poll asks which box it reaches on every tick", async () => {
    const { startAiChatAlertPoll } = await load();
    const ops = fakeOps();
    let box = "home.alice.flagship.services";
    const { fetcher } = fakeFetcher([aiChatEnvelope(1, "sess-d", "talkToUser", "t")]);
    const timers: Array<() => void> = [];
    const stop = startAiChatAlertPoll({
      fetcher,
      operations: ops,
      server: () => box,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ops.upserts[0]?.target.params.server).toBe("home.alice.flagship.services");
    // The owner switched servers: the next drain reaches (and names) that one.
    box = "office.alice.flagship.services";
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ops.upserts.at(-1)?.target.params.server).toBe("office.alice.flagship.services");
    stop();
  });
});

describe("aiChatAlerts — makeAiChatNotifier dedup", () => {
  it("shows once per (sessionId, toolUseId); re-drain of the same tool is silent", async () => {
    const { makeAiChatNotifier } = await load();
    const shown: any[] = [];
    const notify = makeAiChatNotifier({ show: (n: any) => shown.push(n) });

    const a = { serviceId: "sess-a", request: "talkToUser", toolUseId: "tool-1" };
    notify(a);
    notify(a); // same pending tool re-delivered (e.g. ACK failed last tick)
    expect(shown).toHaveLength(1);
    expect(shown[0].sessionId).toBe("sess-a");
    expect(shown[0].body).toBe("The AI is asking you a question.");
    expect(shown[0].tag).toBe("flagship-ai-chat-sess-a-tool-1");

    // The AI emits its NEXT tool in the same session — a new notification.
    notify({ serviceId: "sess-a", request: "requestEnvVar", toolUseId: "tool-2" });
    expect(shown).toHaveLength(2);
    expect(shown[1].body).toBe("The AI needs an environment variable to continue.");
  });
});

describe("aiChatAlerts — startAiChatAlertPoll", () => {
  it("does not drain while inactive, drains once active, and stops cleanly", async () => {
    const { startAiChatAlertPoll } = await load();
    const ops = fakeOps();
    const { fetcher, calls } = fakeFetcher([
      aiChatEnvelope(1, "sess-z", "talkToUser", "tool-1"),
    ]);

    // Manual timer: capture the scheduled callback so we can step ticks.
    let scheduled: (() => void) | null = null;
    const setT = (fn: () => void) => {
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    };
    const clearT = () => {
      scheduled = null;
    };

    let isActive = false;
    const stop = startAiChatAlertPoll({
      active: () => isActive,
      fetcher,
      operations: ops,
      notify: () => {},
      intervalMs: 50,
      setTimeout: setT as any,
      clearTimeout: clearT as any,
    });

    // First tick runs on a microtask; it's gated off (inactive) → no fetch.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(0);

    // Flip active and run the next scheduled tick → it drains.
    isActive = true;
    expect(scheduled).toBeTruthy();
    scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    expect(ops.upserts.some((u) => u.id === "sess-z")).toBe(true);

    stop();
    expect(scheduled).toBeNull();
  });
});

// The box wakes the owner with a content-free `generic` push when a build
// needs them (d36407cab). Tapping it drains the inbox at once and opens the
// chat it names, also when the foreground poll already drained it, or once
// the app is unlocked.
describe("aiChatAlerts — a tapped push wakes the poll", () => {
  function manualTimer() {
    let scheduled: (() => void) | null = null;
    return {
      setTimeout: ((fn: () => void) => {
        scheduled = fn;
        return 1;
      }) as any,
      clearTimeout: (() => {
        scheduled = null;
      }) as any,
      run: () => scheduled?.(),
    };
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("drains now and opens the waiting chat on its server", async () => {
    const { startAiChatAlertPoll } = await load();
    let events: any[] = [];
    const opened: any[] = [];
    const stop = startAiChatAlertPoll({
      fetcher: async (p: string) => (p.startsWith("/api/phone/alerts?") ? { events } : { ok: true }),
      operations: fakeOps(),
      server: () => "home.harry.flagship.services",
      open: (a: any) => opened.push(a),
      ...manualTimer(),
    });
    await flush();
    expect(opened).toEqual([]);
    events = [aiChatEnvelope(4, "sess-w", "requestEnvVar", "tool-9")];
    await stop.wake();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ serviceId: "sess-w", server: "home.harry.flagship.services" });
    stop();
  });

  it("a poll tick alone never opens a chat", async () => {
    const { startAiChatAlertPoll } = await load();
    const { fetcher } = fakeFetcher([aiChatEnvelope(1, "sess-a", "talkToUser", "t")]);
    const opened: any[] = [];
    const ops = fakeOps();
    const stop = startAiChatAlertPoll({ fetcher, operations: ops, open: (a: any) => opened.push(a), ...manualTimer() });
    await flush();
    expect(ops.upserts.map((u) => u.id)).toEqual(["sess-a"]);
    expect(opened).toEqual([]);
    stop();
  });

  it("opens the chat the foreground poll already drained, if it is recent", async () => {
    const { startAiChatAlertPoll, RECENT_ALERT_MS } = await load();
    let events: any[] = [aiChatEnvelope(1, "sess-b", "talkToUser", "t")];
    const opened: any[] = [];
    let now = 1_000_000;
    const stop = startAiChatAlertPoll({
      fetcher: async (p: string) => (p.startsWith("/api/phone/alerts?") ? { events } : { ok: true }),
      operations: fakeOps(),
      open: (a: any) => opened.push(a),
      now: () => now,
      ...manualTimer(),
    });
    await flush();
    events = [];
    await stop.wake();
    expect(opened.map((a) => a.serviceId)).toEqual(["sess-b"]);
    now += RECENT_ALERT_MS + 1;
    await stop.wake();
    expect(opened).toHaveLength(1);
    stop();
  });

  it("while locked the wake waits for the first drain after unlock", async () => {
    const { startAiChatAlertPoll } = await load();
    let unlocked = false;
    const { fetcher, calls } = fakeFetcher([aiChatEnvelope(2, "sess-c", "talkToUser", "t")]);
    const opened: any[] = [];
    const t = manualTimer();
    const stop = startAiChatAlertPoll({ active: () => unlocked, fetcher, operations: fakeOps(), open: (a: any) => opened.push(a), ...t });
    await flush();
    await stop.wake();
    expect(calls).toHaveLength(0);
    expect(opened).toEqual([]);
    unlocked = true;
    t.run();
    await flush();
    expect(opened.map((a) => a.serviceId)).toEqual(["sess-c"]);
    stop();
  });
});
