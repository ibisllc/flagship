import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitImporter, buildAdaptPrompt } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import type { CommandRunner } from "../src/serviceRunner.js";

const VALID_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "shopping",
  version: "0.1.0",
  description: "A shared shopping list.",
  runtime: { image: "flagship/shopping:0.1.0", port: 8080 },
  data: { stores: { postgres: true } },
  network: { subdomain: "shopping" },
  access: { enabled: true, default_role: "member", public_routes: [] },
  migration: { verification: "standard" },
});

const noopCmd: CommandRunner = { run: async () => {} };

function workDir(): string {
  return mkdtempSync(join(tmpdir(), "gitimport-"));
}

/** A cloneInto that writes the given fixture files into the dest dir. */
function fixtureClone(files: Record<string, string | Buffer>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

describe("GitImporter.inspect — fitness", () => {
  it("FIT when a valid flagship.app.json is present", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: fixtureClone({
        "flagship.app.json": VALID_MANIFEST,
        Dockerfile: "FROM node:20-alpine\n",
        "src/index.js": "console.log('hi')\n",
      }),
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/alice/shopping" });
    expect(r.fit).toBe(true);
    if (r.fit) {
      expect(r.manifest.name).toBe("shopping");
      expect(r.files["Dockerfile"]).toContain("node:20-alpine");
      expect(r.reason).toContain("Flagship-ready");
    }
  });

  it("NOT FIT when there is no flagship.app.json — files still returned for adapt", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: fixtureClone({
        "package.json": '{"name":"some-express-app"}',
        "index.js": "const express = require('express')\n",
      }),
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/bob/express-thing" });
    expect(r.fit).toBe(false);
    expect(r.files["index.js"]).toContain("express");
    expect(r.reason).toContain("adapt");
  });

  it("NOT FIT when the manifest is present but not valid JSON", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: fixtureClone({ "flagship.app.json": "{ not json" }),
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/x/y" });
    expect(r.fit).toBe(false);
    if (!r.fit) expect(r.manifestErrors?.[0]).toContain("not valid JSON");
  });

  it("NOT FIT when the manifest violates the schema", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: fixtureClone({ "flagship.app.json": JSON.stringify({ schema_version: 1, name: "X bad name" }) }),
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/x/y" });
    expect(r.fit).toBe(false);
    if (!r.fit) expect((r.manifestErrors ?? []).length).toBeGreaterThan(0);
  });
});

describe("GitImporter.inspect — input validation (no clone attempted)", () => {
  it("rejects a non-git URL", async () => {
    let cloned = false;
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: async () => {
        cloned = true;
      },
    });
    const r = await importer.inspect({ gitUrl: "file:///etc/passwd" });
    expect(r.fit).toBe(false);
    expect(cloned).toBe(false);
  });

  it("rejects shell metacharacters in the URL", async () => {
    const importer = new GitImporter({ cmd: noopCmd, workingDir: workDir(), cloneInto: async () => {} });
    const r = await importer.inspect({ gitUrl: "https://x/y; rm -rf /" });
    expect(r.fit).toBe(false);
  });

  it("rejects a traversal ref", async () => {
    const importer = new GitImporter({ cmd: noopCmd, workingDir: workDir(), cloneInto: async () => {} });
    const r = await importer.inspect({ gitUrl: "https://github.com/a/b", ref: "../../evil" });
    expect(r.fit).toBe(false);
  });

  it("accepts a git@ scp-style URL", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: fixtureClone({ "flagship.app.json": VALID_MANIFEST }),
    });
    const r = await importer.inspect({ gitUrl: "git@github.com:alice/shopping.git" });
    expect(r.fit).toBe(true);
  });
});

describe("GitImporter.inspect — tree reading", () => {
  it("skips .git, node_modules, binaries and oversize files", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      maxBytesPerFile: 32,
      cloneInto: fixtureClone({
        "flagship.app.json": VALID_MANIFEST,
        ".git/HEAD": "ref: refs/heads/main",
        "node_modules/dep/index.js": "module.exports = 1",
        "logo.png": Buffer.from([0, 1, 2, 0, 3]),
        "huge.txt": "x".repeat(1000),
        "small.txt": "ok",
      }),
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/a/b" });
    const paths = Object.keys(r.files);
    expect(paths).toContain("small.txt");
    expect(paths).not.toContain(".git/HEAD");
    expect(paths).not.toContain("node_modules/dep/index.js");
    expect(paths).not.toContain("logo.png");
    expect(paths).not.toContain("huge.txt");
  });
});

describe("GitImporter.inspect — journaling + clone failure", () => {
  it("journals clone + fitness verdict", async () => {
    const journal = new InMemoryBuildJournal();
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      journal,
      cloneInto: fixtureClone({ "flagship.app.json": VALID_MANIFEST }),
    });
    await importer.inspect({ gitUrl: "https://github.com/a/b", buildId: "g1" });
    const entries = await journal.read("g1");
    expect(entries.map((e) => e.kind)).toEqual(["git-clone", "fitness-check"]);
    expect(entries.every((e) => e.mode === "git")).toBe(true);
  });

  it("returns a failure (not throw) when the clone errors, and journals it", async () => {
    const journal = new InMemoryBuildJournal();
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      journal,
      cloneInto: async () => {
        throw new Error("auth required");
      },
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/a/b", buildId: "g2" });
    expect(r.fit).toBe(false);
    expect(r.reason).toContain("clone failed");
    expect((await journal.read("g2")).some((e) => e.kind === "error")).toBe(true);
  });

  it("uses `git clone` via the CommandRunner by default", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const importer = new GitImporter({
      cmd: { run: async (cmd, args) => void calls.push({ cmd, args }) },
      workingDir: workDir(),
    });
    await importer.inspect({ gitUrl: "https://github.com/a/b", ref: "main" });
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args).toContain("clone");
    expect(calls[0]!.args).toContain("--depth");
    expect(calls[0]!.args).toContain("--branch");
    expect(calls[0]!.args).toContain("main");
  });
});

describe("buildAdaptPrompt", () => {
  it("renders files with instructions and surfaces priority files first", () => {
    const prompt = buildAdaptPrompt({
      "src/index.js": "server code",
      "package.json": '{"name":"thing"}',
      "README.md": "# Thing",
    });
    expect(prompt).toContain("Adapt the following Git repository");
    expect(prompt).toContain("flagship.app.json");
    expect(prompt).toContain("=== package.json ===");
    // package.json (rank 0) appears before src/index.js (rank 2)
    expect(prompt.indexOf("package.json")).toBeLessThan(prompt.indexOf("src/index.js"));
  });

  it("omits files past the size cap and lists them", () => {
    const big = "y".repeat(5000);
    const prompt = buildAdaptPrompt({ "a.js": "small", "b.js": big }, 1000);
    expect(prompt).toContain("omitted for size");
  });
});
