/**
 * Phase 2 webapp — multi-pod liveness fixes.
 *
 * Fix A — Honest liveness display in classifyServer:
 *   The /pods contract now includes `liveness: "live"|"unreachable"|"never"`
 *   and `lastSeenMsAgo: number|null` per pod. classifyServer reads these
 *   fields when present and maps them to honest copy, falling back to the
 *   existing lastReported-age logic when absent.
 *
 * Fix B — Per-pod session token + base URL:
 *   sessionToken and podBaseUrl are now pod-keyed so a second pod never
 *   overwrites the first. Pairing writes under the pod's FQDN key. A pod
 *   with no stored token surfaces a "pair this device" prompt, NOT "Connecting".
 *
 * Fix C — Leader/default pod:
 *   The webapp's buildPodSwitcherModel marks the earliest-registered
 *   non-revoked pod as `isLeader` (informational) but does NOT auto-select
 *   it as the active pod. Selection is driven by the stored active base URL.
 *   A newly-added second pod therefore does NOT become the default/leader
 *   selection. Confirmed no-op: no auto-reassignment logic exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyServer,
  renderServerCard,
} from "../public/webapp/views/home.js";
import {
  buildPodSwitcherModel,
  leaderFqdnOf,
} from "../public/webapp/lib/podSwitcher.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k: string) { return map.get(k) ?? null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, String(v)); },
  } as Storage;
}

async function loadProfilesStore() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "profilesStore.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

async function loadApi() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "api.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Fix A: liveness field mapping ────────────────────────────────────────────

const BASE_SERVER = { serverId: "home.alice.flagship.services" };

describe("Fix A — classifyServer reads the liveness field", () => {
  it('liveness:"live" is treated as online (falls through to cert checks)', () => {
    const pod = {
      liveness: "live",
      lastReported: Date.now(),
    };
    const c = classifyServer(BASE_SERVER, pod);
    expect(c.kind).toBe("online");
    expect(c.label).toBe("Online");
  });

  it('liveness:"unreachable" → offline with "last seen Xh ago" from lastSeenMsAgo', () => {
    const threeHoursMs = 3 * 60 * 60 * 1000;
    const pod = {
      liveness: "unreachable",
      lastSeenMsAgo: threeHoursMs,
    };
    const c = classifyServer(BASE_SERVER, pod);
    expect(c.kind).toBe("offline");
    expect(c.label).toContain("Offline");
    expect(c.label).toContain("last seen");
    expect(c.label).toContain("3h");
    expect(c.label).toContain("ago");
  });

  it('liveness:"unreachable" with null lastSeenMsAgo → offline with "unknown"', () => {
    const pod = { liveness: "unreachable", lastSeenMsAgo: null };
    const c = classifyServer(BASE_SERVER, pod);
    expect(c.kind).toBe("offline");
    expect(c.label).toContain("unknown");
  });

  it('liveness:"never" → never-seen with "still coming up" copy', () => {
    const pod = { liveness: "never" };
    const c = classifyServer(BASE_SERVER, pod);
    expect(c.kind).toBe("never-seen");
    expect(c.label).toBe("Still coming up");
  });

  it('liveness:"never" + live unlock request → waiting-for-approval (approval wins)', () => {
    const pod = { liveness: "never" };
    const c = classifyServer(BASE_SERVER, pod, { hasLiveUnlockRequest: true });
    expect(c.kind).toBe("waiting-for-approval");
  });

  it('liveness:"never" + pendingRequests digest → waiting-for-approval', () => {
    const pod = {
      liveness: "never",
      pendingRequests: [{ id: "r1", type: "entitlement" }],
    };
    const c = classifyServer(BASE_SERVER, pod, { hasLiveUnlockRequest: false });
    expect(c.kind).toBe("waiting-for-approval");
  });

  it("no liveness field → falls back to lastReported-age logic (existing tests unaffected)", () => {
    // No liveness field; lastReported is recent → online
    const online = classifyServer(BASE_SERVER, { lastReported: Date.now() });
    expect(online.kind).toBe("online");

    // No liveness field; lastReported is stale (>15min) → offline
    const staleMs = 20 * 60 * 1000;
    const offline = classifyServer(BASE_SERVER, { lastReported: Date.now() - staleMs });
    expect(offline.kind).toBe("offline");

    // No liveness field; no lastReported → never-seen fallback chain intact
    const neverSeen = classifyServer(BASE_SERVER, { lastReported: null });
    expect(neverSeen.kind).toBe("never-seen");
  });

  it("revoked server always returns revoked regardless of liveness", () => {
    const pod = { liveness: "live", lastReported: Date.now() };
    const c = classifyServer(
      { serverId: "home.alice.flagship.services", revoked: { reason: "lost" } },
      pod,
    );
    expect(c.kind).toBe("revoked");
  });

  it('liveness:"live" cert-expiry sub-checks still apply', () => {
    const soon = Date.now() + 5 * 86400_000; // 5 days
    const pod = {
      liveness: "live",
      lastReported: Date.now(),
      currentCert: { validUntil: soon },
    };
    const c = classifyServer(BASE_SERVER, pod);
    expect(c.kind).toBe("cert-expiring-soon");
  });

  it("renderServerCard with liveness:unreachable shows offline copy, no Connecting", () => {
    const pod = { liveness: "unreachable", lastSeenMsAgo: 2 * 3600_000 };
    const html = renderServerCard(BASE_SERVER, pod);
    expect(html).toContain("Offline");
    expect(html).not.toContain("Connecting");
  });

  it("renderServerCard with liveness:never shows still-coming-up copy, no Connecting", () => {
    const pod = { liveness: "never" };
    const html = renderServerCard(BASE_SERVER, pod);
    expect(html).toContain("Still coming up");
    expect(html).not.toContain("Connecting");
  });
});

// ── Fix B: per-pod session token + base URL ──────────────────────────────────

describe("Fix B — per-pod session token storage", () => {
  it("getSessionTokenFor / setSessionTokenFor round-trips per-pod token", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    s.setSessionTokenFor("home.alice.flagship.services", "tok-home", { storage });
    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBe("tok-home");
    // Other pod unaffected.
    expect(s.getSessionTokenFor("work.alice.flagship.services", { storage })).toBeNull();
  });

  it("a second pod gets its own token, does not overwrite the first", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    s.setSessionTokenFor("home.alice.flagship.services", "tok-home", { storage });
    s.setSessionTokenFor("work.alice.flagship.services", "tok-work", { storage });

    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBe("tok-home");
    expect(s.getSessionTokenFor("work.alice.flagship.services", { storage })).toBe("tok-work");
  });

  it("removeSessionTokenFor removes only the targeted pod", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    s.setSessionTokenFor("home.alice.flagship.services", "tok-home", { storage });
    s.setSessionTokenFor("work.alice.flagship.services", "tok-work", { storage });
    s.removeSessionTokenFor("home.alice.flagship.services", { storage });

    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBeNull();
    expect(s.getSessionTokenFor("work.alice.flagship.services", { storage })).toBe("tok-work");
  });

  it("getPodBaseUrlFor is deterministic and never stored", async () => {
    const s = await loadProfilesStore();
    expect(s.getPodBaseUrlFor("home.alice.flagship.services")).toBe("https://home.alice.flagship.services");
    expect(s.getPodBaseUrlFor("work.alice.flagship.services")).toBe("https://work.alice.flagship.services");
    expect(s.getPodBaseUrlFor("")).toBe("");
    expect(s.getPodBaseUrlFor(null)).toBe("");
  });

  it("listPodTokenIds lists only pods with a stored token", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    expect(s.listPodTokenIds({ storage })).toEqual([]);
    s.setSessionTokenFor("home.alice.flagship.services", "tok-home", { storage });
    s.setSessionTokenFor("work.alice.flagship.services", "tok-work", { storage });
    const ids = s.listPodTokenIds({ storage });
    expect(ids).toHaveLength(2);
    expect(ids).toContain("home.alice.flagship.services");
    expect(ids).toContain("work.alice.flagship.services");
  });

  it("migrateSingleTokenToPod attributes the legacy single-profile token to the anchor pod", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    // Legacy single-slot token (written by old pairing flow).
    s.set("sessionToken", "legacy-tok", { storage });

    const result = s.migrateSingleTokenToPod("home.alice.flagship.services", { storage });
    expect(result.migrated).toBe(true);
    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBe("legacy-tok");
  });

  it("migrateSingleTokenToPod is a no-op when the pod already has a token", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    s.setSessionTokenFor("home.alice.flagship.services", "existing-tok", { storage });
    s.set("sessionToken", "legacy-tok", { storage });

    const result = s.migrateSingleTokenToPod("home.alice.flagship.services", { storage });
    expect(result.migrated).toBe(false);
    // Token unchanged.
    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBe("existing-tok");
  });

  it("migrateSingleTokenToPod is a no-op when there is no legacy token", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    const result = s.migrateSingleTokenToPod("home.alice.flagship.services", { storage });
    expect(result.migrated).toBe(false);
    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBeNull();
  });

  it("per-pod tokens are isolated across profiles", async () => {
    const s = await loadProfilesStore();
    const storage = memoryStorage();
    s.ensureProfile("alice", storage);
    s.ensureProfile("bob", storage);

    s.setActiveCloudName("alice", storage);
    s.setSessionTokenFor("home.alice.flagship.services", "alice-tok", { storage });

    s.setActiveCloudName("bob", storage);
    // Bob has no tokens.
    expect(s.getSessionTokenFor("home.alice.flagship.services", { storage })).toBeNull();
  });
});

describe("Fix B — api.js per-pod fetch helpers (unit contract)", () => {
  it("screensFetchForPod throws a descriptive error when the pod has no token", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    // Load fresh store so it picks up the stubbed localStorage.
    const s = await loadProfilesStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);

    const api = await loadApi();
    // No per-pod token → should throw with "pair this device" copy.
    await expect(
      api.screensFetchForPod("home.alice.flagship.services", "/api/screens/server-detail"),
    ).rejects.toThrow(/pair this device/i);
  });

  it("screensFetchForPod uses the pod's own base URL and token (not the active-pod slot)", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    const s = await loadProfilesStore();
    s.ensureProfile("alice", storage);
    s.setActiveCloudName("alice", storage);
    s.setSessionTokenFor("work.alice.flagship.services", "work-tok", { storage });
    // The legacy active-pod slot points somewhere else.
    s.set("podBaseUrl", "https://home.alice.flagship.services", { storage });
    s.set("sessionToken", "home-tok", { storage });

    const api = await loadApi();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.screensFetchForPod("work.alice.flagship.services", "/api/screens/test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    // URL must target the work pod, not home.
    expect(String(url)).toContain("work.alice.flagship.services");
    expect(String(url)).not.toContain("home.alice.flagship.services");
    // Token must be work-tok, not home-tok.
    expect((init as RequestInit).headers).toMatchObject({
      "x-flagship-session": "work-tok",
    });
  });

  it("podBaseUrl is deterministic from the FQDN", async () => {
    const api = await loadApi();
    expect(api.podBaseUrl("home.alice.flagship.services")).toBe("https://home.alice.flagship.services");
    expect(api.podBaseUrl("")).toBe("");
  });
});

// ── Fix C: leader / default-pod selection ────────────────────────────────────

describe("Fix C — new pod does not become the default/leader selection", () => {
  let seq = 0;
  function pod(fqdn: string, extra: Record<string, unknown> = {}) {
    return { serverDomain: fqdn, registeredAt: ++seq, revokedAt: null, ...extra };
  }
  const HOME = "home.alice.flagship.services";
  const WORK = "work.alice.flagship.services";

  it("adding a second pod does not move the active selection", () => {
    // Initially only HOME exists and is selected.
    const before = buildPodSwitcherModel([pod(HOME)], `https://${HOME}`);
    const selected = before.options.find((o) => o.selected);
    expect(selected?.fqdn).toBe(HOME);

    // WORK pod arrives (the new-box scenario). The active base URL is still
    // pointing at HOME — selection must stay on HOME.
    const after = buildPodSwitcherModel([pod(HOME), pod(WORK)], `https://${HOME}`);
    const still = after.options.find((o) => o.selected);
    expect(still?.fqdn).toBe(HOME);
    // WORK is NOT selected.
    expect(after.options.find((o) => o.fqdn === WORK)?.selected).toBe(false);
  });

  it("leader marking is purely informational — it does not control selection", () => {
    // WORK is the leader (registered first).
    const w = pod(WORK); // registeredAt N
    const h = pod(HOME); // registeredAt N+1
    // Active base URL still points at HOME.
    const m = buildPodSwitcherModel([w, h], `https://${HOME}`);

    // WORK is the leader.
    expect(m.options.find((o) => o.fqdn === WORK)?.isLeader).toBe(true);
    // But HOME is selected because that's where the active base URL points.
    expect(m.options.find((o) => o.selected)?.fqdn).toBe(HOME);
    // WORK is NOT auto-selected despite being leader.
    expect(m.options.find((o) => o.fqdn === WORK)?.selected).toBe(false);
  });

  it("leaderFqdnOf is deterministic — always earliest-registered non-revoked", () => {
    // Regardless of array order, the earliest registeredAt wins.
    const w = pod(WORK); // seq N
    const h = pod(HOME); // seq N+1
    expect(leaderFqdnOf([h, w])).toBe(WORK.toLowerCase());
    expect(leaderFqdnOf([w, h])).toBe(WORK.toLowerCase());

    // Revoked pods are skipped.
    const wr = pod(WORK, { revokedAt: 1 });
    const h2 = pod(HOME);
    expect(leaderFqdnOf([wr, h2])).toBe(HOME.toLowerCase());
  });

  it("selection only changes when the caller explicitly changes the stored base URL", () => {
    const pods = [pod(HOME), pod(WORK)];
    // Initial: HOME selected.
    const m1 = buildPodSwitcherModel(pods, `https://${HOME}`);
    expect(m1.options.find((o) => o.selected)?.fqdn).toBe(HOME);

    // User explicitly picks WORK (sets the active base URL). NOW WORK is selected.
    const m2 = buildPodSwitcherModel(pods, `https://${WORK}`);
    expect(m2.options.find((o) => o.selected)?.fqdn).toBe(WORK);

    // HOME is no longer selected.
    expect(m2.options.find((o) => o.fqdn === HOME)?.selected).toBe(false);
  });
});
