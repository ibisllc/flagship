import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { buildBuildModesHttpHandlers } from "../src/buildmodes/buildModesHttp.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { InMemoryBuildCredentialStore } from "../src/llm/buildCredentialStore.js";
import {
  checkServiceName,
  combineNameHolders,
  deriveServiceName,
  repoNameFromUrl,
  slugifyLabel,
  type ServiceNameDeps,
} from "../src/llm/serviceName.js";
import type { DeployResult } from "../src/buildmodes/deployArtifact.js";
import { FakeStaging } from "./helpers/fakeStaging.js";
import type { HttpRequest } from "../src/runtime.js";
import type { ChatResponse } from "@flagship/llm-providers";

const FQDN = "home.harry.flagship.services";
const NOT_FIT = { "package.json": JSON.stringify({ name: "hello" }), "index.js": "console.log(1)" };

function fixtureClone(files: Record<string, string>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

function setup(opts: { apps?: string[]; vibeNames?: Record<string, string>; clone?: Record<string, string> | "fail" } = {}) {
  const journal = new InMemoryBuildJournal();
  const apps = new Set(opts.apps ?? []);
  const installed = {
    byLabel: (l: string) => (apps.has(l) ? { serviceId: `harry--${l}` } : undefined),
    byServiceId: (id: string) => (apps.has(id.split("--")[1] ?? "") ? { serviceId: id } : undefined),
  };
  const vibe = {
    holderOf: (name: string) => {
      const id = Object.entries(opts.vibeNames ?? {}).find(([, n]) => n === name)?.[0];
      return id ? { sessionId: id } : undefined;
    },
  };
  const ref: { o: BuildOrchestrator | null } = { o: null };
  const names = (): ServiceNameDeps => ({
    registry: combineNameHolders(vibe, { holderOf: (n, e) => ref.o?.holderOf(n, e) }),
    hostUsername: "harry",
    installed,
  });
  const deployed: Array<{ name?: string }> = [];
  const o = new BuildOrchestrator({
    journal,
    gitImporter: new GitImporter({
      cmd: { run: async () => {} },
      workingDir: mkdtempSync(join(tmpdir(), "git-names-")),
      cloneInto:
        opts.clone === "fail"
          ? async () => {
              throw new Error("repository not found");
            }
          : fixtureClone(opts.clone ?? NOT_FIT),
    }),
    mcpKeys: new InMemoryMcpKeyStore(),
    serverFqdn: FQDN,
    names,
    deployArtifact: async (a): Promise<DeployResult> => {
      deployed.push({ ...(a.name ? { name: a.name } : {}) });
      return { ok: true, serviceId: `harry--${a.name}`, url: `https://${a.name}.${FQDN}`, image: "img" };
    },
    rand: (() => {
      let n = 0;
      return () => `b${++n}`;
    })(),
  });
  ref.o = o;
  return { o, names, deployed, journal, apps };
}

describe("naming a git import", () => {
  it("makes a label from repo and branch names", () => {
    expect(repoNameFromUrl("https://github.com/me/Hello_World.git")).toBe("Hello_World");
    expect(repoNameFromUrl("git@github.com:me/notes.git")).toBe("notes");
    expect(repoNameFromUrl("https://gitlab.com/g/sub/app/")).toBe("app");
    expect(slugifyLabel("Hello_World Ünïcode!")).toBe("hello-world-unicode");
  });

  it("uses the repo name, adds a branch that isn't the default, and steps past taken names", () => {
    const { names, apps } = setup({ apps: ["hello", "hello-2"] });
    expect(deriveServiceName({ gitUrl: "https://github.com/me/notes" }, names())).toBe("notes");
    expect(deriveServiceName({ gitUrl: "https://github.com/me/notes", ref: "main" }, names())).toBe("notes");
    expect(deriveServiceName({ gitUrl: "https://github.com/me/notes", ref: "feature/dark-mode" }, names())).toBe("notes-dark-mode");
    expect(deriveServiceName({ gitUrl: "https://github.com/me/helloworld" }, names())).toBe("helloworld");
    expect(deriveServiceName({ gitUrl: "https://github.com/me/hello" }, names())).toBe("hello-3");
    apps.add("hello-3");
    expect(deriveServiceName({ gitUrl: "https://github.com/me/Hello.git" }, names())).toBe("hello-4");
    expect(deriveServiceName({ gitUrl: "https://github.com/me/---" }, names())).toBe("app");
  });

  it("names a blank-name import from its repo, and holds the name until it deploys", async () => {
    const { o, names, deployed } = setup();
    const r = await o.createGit({ gitUrl: "https://github.com/me/helloworld" });
    if ("error" in r) throw new Error(r.error);
    expect(r.name).toBe("helloworld");
    expect(checkServiceName("helloworld", names())).toMatchObject({ ok: false, kind: "session", sessionId: r.buildId });

    const again = await o.createGit({ gitUrl: "https://github.com/me/helloworld" });
    if ("error" in again) throw new Error(again.error);
    expect(again.name).toBe("helloworld-2");

    await o.deploy(r.buildId);
    expect(deployed[0]).toEqual({ name: "helloworld" });
    expect(o.holderOf("helloworld")).toBeUndefined();
  });

  it("refuses a name an app or an AI chat already has, before cloning", async () => {
    const { o, journal } = setup({ apps: ["notes"], vibeNames: { s9: "todo" } });
    const app = await o.createGit({ gitUrl: "https://github.com/me/x", name: "Notes" });
    expect(app).toMatchObject({ status: 409, check: { kind: "app", serviceId: "harry--notes" } });
    const chat = await o.createGit({ gitUrl: "https://github.com/me/x", name: "todo" });
    expect(chat).toMatchObject({ status: 409, check: { kind: "session", sessionId: "s9" } });
    const bad = await o.createGit({ gitUrl: "https://github.com/me/x", name: "no spaces" });
    expect(bad).toMatchObject({ status: 400, check: { kind: "invalid" } });
    expect(await journal.list()).toEqual([]);
  });

  it("deploys under the given name, whatever the repo's manifest says", async () => {
    const manifest = JSON.stringify({ schema_version: 1, name: "upstream", version: "1.0.0", runtime: { image: "x", port: 8080 } });
    const { o, deployed } = setup({ clone: { "flagship.app.json": manifest, Dockerfile: "FROM x" } });
    const r = await o.createGit({ gitUrl: "https://github.com/me/upstream", name: "mine" });
    if ("error" in r) throw new Error(r.error);
    expect(r.fit).toBe(true);
    await o.deploy(r.buildId);
    expect(deployed[0]).toEqual({ name: "mine" });
  });

  it("reports a failed clone as an error, not as a repo the AI should adapt", async () => {
    const { o } = setup({ clone: "fail" });
    const r = await o.createGit({ gitUrl: "https://github.com/me/missing" });
    expect(r).toMatchObject({ status: 422 });
    expect("error" in r && r.error).toMatch(/clone failed: repository not found/);
  });

  it("discarding frees the name", async () => {
    const { o, names } = setup();
    const r = await o.createGit({ gitUrl: "https://github.com/me/notes" });
    if ("error" in r) throw new Error(r.error);
    expect(o.isOpen(r.buildId)).toBe(true);
    expect(await o.discard(r.buildId)).toBe(true);
    expect(o.isOpen(r.buildId)).toBe(false);
    expect(checkServiceName("notes", names()).ok).toBe(true);
  });
});

function call(handle: ReturnType<typeof buildBuildModesHttpHandlers>, method: string, path: string, body?: unknown) {
  const req: HttpRequest = {
    method,
    path,
    headers: {},
    body: Buffer.from(body == null ? "" : JSON.stringify(body)),
  } as HttpRequest;
  return handle(req).then((r) => ({ status: r!.status, json: r!.body ? JSON.parse(String(r!.body)) : null }));
}

describe("git import over HTTP", () => {
  const gate = { check: () => null };

  it("answers a taken name with who holds it", async () => {
    const { o } = setup({ vibeNames: { s1: "todo" } });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate });
    const r = await call(handle, "POST", "/api/build/git", { gitUrl: "https://github.com/me/x", name: "todo" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, kind: "session", sessionId: "s1" });
    expect(r.json.error).toMatch(/already uses the name "todo"/);
  });

  it("returns the name it chose, lists the build as open, and discards it", async () => {
    const { o } = setup();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate });
    const r = await call(handle, "POST", "/api/build/git", { gitUrl: "https://github.com/me/hello-app", ref: "dev" });
    expect(r.json).toMatchObject({ name: "hello-app-dev", fit: false });
    const list = await call(handle, "GET", "/api/build/sessions");
    expect(list.json.builds[0]).toMatchObject({ buildId: r.json.buildId, open: true, name: "hello-app-dev" });
    const d = await call(handle, "POST", `/api/build/sessions/${r.json.buildId}/discard`, {});
    expect(d.json).toEqual({ ok: true });
    const after = await call(handle, "GET", "/api/build/sessions");
    expect(after.json.builds[0].open).toBeUndefined();
  });

  it("runs the AI adapt in the background and reports how it went", async () => {
    const journal = new InMemoryBuildJournal();
    const credentials = new InMemoryBuildCredentialStore();
    let release!: () => void;
    const gateTurn = new Promise<void>((r) => (release = r));
    const turns: ChatResponse[] = [
      {
        content: "",
        model: "m",
        toolUses: [
          {
            id: "1",
            name: "write_file",
            input: {
              path: "flagship.app.json",
              content: JSON.stringify({ schema_version: 1, name: "whatever", version: "0.1.0", runtime: { image: "x", port: 8080 } }),
            },
          },
          { id: "2", name: "write_file", input: { path: "Dockerfile", content: "FROM node:20\nEXPOSE 8080" } },
          { id: "3", name: "deploy", input: {} },
        ],
      },
      { content: "", model: "m", toolUses: [{ id: "4", name: "finish", input: {} }] },
    ];
    let seenInstructions = "";
    const o = new BuildOrchestrator({
      journal,
      gitImporter: new GitImporter({
        cmd: { run: async () => {} },
        workingDir: mkdtempSync(join(tmpdir(), "git-bg-")),
        cloneInto: fixtureClone(NOT_FIT),
      }),
      mcpKeys: new InMemoryMcpKeyStore(),
      serverFqdn: FQDN,
      names: () => ({ registry: { holderOf: (n, e) => o.holderOf(n, e) }, hostUsername: "harry", installed: null }),
      staging: new FakeStaging(),
      deployArtifact: async (a): Promise<DeployResult> => ({ ok: true, serviceId: `harry--${a.name}`, url: `https://${a.name}.${FQDN}`, image: "i" }),
      forgetCredential: (id) => credentials.forget(id),
      agentRunner: async (_id, req) => {
        seenInstructions = String(req.messages[1]?.content ?? "");
        await gateTurn;
        return turns.shift() ?? { content: "done", model: "m" };
      },
      adaptCredentialAvailable: (id) => credentials.has(id),
    });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate, credentials });
    const created = await call(handle, "POST", "/api/build/git", {
      gitUrl: "https://github.com/me/helloworld",
      credential: { provider: "openai", apiKey: "sk-test" },
    });
    const id = created.json.buildId as string;
    const started = await call(handle, "POST", `/api/build/sessions/${id}/adapt`, { background: true });
    expect(started.status).toBe(202);
    expect((await call(handle, "GET", `/api/build/sessions/${id}`)).json.state.adapt).toMatchObject({ status: "running", phase: "staging" });
    expect((await call(handle, "POST", `/api/build/sessions/${id}/adapt`, { background: true })).status).toBe(409);
    expect((await call(handle, "POST", `/api/build/sessions/${id}/discard`, {})).status).toBe(409);
    release();
    for (let i = 0; i < 50; i++) {
      const s = (await call(handle, "GET", `/api/build/sessions/${id}`)).json.state;
      if (s.adapt.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const done = (await call(handle, "GET", `/api/build/sessions/${id}`)).json.state;
    expect(done.adapt).toMatchObject({ status: "done", deployed: true, deployedUrl: `https://helloworld.${FQDN}` });
    expect(done.sealed).toBe(true);
    expect(credentials.has(id)).toBe(false);
    expect(seenInstructions).toMatch(/The app's name is "helloworld"/);
    // A live build never takes an AI again.
    const again = await call(handle, "POST", `/api/build/sessions/${id}/adapt`, { credential: { provider: "openai", apiKey: "sk-test" } });
    expect(again.status).toBe(409);
    expect(credentials.has(id)).toBe(false);
  });

  it("a background adapt with no AI key is a 503 at once", async () => {
    const { o } = setup();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate });
    const created = await call(handle, "POST", "/api/build/git", { gitUrl: "https://github.com/me/x" });
    const r = await call(handle, "POST", `/api/build/sessions/${created.json.buildId}/adapt`, { background: true });
    expect(r.status).toBe(503);
  });
});
