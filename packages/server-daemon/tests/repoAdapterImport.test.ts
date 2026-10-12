import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdapterFile, deriveRepoAdapter } from "@flagship/protocol";
import type { ChatRequest, ChatResponse } from "@flagship/llm-providers";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { httpAdapterIndex, indexableRepo, licensePathOf, type AdapterIndex } from "../src/buildmodes/adapterIndex.js";
import type { DeployResult } from "../src/buildmodes/deployArtifact.js";

const FQDN = "home.harry.flagship.services";
const COMMIT = "c".repeat(40);
const REPO = "https://github.com/me/hello";
const MIT = "MIT License\n\nPermission is hereby granted, free of charge…\n";
const ORIGINAL = {
  LICENSE: MIT,
  "index.js": "const port = 3000;\nrequire('http').createServer((q, s) => s.end('hi')).listen(port);\n",
  "package.json": JSON.stringify({ name: "hello" }),
};
const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "hello",
  version: "0.1.0",
  description: "Hello",
  runtime: { image: "x", port: 8080 },
  access: { enabled: true, default_role: "member", public_routes: ["/"] },
});
const ADAPTED = {
  ...ORIGINAL,
  "index.js": ORIGINAL["index.js"].replace("3000", "process.env.PORT"),
  Dockerfile: "FROM node:20-alpine\nCOPY . .\nEXPOSE 8080\nCMD [\"node\",\"index.js\"]\n",
  "flagship.app.json": MANIFEST,
};
const ADAPTER_FILE = buildAdapterFile(MANIFEST, deriveRepoAdapter(ORIGINAL, ADAPTED, { repo: REPO, base: COMMIT }));

function fixtureClone(files: Record<string, string>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

function fakeIndex(stored: Array<{ base: string; file: string }> = []) {
  const lookups: Array<[string, string]> = [];
  const submitted: unknown[] = [];
  const index: AdapterIndex = {
    lookup: async (repo, base) => {
      lookups.push([repo, base]);
      return stored;
    },
    submit: async (s) => {
      submitted.push(s);
    },
  };
  return { index, lookups, submitted };
}

function setup(opts: { clone?: Record<string, string>; index?: AdapterIndex; agent?: (req: ChatRequest) => ChatResponse } = {}) {
  const journal = new InMemoryBuildJournal();
  const deployed: Array<{ files: Record<string, string>; name?: string }> = [];
  const o: BuildOrchestrator = new BuildOrchestrator({
    journal,
    gitImporter: new GitImporter({
      cmd: { run: async () => {} },
      workingDir: mkdtempSync(join(tmpdir(), "adapter-import-")),
      cloneInto: fixtureClone(opts.clone ?? ORIGINAL),
      commitOf: async () => COMMIT,
    }),
    mcpKeys: new InMemoryMcpKeyStore(),
    serverFqdn: FQDN,
    names: () => ({ registry: { holderOf: (n, e) => o.holderOf(n, e) }, hostUsername: "harry", installed: null }),
    ...(opts.index ? { adapterIndex: opts.index } : {}),
    deployArtifact: async (a): Promise<DeployResult> => {
      deployed.push({ files: a.files, ...(a.name ? { name: a.name } : {}) });
      return { ok: true, serviceId: `harry--${a.name}`, url: `https://${a.name}.${FQDN}`, image: "i" };
    },
    ...(opts.agent ? { agentRunner: async (_id: string, req: ChatRequest) => opts.agent!(req) } : {}),
  });
  return { o, deployed, journal };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("importing a repo that carries its own adapter", () => {
  it("applies it and installs without AI, and shares nothing (it's the author's)", async () => {
    const { index, lookups, submitted } = fakeIndex();
    const { o, deployed } = setup({ clone: { ...ORIGINAL, "flagship.app.json": ADAPTER_FILE }, index });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    expect(r.fit).toBe(true);
    expect(r.reason).toMatch(/the repo says how to run it/);
    expect(lookups).toEqual([]);
    await o.deploy(r.buildId);
    expect(deployed[0]!.files["index.js"]).toContain("process.env.PORT");
    expect(deployed[0]!.files.Dockerfile).toContain("EXPOSE 8080");
    expect(JSON.parse(deployed[0]!.files["flagship.app.json"]!)).not.toHaveProperty("adapter");
    await settle();
    expect(submitted).toEqual([]);
  });

  it("an adapter that no longer fits goes to the AI as a guide", async () => {
    let firstPrompt = "";
    const { o } = setup({
      clone: { ...ORIGINAL, "index.js": "rewritten entirely\n", "flagship.app.json": ADAPTER_FILE },
      agent: (req) => {
        firstPrompt ||= String(req.messages[1]?.content ?? "");
        return { content: "done", model: "m" };
      },
    });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    expect(r.fit).toBe(false);
    expect(r.reason).toMatch(/adapter no longer fits index\.js/);
    await o.adaptGit(r.buildId);
    expect(firstPrompt).toMatch(/carries an adapter .* no longer fit index\.js/s);
  });
});

describe("the adapter index", () => {
  it("installs a repo someone adapted before without AI, then confirms it", async () => {
    const { index, lookups, submitted } = fakeIndex([{ base: COMMIT, file: ADAPTER_FILE }]);
    const { o, deployed } = setup({ index });
    const r = await o.createGit({ gitUrl: "https://github.com/me/hello.git" });
    if ("error" in r) throw new Error(r.error);
    expect(lookups).toEqual([[REPO, COMMIT]]);
    expect(r.fit).toBe(true);
    expect(r.reason).toMatch(/no AI needed/);
    await o.deploy(r.buildId);
    expect(deployed[0]!.files["index.js"]).toContain("process.env.PORT");
    await settle();
    expect(submitted).toHaveLength(1);
  });

  it("skips adapters that are for another repo, carry secrets, or don't fit", async () => {
    const other = buildAdapterFile(MANIFEST, deriveRepoAdapter(ORIGINAL, ADAPTED, { repo: "https://github.com/x/y", base: COMMIT }));
    const secret = buildAdapterFile(
      MANIFEST,
      deriveRepoAdapter(ORIGINAL, { ...ADAPTED, ".env": "KEY=AKIAABCDEFGHIJKLMNOP\n" }, { repo: REPO, base: COMMIT }),
    );
    const misfit = buildAdapterFile(
      MANIFEST,
      deriveRepoAdapter({ ...ORIGINAL, "index.js": "something else\n" }, ADAPTED, { repo: REPO, base: COMMIT }),
    );
    const { index } = fakeIndex([{ base: COMMIT, file: other }, { base: COMMIT, file: secret }, { base: COMMIT, file: misfit }, { base: COMMIT, file: "{" }]);
    const { o } = setup({ index });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    expect(r.fit).toBe(false);
  });

  it("after an AI adapt deploys, shares the adapter with nothing that says whose it was", async () => {
    const turns: ChatResponse[] = [
      {
        content: "",
        model: "m",
        toolUses: [
          { id: "1", name: "write_file", input: { path: "index.js", content: ADAPTED["index.js"] } },
          { id: "2", name: "write_file", input: { path: "Dockerfile", content: ADAPTED.Dockerfile } },
          { id: "3", name: "write_file", input: { path: "flagship.app.json", content: MANIFEST.replace('"hello"', '"my-private-name"') } },
          { id: "4", name: "deploy", input: {} },
        ],
      },
    ];
    const { index, submitted } = fakeIndex();
    const { o } = setup({ index, agent: () => turns.shift() ?? { content: "done", model: "m" } });
    const r = await o.createGit({ gitUrl: REPO, name: "my-private-name" });
    if ("error" in r) throw new Error(r.error);
    const a = await o.adaptGit(r.buildId);
    expect(a).toMatchObject({ ok: true, deployed: true });
    await settle();
    expect(submitted).toHaveLength(1);
    const sent = submitted[0] as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(["base", "file", "licensePath", "repo"]);
    expect(sent).toMatchObject({ repo: REPO, base: COMMIT, licensePath: "LICENSE" });
    expect(sent.file).not.toContain("my-private-name");
    expect(sent.file).not.toContain(FQDN);
    expect(sent.file).not.toContain("harry");
    expect(JSON.parse(sent.file).name).toBe("hello");
    expect(JSON.parse(sent.file).description).toBe("hello");
    expect(JSON.parse(sent.file).adapter.source).toEqual({ repo: REPO, base: COMMIT });
  });

  it("doesn't share an adapt the owner steered in their own words", async () => {
    const turns: ChatResponse[] = [
      {
        content: "",
        model: "m",
        toolUses: [
          { id: "1", name: "write_file", input: { path: "Dockerfile", content: ADAPTED.Dockerfile } },
          { id: "2", name: "write_file", input: { path: "flagship.app.json", content: MANIFEST } },
          { id: "3", name: "deploy", input: {} },
        ],
      },
    ];
    const { index, submitted } = fakeIndex();
    const { o } = setup({ index, agent: () => turns.shift() ?? { content: "done", model: "m" } });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    expect(await o.adaptGit(r.buildId, { instructions: "brand it for Acme Dental, 12 Rue X" })).toMatchObject({ deployed: true });
    await settle();
    expect(submitted).toEqual([]);
  });

  it("never asks about or shares a repo off the big public hosts, or one without a license", async () => {
    expect(indexableRepo("https://git.mycompany.lan/team/app")).toBeNull();
    expect(indexableRepo("git@gitlab.com:g/sub/app.git")).toBe("https://gitlab.com/g/sub/app");
    expect(licensePathOf({ "COPYING.md": "", "docs/LICENSE": "" })).toBe("COPYING.md");
    expect(licensePathOf({ "README.md": "" })).toBeNull();

    const { index, lookups } = fakeIndex([{ base: COMMIT, file: ADAPTER_FILE }]);
    const { o } = setup({ index });
    const r = await o.createGit({ gitUrl: "https://git.mycompany.lan/team/hello" });
    if ("error" in r) throw new Error(r.error);
    expect(lookups).toEqual([]);
    expect(r.fit).toBe(false);
  });

  it("reads the public store directly, checks each file against its hash, and sends nothing identifying", async () => {
    const { createHash } = await import("node:crypto");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const older = buildAdapterFile(MANIFEST, deriveRepoAdapter(ORIGINAL, ADAPTED, { repo: REPO, base: "b".repeat(40) }));
    const store: Record<string, string> = {
      "https://store.test/adapters/github.com/me/hello/index.json": JSON.stringify({
        repo: REPO,
        adapters: [
          { base: "b".repeat(40), file: `${sha(older)}.json` },
          { base: COMMIT, file: `${sha(ADAPTER_FILE)}.json` },
          { base: COMMIT, file: `${"0".repeat(64)}.json` },
        ],
      }),
      [`https://store.test/adapters/github.com/me/hello/${sha(older)}.json`]: older,
      [`https://store.test/adapters/github.com/me/hello/${sha(ADAPTER_FILE)}.json`]: ADAPTER_FILE,
      [`https://store.test/adapters/github.com/me/hello/${"0".repeat(64)}.json`]: "tampered",
      "https://store.test/do-not-adapt.txt": "https://github.com/someone/else\n",
    };
    const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
    const fetcher = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init.method, ...(init.headers ? { headers: init.headers } : {}), ...(init.body ? { body: init.body } : {}) });
      const body = store[url];
      return { ok: body != null || init.method === "POST", text: async () => body ?? "" };
    };
    const idx = httpAdapterIndex({ store: "https://store.test/", submitTo: "https://flagshipserver.com/" }, fetcher);
    const found = await idx.lookup(REPO, COMMIT);
    expect(found).toEqual([
      { base: COMMIT, file: ADAPTER_FILE, sha: sha(ADAPTER_FILE) },
      { base: "b".repeat(40), file: older, sha: sha(older) },
    ]);
    for (const c of calls) expect(c.headers).toBeUndefined();

    store["https://store.test/do-not-adapt.txt"] = `${REPO}\n`;
    expect(await idx.lookup(REPO, COMMIT)).toEqual([]);
    expect(await idx.lookup("https://github.com/me/unknown", COMMIT)).toEqual([]);

    calls.length = 0;
    await idx.submit({ repo: REPO, base: COMMIT, licensePath: "LICENSE", file: "{}" });
    expect(calls).toEqual([
      {
        url: "https://flagshipserver.com/api/adapters/submit",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: REPO, base: COMMIT, licensePath: "LICENSE", file: "{}", wait: true }),
      },
    ]);
    const offline = httpAdapterIndex({ submitTo: "https://x" }, async () => {
      throw new Error("offline");
    });
    expect(await offline.lookup(REPO, COMMIT)).toEqual([]);
  });

});

describe("non-text files and symlinks", () => {
  it("carries images through to the build, and never follows a symlink out of the repo", async () => {
    const { symlink } = await import("node:fs/promises");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const journal = new InMemoryBuildJournal();
    const deployed: Array<{ files: Record<string, string>; binaries?: Record<string, Buffer> }> = [];
    const o: BuildOrchestrator = new BuildOrchestrator({
      journal,
      gitImporter: new GitImporter({
        cmd: { run: async () => {} },
        workingDir: mkdtempSync(join(tmpdir(), "bin-")),
        cloneInto: async ({ dest }) => {
          await fixtureClone({ ...ORIGINAL, "flagship.app.json": ADAPTER_FILE })({ dest });
          await mkdir(join(dest, "public"), { recursive: true });
          await writeFile(join(dest, "public/logo.png"), png);
          await symlink("/etc/hosts", join(dest, "public/hosts.txt"));
        },
      }),
      mcpKeys: new InMemoryMcpKeyStore(),
      serverFqdn: FQDN,
      deployArtifact: async (a): Promise<DeployResult> => {
        deployed.push({ files: a.files, ...(a.binaries ? { binaries: a.binaries } : {}) });
        return { ok: true, serviceId: "harry--hello", url: `https://hello.${FQDN}`, image: "i" };
      },
    });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    await o.deploy(r.buildId);
    expect(deployed[0]!.binaries?.["public/logo.png"]).toEqual(png);
    expect(deployed[0]!.files["public/hosts.txt"]).toBeUndefined();
    expect(deployed[0]!.binaries?.["public/hosts.txt"]).toBeUndefined();
  });

  it("an edit keeps the binaries the running version has", async () => {
    const { writeSourceTree } = await import("../src/llm/serviceSource.js");
    const { readFile } = await import("node:fs/promises");
    const dir = join(mkdtempSync(join(tmpdir(), "tree-")), "harry--hello");
    const png = Buffer.from([0x89, 0x50, 0, 7]);
    await writeSourceTree(dir, { "index.js": "1" }, { binaries: { "logo.png": png } });
    await writeSourceTree(dir, { "index.js": "2" }, { keepBinaries: true });
    expect(await readFile(join(dir, "logo.png"))).toEqual(png);
    expect(await readFile(join(dir, "index.js"), "utf8")).toBe("2");
    await writeSourceTree(dir, { "index.js": "3" });
    await expect(readFile(join(dir, "logo.png"))).rejects.toThrow();
    expect(await writeSourceTree(dir, { "../x": "" })).toEqual({ ok: false, unsafePath: "../x" });
  });
});

describe("a repo's own flagship.app.json is its author's", () => {
  it("keeps the repo out of the index, even when the AI has to redo a stale adapter", async () => {
    const turns: ChatResponse[] = [
      {
        content: "",
        model: "m",
        toolUses: [
          { id: "1", name: "write_file", input: { path: "Dockerfile", content: ADAPTED.Dockerfile } },
          { id: "2", name: "write_file", input: { path: "flagship.app.json", content: MANIFEST } },
          { id: "3", name: "deploy", input: {} },
        ],
      },
    ];
    const { index, lookups, submitted } = fakeIndex([{ base: COMMIT, file: ADAPTER_FILE }]);
    const { o } = setup({
      clone: { ...ORIGINAL, "index.js": "rewritten\n", "flagship.app.json": ADAPTER_FILE },
      index,
      agent: () => turns.shift() ?? { content: "done", model: "m" },
    });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    expect(r.fit).toBe(false);
    expect(lookups).toEqual([]);
    expect(await o.adaptGit(r.buildId)).toMatchObject({ deployed: true });
    await settle();
    expect(submitted).toEqual([]);
  });

  it("hands the author the file that makes their repo run this way", async () => {
    const { buildBuildModesHttpHandlers } = await import("../src/buildmodes/buildModesHttp.js");
    const { splitAdapterFile, applyRepoAdapter } = await import("@flagship/protocol");
    const turns: ChatResponse[] = [
      {
        content: "",
        model: "m",
        toolUses: [
          { id: "1", name: "write_file", input: { path: "index.js", content: ADAPTED["index.js"] } },
          { id: "2", name: "write_file", input: { path: "Dockerfile", content: ADAPTED.Dockerfile } },
          { id: "3", name: "write_file", input: { path: "flagship.app.json", content: MANIFEST.replace('"hello"', '"mine"') } },
        ],
      },
    ];
    const { o } = setup({ agent: () => turns.shift() ?? { content: "done", model: "m" } });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: { check: () => null } });
    const r = await o.createGit({ gitUrl: "https://git.example.org/me/hello" });
    if ("error" in r) throw new Error(r.error);
    await o.adaptGit(r.buildId);
    const res = await handle({ method: "GET", path: `/api/build/sessions/${r.buildId}/adapter`, headers: {}, body: Buffer.alloc(0) });
    expect(res!.status).toBe(200);
    const file = JSON.parse(String(res!.body)).file as string;
    const split = splitAdapterFile(file);
    if (!split.ok || !split.adapter) throw new Error("no adapter");
    expect(split.adapter.source).toEqual({ repo: "https://git.example.org/me/hello", base: COMMIT });
    expect(JSON.parse(split.manifestJson).name).toBe("hello");
    const applied = applyRepoAdapter(ORIGINAL, split.adapter, split.manifestJson);
    expect(applied.ok && applied.files["index.js"]).toBe(ADAPTED["index.js"]);
    const none = await handle({ method: "GET", path: "/api/build/sessions/nope/adapter", headers: {}, body: Buffer.alloc(0) });
    expect(none!.status).toBe(404);
  });
});

describe("the store's answer, and fixing what it refused", () => {
  function deployingTurns() {
    return [
      {
        content: "",
        model: "m",
        toolUses: [
          { id: "1", name: "write_file", input: { path: "index.js", content: ADAPTED["index.js"] } },
          { id: "2", name: "write_file", input: { path: "Dockerfile", content: ADAPTED.Dockerfile } },
          { id: "3", name: "write_file", input: { path: "flagship.app.json", content: MANIFEST } },
          { id: "4", name: "deploy", input: {} },
        ],
      },
    ] as ChatResponse[];
  }

  function scripted(verdicts: Array<import("../src/buildmodes/adapterIndex.js").SubmitVerdict>) {
    const submitted: string[] = [];
    const complaints: unknown[] = [];
    const index: AdapterIndex = {
      lookup: async () => [],
      submit: async (s) => {
        submitted.push(s.file);
        return verdicts.shift() ?? { status: "kept", file: "f".repeat(64) };
      },
      complain: async (c) => {
        complaints.push(c);
      },
    };
    return { index, submitted, complaints };
  }

  async function adaptAndSettle(o: BuildOrchestrator, gitUrl = REPO) {
    const r = await o.createGit({ gitUrl });
    if ("error" in r) throw new Error(r.error);
    await o.adaptGit(r.buildId);
    for (let i = 0; i < 20; i++) await settle();
    return r.buildId;
  }

  it("asks the AI to fix a fixable refusal, redeploys in place and sends it again", async () => {
    const prompts: string[] = [];
    let turns = deployingTurns();
    const { index, submitted } = scripted([
      { status: "refused", file: "a".repeat(64), reasons: [{ code: "adds-secret", message: "it adds what looks like a Stripe secret key", fixable: true }] },
      { status: "kept", file: "b".repeat(64) },
    ]);
    const origins: Array<[string, unknown]> = [];
    const journal = new InMemoryBuildJournal();
    const deployed: Array<{ editsServiceId?: string }> = [];
    const o: BuildOrchestrator = new BuildOrchestrator({
      journal,
      gitImporter: new GitImporter({
        cmd: { run: async () => {} },
        workingDir: mkdtempSync(join(tmpdir(), "fix-")),
        cloneInto: fixtureClone(ORIGINAL),
        commitOf: async () => COMMIT,
      }),
      mcpKeys: new InMemoryMcpKeyStore(),
      serverFqdn: FQDN,
      adapterIndex: index,
      recordAdapterOrigin: async (id, origin) => {
        origins.push([id, origin]);
      },
      deployArtifact: async (a): Promise<DeployResult> => {
        deployed.push({ ...(a.editsServiceId ? { editsServiceId: a.editsServiceId } : {}) });
        return { ok: true, serviceId: "harry--hello", url: `https://hello.${FQDN}`, image: "i" };
      },
      agentRunner: async (_id, req) => {
        if (req.messages.length === 2) {
          prompts.push(String(req.messages[1]!.content));
          if (turns.length === 0) turns = deployingTurns();
        }
        return turns.shift() ?? { content: "done", model: "m" };
      },
    });
    const id = await adaptAndSettle(o);
    expect(submitted).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/refused it for these reasons:\n- it adds what looks like a Stripe secret key/);
    expect(prompts[1]).not.toMatch(/Extra instructions from the owner: .*Acme/);
    expect(deployed).toEqual([{}, { editsServiceId: "harry--hello" }]);
    expect(origins.at(-1)).toEqual(["harry--hello", { repo: REPO, file: "b".repeat(64) }]);
    expect((await journal.read(id)).map((e) => e.summary)).toContain("shared the adaptation with Flagship's public store");
  });

  it("stops after two fix rounds, and never tries to fix what can't be fixed", async () => {
    const refusal = { status: "refused" as const, reasons: [{ code: "review", message: "other concern", fixable: true }] };
    let turns = deployingTurns();
    const { index, submitted } = scripted([refusal, refusal, refusal, refusal]);
    const { o } = setup({
      index,
      agent: (req) => {
        if (req.messages.length === 2 && turns.length === 0) turns = deployingTurns();
        return turns.shift() ?? { content: "done", model: "m" };
      },
    });
    await adaptAndSettle(o);
    expect(submitted).toHaveLength(3);

    turns = deployingTurns();
    const hard = scripted([{ status: "refused", reasons: [{ code: "no-license", message: "no license", fixable: false }] }]);
    const { o: o2 } = setup({ index: hard.index, agent: () => turns.shift() ?? { content: "done", model: "m" } });
    await adaptAndSettle(o2);
    expect(hard.submitted).toHaveLength(1);
  });

  it("shares nothing when the owner switched sharing off", async () => {
    const turns = deployingTurns();
    const { index, submitted } = scripted([]);
    const { o } = setup({ index, agent: () => turns.shift() ?? { content: "done", model: "m" } });
    const r = await o.createGit({ gitUrl: REPO, share: false });
    if ("error" in r) throw new Error(r.error);
    await o.adaptGit(r.buildId);
    await settle();
    expect(submitted).toEqual([]);
  });

  it("shares nothing when the owner switched sharing off after the check", async () => {
    const turns = deployingTurns();
    const { index, submitted } = scripted([]);
    const { o } = setup({ index, agent: () => turns.shift() ?? { content: "done", model: "m" } });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    o.setShare(r.buildId, false);
    await o.adaptGit(r.buildId);
    await settle();
    expect(submitted).toEqual([]);
  });

  it("reports a published adapter that fails to build here, and doesn't offer it again", async () => {
    const { createHash } = await import("node:crypto");
    const fileSha = createHash("sha256").update(ADAPTER_FILE).digest("hex");
    const complaints: unknown[] = [];
    const index: AdapterIndex = {
      lookup: async () => [{ base: COMMIT, file: ADAPTER_FILE, sha: fileSha }],
      submit: async () => null,
      complain: async (c) => {
        complaints.push(c);
      },
    };
    const journal = new InMemoryBuildJournal();
    const o = new BuildOrchestrator({
      journal,
      gitImporter: new GitImporter({
        cmd: { run: async () => {} },
        workingDir: mkdtempSync(join(tmpdir(), "crash-")),
        cloneInto: fixtureClone(ORIGINAL),
        commitOf: async () => COMMIT,
      }),
      mcpKeys: new InMemoryMcpKeyStore(),
      serverFqdn: FQDN,
      adapterIndex: index,
      deployArtifact: async (): Promise<DeployResult> => ({ ok: false, reason: "docker build failed: exit 1" }),
    });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    expect(r.fit).toBe(true);
    const d = await o.deploy(r.buildId);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/didn't work on this server, so it has been reported/);
    expect(!d.ok && d.needsAdapt).toBe(true);
    await settle();
    expect(complaints).toEqual([{ repo: REPO, file: fileSha, stage: "build" }]);
    expect(o.workspace(r.buildId)!.read("Dockerfile")).toBeNull();

    const again = await o.createGit({ gitUrl: REPO });
    if ("error" in again) throw new Error(again.error);
    expect(again.fit).toBe(false);
  });

  it("doesn't blame the adapter for a failure that isn't its own", async () => {
    const complaints: unknown[] = [];
    const index: AdapterIndex = {
      lookup: async () => [{ base: COMMIT, file: ADAPTER_FILE, sha: "e".repeat(64) }],
      submit: async () => null,
      complain: async (c) => {
        complaints.push(c);
      },
    };
    const o = new BuildOrchestrator({
      journal: new InMemoryBuildJournal(),
      gitImporter: new GitImporter({
        cmd: { run: async () => {} },
        workingDir: mkdtempSync(join(tmpdir(), "nocrash-")),
        cloneInto: fixtureClone(ORIGINAL),
        commitOf: async () => COMMIT,
      }),
      mcpKeys: new InMemoryMcpKeyStore(),
      serverFqdn: FQDN,
      adapterIndex: index,
      deployArtifact: async (): Promise<DeployResult> => ({ ok: false, reason: 'You already have a service called "hello".' }),
    });
    const r = await o.createGit({ gitUrl: REPO });
    if ("error" in r) throw new Error(r.error);
    await o.deploy(r.buildId);
    await settle();
    expect(complaints).toEqual([]);
  });
});

describe("reporting a problem from the service page", () => {
  it("remembers which adapter a service came from, across restarts", async () => {
    const { FileAdapterOrigins } = await import("../src/buildmodes/adapterOrigins.js");
    const path = join(mkdtempSync(join(tmpdir(), "origins-")), "data", "adapter-origins.json");
    const a = new FileAdapterOrigins(path);
    await a.load();
    await a.set("harry--hello", { repo: REPO, file: "c".repeat(64) });
    const b = new FileAdapterOrigins(path);
    await b.load();
    expect(b.get("harry--hello")).toEqual({ repo: REPO, file: "c".repeat(64) });
    await b.set("harry--hello", null);
    const c = new FileAdapterOrigins(path);
    await c.load();
    expect(c.get("harry--hello")).toBeNull();
  });

  it("sends the owner's note for a service built from a shared adaptation, and nothing for others", async () => {
    const { buildScreensHttp } = await import("../src/screens/screensHttp.js");
    const reports: Array<[string, string]> = [];
    const handle = buildScreensHttp({
      gate: { check: () => null },
      serverFqdn: FQDN,
      username: "harry",
      daemonVersion: "t",
      startedAt: 0,
      adapterReports: {
        originOf: (id) => (id === "harry--hello" ? { repo: REPO } : null),
        report: async (id, detail) => {
          reports.push([id, detail]);
          return true;
        },
      },
    } as unknown as Parameters<typeof buildScreensHttp>[0]);
    const post = (id: string, body: unknown) =>
      handle({ method: "POST", path: `/api/screens/adapter-report/${id}`, headers: {}, body: Buffer.from(JSON.stringify(body)) });
    expect((await post("harry--other", { detail: "x" }))!.status).toBe(404);
    expect((await post("harry--hello", { detail: "  " }))!.status).toBe(400);
    expect((await post("harry--hello", { detail: "x".repeat(2001) }))!.status).toBe(400);
    expect((await post("harry--hello", { detail: " The upload page crashes. " }))!.status).toBe(200);
    expect(reports).toEqual([["harry--hello", "The upload page crashes."]]);
  });
});
