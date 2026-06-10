/**
 * #56 — webapp server-list consolidation onto ONE unauthenticated
 * /api/users/:u/pods fetch (mirrors the iOS reconciler, commit bae3537).
 *
 * The list now surfaces BOTH registered servers (from the paired
 * session's /api/me/servers) AND active in-flight install orders (the
 * new backward-compatible `pending[]` on /pods). We assert the pure,
 * DOM-free seams directly:
 *   - fetchPodInventory decodes registered status + pending from ONE
 *     fetch, and degrades gracefully when `pending` is absent
 *     (backward-compatible with a pre-#56 Worker);
 *   - pendingWithoutRegisteredTwin merges by normalized fqdn so a
 *     REGISTERED server supersedes a pending order with the same fqdn.
 *
 * Pure-function tests, mirroring homeRecoveryBanner.test.ts — no DOM, no
 * second signed fetch (the webapp has no biometric; this is the same
 * "one merged fetch" model the iOS consolidation adopted).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPodInventory,
  pendingWithoutRegisteredTwin,
  renderPendingCard,
  renderServerCard,
  classifyServer,
} from "../public/webapp/views/home.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("webapp fetchPodInventory — one merged fetch", () => {
  it("decodes BOTH registered pods and pending orders from a single call", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        username: "demo",
        pods: [
          { serverDomain: "blog.demo.flagship.services", lastReported: 123, state: "online" },
        ],
        pending: [
          {
            orderRef: "94fa2ec15363579a4b39efe6666012ca35cbaf5eebddb9301f3947ace45d8034",
            serverName: "wiki",
            fqdn: "wiki.demo.flagship.services",
            phase: "installing",
            createdAt: 1000,
            state: "pending",
          },
        ],
        fetchedAt: 2000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const inv = await fetchPodInventory("demo");

    // Exactly ONE network call — no second signed/biometric endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/users/demo/pods");

    // Registered pod is keyed by lower-cased serverDomain.
    expect(inv.statusByDomain.get("blog.demo.flagship.services")?.lastReported).toBe(123);
    // Pending order surfaces from the same response.
    expect(inv.pending).toHaveLength(1);
    expect(inv.pending[0]!.fqdn).toBe("wiki.demo.flagship.services");
    expect(inv.pending[0]!.phase).toBe("installing");
  });

  it("is backward-compatible when `pending` is absent (pre-#56 Worker)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        username: "demo",
        pods: [{ serverDomain: "blog.demo.flagship.services", state: "online" }],
        // no `pending` field at all
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const inv = await fetchPodInventory("demo");
    expect(inv.statusByDomain.size).toBe(1);
    expect(inv.pending).toEqual([]);
  });

  it("drops malformed pending entries (missing fqdn) without throwing", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        username: "demo",
        pods: [],
        pending: [
          { orderRef: "aa".repeat(32), serverName: "ok", fqdn: "ok.demo.flagship.services", state: "pending" },
          { orderRef: "bb".repeat(32), serverName: "broken" /* no fqdn */, state: "pending" },
          null,
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const inv = await fetchPodInventory("demo");
    expect(inv.pending.map((p: { fqdn: string }) => p.fqdn)).toEqual([
      "ok.demo.flagship.services",
    ]);
  });

  it("degrades to empty on a non-OK response or network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, {})));
    let inv = await fetchPodInventory("demo");
    expect(inv.statusByDomain.size).toBe(0);
    expect(inv.pending).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    inv = await fetchPodInventory("demo");
    expect(inv.pending).toEqual([]);

    // No username → no fetch at all.
    const noFetch = vi.fn();
    vi.stubGlobal("fetch", noFetch);
    inv = await fetchPodInventory("");
    expect(noFetch).not.toHaveBeenCalled();
    expect(inv.pending).toEqual([]);
  });
});

describe("webapp pendingWithoutRegisteredTwin — registered supersedes pending", () => {
  it("a registered server SUPERSEDES a pending order with the same fqdn", () => {
    const servers = [{ serverId: "wiki.demo.flagship.services" }];
    const pending = [
      { fqdn: "wiki.demo.flagship.services", createdAt: 10 }, // already registered
      { fqdn: "blog.demo.flagship.services", createdAt: 20 }, // still pending
    ];
    const out = pendingWithoutRegisteredTwin(servers, pending);
    expect(out.map((p) => p.fqdn)).toEqual(["blog.demo.flagship.services"]);
  });

  it("matches fqdn case-insensitively (normalized identity)", () => {
    const servers = [{ serverId: "Wiki.Demo.Flagship.Services" }];
    const pending = [{ fqdn: "wiki.demo.flagship.services", createdAt: 10 }];
    expect(pendingWithoutRegisteredTwin(servers, pending)).toHaveLength(0);
  });

  it("surfaces pending orders newest-first when no registered twin exists", () => {
    const out = pendingWithoutRegisteredTwin(
      [],
      [
        { fqdn: "a.demo.flagship.services", createdAt: 1 },
        { fqdn: "c.demo.flagship.services", createdAt: 3 },
        { fqdn: "b.demo.flagship.services", createdAt: 2 },
      ],
    );
    expect(out.map((p) => p.fqdn)).toEqual([
      "c.demo.flagship.services",
      "b.demo.flagship.services",
      "a.demo.flagship.services",
    ]);
  });

  it("tolerates absent/empty inputs", () => {
    expect(pendingWithoutRegisteredTwin(undefined, undefined)).toEqual([]);
    expect(pendingWithoutRegisteredTwin([], [])).toEqual([]);
  });
});

describe("webapp renderPendingCard", () => {
  it("renders a pending pill + the determinate progress bar for a known phase", () => {
    const html = renderPendingCard({
      fqdn: "wiki.demo.flagship.services",
      serverName: "wiki",
      phase: "installing",
    });
    expect(html).toContain("pending");
    expect(html).toContain("wiki");
    expect(html).toContain("demo-progress-bar");
    expect(html).toContain('role="progressbar"');
  });

  it("escapes the server name / fqdn (no HTML injection)", () => {
    const html = renderPendingCard({
      fqdn: "x.demo.flagship.services",
      serverName: "<img src=x onerror=alert(1)>",
      phase: null,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("offers the decommission/free-the-name delete on a pending card", () => {
    const html = renderPendingCard({
      fqdn: "wiki.demo.flagship.services",
      serverName: "wiki",
      phase: "installing",
    });
    expect(html).toContain("js-delete-dead-server");
    expect(html).toContain('data-fqdn="wiki.demo.flagship.services"');
    expect(html).toContain("Delete server (free name)");
  });
});

describe("webapp dead-registered server delete (free the name)", () => {
  // A registered box whose daemon never checked in.
  const deadServer = { serverId: "dead.demo.flagship.services" };

  it("classifies a registered box with no check-in as never-seen", () => {
    expect(classifyServer(deadServer, undefined).kind).toBe("never-seen");
    expect(classifyServer(deadServer, { lastReported: null }).kind).toBe("never-seen");
  });

  it("renders the delete (free name) action for a never-seen server", () => {
    const html = renderServerCard(deadServer, { lastReported: null });
    expect(html).toContain("js-delete-dead-server");
    expect(html).toContain('data-fqdn="dead.demo.flagship.services"');
    expect(html).toContain("Delete server (free name)");
  });

  it("does NOT render the delete action for a live server", () => {
    // A box that checked in recently is online — deletion stays behind the
    // lost/stolen revoke, not the free-the-name path.
    const html = renderServerCard(
      { serverId: "live.demo.flagship.services" },
      { lastReported: Date.now() },
    );
    expect(classifyServer({ serverId: "live.demo.flagship.services" }, { lastReported: Date.now() }).kind).toBe("online");
    expect(html).not.toContain("js-delete-dead-server");
  });
});

describe("webapp classifyServer — three states of a registered-but-not-online box", () => {
  const server = { serverId: "box.demo.flagship.services" };
  const now = 1_000_000_000_000;

  it("waiting-for-approval: a live unlock request means it is NOT dead", () => {
    // No check-in, registered long ago — but a live unlock request is the
    // overriding signal: the box is actively trying to boot.
    const pod = { lastReported: null, registeredAt: now - 60 * 60 * 1000 };
    const c = classifyServer(server, pod, { hasLiveUnlockRequest: true, now });
    expect(c.kind).toBe("waiting-for-approval");
    const html = renderServerCard(server, pod, { hasLiveUnlockRequest: true, now });
    expect(html).not.toContain("js-delete-dead-server");
  });

  it("coming-online: registered within the grace window, no live request", () => {
    const pod = { lastReported: null, registeredAt: now - 5 * 60 * 1000 };
    const c = classifyServer(server, pod, { hasLiveUnlockRequest: false, now });
    expect(c.kind).toBe("coming-online");
    const html = renderServerCard(server, pod, { hasLiveUnlockRequest: false, now });
    expect(html).not.toContain("js-delete-dead-server");
  });

  it("never-seen (dead): no live request + past the grace window", () => {
    const pod = { lastReported: null, registeredAt: now - 60 * 60 * 1000 };
    const c = classifyServer(server, pod, { hasLiveUnlockRequest: false, now });
    expect(c.kind).toBe("never-seen");
    const html = renderServerCard(server, pod, { hasLiveUnlockRequest: false, now });
    expect(html).toContain("js-delete-dead-server");
  });
});
