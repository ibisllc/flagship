// Where an app runs (docs/app-placement.md) on the webapp: the app-copy grant
// against the shared vectors, the leader becoming the current server, the
// creation picker (default + pinned) and its box-bound client, Runs on read
// from every server's apps list (unreachable = unknown), tick = signed copy to
// the target, untick = signed uninstall, the last-copy guard, the server
// page's "Copying…" rows, and an older box that 404s the copy endpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { deriveIRK } from "@flagship/protocol";
import { buildServer } from "../src/server.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/app-copy/vectors.json"), "utf8"),
);

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadPlacement = () => load("lib/appPlacement.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const err = (status: number, body: Record<string, unknown> = {}) => new ScreensError(String(body.error ?? `HTTP ${status}`), status, body);

const HOME = "home.alice.flagship.services";
const OFFICE = "office.alice.flagship.services";
const GARAGE = "garage.alice.flagship.services";
const ATTIC = "attic.alice.flagship.services";
const NOW = 1_760_000_000_000;
const stkOf = (serverDomain: string) => serverDomain.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
const pod = (serverDomain: string, extra: Record<string, unknown> = {}) => ({
  serverDomain,
  identityPubKey: stkOf(serverDomain),
  registeredAt: 1,
  lastReported: NOW,
  liveness: "live",
  ...extra,
});

let storage: MemStorage;
beforeEach(async () => {
  storage = new MemStorage();
  vi.stubGlobal("localStorage", storage);
  const ps = await load("lib/profilesStore.js");
  ps.ensureProfile("alice", storage);
  ps.setActiveCloudName("alice", storage);
  (await load("lib/serverOrder.js"))._resetServerOrdersForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app copy — the shared vectors", () => {
  it("builds the canonical bytes and signs with the IRK of the UMK seed", async () => {
    const { canonicalAppCopyBytes, signAppCopy, TAG_APP_COPY } = await loadPlacement();
    const { signWithIrk } = await load("keystore.js");
    expect(TAG_APP_COPY).toBe("flagship/app-copy/v1");
    const seed = fromHex(VECTORS.umkSeedHex);
    expect(hex(deriveIRK({ seed }).publicKey)).toBe(VECTORS.pub);
    for (const c of VECTORS.cases) {
      const grant = { sourceServer: c.sourceServer, targetServer: c.targetServer, serviceId: c.serviceId, issuedAt: c.issuedAt };
      expect(utf8(canonicalAppCopyBytes(grant))).toBe(c.canonical);
      const body = await signAppCopy({ ...grant, umk: seed, signWithIrk });
      expect(body).toEqual({ grant, signature: c.signature });
      expect(ed25519.verify(fromHex(body.signature), canonicalAppCopyBytes(grant), fromHex(VECTORS.pub))).toBe(true);
    }
  });

  it("refuses a field that would break the canonical form", async () => {
    const { canonicalAppCopyBytes } = await loadPlacement();
    const g = { sourceServer: HOME, targetServer: OFFICE, serviceId: "alice--notes", issuedAt: 1 };
    expect(() => canonicalAppCopyBytes({ ...g, serviceId: "a|b" })).toThrow(/serviceId/);
    expect(() => canonicalAppCopyBytes({ ...g, targetServer: "" })).toThrow(/targetServer/);
    expect(() => canonicalAppCopyBytes({ ...g, issuedAt: 1.5 })).toThrow(/issuedAt/);
  });

  it("signs with the sensitive-order key (admin root when held)", async () => {
    const { SENSITIVE_TAGS, canonicalTag, makeSensitiveSigner } = await load("lib/adminRoot.js");
    const { canonicalAppCopyBytes } = await loadPlacement();
    expect(SENSITIVE_TAGS.has("flagship/app-copy/v1")).toBe(true);
    const bytes = canonicalAppCopyBytes({ sourceServer: HOME, targetServer: OFFICE, serviceId: "alice--notes", issuedAt: 1 });
    expect(canonicalTag(bytes)).toBe("flagship/app-copy/v1");
    const admin = vi.fn(async () => new Uint8Array(64).fill(1));
    const legacy = vi.fn(async () => new Uint8Array(64));
    await makeSensitiveSigner(new Uint8Array(32), legacy, { signWithAdminRoot: admin })(new Uint8Array(32), bytes);
    expect(admin).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("§1 the leader is the current server", () => {
  it("making a server leader puts it first in the order and makes it current when this device has a session for it", async () => {
    const api = await load("lib/api.js");
    const { saveServerOrder, currentServerOrder } = await load("lib/serverOrder.js");
    const { preferLeaderAsCurrent } = await loadPlacement();
    const { getSession } = await load("lib/state.js");
    Object.assign(getSession(), { username: "alice", umk: new Uint8Array(32).fill(7) });
    api.setPodBaseUrl(`https://${HOME}`);
    api.setSessionToken("tok-home");
    api.setSessionTokenForPod(HOME, "tok-home");
    api.setSessionTokenForPod(OFFICE, "tok-office");
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));

    await saveServerOrder({ stks: [stkOf(OFFICE), stkOf(HOME)] }, { fetch, comBase: "https://com", demo: false });
    expect(currentServerOrder()).toEqual([stkOf(OFFICE), stkOf(HOME)]);
    expect(preferLeaderAsCurrent([pod(HOME), pod(OFFICE, { registeredAt: 2 })], { now: () => NOW })).toBe(true);
    expect(api.getPodBaseUrl()).toBe(`https://${OFFICE}`);
    expect(api.getSessionToken()).toBe("tok-office");
    expect(api.currentPodFqdn()).toBe(OFFICE);
  });

  it("without a session for the leader the current server stays put", async () => {
    const api = await load("lib/api.js");
    const { preferLeaderAsCurrent } = await loadPlacement();
    api.setPodBaseUrl(`https://${HOME}`);
    api.setSessionToken("tok-home");
    expect(preferLeaderAsCurrent([pod(HOME), pod(GARAGE)], { order: [stkOf(GARAGE)], now: () => NOW })).toBe(false);
    expect(api.currentPodFqdn()).toBe(HOME);
  });

  it("at load the leader becomes current only when it's online and paired here", async () => {
    const { preferLeaderAsCurrent } = await loadPlacement();
    const pods = [pod(HOME, { registeredAt: 1 }), pod(OFFICE, { registeredAt: 2 })];
    const make = vi.fn(() => true);
    const order = [stkOf(OFFICE)];
    expect(preferLeaderAsCurrent(pods, { order, hasSession: () => true, makeCurrentPod: make, now: () => NOW })).toBe(true);
    expect(make).toHaveBeenCalledWith(OFFICE);
    make.mockClear();
    // The first in the order is down: the role passes to the next one up.
    const offline = [pod(HOME), pod(OFFICE, { liveness: "unreachable" })];
    expect(preferLeaderAsCurrent(offline, { order, hasSession: () => true, makeCurrentPod: make, now: () => NOW })).toBe(true);
    expect(make).toHaveBeenCalledWith(HOME);
    make.mockClear();
    expect(preferLeaderAsCurrent(pods, { order, hasSession: () => false, makeCurrentPod: make })).toBe(false);
    expect(make).not.toHaveBeenCalled();
    // No order: the oldest server that's online.
    expect(preferLeaderAsCurrent(pods, { order: [], hasSession: () => true, makeCurrentPod: make, now: () => NOW })).toBe(true);
    expect(make).toHaveBeenCalledWith(HOME);
  });
});

describe("§2 choosing where a new app runs", () => {
  const pods = [pod(HOME, { registeredAt: 1 }), pod(OFFICE, { registeredAt: 2 }), pod(ATTIC, { registeredAt: 3, liveness: "unreachable" })];
  const session = (f: string) => f !== GARAGE;

  it("defaults to the leader, not the current server", async () => {
    const p = await loadPlacement();
    const servers = p.creationServers(pods, { hasSession: session, order: [stkOf(OFFICE)], current: HOME, now: () => NOW });
    expect(servers.map((s: { fqdn: string }) => s.fqdn)).toEqual([ATTIC, HOME, OFFICE]);
    expect(p.defaultCreationServer(servers, HOME)).toBe(OFFICE);
    p.startCreation();
    expect(p.resolveCreationServer(servers, HOME)).toBe(OFFICE);
    const model = p.creationPickerModel(servers);
    expect(model.choosable).toBe(true);
    expect(model.options.find((o: { fqdn: string }) => o.fqdn === ATTIC)).toMatchObject({ disabled: true, note: "offline" });
    const html = p.creationPickerHtml(model);
    expect(html).toContain("data-runs-on-select");
    expect(html).toMatch(new RegExp(`value="${OFFICE}" selected`));
    p.chooseCreationServer(HOME);
    expect(p.creationTarget()).toEqual({ fqdn: HOME, pinned: false });
  });

  it("falls back to the current server when the leader can't be built on", async () => {
    const p = await loadPlacement();
    const down = [pod(HOME), pod(OFFICE, { liveness: "unreachable" })];
    const servers = p.creationServers(down, { hasSession: () => true, order: [stkOf(OFFICE)], current: HOME, now: () => NOW });
    expect(p.defaultCreationServer(servers, HOME)).toBe(HOME);
  });

  it("started from a server's page the server is fixed and not asked", async () => {
    const p = await loadPlacement();
    p.startCreation({ server: GARAGE.toUpperCase(), pinned: true });
    const servers = p.creationServers(pods, { hasSession: () => true, order: [stkOf(OFFICE)], current: HOME, now: () => NOW });
    expect(p.resolveCreationServer(servers, HOME)).toBe(GARAGE);
    p.chooseCreationServer(OFFICE);
    expect(p.creationTarget()).toEqual({ fqdn: GARAGE, pinned: true });
    const model = p.creationPickerModel(servers);
    expect(model.choosable).toBe(false);
    const html = p.creationPickerHtml(model);
    expect(html).not.toContain("<select");
    expect(html).toContain("Runs on: <strong>garage</strong>");
  });

  it("the creation request goes to the chosen box with that box's own session", async () => {
    const api = await load("lib/api.js");
    api.setPodBaseUrl(`https://${HOME}`);
    api.setSessionToken("tok-home");
    api.setSessionTokenForPod(OFFICE, "tok-office");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sessionId: "s1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const r = await api.boxClient(OFFICE).fetch("/api/screens/vibe-code/start", { method: "POST", body: "{}" });
    expect(r).toEqual({ sessionId: "s1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`https://${OFFICE}/api/screens/vibe-code/start`);
    expect(init.headers["x-flagship-session"]).toBe("tok-office");
    // The current server is untouched.
    expect(api.currentPodFqdn()).toBe(HOME);
    // A box with no session here refuses before any request.
    await expect(api.boxClient(GARAGE).fetch("/api/screens/apps-list")).rejects.toMatchObject({ status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("every creation flow sends through the box it picked", async () => {
    const vibe = await asset("/webapp/views/vibe-code.js");
    expect(vibe).toContain('boxFetch("/api/screens/vibe-code/start"');
    expect(vibe).toContain('mountCreationPicker($("vc-runs-on")');
    expect(vibe).not.toContain("getPodBaseUrl");
    const git = await asset("/webapp/views/build-git.js");
    expect(git).toContain('boxFetch("/api/build/git"');
    expect(git).toContain('mountCreationPicker($("build-git-runs-on")');
    expect(git).not.toContain("getPodBaseUrl");
    const mcp = await asset("/webapp/views/build-mcp.js");
    expect(mcp).toContain('boxFetch("/api/build/mcp"');
    expect(mcp).toContain("mountCreationPicker(picker");
    const source = await asset("/webapp/views/build-source.js");
    expect(source).toContain("startCreation({ server, pinned: !!server })");
    const html = await asset("/webapp/");
    for (const id of ["vc-runs-on", "build-git-runs-on", "build-mcp-runs-on"]) expect(html).toContain(`id="${id}"`);
  });
});

type Init = { method?: string; body?: string };
function fakeBoxes(boxes: Record<string, (path: string, init: Init) => unknown>) {
  const calls: { fqdn: string; path: string; init: Init }[] = [];
  const clientFor = (fqdn: string) => ({
    fetch: async (path: string, init: Init = {}) => {
      calls.push({ fqdn, path, init });
      const h = boxes[fqdn];
      if (!h) throw err(0);
      return h(path, init);
    },
  });
  return { calls, clientFor };
}
const appsList = (...apps: Record<string, unknown>[]) => () => ({ apps });
const NOTES = { serviceId: "alice--notes", creator: "alice", slug: "notes" };

describe("§4 Runs on, from every server's own apps list", () => {
  it("ticks exactly the servers that have the app; an unreachable one is unknown", async () => {
    const p = await loadPlacement();
    const { clientFor } = fakeBoxes({
      [HOME]: appsList(NOTES),
      [OFFICE]: appsList({ serviceId: "alice--other" }),
      [GARAGE]: () => {
        throw err(502);
      },
      ["cellar.alice.flagship.services"]: appsList({ ...NOTES, copying: { state: "installing", progress: 0.4 } }),
    });
    const pods = [pod(HOME), pod(OFFICE), pod(GARAGE), pod(ATTIC), pod("cellar.alice.flagship.services"), pod("gone.alice.flagship.services", { revokedAt: 5 })];
    const rows = await p.fetchRunsOn({ serviceId: NOTES.serviceId, pods, current: HOME, clientFor, hasSession: (f: string) => f !== ATTIC });
    const by = Object.fromEntries(rows.map((r: { fqdn: string; state: string }) => [r.fqdn, r.state]));
    expect(by).toEqual({
      [HOME]: "has",
      [OFFICE]: "missing",
      [GARAGE]: "unknown",
      [ATTIC]: "unknown",
      ["cellar.alice.flagship.services"]: "copying",
    });
    const model = p.runsOnModel(rows);
    const m = Object.fromEntries(model.map((r: { fqdn: string }) => [r.fqdn, r]));
    expect(m[GARAGE]).toMatchObject({ checked: false, disabled: true, note: p.RUNS_ON_UNKNOWN });
    expect(m[ATTIC]).toMatchObject({ checked: false, disabled: true });
    expect(m[OFFICE]).toMatchObject({ checked: false, disabled: false });
    expect(m["cellar.alice.flagship.services"]).toMatchObject({ checked: true, disabled: true, note: "Copying… 40%" });
    const html = p.runsOnHtml(model);
    expect(html).toContain('<span class="pill">unknown</span>');
    expect(p.runsOnModel(rows, { companion: true }).every((r: { disabled: boolean }) => r.disabled)).toBe(true);
  });

  it("tick signs the copy and posts it to the target box", async () => {
    const p = await loadPlacement();
    const { signWithIrk } = await load("keystore.js");
    const seed = fromHex(VECTORS.umkSeedHex);
    const { calls, clientFor } = fakeBoxes({ [OFFICE]: () => ({ copyId: "c1" }) });
    const rows = [
      { fqdn: HOME, name: "home", state: "has", copying: null },
      { fqdn: OFFICE, name: "office", state: "missing", copying: null },
    ];
    const out = await p.changeRunsOn({ rows, fqdn: OFFICE, checked: true, app: NOTES, current: HOME, umk: seed, signWithIrk, clientFor, now: () => NOW });
    expect(out.error).toBeUndefined();
    expect(out.message).toBe(p.COPY_STARTED);
    expect(out.rows.find((r: { fqdn: string }) => r.fqdn === OFFICE).state).toBe("copying");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fqdn: OFFICE, path: "/api/screens/services/copy", init: { method: "POST" } });
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.grant).toEqual({ sourceServer: HOME, targetServer: OFFICE, serviceId: NOTES.serviceId, issuedAt: NOW });
    expect(ed25519.verify(fromHex(body.signature), p.canonicalAppCopyBytes(body.grant), fromHex(VECTORS.pub))).toBe(true);
  });

  it("untick sends the signed uninstall to that server", async () => {
    const p = await loadPlacement();
    const { signWithIrk } = await load("keystore.js");
    const seed = fromHex(VECTORS.umkSeedHex);
    const { calls, clientFor } = fakeBoxes({ [OFFICE]: () => ({ ok: true }) });
    const rows = [
      { fqdn: HOME, name: "home", state: "has", copying: null },
      { fqdn: OFFICE, name: "office", state: "has", copying: null },
    ];
    const confirmRemove = vi.fn(async () => true);
    const out = await p.changeRunsOn({ rows, fqdn: OFFICE, checked: false, app: NOTES, umk: seed, signWithIrk, clientFor, confirmRemove, now: () => NOW });
    expect(confirmRemove).toHaveBeenCalledTimes(1);
    expect(out.error).toBeUndefined();
    expect(out.rows.find((r: { fqdn: string }) => r.fqdn === OFFICE).state).toBe("missing");
    expect(calls[0]).toMatchObject({ fqdn: OFFICE, path: "/api/services/alice--notes", init: { method: "DELETE" } });
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.request).toEqual({ serverId: OFFICE, creator: "alice", slug: "notes", issuedAt: NOW });
    const canonical = `flagship/uninstall-service/v1|${OFFICE}|alice|notes|${NOW}`;
    expect(utf8(p.canonicalUninstallServiceBytes(body.request))).toBe(canonical);
    expect(ed25519.verify(fromHex(body.signature), new TextEncoder().encode(canonical), fromHex(VECTORS.pub))).toBe(true);
  });

  it("a cancelled confirm sends nothing", async () => {
    const p = await loadPlacement();
    const { calls, clientFor } = fakeBoxes({ [OFFICE]: () => ({ ok: true }) });
    const rows = [
      { fqdn: HOME, name: "home", state: "has", copying: null },
      { fqdn: OFFICE, name: "office", state: "has", copying: null },
    ];
    const out = await p.changeRunsOn({ rows, fqdn: OFFICE, checked: false, app: NOTES, umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64), clientFor, confirmRemove: async () => false });
    expect(out.rows).toBe(rows);
    expect(calls).toHaveLength(0);
  });

  it("the last copy can't be unticked", async () => {
    const p = await loadPlacement();
    const { calls, clientFor } = fakeBoxes({ [HOME]: () => ({ ok: true }) });
    const rows = [
      { fqdn: HOME, name: "home", state: "has", copying: null },
      { fqdn: OFFICE, name: "office", state: "missing", copying: null },
      { fqdn: GARAGE, name: "garage", state: "unknown", copying: null },
    ];
    expect(p.runsOnModel(rows).find((r: { fqdn: string }) => r.fqdn === HOME)).toMatchObject({ checked: true, disabled: true, note: p.RUNS_ON_LAST_COPY });
    const out = await p.changeRunsOn({ rows, fqdn: HOME, checked: false, app: NOTES, umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64), clientFor });
    expect(out.error).toBe(p.RUNS_ON_LAST_COPY);
    expect(calls).toHaveLength(0);
  });

  it("an older box that 404s the copy says it needs an update; 409 and 403 read plainly", async () => {
    const p = await loadPlacement();
    const rows = [
      { fqdn: HOME, name: "home", state: "has", copying: null },
      { fqdn: OFFICE, name: "office", state: "missing", copying: null },
    ];
    const run = (e: unknown) =>
      p.changeRunsOn({
        rows,
        fqdn: OFFICE,
        checked: true,
        app: NOTES,
        current: HOME,
        umk: new Uint8Array(32),
        signWithIrk: async () => new Uint8Array(64),
        clientFor: fakeBoxes({
          [OFFICE]: () => {
            throw e;
          },
        }).clientFor,
      });
    const old = await run(err(404));
    expect(old.error).toBe("This server needs an update to receive copies.");
    expect(old.rows).toBe(rows);
    expect((await run(err(409, { error: "already copying" }))).error).toBe(p.COPY_ALREADY);
    expect((await run(err(403, { error: "stale grant" }))).error).toBe(`${p.COPY_REFUSED} stale grant`);
    expect((await run(err(403))).error).toContain(p.COPY_REFUSED);
  });

  it("with no server that has it reachable there is nothing to copy from", async () => {
    const p = await loadPlacement();
    const rows = [
      { fqdn: HOME, name: "home", state: "unknown", copying: null },
      { fqdn: OFFICE, name: "office", state: "missing", copying: null },
    ];
    const { calls, clientFor } = fakeBoxes({});
    const out = await p.changeRunsOn({ rows, fqdn: OFFICE, checked: true, app: NOTES, umk: new Uint8Array(32), signWithIrk: async () => new Uint8Array(64), clientFor });
    expect(out.error).toBe(p.NO_COPY_SOURCE);
    expect(calls).toHaveLength(0);
  });

  it("the app page loads Runs on, signs with sensitiveSigner and sends no service-policy order", async () => {
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain('<div id="sd-runs-on">');
    expect(detail).toContain("void loadRunsOn(s);");
    expect(detail).toContain("changeRunsOn({");
    expect(detail).toContain("signWithIrk: sensitiveSigner(),");
    for (const f of ["views/service-detail.js", "views/edit-service.js", "lib/editService.js", "lib/appPlacement.js"]) {
      expect(await asset(`/webapp/${f}`)).not.toContain("service-policy");
    }
  });
});

describe("§3 a server's apps", () => {
  it("each app row shows that server's state; unknown shows none; a copy arriving stays greyed", async () => {
    const p = await loadPlacement();
    const rows = p.serverAppRows([
      { serviceId: "alice--notes", slug: "notes", status: "running" },
      { serviceId: "alice--blog", slug: "blog", status: "stopped" },
      { serviceId: "alice--wiki", slug: "wiki", status: "running", activity: { kind: "deploying" } },
      { serviceId: "alice--todo", slug: "todo", status: "unknown", activity: { kind: "editing" } },
      { serviceId: "alice--old", slug: "old", status: "unknown" },
      { serviceId: "alice--photos", slug: "photos", status: "stopped", copying: { state: "copying", progress: 0.5 } },
    ]);
    expect(rows.map((r: { state: string }) => r.state)).toEqual(["running", "stopped", "deploying", "editing", "unknown", "copying"]);
    const html = p.serverAppsHtml(rows);
    const row = (id: string) => {
      const at = html.indexOf(`data-open-app="${id}"`);
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf("</button>", at));
    };
    expect(row("alice--notes")).toContain(">Running</span>");
    expect(row("alice--blog")).toContain(">Stopped</span>");
    expect(row("alice--wiki")).toContain(">Deploying</span>");
    expect(row("alice--todo")).toContain(">Editing</span>");
    expect(row("alice--old")).not.toContain("data-app-state");
    expect(html).not.toContain(">unknown<");
    expect(html).toContain('data-copying-app="alice--photos"');
    expect(html).toContain("Copying… 50%");
    expect(html).not.toContain('data-app-state="copying"');
  });

  it("lists the apps, and a copy under way greyed with its progress", async () => {
    const p = await loadPlacement();
    const rows = p.serverAppRows(
      [
        { serviceId: "alice--notes", slug: "notes", url: `https://notes.${HOME}`, status: "running" },
        { serviceId: "alice--photos", slug: "photos", url: `https://photos.${HOME}`, status: "stopped", copying: { state: "copying", progress: 40 } },
      ],
      [
        { copyId: "c2", serviceId: "alice--blog", appName: "blog", state: "copying", progress: 0.1 },
        { copyId: "c3", serviceId: "alice--old", appName: "old", state: "failed", reason: "x" },
        { copyId: "c4", serviceId: "alice--done", appName: "done", state: "done" },
      ],
    );
    expect(rows.map((r: { serviceId: string }) => r.serviceId)).toEqual(["alice--notes", "alice--photos", "alice--blog"]);
    expect(p.anyCopying(rows)).toBe(true);
    const html = p.serverAppsHtml(rows);
    expect(html).toContain('data-open-app="alice--notes"');
    expect(html).not.toContain('data-open-app="alice--photos"');
    expect(html).toContain('data-copying-app="alice--photos"');
    expect(html).toContain("Copying… 40%");
    expect(html).toContain("Copying… 10%");
    expect(html).toContain('id="server-create-app"');
    expect(p.serverAppsHtml([], { canCreate: false })).not.toContain("server-create-app");
    expect(p.serverAppsHtml([])).toContain(p.SERVER_NO_APPS);
  });

  it("an older box without the copies list still lists its apps", async () => {
    const p = await loadPlacement();
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/screens/services/copies") throw err(404);
      return { apps: [{ serviceId: "alice--notes", slug: "notes" }] };
    });
    const rows = await p.fetchServerApps(fetchJson);
    expect(rows).toHaveLength(1);
    expect(await p.fetchCopies(fetchJson)).toEqual([]);
  });

  it("re-reads while a copy is under way and the page is visible, then stops", async () => {
    const p = await loadPlacement();
    const timers: (() => void)[] = [];
    const setTimer = (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    };
    const doc = { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const copying = [{ serviceId: "a", copying: { state: "copying", progress: 0.5 } }];
    const done = [{ serviceId: "a", copying: null }];
    const load = vi.fn().mockResolvedValueOnce(copying).mockResolvedValueOnce(done);
    const onRows = vi.fn();
    p.watchWhileCopying({ load, onRows, active: () => true, doc, setTimer, clearTimer: () => {} });
    const flush = async () => {
      const fn = timers.shift()!;
      fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    await flush();
    expect(onRows).toHaveBeenLastCalledWith(copying);
    expect(timers).toHaveLength(1);
    await flush();
    expect(onRows).toHaveBeenLastCalledWith(done);
    expect(timers).toHaveLength(0);
    // Hidden: waits for visibility instead of reading.
    doc.visibilityState = "hidden";
    const load2 = vi.fn();
    p.watchWhileCopying({ load: load2, onRows, active: () => true, doc, setTimer, clearTimer: () => {} });
    await flush();
    expect(load2).not.toHaveBeenCalled();
    expect(doc.addEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("the server page lists its apps with Create app here, and the shell precaches the lib", async () => {
    const page = await asset("/webapp/views/server-detail.js");
    expect(page).toContain('<div id="server-apps">');
    expect(page).toContain("wireServerApps(body.serverFqdn);");
    expect(page).toContain("enterBuildSource({ server: fqdn })");
    expect(page).toContain('enterServiceDetail(btn.getAttribute("data-open-app"), { server: fqdn, from: "server" })');
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/lib/appPlacement.js"');
    expect(sw).toContain('SHELL_VERSION = "v99"');
  });
});

describe("viewing a server reads that server's own box", () => {
  it("every read and order on the server page goes to the server it shows; the current server stays", async () => {
    const page = await asset("/webapp/views/server-detail.js");
    expect(page).toContain('body = await fetchOn(knownFqdn)("/api/screens/server-detail");');
    expect(page).toContain("fetchOn(serverFqdn)(");
    expect(page).toContain("fetchBox: fetchOn(card.fqdn)");
    expect(page).toContain("fetchBox: fetchOn(body.serverFqdn)");
    expect(page).not.toMatch(/\bscreensFetch\b/);
    expect(page).not.toContain("makeCurrentPod");
    expect(page).not.toContain("setPodBaseUrl");
    // getPodBaseUrl only names the server when the page is opened without one.
    expect(page.match(/getPodBaseUrl\(\)/g)).toHaveLength(1);
  });
});

describe("build sessions from every server", () => {
  it("lists the servers this device has a session for", async () => {
    const { sessionServers } = await loadPlacement();
    const clientFor = (fqdn: string) => ({
      baseUrl: `https://${fqdn}`,
      token: () => (fqdn === GARAGE ? "" : `tok-${fqdn}`),
      fetch: async () => ({}),
    });
    const servers = sessionServers([pod(HOME), pod(GARAGE), pod("x.alice.flagship.services", { revokedAt: 1 })], { current: OFFICE, clientFor });
    expect(servers.map((s: { fqdn: string }) => s.fqdn)).toEqual([HOME, OFFICE]);
    expect(servers[1]).toMatchObject({ baseUrl: `https://${OFFICE}`, token: `tok-${OFFICE}` });
  });

  it("merges each server's sessions and builds, tagged with the server, and leaves out one that fails", async () => {
    const { fetchBuildsOnServers, openBuilds, endedBuilds, sessionTitle } = await load("lib/vibeSessions.js");
    const fetchImpl = vi.fn(async (url: string) => {
      const sessions = url.startsWith(`https://${OFFICE}`) ? [{ sessionId: "s1", status: "streaming", startedAt: 2 }] : [];
      return { ok: true, json: async () => ({ sessions }) };
    });
    const srv = (fqdn: string, builds: unknown) => ({
      fqdn,
      baseUrl: `https://${fqdn}`,
      token: "t",
      fetchJson: async () => {
        if (builds instanceof Error) throw builds;
        return { builds };
      },
    });
    const all = await fetchBuildsOnServers(
      [
        srv(HOME, [{ buildId: "s1", open: false, name: "notes" }, { buildId: "g1", open: true }]),
        srv(OFFICE, [{ buildId: "s1", name: "blog" }]),
        srv(GARAGE, err(404)),
      ],
      { fetchImpl },
    );
    expect(all.sessions).toEqual([expect.objectContaining({ sessionId: "s1", server: OFFICE })]);
    expect(all.builds.map((b: { buildId: string; server: string }) => `${b.server}:${b.buildId}`)).toEqual([`${HOME}:s1`, `${HOME}:g1`, `${OFFICE}:s1`]);
    expect(all.failed.map((f: { fqdn: string }) => f.fqdn)).toEqual([GARAGE]);
    // Ids are per box: office's live s1 doesn't hide home's ended s1.
    expect(endedBuilds(all.builds, all.sessions).map((b: { server: string }) => b.server)).toEqual([HOME]);
    expect(openBuilds(all.builds, all.sessions).map((b: { buildId: string }) => b.buildId)).toEqual(["g1"]);
    expect(sessionTitle(all.sessions[0], all.builds)).toBe("blog");
  });

  it("the build list, its rows and the chooser's count ask every server", async () => {
    const journal = await asset("/webapp/views/build-journal.js");
    expect(journal).toContain("fetchBuildsOnServers(servers)");
    expect(journal).toContain('openVibeCodeSession(el.getAttribute("data-session"), { server: el.getAttribute("data-server") || "" })');
    expect(journal).toContain("clientOf(server).fetch(");
    expect(journal).not.toContain("getPodBaseUrl");
    const source = await asset("/webapp/views/build-source.js");
    expect(source).toContain("sessionServers(await loadAccountPods(");
    expect(await asset("/webapp/views/build-git.js")).toContain("enterBuildJournal(buildId, { server: client().fqdn })");
  });
});

describe("§6 an app's status pill", () => {
  const label = async (states: string[]) => (await loadPlacement()).combineAppStatus(states).label;

  it("one server's state: activity first, then the container's status; unknown shows nothing", async () => {
    const p = await loadPlacement();
    expect(p.appServerState({ status: "running" })).toBe("running");
    expect(p.appServerState({ status: "starting" })).toBe("starting");
    expect(p.appServerState({ status: "stopped" })).toBe("stopped");
    expect(p.appServerState({ status: "unknown" })).toBe("unknown");
    expect(p.appServerState({})).toBe("unknown");
    expect(p.appServerState({ status: "weird" })).toBe("unknown");
    expect(p.appServerState({ status: "running", activity: { kind: "deploying" } })).toBe("deploying");
    expect(p.appServerState({ status: "running", activity: { kind: "editing" } })).toBe("editing");
    expect(p.appServerState({ status: "stopped", activity: { kind: "copying" } })).toBe("copying");
    expect(p.appServerState({ status: "unknown", copying: { state: "installing", progress: 0.2 } })).toBe("copying");
    expect(p.appServerState({ status: "running", activity: { kind: "nope" } })).toBe("running");
    expect(["running", "starting", "stopped", "deploying", "copying", "editing"].map(p.appStateLabel)).toEqual([
      "Running",
      "Starting",
      "Stopped",
      "Deploying",
      "Copying",
      "Editing",
    ]);
    expect(p.appStateLabel("unknown")).toBe("");
    expect(p.appStatePillHtml("unknown")).toBe("");
    expect(p.appStatePillHtml("running")).toContain(">Running</span>");
  });

  it("deploying or copying anywhere → Deploying, before anything else", async () => {
    expect(await label(["running", "deploying", "editing"])).toBe("Deploying");
    expect(await label(["stopped", "copying"])).toBe("Deploying");
  });

  it("else editing anywhere → Editing", async () => {
    expect(await label(["running", "editing", "stopped"])).toBe("Editing");
  });

  it("else On 1 server / On N servers, counting running and starting", async () => {
    expect(await label(["running"])).toBe("On 1 server");
    expect(await label(["starting"])).toBe("On 1 server");
    expect(await label(["running", "starting", "running"])).toBe("On 3 servers");
    expect(await label(["running", "stopped"])).toBe("On 1 server");
  });

  it("else every server that answered says stopped → Stopped; an unreachable one doesn't count", async () => {
    expect(await label(["stopped"])).toBe("Stopped");
    expect(await label(["stopped", "stopped", "unreachable"])).toBe("Stopped");
  });

  it("an older box's unknown is on that server but not running, and never reads as Stopped", async () => {
    expect(await label(["running", "unknown"])).toBe("On 1 server");
    expect(await label(["unknown"])).toBe("On 1 server");
    expect(await label(["unknown", "unknown"])).toBe("On 2 servers");
    expect(await label(["stopped", "unknown"])).toBe("On 1 server");
  });

  it("no server answered → Can't reach", async () => {
    expect(await label([])).toBe("Can't reach");
    expect(await label(["unreachable", "unreachable"])).toBe("Can't reach");
    const p = await loadPlacement();
    expect(p.combineAppStatus(undefined).kind).toBe("unreachable");
  });

  it("the services list has one row per app, opening on the leader's copy, else the first server listing it", async () => {
    const p = await loadPlacement();
    const rows = p.mergeAppsAcrossServers(
      [
        { fqdn: HOME, apps: [{ ...NOTES, status: "stopped", version: "1" }, { serviceId: "alice--blog", status: "unknown" }] },
        { fqdn: OFFICE, apps: [{ ...NOTES, status: "running", version: "2" }] },
        { fqdn: GARAGE, apps: null },
        { fqdn: ATTIC, apps: [{ serviceId: "alice--blog", status: "unknown" }, { serviceId: "alice--wiki", status: "running", copying: { state: "copying" } }] },
        { fqdn: "cellar.alice.flagship.services", apps: [{ serviceId: "alice--wiki", status: "running" }] },
      ],
      OFFICE,
    );
    const by = Object.fromEntries(rows.map((r: { serviceId: string }) => [r.serviceId, r]));
    expect(rows).toHaveLength(3);
    expect(by[NOTES.serviceId]).toMatchObject({ listedBy: OFFICE, version: "2", servers: [HOME, OFFICE], appStatus: { kind: "on", label: "On 1 server" } });
    expect(by["alice--blog"]).toMatchObject({ listedBy: HOME, servers: [HOME, ATTIC], appStatus: { label: "On 2 servers" } });
    // A copy still arriving isn't opened when a settled one exists.
    expect(by["alice--wiki"]).toMatchObject({ listedBy: "cellar.alice.flagship.services", appStatus: { kind: "deploying", label: "Deploying" } });
    expect(p.mergeAppsAcrossServers([{ fqdn: HOME, apps: [NOTES] }])[0]).toMatchObject({ listedBy: HOME, appStatus: { label: "On 1 server" } });
  });

  it("Runs on rows carry each server's state, and the views show the pills", async () => {
    const p = await loadPlacement();
    const { clientFor } = fakeBoxes({
      [HOME]: appsList({ ...NOTES, status: "running" }),
      [OFFICE]: appsList({ ...NOTES, status: "stopped", activity: { kind: "editing" } }),
      [GARAGE]: appsList({ ...NOTES, status: "unknown" }),
      [ATTIC]: appsList({ ...NOTES, status: "stopped", activity: { kind: "copying" } }),
    });
    const pods = [pod(HOME), pod(OFFICE), pod(GARAGE), pod(ATTIC)];
    const rows = await p.fetchRunsOn({ serviceId: NOTES.serviceId, pods, current: HOME, clientFor, hasSession: () => true });
    const by = Object.fromEntries(rows.map((r: { fqdn: string }) => [r.fqdn, r]));
    expect(by[HOME]).toMatchObject({ state: "has", appState: "running" });
    expect(by[OFFICE]).toMatchObject({ state: "has", appState: "editing" });
    expect(by[GARAGE]).toMatchObject({ state: "has", appState: "unknown" });
    expect(by[ATTIC]).toMatchObject({ state: "copying" });
    const html = p.runsOnHtml(p.runsOnModel(rows));
    expect(html).toContain(">Running</span>");
    expect(html).toContain(">Editing</span>");
    expect(html).not.toContain('data-app-state="unknown"');
    const list = await asset("/webapp/views/services-list.js");
    expect(list).toContain("mergeAppsAcrossServers(lists, leaderOf(pods))");
    expect(list).toContain("appStatusPillHtml(s.appStatus ?? combineAppStatus([appServerState(s)]))");
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain("appStatePillHtml(appServerState(s))");
  });
});

describe("the sandbox apps run in (docs/app-runtimes.md §5.1)", () => {
  it("warns on the server page only when apps can't start, or while it's being set up", async () => {
    const { appSandboxNotice } = await loadPlacement();
    expect(appSandboxNotice({ state: "unavailable", reason: "no network" })).toEqual({
      tone: "danger",
      text: "Apps can't start on this server: the sandbox they run in isn't working (no network). The server tries again every 10 minutes.",
    });
    expect(appSandboxNotice({ state: "starting" })?.tone).toBe("muted");
    expect(appSandboxNotice({ state: "ready", version: "runsc" })).toBeNull();
    expect(appSandboxNotice({ state: "off" })).toBeNull();
    // An older server sends nothing.
    expect(appSandboxNotice(undefined)).toBeNull();
  });
});
