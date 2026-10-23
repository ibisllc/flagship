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
      // Hermetic: stub the SSRF resolver so the default-clone path never
      // does real DNS. github.com → a public address.
      resolveHost: async () => ["140.82.112.3"],
    });
    await importer.inspect({ gitUrl: "https://github.com/a/b", ref: "main" });
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args).toContain("clone");
    expect(calls[0]!.args).toContain("--depth");
    expect(calls[0]!.args).toContain("--branch");
    expect(calls[0]!.args).toContain("main");
  });
});

describe("GitImporter.inspect — the clone itself is hardened (SEC N02, E04)", () => {
  async function cloneCall(gitUrl: string, resolved: string[]) {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const importer = new GitImporter({
      cmd: { run: async (_c, args, o) => void calls.push({ args, ...(o?.env ? { env: o.env } : {}) }) },
      workingDir: workDir(),
      resolveHost: async () => resolved,
    });
    await importer.inspect({ gitUrl });
    return calls[0]!;
  }
  const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

  it("connects only to the address that was checked, follows no redirect and runs no hooks", async () => {
    const call = await cloneCall("https://example.org:8443/a/b", ["93.184.216.34", "2606:2800:220:1::1"]);
    const c = configs(call.args);
    expect(c).toContain("http.curloptResolve=example.org:8443:93.184.216.34");
    expect(c).toContain("http.curloptResolve=example.org:8443:[2606:2800:220:1::1]");
    expect(c).toContain("http.followRedirects=false");
    expect(c).toContain("core.hooksPath=/dev/null");
    expect(c).toContain("credential.helper=");
    expect(c).toContain("protocol.allow=never");
    expect(c).toContain("protocol.https.allow=always");
    expect(call.args).toContain("--no-recurse-submodules");
    expect(call.args.indexOf("clone")).toBeGreaterThan(call.args.lastIndexOf("-c"));
  });

  it("hands git nothing of the daemon's environment", async () => {
    process.env["FLAGSHIP_TEST_SECRET"] = "s3cret";
    try {
      const call = await cloneCall("https://github.com/a/b", ["140.82.112.3"]);
      expect(call.env).toBeDefined();
      expect(Object.keys(call.env!)).not.toContain("FLAGSHIP_TEST_SECRET");
      expect(JSON.stringify(call.env)).not.toContain("s3cret");
      expect(call.env!["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      expect(call.env!["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
      expect(call.env!["GIT_ALLOW_PROTOCOL"]).toBe("https:http");
    } finally {
      delete process.env["FLAGSHIP_TEST_SECRET"];
    }
  });

  it.each([
    ["an IPv4-mapped loopback written in hex", "::ffff:7f00:1"],
    ["an expanded IPv6 loopback", "0:0:0:0:0:0:0:1"],
    ["the metadata address, mapped", "::ffff:a9fe:a9fe"],
  ])("refuses a name that resolves to %s", async (_n, addr) => {
    let cloned = false;
    const importer = new GitImporter({
      cmd: { run: async () => void (cloned = true) },
      workingDir: workDir(),
      resolveHost: async () => [addr],
    });
    const r = await importer.inspect({ gitUrl: "https://rebind.example/a/b" });
    expect(r.fit).toBe(false);
    expect(cloned).toBe(false);
  });
});

describe("GitImporter.inspect — SSRF guard on the clone host", () => {
  it("rejects a clone URL pointing at a literal loopback IP (no clone)", async () => {
    let cloned = false;
    const importer = new GitImporter({
      cmd: { run: async () => void (cloned = true) },
      workingDir: workDir(),
      resolveHost: async () => [], // never reached for a literal IP
    });
    const r = await importer.inspect({ gitUrl: "http://127.0.0.1:6379/x" });
    expect(r.fit).toBe(false);
    expect(r.reason).toContain("unsafe clone host");
    expect(cloned).toBe(false);
  });

  it("rejects a public clone host that RESOLVES to loopback (DNS bypass)", async () => {
    let cloned = false;
    const importer = new GitImporter({
      cmd: { run: async () => void (cloned = true) },
      workingDir: workDir(),
      resolveHost: async () => ["127.0.0.1"],
    });
    const r = await importer.inspect({ gitUrl: "https://localtest.me/a/b" });
    expect(r.fit).toBe(false);
    expect(r.reason).toContain("unsafe clone host");
    expect(cloned).toBe(false);
  });

  it("rejects a public clone host that resolves to the cloud metadata IP", async () => {
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      resolveHost: async () => ["169.254.169.254"],
    });
    const r = await importer.inspect({ gitUrl: "https://evil.example.com/a/b", buildId: "g3" });
    expect(r.fit).toBe(false);
    expect(r.reason).toContain("unsafe clone host");
  });

  it("permits an allowlisted internal Forgejo host (self-host override)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const importer = new GitImporter({
      cmd: { run: async (cmd, args) => void calls.push({ cmd, args }) },
      workingDir: workDir(),
      hostGuard: { hostAllowlist: ["forgejo.lan"] },
      resolveHost: async () => {
        throw new Error("resolver should be skipped for an allowlisted host");
      },
    });
    await importer.inspect({ gitUrl: "https://forgejo.lan/team/app" });
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args).toContain("clone");
  });

  it("permits a resolved-private clone host when allowPrivate is set", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const importer = new GitImporter({
      cmd: { run: async (cmd, args) => void calls.push({ cmd, args }) },
      workingDir: workDir(),
      hostGuard: { allowPrivate: true },
      resolveHost: async () => ["192.168.1.20"],
    });
    await importer.inspect({ gitUrl: "https://forgejo.lan/team/app" });
    expect(calls[0]!.cmd).toBe("git");
  });

  it("does NOT run the SSRF check when a cloneInto override supplies bytes", async () => {
    // A `cloneInto` override never opens a socket; the host is irrelevant.
    const importer = new GitImporter({
      cmd: noopCmd,
      workingDir: workDir(),
      cloneInto: fixtureClone({ "flagship.app.json": VALID_MANIFEST }),
      resolveHost: async () => {
        throw new Error("resolver should not be consulted on the cloneInto path");
      },
    });
    const r = await importer.inspect({ gitUrl: "https://github.com/alice/shopping" });
    expect(r.fit).toBe(true);
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
