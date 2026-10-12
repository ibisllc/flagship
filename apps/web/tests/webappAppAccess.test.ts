// App access lists on the webapp (docs/ai-privacy-and-staging.md §3a): the
// normalizer, parser, matcher, editor and signer against the shared vectors,
// the box calls, the "<App> wants to reach <host>" alerts, the screens socket,
// the generic push, and the page wiring.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { deriveIRK } from "@flagship/protocol";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-access/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadAccess = () => load("lib/appAccess.js");
const loadAlerts = () => load("lib/accessAlerts.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const owner = { requireOwnerProfile: () => {} };

describe("access lists — the shared vectors", () => {
  it("normalizes", async () => {
    const { normalizeAccessList } = await loadAccess();
    for (const c of VECTORS.normalize) expect(normalizeAccessList(c.in)).toBe(c.out);
  });

  it("parses, with the exact error texts", async () => {
    const { parseAccessList } = await loadAccess();
    for (const c of VECTORS.parse) {
      const out = parseAccessList(c.list);
      if (c.errors) {
        expect(out.errors, c.list).toEqual(c.errors);
      } else {
        expect(out.errors, c.list).toEqual([]);
        expect(out.rules, c.list).toEqual(c.rules);
      }
    }
  });

  it("decides: first matching rule, else deny", async () => {
    const { decideAccess } = await loadAccess();
    for (const c of VECTORS.decide) {
      expect(decideAccess(c.list, c.host), `${c.list} / ${c.host}`).toEqual({ result: c.result, rule: c.rule });
    }
  });

  it("withRule drops the host's rule and puts the new one on top", async () => {
    const { withRule } = await loadAccess();
    for (const c of VECTORS.withRule) expect(withRule(c.list, c.action, c.host)).toBe(c.out);
  });

  it("starts an app with the default list, which denies everything", async () => {
    const { DEFAULT_ACCESS_LIST, parseAccessList, decideAccess } = await loadAccess();
    expect(DEFAULT_ACCESS_LIST).toBe(VECTORS.defaultList);
    expect(parseAccessList(DEFAULT_ACCESS_LIST)).toEqual({ rules: [], errors: [] });
    expect(decideAccess(DEFAULT_ACCESS_LIST, "example.com")).toEqual({ result: "deny", rule: null });
  });

  it("hashes, builds the canonical bytes and signs with the IRK of the UMK seed", async () => {
    const { accessListSha256, canonicalAppAccessBytes, signAccessList } = await loadAccess();
    const { signWithIrk } = await load("keystore.js");
    const seed = fromHex(VECTORS.sign.umkSeedHex);
    expect(hex(deriveIRK({ seed }).publicKey)).toBe(VECTORS.sign.pub);
    for (const c of VECTORS.sign.cases) {
      expect(await accessListSha256(c.list)).toBe(c.listSha256);
      const grant = { serverDomain: c.serverDomain, serviceId: c.serviceId, listSha256: c.listSha256, issuedAt: c.issuedAt };
      expect(utf8(canonicalAppAccessBytes(grant))).toBe(c.canonical);
      expect(hex(await signWithIrk(seed, canonicalAppAccessBytes(grant)))).toBe(c.signature);
      const body = await signAccessList({ ...grant, list: c.list, umk: seed, signWithIrk });
      expect(body).toEqual({ list: c.list, grant, signature: c.signature });
    }
  });

  it("signs with the sensitive-order key (admin root when held)", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/app-access/v1")).toBe(true);
  });
});

describe("access lists — more parser edges", () => {
  it("caps a list at 200 rules and names the line", async () => {
    const { parseAccessList } = await loadAccess();
    const list = Array.from({ length: 201 }, (_, i) => `allow h${i}.example.com`).join("\n");
    const out = parseAccessList(list);
    expect(out.rules).toHaveLength(200);
    expect(out.errors).toEqual([{ line: 201, message: "an access list can have at most 200 rules" }]);
  });

  it("rejects IPv6 and *.localhost, and withRule refuses a bad host", async () => {
    const { parseAccessList, withRule } = await loadAccess();
    expect(parseAccessList("allow ::1\n").errors[0].message).toMatch(/IP addresses/);
    expect(parseAccessList("allow *.localhost\n").errors[0].message).toBe('"localhost" is not a public host name');
    expect(() => withRule("", "allow", "https://x.com")).toThrow(/without http/);
    expect(() => withRule("", "maybe", "x.com")).toThrow();
  });

  it("the editor keeps Save off with errors, unchanged text, or on a companion", async () => {
    const { accessEditorState } = await loadAccess();
    const saved = "allow a.com\n";
    expect(accessEditorState("allow a.com", saved).canSave).toBe(false);
    const bad = accessEditorState("allow a.com\nallow https://b.com\n", saved);
    expect(bad.canSave).toBe(false);
    expect(bad.errors).toEqual([{ line: 2, message: "write the host only, without http:// or https://" }]);
    expect(accessEditorState("allow a.com\ndeny all\n", saved)).toMatchObject({ rules: 2, canSave: true });
    expect(accessEditorState("allow a.com\ndeny all\n", saved, { companion: true }).canSave).toBe(false);
  });
});

describe("access lists — the box calls", () => {
  const c = VECTORS.sign.cases[0];

  it("Save signs the normalized list and posts what the box verifies", async () => {
    const { sendAccessList } = await loadAccess();
    const { signWithIrk } = await load("keystore.js");
    const fetchJson = vi.fn(async () => ({ ok: true, access: { list: c.list, listSha256: c.listSha256, pending: [] } }));
    const out = await sendAccessList(
      {
        serverDomain: c.serverDomain,
        serviceId: c.serviceId,
        list: c.list.replace(/\n/g, "\r\n") + "\n\n",
        umk: fromHex(VECTORS.sign.umkSeedHex),
        signWithIrk,
        fetchJson,
      },
      { ...owner, now: () => c.issuedAt },
    );
    expect(out).toEqual({ list: c.list, listSha256: c.listSha256, pending: [] });
    const [path, init] = fetchJson.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(path).toBe("/api/screens/services/harry-weather/access");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      list: c.list,
      grant: { serverDomain: c.serverDomain, serviceId: c.serviceId, listSha256: c.listSha256, issuedAt: c.issuedAt },
      signature: c.signature,
    });
  });

  it("won't sign a list with errors, or on a companion", async () => {
    const { sendAccessList, AccessListError } = await loadAccess();
    const sign = vi.fn();
    const args = { serverDomain: "s", serviceId: "x", umk: new Uint8Array(32), signWithIrk: sign, fetchJson: vi.fn() };
    await expect(sendAccessList({ ...args, list: "permit a.com\n" }, owner)).rejects.toBeInstanceOf(AccessListError);
    await expect(
      sendAccessList({ ...args, list: "allow a.com\n" }, { requireOwnerProfile: () => { throw new Error("A remote browser can't sign"); } }),
    ).rejects.toThrow(/can't sign/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("Allow reads the list, puts the rule on top, and retries once on 409", async () => {
    const { answerAccessRequest } = await loadAccess();
    const lists = ["allow a.com\n", `${VECTORS.defaultList}`];
    const posts: string[] = [];
    let postCount = 0;
    const fetchJson = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (!init?.method) return { list: lists.shift(), listSha256: "", pending: [{ host: "api.github.com", source: "attempt", attempts: 2 }] };
      const body = JSON.parse(init.body!);
      posts.push(body.list);
      if (postCount++ === 0) throw new ScreensError("not newer", 409, { error: "not newer" });
      return { ok: true, access: { list: body.list, listSha256: body.grant.listSha256, pending: [] } };
    });
    const out = await answerAccessRequest(
      {
        serverDomain: "home.harry.flagship.services",
        serviceId: "harry-weather",
        host: "API.GitHub.com",
        action: "allow",
        umk: new Uint8Array(32),
        signWithIrk: async () => new Uint8Array(64),
        fetchJson,
      },
      owner,
    );
    expect(posts).toEqual(["allow api.github.com\nallow a.com\n", `allow api.github.com\n${VECTORS.defaultList}`]);
    expect(out.list).toBe(`allow api.github.com\n${VECTORS.defaultList}`);
  });

  it("Ignore dismisses without a signature; requests and summaries are read defensively", async () => {
    const { dismissAccessRequest, fetchAccessRequests, readAccessSummary, hasPendingInternetRequest } = await loadAccess();
    const fetchJson = vi.fn(async () => ({ ok: true }));
    await dismissAccessRequest({ serviceId: "harry-weather", host: "x.com", fetchJson }, owner);
    expect(fetchJson).toHaveBeenCalledWith("/api/screens/services/harry-weather/access/dismiss", {
      method: "POST",
      body: JSON.stringify({ host: "x.com" }),
    });
    const reqs = await fetchAccessRequests(async () => ({
      requests: [
        { serviceId: "harry-weather", appName: "Weather", host: "api.open-meteo.com", source: "app", attempts: 0 },
        { host: "no-service.com" },
        null,
      ],
    }));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ serviceId: "harry-weather", appName: "Weather", source: "app" });
    expect(readAccessSummary({ access: { rules: 3, pending: 1 } })).toEqual({ rules: 3, pending: 1 });
    expect(readAccessSummary({})).toBeNull();
    expect(hasPendingInternetRequest({ access: { rules: 0, pending: 0 } }, () => true)).toBe(false);
    expect(hasPendingInternetRequest({ access: { rules: 0, pending: [{ host: "a" }] } })).toBe(true);
    // An older box (egress, no access) keeps the v1 badge logic.
    expect(hasPendingInternetRequest({ egress: {} }, () => true)).toBe(true);
  });

  it("says the box's refusals plainly, with errors by line", async () => {
    const { accessErrorMessage } = await loadAccess();
    const err = (status: number, body: object) => new ScreensError((body as { error?: string }).error ?? "", status, body);
    expect(accessErrorMessage(err(400, { error: "bad list", errors: [{ line: 3, message: "one host per line" }] }))).toBe(
      "Line 3: one host per line",
    );
    expect(accessErrorMessage(err(403, { error: "stale grant" }))).toMatch(/clock/);
    expect(accessErrorMessage(err(403, { error: "invalid signature" }))).toMatch(/signature/);
    expect(accessErrorMessage(err(404, { error: "no such service" }))).toMatch(/isn't installed/);
    expect(accessErrorMessage(err(409, { error: "not newer" }))).toMatch(/Refresh/);
  });

  it("words the request and the answer", async () => {
    const a = await loadAccess();
    expect(a.accessRequestTitle("Weather", "api.open-meteo.com")).toBe("Weather wants to reach api.open-meteo.com");
    expect(a.accessRequestNote({ source: "app" })).toBe("It asked for this when it was installed.");
    expect(a.accessRequestNote({ source: "attempt", attempts: 3 })).toBe("It tried to connect 3 times.");
    expect(a.accessAnsweredText("Weather", "x.com", "allow")).toBe("Weather can now reach x.com");
    expect(a.accessAnsweredText("Weather", "x.com", "deny")).toBe("Weather won't reach x.com");
    expect(a.ruleCountText(0)).toMatch(/can't reach the internet/);
    expect(a.ruleCountText(2)).toBe("2 rules");
  });
});

describe("access alerts", () => {
  const req = (host: string) => ({ serviceId: "harry-weather", appName: "Weather", host, source: "attempt", attempts: 1 });

  it("asks about each request once; Not now comes back after the snooze", async () => {
    const { createAccessAlertController } = await loadAlerts();
    let t = 0;
    const handle = vi.fn(async (r: { host: string }) => (r.host === "a.com" ? "later" : "allow"));
    const ctl = createAccessAlertController({
      fetchRequests: async () => [req("a.com"), req("b.com")],
      handle,
      isActive: () => true,
      now: () => t,
      snoozeMs: 1000,
      minIntervalMs: 100,
    });
    await ctl.check();
    expect(handle.mock.calls.map((c) => c[0].host)).toEqual(["a.com", "b.com"]);
    t = 50;
    await ctl.check({ force: true });
    expect(handle).toHaveBeenCalledTimes(2);
    t = 2000;
    await ctl.check();
    expect(handle).toHaveBeenCalledTimes(4);
  });

  it("does nothing while inactive (locked, companion, unpaired) and throttles focus checks", async () => {
    const { createAccessAlertController } = await loadAlerts();
    const fetchRequests = vi.fn(async () => []);
    let active = false;
    let t = 0;
    const ctl = createAccessAlertController({ fetchRequests, handle: vi.fn(), isActive: () => active, now: () => t, minIntervalMs: 100 });
    await ctl.check({ force: true });
    expect(fetchRequests).not.toHaveBeenCalled();
    active = true;
    await ctl.check();
    t = 10;
    await ctl.check();
    expect(fetchRequests).toHaveBeenCalledTimes(1);
    await ctl.check({ force: true });
    expect(fetchRequests).toHaveBeenCalledTimes(2);
  });

  it("Allow signs, confirms, and opens the list on View access list; Not now changes nothing", async () => {
    const { handleAccessRequest } = await loadAlerts();
    const answer = vi.fn(async () => ({}));
    const confirm = vi.fn(async () => "view");
    const openList = vi.fn(async () => {});
    const notify = vi.fn();
    const r = req("api.open-meteo.com");
    expect(await handleAccessRequest(r, { present: async () => "allow", answer, confirm, openList, notify })).toBe("allow");
    expect(answer).toHaveBeenCalledWith(r, "allow");
    expect(confirm).toHaveBeenCalledWith("Weather can now reach api.open-meteo.com");
    expect(openList).toHaveBeenCalledWith(r);
    answer.mockClear();
    expect(await handleAccessRequest(r, { present: async () => "later", answer, confirm, openList, notify })).toBe("later");
    expect(answer).not.toHaveBeenCalled();
    const failing = vi.fn(async () => { throw new Error("nope"); });
    expect(await handleAccessRequest(r, { present: async () => "deny", answer: failing, confirm, openList, notify })).toBe("failed");
    expect(notify).toHaveBeenCalled();
  });

  it("the screens socket checks on access-request and gives up on a box without it", async () => {
    const { createAccessEventSocket, ACCESS_EVENTS_PATH } = await loadAlerts();
    expect(ACCESS_EVENTS_PATH).toBe("/api/screens/events");
    const sockets: FakeWs[] = [];
    class FakeWs {
      handlers: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
      constructor(public url: string) { sockets.push(this); }
      addEventListener(t: string, cb: (ev: { data?: unknown }) => void) { (this.handlers[t] ??= []).push(cb); }
      fire(t: string, ev: { data?: unknown } = {}) { for (const cb of this.handlers[t] ?? []) cb(ev); }
      close() {}
    }
    const timers: (() => void)[] = [];
    const onEvent = vi.fn();
    const sock = createAccessEventSocket({
      url: () => "wss://home.example/api/screens/events?sessionToken=t",
      onEvent,
      WebSocketImpl: FakeWs,
      setTimer: (fn: () => void) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });
    sock.ensure();
    expect(sockets).toHaveLength(1);
    sockets[0]!.fire("open");
    sockets[0]!.fire("message", { data: JSON.stringify({ type: "access-request", serviceId: "x" }) });
    sockets[0]!.fire("message", { data: JSON.stringify({ type: "other" }) });
    sockets[0]!.fire("message", { data: "not json" });
    expect(onEvent).toHaveBeenCalledTimes(1);
    // Drop → reconnect; three refused upgrades in a row → stop asking.
    sockets[0]!.fire("close");
    for (let i = 0; i < 3; i++) {
      timers.shift()!();
      sockets[sockets.length - 1]!.fire("close");
    }
    expect(sock.failures).toBe(3);
    expect(timers).toHaveLength(0);
    sock.ensure();
    expect(sockets).toHaveLength(4);
  });
});

describe("the app-access push", () => {
  function sandbox(clients: { url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void }[] = []) {
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    const shown: { title: string; opts: { body: string; data: { kind: string } } }[] = [];
    const opened: string[] = [];
    const self = {
      location: { origin: "https://webapp.flagshipserver.com" },
      addEventListener: (t: string, cb: (ev: unknown) => void) => { (listeners.get(t) ?? listeners.set(t, []).get(t)!).push(cb); },
      registration: { showNotification: async (title: string, opts: never) => { shown.push({ title, opts }); } },
      clients: { matchAll: async () => clients, openWindow: async (u: string) => { opened.push(u); } },
    };
    const src = readFileSync(resolve(__dirname, "../public/webapp/service-worker.js"), "utf8");
    vm.runInNewContext(src, { self, caches: {}, fetch: async () => ({}), URL, Response: class {}, Headers: class {}, console, Date });
    const fire = async (t: string, ev: object) => {
      const waits: Promise<unknown>[] = [];
      for (const cb of listeners.get(t) ?? []) cb({ ...ev, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { fire, shown, opened };
  }

  it("shows the generic text, naming no app or host", async () => {
    const h = sandbox();
    await h.fire("push", { data: { json: () => ({ category: "app-access" }) } });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.opts.body).toBe("One of your apps wants to reach the internet");
    expect(h.shown[0]!.opts.data.kind).toBe("app-access");
  });

  it("a click focuses the open webapp and asks it to show the sheet, or opens it", async () => {
    const posted: unknown[] = [];
    const tab = { url: "https://webapp.flagshipserver.com/", focus: async () => {}, postMessage: (m: unknown) => posted.push(m) };
    const h = sandbox([tab]);
    await h.fire("notificationclick", { notification: { close: () => {}, data: { kind: "app-access" } } });
    expect(posted).toEqual([{ type: "ACCESS_REQUESTS" }]);
    const none = sandbox([]);
    await none.fire("notificationclick", { notification: { close: () => {}, data: { kind: "app-access" } } });
    expect(none.opened).toEqual(["/"]);
  });
});

describe("the pages wire it", () => {
  it("the service page shows Internet access, and the v1 card only for an older box", async () => {
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain("renderInternetSection(s)");
    expect(detail).toContain("if (readAccessSummary(s)) void loadAccessSection(s);");
    expect(detail).toContain('data-access-act="allow"');
    expect(detail).toContain('data-access-act="deny"');
    expect(detail).toContain('data-access-act="ignore"');
    expect(detail).toContain("dismissAccessRequest");
    expect(detail).toContain("sd-access-view");
    expect(detail).toContain("sensitiveSigner()");
  });

  it("the access-list view, its section and the alerts are in the shell", async () => {
    const view = await asset("/webapp/views/app-access.js");
    expect(view).toContain('registerView("view-app-access")');
    expect(view).toContain('textarea.addEventListener("input", update)');
    expect(view).toContain("sendAccessList");
    const html = await asset("/webapp/index.html");
    expect(html).toContain('<section id="view-app-access" class="hidden">');
    const app = await asset("/webapp/app.js");
    expect(app).toContain("initAppAccessView()");
    expect(app).toContain("startAccessAlerts({ isUnlocked: sliversUnlocked })");
    const sw = await asset("/webapp/service-worker.js");
    for (const p of ['"/lib/appAccess.js"', '"/lib/accessAlerts.js"', '"/views/app-access.js"']) expect(sw).toContain(p);
  });
});
