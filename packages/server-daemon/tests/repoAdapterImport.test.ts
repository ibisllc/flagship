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
    expect(JSON.parse(sent.file).adapter.source).toEqual({ repo: REPO, base: COMMIT });
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

  it("talks to flagshipserver.com with nothing but the content type", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const idx = httpAdapterIndex("https://flagshipserver.com/", async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, json: async () => ({ adapters: [{ base: COMMIT, file: "{}" }, { junk: 1 }] }) };
    });
    expect(await idx.lookup(REPO, COMMIT)).toEqual([{ base: COMMIT, file: "{}" }]);
    await idx.submit({ repo: REPO, base: COMMIT, licensePath: "LICENSE", file: "{}" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://flagshipserver.com/api/adapters/lookup",
      "https://flagshipserver.com/api/adapters/submit",
    ]);
    for (const c of calls) expect(c.headers).toEqual({ "content-type": "application/json" });
    const failing = httpAdapterIndex("https://x", async () => {
      throw new Error("offline");
    });
    expect(await failing.lookup(REPO, COMMIT)).toEqual([]);
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
