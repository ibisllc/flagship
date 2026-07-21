import { describe, expect, it, vi } from "vitest";
// LiveSync — the webapp's single app-scope live-update canal. Pure logic with
// DI'd getSession + fetch + timers, no DOM, no real network. Guards: the client
// method echoes the cursor, the loop updates the shared snapshot only when the
// cursor changes, it falls back to /pods on a stream error, and the boxInbox is
// FED by it (no second fetch).
import {
  fetchLiveSync,
  createLiveSync,
} from "../public/webapp/lib/liveSync.js";
import { createBoxInbox } from "../public/webapp/lib/boxInbox.js";

const SESSION = () => ({ username: "harry", umk: new Uint8Array(32) });

function streamResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function podWithRequest(id: string) {
  return {
    serverDomain: "ezra.harry.flagship.services",
    pendingRequests: [{ id, type: "unlock-key", issuedAt: 1, expiresAt: 9 }],
  };
}

describe("LiveSync — fetchLiveSync (the client method + Mock)", () => {
  it("echoes the cursor back and returns the parsed snapshot", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      streamResponse({ cursor: "c2", username: "harry", pods: [podWithRequest("aa".repeat(32))], pending: [], fetchedAt: 5 }),
    );
    const snap = await fetchLiveSync("c1", { getSession: SESSION, fetch: fetchMock, comBase: "https://com" });
    // The last cursor we held is sent on the wire.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/users/harry/stream?cursor=c1");
    // The new cursor + pods come back.
    expect(snap.cursor).toBe("c2");
    expect(snap.pods).toHaveLength(1);
  });

  it("omits the cursor query on first connect and throws on a non-200", async () => {
    const first = vi.fn(async () => streamResponse({ cursor: "c0", username: "harry", pods: [], pending: [] }));
    await fetchLiveSync(null, { getSession: SESSION, fetch: first, comBase: "https://com" });
    expect(String(first.mock.calls[0]?.[0])).not.toContain("cursor=");

    const bad = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    await expect(
      fetchLiveSync("c1", { getSession: SESSION, fetch: bad, comBase: "https://com" }),
    ).rejects.toThrow(/503/);
  });
});

describe("LiveSync — the loop updates shared state on a cursor change", () => {
  it("emits a new snapshot only when the cursor changes (a held timeout does not churn)", async () => {
    // Two responses: same cursor (a timeout hold — no change), then a new
    // cursor with a fresh pendingRequest (a box starts waiting → surfaces).
    const responses = [
      streamResponse({ cursor: "c1", username: "harry", pods: [], pending: [] }),
      streamResponse({ cursor: "c1", username: "harry", pods: [], pending: [] }), // timeout: same cursor
      streamResponse({ cursor: "c2", username: "harry", pods: [podWithRequest("aa".repeat(32))], pending: [] }),
    ];
    let i = 0;
    const fetchMock = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!);
    const sync = createLiveSync({
      getSession: SESSION,
      fetch: fetchMock,
      comBase: "https://com",
      random: () => 0.5, // zero jitter
    });

    const seen: number[] = [];
    sync.subscribe((s) => seen.push(s.pods.length));
    // immediate subscribe replay = empty
    expect(seen).toEqual([0]);

    await sync.refresh(); // c1, first connect → emits (cursor changed from null)
    await sync.refresh(); // c1 again → NO emit (same cursor, held timeout)
    await sync.refresh(); // c2 → emits the new pod (a box now waiting)

    // Only two genuine changes after the initial replay: c1 (empty), c2 (1 pod).
    expect(seen).toEqual([0, 0, 1]);
    expect(sync.get().pods).toHaveLength(1);
  });

  it("a phase change in a pending order surfaces (checklist advances)", async () => {
    const responses = [
      streamResponse({ cursor: "p1", username: "harry", pods: [], pending: [{ fqdn: "x.harry.flagship.services", phase: "partitioning" }] }),
      streamResponse({ cursor: "p2", username: "harry", pods: [], pending: [{ fqdn: "x.harry.flagship.services", phase: "installing" }] }),
    ];
    let i = 0;
    const fetchMock = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!);
    const sync = createLiveSync({ getSession: SESSION, fetch: fetchMock, comBase: "https://com", random: () => 0.5 });
    await sync.refresh();
    expect(sync.get().pending[0]?.phase).toBe("partitioning");
    await sync.refresh();
    expect(sync.get().pending[0]?.phase).toBe("installing");
  });
});

describe("LiveSync — graceful fallback to /pods on a stream error", () => {
  it("falls back to /pods when /stream is unreachable, keeping shared state fed", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/stream")) throw new Error("stream down");
      // the /pods fallback
      return streamResponse({ pods: [podWithRequest("bb".repeat(32))], pending: [] });
    });
    const sync = createLiveSync({ getSession: SESSION, fetch: fetchMock, comBase: "https://com", random: () => 0.5 });

    const seen: number[] = [];
    sync.subscribe((s) => seen.push(s.pods.length));
    await sync.refresh();

    // It hit /stream (threw), then /pods (succeeded) — shared state still fed.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/stream"))).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pods"))).toBe(true);
    expect(sync.isDegraded()).toBe(true);
    expect(sync.get().pods).toHaveLength(1);
    expect(seen.at(-1)).toBe(1);
  });
});

describe("LiveSync feeds the Box Request Inbox (one canal, no extra fetch)", () => {
  it("the inbox is fed from LiveSync snapshots, not its own /pods interval", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse({ cursor: "c2", username: "harry", pods: [podWithRequest("aa".repeat(32))], pending: [] }),
    );
    const sync = createLiveSync({ getSession: SESSION, fetch: fetchMock, comBase: "https://com", random: () => 0.5 });
    // The inbox subscribes to LiveSync as its source — it must NOT make its own
    // fetch. Give it a fetch that throws so any direct use would blow up.
    const exploding = vi.fn(async () => { throw new Error("inbox must not fetch"); });
    const inbox = createBoxInbox({ getSession: SESSION, fetch: exploding, source: sync });

    const sizes: number[] = [];
    inbox.subscribe((reqs) => sizes.push(reqs.length));
    inbox.start(); // subscribes to the LiveSync source

    await sync.refresh(); // LiveSync gets a pod with one pendingRequest → feeds inbox

    expect(exploding).not.toHaveBeenCalled();
    expect(inbox.get()).toHaveLength(1);
    expect(inbox.get()[0]?.type).toBe("unlock-key");
    inbox.stop();
  });
});
