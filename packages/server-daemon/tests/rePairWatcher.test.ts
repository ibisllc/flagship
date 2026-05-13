import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAlertInbox } from "../src/alertInbox.js";
import type { ReissuanceAlert } from "../src/phoneAlerts.js";
import { RePairWatcher, type RePairPendingRow } from "../src/postRecovery/rePairWatcher.js";
import {
  InMemoryJournalStore,
  type ReissuerDeps,
} from "../src/postRecovery/stableIdReissuer.js";
import type { AppPlatform } from "../src/appPlatform.js";
import type { MemberRecord } from "../src/membership.js";

const USERNAME = "alice";
const OLD_HEX = "11".repeat(32);
const NEW_HEX = "22".repeat(32);
const PROBE = "33".repeat(32);

function mkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchSequence(payloads: Array<{ pending: RePairPendingRow | null } | Error>): {
  fetchImpl: typeof fetch;
  callCount: () => number;
  urls: string[];
} {
  let idx = 0;
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const next = payloads[idx];
    if (idx < payloads.length - 1) idx++;
    if (next instanceof Error) throw next;
    return mkResponse(next ?? { pending: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, callCount: () => idx + 1, urls };
}

function makeWatcher(opts: {
  payloads: Array<{ pending: RePairPendingRow | null } | Error>;
  onSwapped?: () => void;
  reissuerEnabled?: boolean;
  paired?: { count: number };
  statePath?: string;
}) {
  const fetched = makeFetchSequence(opts.payloads);
  const paired = opts.paired ?? { count: 0 };
  let now = 1_000_000;
  const statePath = opts.statePath ?? join(
    mkdtempSync(join(tmpdir(), "repair-watcher-")),
    "repair-watcher.json",
  );
  const watcher = new RePairWatcher({
    username: USERNAME,
    currentIrkPubHex: OLD_HEX,
    comBaseUrl: "https://flagshipserver.com",
    fetchImpl: fetched.fetchImpl,
    statePath,
    now: () => now,
    pollIntervalMs: 60_000,
    clearPairedSessions: async () => {
      const n = paired.count;
      paired.count = 0;
      return n;
    },
    reissuerDeps: null,
    onIrkSwapped: opts.onSwapped,
  });
  return {
    watcher,
    advance: (ms: number) => { now += ms; },
    paired,
    fetched,
    statePath,
  };
}

describe("RePairWatcher", () => {
  it("returns 'none' on first poll with no pending row", async () => {
    const { watcher } = makeWatcher({ payloads: [{ pending: null }] });
    const r = await watcher.pollOnce();
    expect(r).toBe("none");
    expect(watcher.state.lastSeen).toBeNull();
  });

  it("detects an initiation transition", async () => {
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX,
      oldIrkPub: OLD_HEX,
      initiatedAt: 1_000,
      completesAt: 1_000 + 24 * 60 * 60_000,
      objectedAt: null,
    };
    const { watcher } = makeWatcher({
      payloads: [{ pending: null }, { pending }],
    });
    expect(await watcher.pollOnce()).toBe("none");
    expect(await watcher.pollOnce()).toBe("initiated");
    expect(watcher.state.lastSeen).toEqual(pending);
  });

  it("detects an objection", async () => {
    const initial: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1_000, completesAt: 86_400_000, objectedAt: null,
    };
    const objected: RePairPendingRow = { ...initial, objectedAt: 2_000 };
    const { watcher } = makeWatcher({
      payloads: [{ pending: initial }, { pending: objected }],
    });
    expect(await watcher.pollOnce()).toBe("initiated");
    expect(await watcher.pollOnce()).toBe("objected");
  });

  it("fires onIrkSwapped + clears paired sessions on completion", async () => {
    let swapEvent: unknown = null;
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1_000, completesAt: 86_400_000, objectedAt: null,
    };
    const { watcher, paired } = makeWatcher({
      payloads: [{ pending }, { pending: null }],
      paired: { count: 3 },
      onSwapped: (e) => { swapEvent = e; },
    });
    expect(await watcher.pollOnce()).toBe("initiated");
    expect(await watcher.pollOnce()).toBe("completed");
    expect(watcher.currentIrkPubHex).toBe(NEW_HEX);
    expect(paired.count).toBe(0);
    expect((swapEvent as Record<string, unknown>).pairedSessionsCleared).toBe(3);
    expect((swapEvent as Record<string, unknown>).newIrkPubHex).toBe(NEW_HEX);
    expect((swapEvent as Record<string, unknown>).oldIrkPubHex).toBe(OLD_HEX);
  });

  it("does NOT re-fire when the same swap target is already on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-watcher-"));
    const statePath = join(dir, "repair-watcher.json");
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1_000, completesAt: 86_400_000, objectedAt: null,
    };
    const first = makeWatcher({
      payloads: [{ pending }, { pending: null }],
      statePath,
    });
    expect(await first.watcher.pollOnce()).toBe("initiated");
    expect(await first.watcher.pollOnce()).toBe("completed");

    // Restart simulation: a new watcher hydrates from the same file
    // and re-observes a null pending row. The transition detector
    // should treat the already-swapped target as a no-op.
    const second = makeWatcher({
      payloads: [{ pending: null }],
      statePath,
    });
    await second.watcher.load();
    expect(await second.watcher.pollOnce()).toBe("none");
    expect(second.watcher.currentIrkPubHex).toBe(NEW_HEX);
  });

  it("treats fetch errors as transient", async () => {
    const { watcher } = makeWatcher({
      payloads: [new Error("network unreachable"), { pending: null }],
    });
    expect(await watcher.pollOnce()).toBe("none");
    expect(watcher.state.lastError).toMatch(/network unreachable/);
    expect(await watcher.pollOnce()).toBe("none");
    expect(watcher.state.lastError).toBeNull();
  });

  it("treats objected-then-cleared as a no-op (no swap fires)", async () => {
    let swapFired = 0;
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1_000, completesAt: 86_400_000, objectedAt: 2_000,
    };
    const { watcher, paired } = makeWatcher({
      payloads: [{ pending }, { pending: null }],
      paired: { count: 7 },
      onSwapped: () => { swapFired++; },
    });
    // First poll: prior null → observed has objectedAt → categorized
    // as `initiated` since the prior was null (we don't distinguish
    // "initiated but already objected"). The subsequent transition
    // is what matters.
    await watcher.pollOnce();
    // Second poll: prior had objectedAt set → pending: null → no swap.
    expect(await watcher.pollOnce()).toBe("none");
    expect(swapFired).toBe(0);
    expect(paired.count).toBe(7);
  });

  it("hits the correct URL with URL-encoded username", async () => {
    const odd = "alice@home";
    const { fetchImpl, urls } = makeFetchSequence([{ pending: null }]);
    const dir = mkdtempSync(join(tmpdir(), "repair-watcher-"));
    const watcher = new RePairWatcher({
      username: odd,
      currentIrkPubHex: OLD_HEX,
      comBaseUrl: "https://flagshipserver.com/",
      fetchImpl,
      statePath: join(dir, "repair-watcher.json"),
      now: () => 0,
      pollIntervalMs: 60_000,
      clearPairedSessions: async () => 0,
      reissuerDeps: null,
    });
    await watcher.pollOnce();
    expect(urls[0]).toBe("https://flagshipserver.com/api/users/alice%40home/re-pair");
  });

  it("propagates the new IRK hex after restart via load()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-watcher-"));
    const statePath = join(dir, "repair-watcher.json");
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1, completesAt: 2, objectedAt: null,
    };
    const first = makeWatcher({
      payloads: [{ pending }, { pending: null }],
      statePath,
    });
    await first.watcher.pollOnce();
    await first.watcher.pollOnce();

    const reborn = new RePairWatcher({
      username: USERNAME,
      currentIrkPubHex: PROBE,
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl: makeFetchSequence([{ pending: null }]).fetchImpl,
      statePath,
      now: () => 999,
      pollIntervalMs: 60_000,
      clearPairedSessions: async () => 0,
      reissuerDeps: null,
    });
    expect(reborn.currentIrkPubHex).toBe(PROBE);
    await reborn.load();
    expect(reborn.currentIrkPubHex).toBe(NEW_HEX);
  });
});

/**
 * Minimal AppPlatform fake — enough for reissueStableIds to walk its
 * .list() output, mutate members.internalAdd/internalRemoveByHex, and
 * produce a non-zero rewrittenCount we can assert on. Real platform
 * machinery (DataProvisioner, AppRunner, dataLayer) is overkill for
 * the alert-emission path under test here.
 */
function fakePlatform(
  apps: Array<{
    appId: string;
    slug: string;
    initialMembers: Array<{ irkPubHex: string; role: string }>;
  }>,
): AppPlatform {
  const installed = apps.map((cfg) => {
    const store = new Map(cfg.initialMembers.map((m) => [
      m.irkPubHex.toLowerCase(),
      { irkPubHex: m.irkPubHex.toLowerCase(), role: m.role, addedAt: 0, addedBy: "x" } as MemberRecord,
    ]));
    const members = {
      list: () => Array.from(store.values()),
      internalAdd: (irk: Uint8Array, role: string) => {
        const hex = Array.from(irk).map((b) => b.toString(16).padStart(2, "0")).join("");
        const existed = store.has(hex);
        store.set(hex, { irkPubHex: hex, role, addedAt: 0, addedBy: "x" } as MemberRecord);
        return existed ? "updated" : "added";
      },
      internalRemoveByHex: (hex: string) => store.delete(hex.toLowerCase()),
    };
    return {
      appId: cfg.appId,
      slug: cfg.slug,
      membership: { members },
    };
  });
  return { list: () => installed } as unknown as AppPlatform;
}

describe("RePairWatcher → AlertInbox emission (J.4)", () => {
  it("emits one membership-reissued alert per app with non-zero rewrites", async () => {
    const platform = fakePlatform([
      {
        appId: "alice--app1",
        slug: "app1",
        initialMembers: [{ irkPubHex: OLD_HEX, role: "owner" }],
      },
      {
        appId: "alice--app2",
        slug: "app2",
        initialMembers: [{ irkPubHex: OLD_HEX, role: "viewer" }],
      },
      // Third app has no row for the old IRK — should NOT emit.
      {
        appId: "alice--app3",
        slug: "app3",
        initialMembers: [{ irkPubHex: PROBE, role: "viewer" }],
      },
    ]);
    const reissuerDeps: ReissuerDeps = {
      appPlatform: platform,
      swk: new Uint8Array(32).fill(7),
      journal: new InMemoryJournalStore(),
    };
    const inbox = new InMemoryAlertInbox();
    const dir = mkdtempSync(join(tmpdir(), "repair-alerts-"));
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1, completesAt: 2, objectedAt: null,
    };
    const { fetchImpl } = makeFetchSequence([{ pending }, { pending: null }]);
    const watcher = new RePairWatcher({
      username: USERNAME,
      currentIrkPubHex: OLD_HEX,
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      statePath: join(dir, "watcher.json"),
      now: () => 1_000,
      pollIntervalMs: 60_000,
      clearPairedSessions: async () => 0,
      reissuerDeps,
      alertInbox: inbox,
    });
    expect(await watcher.pollOnce()).toBe("initiated");
    expect(await watcher.pollOnce()).toBe("completed");

    const events = inbox.list();
    expect(events).toHaveLength(2);
    const apps = events.map((e) => (e.alert as ReissuanceAlert).appId).sort();
    expect(apps).toEqual(["alice--app1", "alice--app2"]);
    const first = events[0]!.alert as ReissuanceAlert;
    expect(first.kind).toBe("membership-reissued");
    expect(first.rewrittenCount).toBe(1);
    expect(first.oldIrkPrefix).toHaveLength(12);
    expect(first.newIrkPrefix).toHaveLength(12);
    expect(first.oldIrkPrefix).not.toBe(first.newIrkPrefix);
  });

  it("dedupes a second swap to the same target", async () => {
    const platform = fakePlatform([
      { appId: "alice--app1", slug: "app1", initialMembers: [{ irkPubHex: OLD_HEX, role: "owner" }] },
    ]);
    const inbox = new InMemoryAlertInbox();
    const dir = mkdtempSync(join(tmpdir(), "repair-alerts-"));
    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1, completesAt: 2, objectedAt: null,
    };
    const { fetchImpl } = makeFetchSequence([
      { pending }, { pending: null },
    ]);
    const reissuerDeps: ReissuerDeps = {
      appPlatform: platform,
      swk: new Uint8Array(32).fill(7),
      journal: new InMemoryJournalStore(),
    };
    const watcher = new RePairWatcher({
      username: USERNAME,
      currentIrkPubHex: OLD_HEX,
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      statePath: join(dir, "watcher.json"),
      now: () => 1_000,
      pollIntervalMs: 60_000,
      clearPairedSessions: async () => 0,
      reissuerDeps,
      alertInbox: inbox,
    });
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(inbox.size()).toBe(1);
    // A second emission to the same newIrkPrefix should be deduped.
    inbox.emit({
      kind: "membership-reissued",
      appId: "alice--app1",
      slug: "app1",
      rewrittenCount: 1,
      oldIrkPrefix: (inbox.list()[0]!.alert as ReissuanceAlert).oldIrkPrefix,
      newIrkPrefix: (inbox.list()[0]!.alert as ReissuanceAlert).newIrkPrefix,
      completedAt: 0,
      undoWindowExpiresAt: 0,
    });
    expect(inbox.size()).toBe(1);
  });
});

describe("RePairWatcher integration with paired sessions + reissuer", () => {
  beforeEach(() => {/* no shared state */});

  it("end-to-end: a real paired-session store + a no-op reissuer", async () => {
    const { FilePairedSessionStore } = await import("../src/pairedSessionStore.js");
    const dir = mkdtempSync(join(tmpdir(), "repair-int-"));
    const store = new FilePairedSessionStore(join(dir, "paired.json"));
    await store.add("tok-aaaaaaaaaaaaaaaa", "browser-1");
    await store.add("tok-bbbbbbbbbbbbbbbb", "browser-2");

    const pending: RePairPendingRow = {
      newIrkPub: NEW_HEX, oldIrkPub: OLD_HEX,
      initiatedAt: 1, completesAt: 2, objectedAt: null,
    };
    const fetched = makeFetchSequence([{ pending }, { pending: null }]);
    const watcher = new RePairWatcher({
      username: USERNAME,
      currentIrkPubHex: OLD_HEX,
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl: fetched.fetchImpl,
      statePath: join(dir, "watcher.json"),
      now: () => 5,
      pollIntervalMs: 60_000,
      clearPairedSessions: () => store.removeAll(),
      reissuerDeps: null,
    });

    expect(store.list()).toHaveLength(2);
    await watcher.pollOnce();
    expect(await watcher.pollOnce()).toBe("completed");
    expect(store.list()).toHaveLength(0);
    expect(watcher.currentIrkPubHex).toBe(NEW_HEX);
  });
});
