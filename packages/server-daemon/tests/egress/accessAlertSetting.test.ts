import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAccessRequestRecorder } from "../../src/egress/accessAlerts.js";
import { ACCESS_ALERTS_PATH, AccessAlertSetting } from "../../src/egress/accessAlertSetting.js";
import { AppAccessStore } from "../../src/egress/accessStore.js";
import { buildScreensHttp, type ScreensHttpDeps } from "../../src/screens/screensHttp.js";
import type { HttpRequest } from "../../src/runtime.js";

const OWNER = "tok-owner";
const COMPANION = "tok-companion";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "access-alerts-"));
  dirs.push(d);
  return d;
}

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: ACCESS_ALERTS_PATH, headers: { "x-flagship-session": OWNER }, body: Buffer.alloc(0), ...over };
}

function screens(setting: AccessAlertSetting | null) {
  const tokens = new Set([OWNER, COMPANION]);
  const deps: ScreensHttpDeps = {
    gate: {
      check: (r: HttpRequest) =>
        tokens.has(r.headers["x-flagship-session"] ?? "") ? null : { status: 401, headers: {}, body: "{}" },
    } as unknown as ScreensHttpDeps["gate"],
    pairedSessions: {
      isCompanionRequest: (r: HttpRequest) => r.headers["x-flagship-session"] === COMPANION,
    } as unknown as ScreensHttpDeps["pairedSessions"],
    accessAlerts: setting,
    serverFqdn: "home.harry.flagship.services",
    username: "harry",
    daemonVersion: "0.0.0",
    startedAt: 0,
  };
  return buildScreensHttp(deps);
}

const body = (r: { body: string | Buffer } | null) => JSON.parse(String(r!.body));

describe("the access alerts setting", () => {
  it("defaults on, persists durably, and reloads", async () => {
    const path = join(tmp(), "data", "access-alerts.json");
    const s = await AccessAlertSetting.load(path);
    expect(s.enabled()).toBe(true);
    await s.set(false);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ accessAlerts: { enabled: false } });
    expect((await AccessAlertSetting.load(path)).enabled()).toBe(false);
    await s.set(true);
    expect((await AccessAlertSetting.load(path)).enabled()).toBe(true);
  });

  it("an unreadable file means on", async () => {
    const path = join(tmp(), "access-alerts.json");
    writeFileSync(path, "{nope");
    const logs: string[] = [];
    expect((await AccessAlertSetting.load(path, (m) => logs.push(m))).enabled()).toBe(true);
    expect(logs).toHaveLength(1);
  });
});

describe("GET/POST /api/screens/settings/access-alerts", () => {
  it("reads and writes for the owner session", async () => {
    const path = join(tmp(), "access-alerts.json");
    const handle = screens(await AccessAlertSetting.load(path));
    const g = await handle(req({}));
    expect(g?.status).toBe(200);
    expect(body(g)).toEqual({ enabled: true });
    const p = await handle(req({ method: "POST", body: Buffer.from(JSON.stringify({ enabled: false })) }));
    expect(p?.status).toBe(200);
    expect(body(p)).toEqual({ ok: true, enabled: false });
    expect(body(await handle(req({})))).toEqual({ enabled: false });
    expect((await AccessAlertSetting.load(path)).enabled()).toBe(false);
  });

  it("refuses a companion session, a bad body and no session", async () => {
    const setting = await AccessAlertSetting.load(null);
    const handle = screens(setting);
    const c = await handle(req({ method: "POST", headers: { "x-flagship-session": COMPANION }, body: Buffer.from('{"enabled":false}') }));
    expect(c?.status).toBe(403);
    expect(body(c).code).toBe("companion-write-not-allowed");
    expect((await handle(req({ headers: { "x-flagship-session": COMPANION } })))?.status).toBe(403);
    expect(setting.enabled()).toBe(true);
    for (const b of ['{"enabled":"no"}', "{}", "nope", ""]) {
      expect((await handle(req({ method: "POST", body: Buffer.from(b) })))?.status, b).toBe(400);
    }
    expect((await handle(req({ headers: {} })))?.status).toBe(401);
    expect(setting.enabled()).toBe(true);
  });

  it("is absent on a box without the setting, so older-box clients see 404", async () => {
    const r = await screens(null)(req({}));
    expect(r === null || r.status === 404).toBe(true);
  });
});

describe("the recorder honours the switch", () => {
  it("off: requests and socket events still happen, no push and no rate budget spent", async () => {
    const setting = await AccessAlertSetting.load(null);
    await setting.set(false);
    const store = new AppAccessStore(null, null);
    let pushes = 0;
    const events: string[] = [];
    const rec = buildAccessRequestRecorder({
      store,
      appName: () => "weather",
      sinks: () => ({ push: () => void pushes++, emit: (e) => events.push(e.serviceId), alertsEnabled: () => setting.enabled() }),
    });
    rec.onUnmatched("harry-weather", "api.github.com");
    await new Promise((r) => setImmediate(r));
    expect(pushes).toBe(0);
    expect(events).toEqual(["harry-weather"]);
    expect(store.pending("harry-weather")).toHaveLength(1);

    await setting.set(true);
    rec.onUnmatched("harry-weather", "api.github.com");
    await new Promise((r) => setImmediate(r));
    expect(pushes).toBe(1);
  });
});
