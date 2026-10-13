/**
 * A vibe-coded service's name is its web address, so the box keeps it unique:
 * no installed service and no open build session may share it. The describe
 * form asks as the owner types, start refuses a taken name, deploy uses the
 * session's name (not whatever the AI wrote) and checks before touching any
 * files, and an invite-only build ends up behind the box's gate with the
 * owner still let through.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServiceName } from "../../src/llm/serviceName.js";
import { VibeCodeSession, VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { buildDeploySession } from "../../src/llm/deploySession.js";
import { buildVibeCodeHttpHandlers } from "../../src/llm/vibeCodeHttp.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { ServiceAccessStore } from "../../src/serviceAccess.js";
import type { ServicePlatform } from "../../src/servicePlatform.js";
import type { CommandRunner } from "../../src/serviceRunner.js";
import type { HttpRequest } from "../../src/runtime.js";

const HOST = "alice";
const SERVER = `home.${HOST}.flagship.services`;

function installed(labels: Record<string, string>) {
  return {
    byLabel: (l: string) => (labels[l] ? { serviceId: labels[l]! } : undefined),
    byServiceId: (id: string) => (Object.values(labels).includes(id) ? { serviceId: id } : undefined),
  };
}

function sessionWithFiles(reg: VibeCodeSessionRegistry, name: string | undefined, manifestName: string, visibility?: "just-me" | "link") {
  const s = reg.create({ username: HOST, serverFqdn: SERVER, ...(name ? { name } : {}), ...(visibility ? { visibility } : {}) });
  s.pushUserMessage("build it");
  s.feedAssistant(
    `=== flagship.app.json ===\n${JSON.stringify({
      schema_version: 1,
      name: manifestName,
      version: "0.1.0",
      runtime: { base: "static", image: "x:0", port: 8080 },
      data: {},
      network: {},
      access: { enabled: true, default_role: "owner" },
      migration: { verification: "standard" },
    })}\n=== Dockerfile ===\nFROM busybox\n=== END ===\n`,
  );
  s.endAssistant();
  return s;
}

describe("checkServiceName", () => {
  const reg = new VibeCodeSessionRegistry();
  const deps = { registry: reg, hostUsername: HOST, installed: installed({ notes: "alice--notes", blog: "alice--journal" }) };

  it("refuses names that can't be a web address", () => {
    for (const bad of ["", "-a", "a-", "a--b", "Has Space", "x".repeat(64), "dots.no"]) {
      expect(checkServiceName(bad, deps)).toMatchObject({ ok: false, kind: "invalid" });
    }
    expect(checkServiceName("Plant-Tracker", deps)).toEqual({ ok: true, name: "plant-tracker" });
  });

  it("refuses the name of an installed service, by slug or by its current address", () => {
    expect(checkServiceName("notes", deps)).toMatchObject({ ok: false, kind: "app", serviceId: "alice--notes" });
    expect(checkServiceName("journal", deps)).toMatchObject({ ok: false, kind: "app", serviceId: "alice--journal" });
    expect(checkServiceName("blog", deps)).toMatchObject({ ok: false, kind: "app", serviceId: "alice--journal" });
  });

  it("refuses a name an open session holds, until it is deployed or cancelled", () => {
    const s = reg.create({ username: HOST, serverFqdn: SERVER, name: "garden" });
    expect(checkServiceName("garden", deps)).toMatchObject({ ok: false, kind: "session", sessionId: s.meta.sessionId });
    expect(checkServiceName("garden", deps, s.meta.sessionId)).toEqual({ ok: true, name: "garden" });
    s.fail("boom", true);
    expect(checkServiceName("garden", deps)).toMatchObject({ ok: false, kind: "session" });
    s.cancel();
    expect(checkServiceName("garden", deps)).toEqual({ ok: true, name: "garden" });
  });
});

describe("discard", () => {
  it("frees the name and drops the session's saved state and key", async () => {
    const deleted: string[] = [];
    const reg = new VibeCodeSessionRegistry(null, { onDelete: (id) => deleted.push(id) });
    const s = reg.create({ username: HOST, serverFqdn: SERVER, name: "garden" });
    const handle = buildVibeCodeHttpHandlers({
      registry: reg,
      gate: { check: () => null } as never,
      username: HOST,
      serverFqdn: SERVER,
    });
    const r = await handle({ method: "POST", path: `/api/llm/sessions/${s.meta.sessionId}/discard`, headers: {}, body: Buffer.alloc(0) });
    expect(r?.status).toBe(200);
    expect(reg.get(s.meta.sessionId)).toBeUndefined();
    expect(reg.holderOf("garden")).toBeUndefined();
    expect(deleted).toEqual([s.meta.sessionId]);
  });
});

describe("deploy and names", () => {
  async function withDeploy(
    labels: Record<string, string>,
    run: (deploy: ReturnType<typeof buildDeploySession>, ctx: { dir: string; calls: string[]; installs: string[]; restricted: string[]; reg: VibeCodeSessionRegistry }) => Promise<void>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "vibe-names-"));
    const calls: string[] = [];
    const installs: string[] = [];
    const restricted: string[] = [];
    const cmd: CommandRunner = {
      run: async (c, a) => { calls.push(`${c} ${a.join(" ")}`); },
      capture: async (c, a) => { calls.push(`${c} ${a.join(" ")}`); return { stdout: "", stderr: "" }; },
    };
    const platform = {
      ...installed(labels),
      install: async ({ request }: { request: { slug: string } }) => { installs.push(request.slug); return { ok: true }; },
    } as unknown as ServicePlatform;
    const reg = new VibeCodeSessionRegistry();
    const deploy = buildDeploySession({
      servicePlatform: platform,
      signer: { signInstallService: () => new Uint8Array(64) },
      hostUsername: HOST,
      workingDir: dir,
      cmd,
      registry: reg,
      restrictToInvited: async (id) => { restricted.push(id); return true; },
    });
    try {
      await run(deploy, { dir, calls, installs, restricted, reg });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("deploys under the owner's name, not the AI's", async () => {
    await withDeploy({}, async (deploy, { installs, reg }) => {
      const r = await deploy(sessionWithFiles(reg, "plants", "habit-thing"));
      expect(r).toMatchObject({ ok: true, serviceId: "alice--plants", url: `https://plants.${SERVER}` });
      expect(installs).toEqual(["plants"]);
    });
  });

  it("stops before writing files or building when the name belongs to an installed service", async () => {
    await withDeploy({ notes: "alice--notes" }, async (deploy, { dir, calls, installs, reg }) => {
      const r = await deploy(sessionWithFiles(reg, undefined, "notes"));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/already have a service called "notes"/);
      expect(await readdir(dir)).toEqual([]);
      expect(calls).toEqual([]);
      expect(installs).toEqual([]);
    });
  });

  it("won't take a name another open session holds", async () => {
    await withDeploy({}, async (deploy, { reg }) => {
      reg.create({ username: HOST, serverFqdn: SERVER, name: "notes" });
      const legacy = sessionWithFiles(reg, undefined, "notes");
      const r = await deploy(legacy);
      expect(r.ok).toBe(false);
    });
  });

  it("puts an invite-only build behind the gate, and leaves an open one alone", async () => {
    await withDeploy({}, async (deploy, { restricted, reg }) => {
      const a = await deploy(sessionWithFiles(reg, "private-notes", "x", "just-me"));
      expect(a).toMatchObject({ ok: true, inviteOnly: true });
      const b = await deploy(sessionWithFiles(reg, "public-blog", "y", "link"));
      expect(b.ok && b.inviteOnly).toBeFalsy();
      expect(restricted).toEqual(["alice--private-notes"]);
    });
  });
});

describe("the owner passes their own invite-only gate", () => {
  it("allows the pinned owner AID on a restricted service with an empty allow-list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "access-owner-"));
    try {
      const owner = "ab".repeat(32);
      const store = new ServiceAccessStore(join(dir, "a.json"), { ownerAidHex: owner.toUpperCase() });
      await store.setMode("alice--notes", "restricted");
      expect(store.knowsOwner()).toBe(true);
      expect(store.isAllowed("alice--notes", owner)).toBe(true);
      expect(store.isAllowed("alice--notes", "cd".repeat(32))).toBe(false);
      expect(new ServiceAccessStore(join(dir, "b.json")).knowsOwner()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("screens: name-check and start", () => {
  function build() {
    const reg = new VibeCodeSessionRegistry();
    const handle = buildScreensHttp({
      gate: { has: () => true, check: () => null } as never,
      serverFqdn: SERVER,
      username: HOST,
      daemonVersion: "test",
      startedAt: 0,
      servicePlatform: installed({ notes: "alice--notes" }) as unknown as ServicePlatform,
      vibeCode: { registry: reg, username: HOST, serverFqdn: SERVER },
    });
    const get = (path: string): HttpRequest => ({ method: "GET", path, headers: { "x-flagship-session": "t" }, body: Buffer.alloc(0) });
    const post = (path: string, body: unknown): HttpRequest => ({
      method: "POST", path, headers: { "x-flagship-session": "t", "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)),
    });
    return { reg, handle, get, post };
  }

  it("answers as the owner types", async () => {
    const { handle, get } = build();
    const free = await handle(get("/api/screens/vibe-code/name-check?name=garden"));
    expect(JSON.parse(free!.body as string)).toEqual({ ok: true, name: "garden" });
    const taken = await handle(get("/api/screens/vibe-code/name-check?name=notes"));
    expect(JSON.parse(taken!.body as string)).toMatchObject({ ok: false, kind: "app", serviceId: "alice--notes" });
  });

  it("start keeps the name on the session and refuses a second build with it", async () => {
    const { reg, handle, post } = build();
    const first = await handle(post("/api/screens/vibe-code/start", { prompt: "a garden log", name: "garden", visibility: "just-me" }));
    expect(first?.status).toBe(200);
    const { sessionId } = JSON.parse(first!.body as string);
    expect(reg.get(sessionId)!.meta).toMatchObject({ name: "garden", visibility: "just-me" });

    const second = await handle(post("/api/screens/vibe-code/start", { prompt: "another", name: "garden" }));
    expect(second?.status).toBe(409);
    expect(JSON.parse(second!.body as string)).toMatchObject({ ok: false, kind: "session", sessionId });
    const app = await handle(post("/api/screens/vibe-code/start", { prompt: "another", name: "notes" }));
    expect(app?.status).toBe(409);
    expect(reg.list()).toHaveLength(1);
  });
});
