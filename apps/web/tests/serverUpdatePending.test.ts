// A sent server update is remembered on this device until the box reports its
// outcome: the update card shows it in place of the button, the update sheet
// opens on it, a 15 s re-read of server-detail clears it, and after 30 min it
// offers Send again / Forget it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../public/webapp/lib/api.js", async (importOriginal) => {
  const screensFetch = vi.fn();
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    screensFetch,
    // The server page reads the box it shows; route those reads to the mock
    // and record which box each went to.
    boxClient: vi.fn((fqdn: string) => ({
      fqdn,
      baseUrl: `https://${fqdn}`,
      token: () => "tok",
      hasSession: () => true,
      fetch: (...args: unknown[]) => screensFetch(...args),
    })),
  };
});
vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

import * as api from "../public/webapp/lib/api.js";
import {
  clearPendingUpdate,
  isPendingUpdateStale,
  orderServerUpdate,
  pendingUpdateKey,
  pendingUpdateSettled,
  readPendingUpdate,
  reconcilePendingUpdate,
  renderPendingUpdate,
  savePendingUpdate,
  PENDING_UPDATE_POLL_MS,
  PENDING_UPDATE_STALE_MS,
} from "../public/webapp/lib/serverUpdate.js";
import { openUpdateDialog, wireUpdate } from "../public/webapp/views/server-detail.js";
import { getSession } from "../public/webapp/lib/state.js";
import { deriveIrkFromSeed } from "../public/webapp/keystore.js";

const screensFetch = api.screensFetch as unknown as ReturnType<typeof vi.fn>;

const HOME = "home.alice.flagship.services";
const OFFICE = "office.alice.flagship.services";
const FROM = "1".repeat(40);
const TARGET = "2".repeat(40);
const OTHER = "3".repeat(40);
const T0 = 1_790_000_000_000;

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    get size() {
      return m.size;
    },
  };
}
const brokenStorage = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("quota");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

const fmt = (ms: number, now: number) => (now - ms < 60_000 ? "just now" : `${Math.floor((now - ms) / 60_000)}m ago`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pendingAt = (orderedAt: number, extra: Record<string, unknown> = {}) => ({
  targetCommit: TARGET,
  fromCommit: FROM,
  orderedAt,
  ...extra,
});

// ---- Pure store + outcome logic -------------------------------------------

describe("orderServerUpdate — the pending order is stored only once .com accepts it", () => {
  const args = {
    serverDomain: HOME,
    targetCommit: TARGET,
    fromCommit: FROM,
    username: "alice",
    umk: new Uint8Array(32),
    irkPubHex: "ab".repeat(32),
    signWithIrk: async () => new Uint8Array(64),
  };
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("stores {targetCommit, targetTag, fromCommit, orderedAt} after a successful deposit", async () => {
    const storage = memoryStorage();
    const out = await orderServerUpdate(args, {
      targetTag: "v1.4.0",
      storage,
      deps: { fetch: respond(200, { ok: true }), comBase: "https://c", now: () => T0 },
    });
    expect(out.pending).toEqual({ targetCommit: TARGET, targetTag: "v1.4.0", fromCommit: FROM, orderedAt: T0 });
    expect(readPendingUpdate(HOME, storage)).toEqual(out.pending);
  });

  it("stores nothing when the deposit is refused or the network fails", async () => {
    const storage = memoryStorage();
    await expect(
      orderServerUpdate(args, { storage, deps: { fetch: respond(409, { error: "busy" }), comBase: "https://c" } }),
    ).rejects.toThrow("busy");
    const offline = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(orderServerUpdate(args, { storage, deps: { fetch: offline, comBase: "https://c" } })).rejects.toThrow(
      /network error/,
    );
    expect(storage.size).toBe(0);
  });

  it("a storage failure doesn't fail the order", async () => {
    const out = await orderServerUpdate(args, {
      storage: brokenStorage as never,
      deps: { fetch: respond(200, { ok: true }), comBase: "https://c", now: () => T0 },
    });
    expect(out.ok).toBe(true);
    expect(out.pending.targetTag).toBeUndefined();
  });
});

describe("pending update store", () => {
  it("keeps one order per server, keyed case-insensitively", () => {
    const storage = memoryStorage();
    expect(savePendingUpdate("Home.Alice.Flagship.Services", pendingAt(T0), storage)).toBe(true);
    savePendingUpdate(OFFICE, pendingAt(T0 + 5, { targetCommit: OTHER }), storage);
    expect(readPendingUpdate(HOME, storage)?.targetCommit).toBe(TARGET);
    expect(readPendingUpdate(OFFICE, storage)?.targetCommit).toBe(OTHER);
    clearPendingUpdate(HOME, storage);
    expect(readPendingUpdate(HOME, storage)).toBeNull();
    expect(readPendingUpdate(OFFICE, storage)?.targetCommit).toBe(OTHER);
  });

  it("ignores junk and tolerates storage that throws", () => {
    const storage = memoryStorage();
    storage.setItem(pendingUpdateKey(HOME), "{nope");
    expect(readPendingUpdate(HOME, storage)).toBeNull();
    storage.setItem(pendingUpdateKey(HOME), JSON.stringify({ targetCommit: "short", fromCommit: FROM, orderedAt: 1 }));
    expect(readPendingUpdate(HOME, storage)).toBeNull();
    expect(savePendingUpdate(HOME, { targetCommit: TARGET }, storage)).toBe(false);
    expect(savePendingUpdate(HOME, pendingAt(T0), brokenStorage as never)).toBe(false);
    expect(readPendingUpdate(HOME, brokenStorage as never)).toBeNull();
    expect(() => clearPendingUpdate(HOME, brokenStorage as never)).not.toThrow();
    expect(readPendingUpdate(HOME, null)).toBeNull();
  });
});

describe("pendingUpdateSettled — when server-detail shows the outcome", () => {
  const p = pendingAt(T0);

  it("settles when the box runs the target", () => {
    expect(pendingUpdateSettled(p, { currentCommit: TARGET })).toBe(true);
    expect(pendingUpdateSettled(p, { currentCommit: FROM })).toBe(false);
  });

  it("settles on a verdict for the target recorded since the order was sent", () => {
    for (const outcome of ["applied", "rolled-back"]) {
      expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: { outcome, at: T0 + 60_000, targetCommit: TARGET } })).toBe(true);
      expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: { outcome, at: T0, targetCommit: TARGET } })).toBe(true);
      // An older verdict for the same target is a previous attempt.
      expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: { outcome, at: T0 - 1, targetCommit: TARGET } })).toBe(false);
      // A verdict for another target is someone else's order.
      expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: { outcome, at: T0 + 60_000, targetCommit: OTHER } })).toBe(false);
    }
  });

  it("settles on a refusal since the order was sent (refusals carry no target)", () => {
    expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: { outcome: "refused", reason: "unendorsed", at: T0 + 1 } })).toBe(true);
    expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: { outcome: "refused", reason: "stale", at: T0 - 1 } })).toBe(false);
  });

  it("a box without lastUpdate settles on currentCommit only", () => {
    expect(pendingUpdateSettled(p, { currentCommit: FROM })).toBe(false);
    expect(pendingUpdateSettled(p, { currentCommit: FROM, lastUpdate: null })).toBe(false);
    expect(pendingUpdateSettled(p, { currentCommit: TARGET, lastUpdate: null })).toBe(true);
  });

  it("reconcile clears a settled order and leaves the other servers alone", () => {
    const storage = memoryStorage();
    savePendingUpdate(HOME, p, storage);
    savePendingUpdate(OFFICE, p, storage);
    expect(reconcilePendingUpdate(HOME, { currentCommit: FROM }, storage)).toEqual(p);
    expect(reconcilePendingUpdate(HOME, { currentCommit: TARGET }, storage)).toBeNull();
    expect(readPendingUpdate(HOME, storage)).toBeNull();
    expect(readPendingUpdate(OFFICE, storage)).toEqual(p);
  });
});

describe("renderPendingUpdate", () => {
  it("names the tag (or short commit) and the send time, with a progress indicator", () => {
    const html = renderPendingUpdate(pendingAt(T0, { targetTag: "v1.4.0" }), { now: T0 + 3 * 60_000, formatWhen: fmt, escapeHtml: esc });
    expect(html).toContain(
      "Update to v1.4.0 sent 3m ago. The server picks it up within about five minutes, restarts, and goes back on its own if the new version doesn't start.",
    );
    expect(html).toContain("update-pending-spinner");
    expect(html).not.toContain("data-update-send-again");
    expect(renderPendingUpdate(pendingAt(T0), { now: T0, formatWhen: fmt, escapeHtml: esc })).toContain(
      `Update to ${TARGET.slice(0, 8)} sent just now.`,
    );
    expect(renderPendingUpdate(pendingAt(T0, { targetTag: "<b>" }), { now: T0, formatWhen: fmt, escapeHtml: esc })).toContain("&lt;b&gt;");
  });

  it("goes stale 30 min after the order with Send again and Forget it", () => {
    const p = pendingAt(T0);
    expect(isPendingUpdateStale(p, T0 + PENDING_UPDATE_STALE_MS - 1)).toBe(false);
    expect(isPendingUpdateStale(p, T0 + PENDING_UPDATE_STALE_MS)).toBe(true);
    const html = renderPendingUpdate(p, { now: T0 + PENDING_UPDATE_STALE_MS, formatWhen: fmt, escapeHtml: esc });
    expect(html).toContain("The server hasn't applied this update yet. It may be offline.");
    expect(html).toContain("Send again");
    expect(html).toContain("Forget it");
    expect(html).not.toContain("update-pending-spinner");
  });
});

// ---- The card and the sheet (a minimal fake DOM) ---------------------------

const OPEN_TAG = /<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/gi;

class FakeEl {
  textContent = "";
  value = "";
  disabled = false;
  open = false;
  classes = new Set<string>();
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e?: unknown) => void>> = {};
  private html = "";
  private kids = new Map<string, FakeEl>();
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
  };
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = String(v);
    this.kids = new Map();
  }
  get hidden() {
    return this.classes.has("hidden");
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type: string) {
    for (const fn of [...(this.listeners[type] ?? [])]) fn({});
  }
  click() {
    if (!this.disabled) this.fire("click");
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire("close");
  }
  remove() {}
  appendChild() {}
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const attr = /^\[([a-z0-9-]+)\]$/i.exec(sel)?.[1];
    if (!attr) return [];
    const out: FakeEl[] = [];
    let i = 0;
    for (const m of this.html.matchAll(OPEN_TAG)) {
      const attrs: Record<string, string> = {};
      for (const a of (m[2] ?? "").matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attrs[a[1]!] = a[2] ?? "";
      if (!(attr in attrs)) continue;
      const key = `${attr}#${i++}`;
      let el = this.kids.get(key);
      if (!el) {
        el = new FakeEl();
        el.attrs = attrs;
        for (const c of (attrs.class ?? "").split(/\s+/).filter(Boolean)) el.classes.add(c);
        el.disabled = "disabled" in attrs;
        this.kids.set(key, el);
      }
      out.push(el);
    }
    for (const kid of this.kids.values()) out.push(...kid.querySelectorAll(sel));
    return out;
  }
}

let ids: Record<string, FakeEl>;
let dialogs: FakeEl[];

function installDom() {
  ids = {};
  for (const id of [
    "view-server-detail",
    "update-current-commit",
    "update-available",
    "update-last-outcome",
    "update-pending",
    "update-server-btn",
    "update-hint",
  ]) {
    ids[id] = new FakeEl();
  }
  ids["update-available"]!.classes.add("hidden");
  ids["update-pending"]!.classes.add("hidden");
  ids["update-hint"]!.classes.add("hidden");
  dialogs = [];
  const document = {
    visibilityState: "visible",
    getElementById: (id: string) => ids[id] ?? null,
    createElement: () => {
      const d = new FakeEl();
      dialogs.push(d);
      return d;
    },
    body: new FakeEl(),
  };
  vi.stubGlobal("document", document);
}

const detail = (extra: Record<string, unknown> = {}) => ({
  serverFqdn: HOME,
  username: "alice",
  currentCommit: FROM,
  lastUpdate: null,
  ...extra,
});

const card = () => ({
  btn: ids["update-server-btn"]!,
  pending: ids["update-pending"]!,
  last: ids["update-last-outcome"]!,
});

// Signing awaits real crypto, so let the event loop turn until it settles.
// Bounded by real time, not turns: signing runs off the event loop and a slow
// CI runner outlasts any fixed number of turns. setImmediate and performance
// are left unfaked by the fake timers below.
async function settle(done: () => boolean, ms = 5000) {
  const until = performance.now() + ms;
  while (!done() && performance.now() < until) await new Promise((r) => setImmediate(r));
}

async function unlockSession() {
  const s = getSession();
  s.umk = new Uint8Array(32).fill(9);
  s.irk = await deriveIrkFromSeed(s.umk);
  s.username = "alice";
}

describe("update card and sheet", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
    storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    installDom();
    screensFetch.mockReset();
    screensFetch.mockRejectedValue(new Error("not wired"));
    await unlockSession();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the button when nothing is pending", () => {
    wireUpdate(detail());
    expect(card().btn.hidden).toBe(false);
    expect(card().pending.hidden).toBe(true);
  });

  it("shows the pending order in place of the button", () => {
    savePendingUpdate(HOME, pendingAt(T0 - 2 * 60_000, { targetTag: "v1.4.0" }), storage);
    wireUpdate(detail());
    expect(card().btn.hidden).toBe(true);
    expect(card().pending.hidden).toBe(false);
    expect(card().pending.innerHTML).toContain("Update to v1.4.0 sent 2m ago.");
    expect(card().pending.innerHTML).toContain("update-pending-spinner");
    expect(ids["update-hint"]!.hidden).toBe(true);
  });

  it("only this server's order shows", () => {
    savePendingUpdate(OFFICE, pendingAt(T0), storage);
    wireUpdate(detail());
    expect(card().btn.hidden).toBe(false);
    expect(readPendingUpdate(OFFICE, storage)).not.toBeNull();
  });

  it("re-reads server-detail every 15 s and clears once the box runs the target", async () => {
    savePendingUpdate(HOME, pendingAt(T0), storage);
    screensFetch.mockResolvedValue(detail());
    wireUpdate(detail());
    await vi.advanceTimersByTimeAsync(PENDING_UPDATE_POLL_MS);
    expect(screensFetch).toHaveBeenCalledWith("/api/screens/server-detail");
    expect(api.boxClient).toHaveBeenCalledWith(HOME);
    expect(card().btn.hidden).toBe(true);
    screensFetch.mockResolvedValue(detail({ currentCommit: TARGET }));
    await vi.advanceTimersByTimeAsync(PENDING_UPDATE_POLL_MS);
    expect(card().btn.hidden).toBe(false);
    expect(card().pending.hidden).toBe(true);
    expect(readPendingUpdate(HOME, storage)).toBeNull();
    expect(ids["update-current-commit"]!.textContent).toBe(TARGET.slice(0, 8));
    // No order pending: no more re-reads.
    const calls = screensFetch.mock.calls.filter((c) => c[0] === "/api/screens/server-detail").length;
    await vi.advanceTimersByTimeAsync(PENDING_UPDATE_POLL_MS * 3);
    expect(screensFetch.mock.calls.filter((c) => c[0] === "/api/screens/server-detail").length).toBe(calls);
  });

  for (const lastUpdate of [
    { outcome: "applied", targetCommit: TARGET, previousCommit: FROM },
    { outcome: "rolled-back", targetCommit: TARGET, previousCommit: FROM },
    { outcome: "refused", reason: "unendorsed" },
  ]) {
    it(`clears on a newer ${lastUpdate.outcome} verdict and shows the last-update line`, async () => {
      savePendingUpdate(HOME, pendingAt(T0), storage);
      wireUpdate(detail());
      screensFetch.mockResolvedValue(detail({ lastUpdate: { ...lastUpdate, at: T0 + 10_000 } }));
      await vi.advanceTimersByTimeAsync(PENDING_UPDATE_POLL_MS);
      expect(readPendingUpdate(HOME, storage)).toBeNull();
      expect(card().btn.hidden).toBe(false);
      expect(card().last.hidden).toBe(false);
      expect(card().last.textContent).toMatch(/update/i);
    });
  }

  it("ignores a detail answered by another server", async () => {
    savePendingUpdate(HOME, pendingAt(T0), storage);
    wireUpdate(detail());
    screensFetch.mockResolvedValue(detail({ serverFqdn: OFFICE, currentCommit: TARGET }));
    await vi.advanceTimersByTimeAsync(PENDING_UPDATE_POLL_MS);
    expect(readPendingUpdate(HOME, storage)).not.toBeNull();
    expect(card().btn.hidden).toBe(true);
  });

  it("doesn't re-read while the page is in the background", async () => {
    savePendingUpdate(HOME, pendingAt(T0), storage);
    wireUpdate(detail());
    (globalThis.document as unknown as { visibilityState: string }).visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(PENDING_UPDATE_POLL_MS * 2);
    expect(screensFetch).not.toHaveBeenCalledWith("/api/screens/server-detail");
  });

  it("turns stale after 30 min: Forget it clears the order", async () => {
    savePendingUpdate(HOME, pendingAt(T0), storage);
    screensFetch.mockResolvedValue(detail());
    wireUpdate(detail());
    expect(card().pending.innerHTML).not.toContain("Forget it");
    await vi.advanceTimersByTimeAsync(PENDING_UPDATE_STALE_MS);
    expect(card().pending.innerHTML).toContain("The server hasn't applied this update yet. It may be offline.");
    card().pending.querySelector("[data-update-forget]")!.click();
    expect(readPendingUpdate(HOME, storage)).toBeNull();
    expect(card().btn.hidden).toBe(false);
  });

  it("Send again re-runs the order flow from the release picker", async () => {
    savePendingUpdate(HOME, pendingAt(T0 - PENDING_UPDATE_STALE_MS), storage);
    wireUpdate(detail());
    card().pending.querySelector("[data-update-send-again]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const dlg = dialogs.at(-1)!;
    expect(dlg.open).toBe(true);
    expect(dlg.querySelector("[data-update-choose]")!.hidden).toBe(false);
    expect(dlg.querySelector("[data-update-result]")!.hidden).toBe(true);
    expect(screensFetch).toHaveBeenCalledWith("/api/screens/updates");
  });

  it("the sheet opens in the post-send state while an order is pending", async () => {
    savePendingUpdate(HOME, pendingAt(T0, { targetTag: "v1.4.0" }), storage);
    const closed = openUpdateDialog(detail()).catch((e: unknown) => e);
    const dlg = dialogs.at(-1)!;
    expect(dlg.querySelector("[data-update-choose]")!.hidden).toBe(true);
    const result = dlg.querySelector("[data-update-result]")!;
    expect(result.hidden).toBe(false);
    expect(result.innerHTML).toContain("Update to v1.4.0 sent just now.");
    expect(dlg.querySelector("[data-update-cancel]")!.textContent).toBe("Done");
    expect(screensFetch).not.toHaveBeenCalled();
    dlg.close();
    expect(await closed).toEqual({ code: "cancelled" });
  });

  it("a successful order from the sheet stores the pending order and shows it; a failed one doesn't", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    void openUpdateDialog(detail()).catch(() => {});
    const dlg = dialogs.at(-1)!;
    const target = dlg.querySelector("[data-update-target]")!;
    const go = dlg.querySelector("[data-update-go]")!;
    target.value = TARGET;
    target.fire("input");
    go.click();
    await settle(() => !dlg.querySelector("[data-update-error]")!.hidden);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dlg.querySelector("[data-update-error]")!.hidden).toBe(false);
    expect(readPendingUpdate(HOME, storage)).toBeNull();

    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    go.click();
    await settle(() => readPendingUpdate(HOME, storage) !== null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stored = readPendingUpdate(HOME, storage);
    expect(stored).toMatchObject({ targetCommit: TARGET, fromCommit: FROM, orderedAt: T0 });
    expect(dlg.querySelector("[data-update-choose]")!.hidden).toBe(true);
    expect(dlg.querySelector("[data-update-result]")!.innerHTML).toContain(`Update to ${TARGET.slice(0, 8)} sent just now.`);
    dlg.close();
  });
});
