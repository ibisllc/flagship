import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildScreensHttp, type ScreensHttpDeps } from "../../src/screens/screensHttp.js";
import { AuthorityHub, GrantIndex, OperationLedger } from "../../src/authority/index.js";
import type { HttpRequest } from "../../src/runtime.js";

const gate = { check: (r: HttpRequest) => (r.headers["x-flagship-session"] === "tok" ? null : { status: 401, headers: {}, body: "{}" }) };
const req = (method: string, path: string, body?: unknown): HttpRequest => ({ method, path, headers: { "x-flagship-session": "tok" }, body: Buffer.from(body ? JSON.stringify(body) : "") });

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "perm-"));
  const idx = new GrantIndex(join(dir, "g.json"));
  await idx.load();
  const base = { kind: "app-api-key" as const, issuer: "dev", subject: "k", accountGeneration: 1, audience: "box", policyRevision: 1, issuedAt: 1 };
  await idx.issue({ ...base, id: "k1", service: "alice--chess", capability: "read" });
  await idx.issue({ ...base, id: "k2", service: "alice--chess", capability: "write" });
  await idx.issue({ ...base, id: "other", service: "alice--other", capability: "read" });
  const ledger = new OperationLedger(join(dir, "o.json"), { grantsLive: () => true, currentRevision: () => 0, verifyApproval: () => false });
  await ledger.load();
  const hub = new AuthorityHub(idx, ledger);
  const handle = buildScreensHttp({
    serverFqdn: "home.alice.flagship.services", username: "alice", daemonVersion: "t", startedAt: 1, now: () => 5_000, gate, authorityHub: hub,
  } as unknown as ScreensHttpDeps);
  return { handle, hub, idx };
}

describe("per-service permissions page", () => {
  it("lists only this app's live grants and the work running under them", async () => {
    const { handle, hub } = await rig();
    hub.registerWork(["k2"], { label: "a download", cancel: () => {} });
    const body = JSON.parse((await handle(req("GET", "/api/screens/services/alice--chess/permissions")))!.body as string);
    expect(body.grants.map((g: { id: string }) => g.id).sort()).toEqual(["k1", "k2"]);
    expect(body.grants.find((g: { id: string }) => g.id === "k2").openWork).toEqual(["a download"]);
    expect(JSON.stringify(body)).not.toContain("dev");
  });

  it("revokes one permission and stops its work; the other app is untouched", async () => {
    const { handle, hub, idx } = await rig();
    let stopped = false;
    hub.registerWork(["k2"], { label: "a download", cancel: () => { stopped = true; } });
    const r = JSON.parse((await handle(req("POST", "/api/screens/services/alice--chess/permissions/revoke", { grantId: "k2" })))!.body as string);
    expect(r).toMatchObject({ ok: true, revoked: 1, stoppedWork: ["a download"] });
    expect(stopped).toBe(true);
    expect(idx.isLive("k2", 5_000)).toBe(false);
    expect(idx.isLive("k1", 5_000)).toBe(true);
    expect(idx.isLive("other", 5_000)).toBe(true);
  });

  it("revokes everything for the app when no grant is named, and refuses another app's grant", async () => {
    const { handle, idx } = await rig();
    const foreign = await handle(req("POST", "/api/screens/services/alice--chess/permissions/revoke", { grantId: "other" }));
    expect(foreign?.status).toBe(404);
    const all = JSON.parse((await handle(req("POST", "/api/screens/services/alice--chess/permissions/revoke", {})))!.body as string);
    expect(all.revoked).toBe(2);
    expect(idx.isLive("other", 5_000)).toBe(true);
  });
});

describe("restored permissions over the screens API", () => {
  it("lists drafts and lets a paired session discard one (it grants nothing)", async () => {
    const { mkdtemp: mk } = await import("node:fs/promises");
    const { RestoredAccessDrafts } = await import("../../src/restoredAccessDrafts.js");
    const dir = await mk(join(tmpdir(), "ra-"));
    const drafts = new RestoredAccessDrafts(join(dir, "r.json"), () => 5_000);
    await drafts.load();
    await drafts.put("alice--chess", { mode: "restricted", allow: ["ab".repeat(32)], groups: {} });
    const handle = buildScreensHttp({
      serverFqdn: "home.alice.flagship.services", username: "alice", daemonVersion: "t", startedAt: 1, now: () => 5_000, gate, restoredAccess: drafts,
    } as unknown as ScreensHttpDeps);
    const list = JSON.parse((await handle(req("GET", "/api/screens/restored-access")))!.body as string);
    expect(list.drafts).toMatchObject([{ serviceRef: "alice--chess", people: 1, mode: "restricted" }]);
    expect(JSON.stringify(list)).not.toContain("abab");
    expect((await handle(req("POST", "/api/screens/restored-access/discard", { serviceRef: "alice--chess" })))?.status).toBe(200);
    expect((await handle(req("POST", "/api/screens/restored-access/discard", { serviceRef: "alice--chess" })))?.status).toBe(404);
  });
});

describe("update mode over the screens API", () => {
  function modeRig() {
    const modes = new Map<string, string>([["alice--chess", "manual"]]);
    const handle = buildScreensHttp({
      serverFqdn: "home.alice.flagship.services", username: "alice", daemonVersion: "t", startedAt: 1, now: () => 5_000, gate,
      updateMode: {
        get: async (id: string) => (modes.get(id) as never) ?? null,
        set: async (id: string, p: string) => (modes.has(id) ? (modes.set(id, p), { ok: true as const }) : { ok: false as const, reason: "no such service" }),
      },
    } as unknown as ScreensHttpDeps);
    return { handle, modes };
  }

  it("reports manual first and changes it to one of the offered modes only", async () => {
    const { handle, modes } = modeRig();
    const got = JSON.parse((await handle(req("GET", "/api/screens/services/alice--chess/update-mode")))!.body as string);
    expect(got).toMatchObject({ mode: "manual", stagedHoldDays: 7 });
    expect(got.modes[0]).toBe("manual");
    expect((await handle(req("POST", "/api/screens/services/alice--chess/update-mode", { mode: "staged" })))?.status).toBe(200);
    expect(modes.get("alice--chess")).toBe("staged");
    expect((await handle(req("POST", "/api/screens/services/alice--chess/update-mode", { mode: "yolo" })))?.status).toBe(400);
    expect((await handle(req("GET", "/api/screens/services/nobody/update-mode")))?.status).toBe(404);
  });
});
