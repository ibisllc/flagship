import { describe, expect, it } from "vitest";
import { deriveIRK, deriveSWK, type AppManifest } from "@flagship/protocol";
import type { FetchLike } from "@flagship/llm-providers";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { AppMembership } from "../src/membership.js";
import { BootCoordinator } from "../src/bootCoordinator.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext, type DeployedApp } from "../src/httpApi.js";
import { ForgejoAppAdmin } from "../src/forgejoServiceAdmin.js";

const umk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(umk);
const swk = deriveSWK(umk, "srv-1");

class NopRunner implements CommandRunner {
  async run(): Promise<void> {}
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeForgejo(handler: (c: Captured) => { ok?: boolean; status?: number; data: unknown }): {
  f: FetchLike;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const f: FetchLike = async (url, init) => {
    const c: Captured = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const reply = handler(c);
    const ok = reply.ok ?? true;
    const status = reply.status ?? 200;
    return {
      ok,
      status,
      async text() {
        return typeof reply.data === "string" ? reply.data : JSON.stringify(reply.data);
      },
      async json() {
        return reply.data;
      },
    };
  };
  return { f, calls };
}

function manifest(over: Partial<AppManifest> = {}): AppManifest {
  return {
    schema_version: 1,
    name: "habit-tracker",
    version: "0.1.0",
    runtime: { image: "img:1", port: 8080 },
    data: { stores: {} },
    network: { subdomain: "habits" },
    access: { enabled: true, default_role: "viewer" },
    migration: { verification: "standard" },
    ...over,
  };
}

describe("ForgejoAppAdmin", () => {
  it("listCommits sends a token-authed GET and parses the response", async () => {
    const { f, calls } = fakeForgejo(() => ({
      data: [
        {
          sha: "abc1234",
          commit: {
            message: "initial",
            author: { name: "Harry", email: "h@x.com", date: "2026-01-01T00:00:00Z" },
          },
        },
      ],
    }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const out = await admin.listCommits("habit-tracker");
    expect(out).toHaveLength(1);
    expect(out[0]!.sha).toBe("abc1234");
    expect(out[0]!.author.name).toBe("Harry");
    expect(calls[0]!.url).toBe(
      "http://forgejo.local/api/v1/repos/harry-flagship/habit-tracker/commits?limit=50",
    );
    expect(calls[0]!.headers.authorization).toBe("token tk");
  });

  it("listPullRequests filters by state", async () => {
    const { f, calls } = fakeForgejo(() => ({
      data: [
        { number: 1, title: "Add x", state: "open", head: { ref: "feat" }, user: { login: "harry" }, created_at: "2026-01-01" },
      ],
    }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await admin.listPullRequests("habits", "closed");
    expect(calls[0]!.url).toContain("state=closed");
  });

  it("mergePr POSTs the squash directive", async () => {
    const { f, calls } = fakeForgejo(() => ({ data: { merged: true } }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const r = await admin.mergePr("habit-tracker", 7, "approved by harry");
    expect(r.merged).toBe(true);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/pulls/7/merge");
    expect((calls[0]!.body as { Do: string }).Do).toBe("squash");
  });

  it("closePr issues a PATCH on the underlying issue (Forgejo's API model)", async () => {
    const { f, calls } = fakeForgejo(() => ({ data: {} }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await admin.closePr("habit-tracker", 7);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/issues/7");
    expect((calls[0]!.body as { state: string }).state).toBe("closed");
  });

  it("createRepo POSTs to /orgs/<org>/repos with auto_init", async () => {
    const { f, calls } = fakeForgejo(() => ({ data: { name: "habits" } }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const r = await admin.createRepo("habits");
    expect(r.created).toBe(true);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://forgejo.local/api/v1/orgs/harry-flagship/repos");
    const body = calls[0]!.body as { name: string; auto_init: boolean; private: boolean; default_branch: string };
    expect(body.name).toBe("habits");
    expect(body.auto_init).toBe(true);
    expect(body.private).toBe(true);
    expect(body.default_branch).toBe("main");
  });

  it("createRepo treats 409/already-exists as not-created (idempotent)", async () => {
    const { f } = fakeForgejo(() => ({
      ok: false,
      status: 409,
      data: "repository name already exists",
    }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const r = await admin.createRepo("habits");
    expect(r.created).toBe(false);
  });

  it("createRepo propagates non-conflict errors", async () => {
    const { f } = fakeForgejo(() => ({ ok: false, status: 500, data: "boom" }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await expect(admin.createRepo("habits")).rejects.toThrow(/500/);
  });

  it("commitFiles tags new files 'create' and existing files 'update' with sha", async () => {
    const seenOps: Array<{ operation: string; path: string; sha?: string }> = [];
    const { f, calls } = fakeForgejo((c) => {
      if (c.url.includes("/git/trees/")) {
        return {
          data: {
            tree: [
              { path: "README.md", type: "blob", sha: "readme-sha" },
              { path: "Dockerfile", type: "blob", sha: "df-sha" },
            ],
          },
        };
      }
      // ChangeFiles endpoint
      const body = c.body as { files: Array<{ operation: string; path: string; sha?: string }> };
      for (const op of body.files) seenOps.push({ operation: op.operation, path: op.path, sha: op.sha });
      return { data: { commit: { sha: "new-commit-sha" } } };
    });
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const r = await admin.commitFiles(
      "habits",
      [
        { path: "Dockerfile", content: "FROM alpine\n" },          // existing → update
        { path: "src/main.js", content: "console.log('x');\n" },   // new → create
      ],
      "deploy v2",
    );
    expect(r.commitSha).toBe("new-commit-sha");
    const dfOp = seenOps.find((o) => o.path === "Dockerfile");
    expect(dfOp?.operation).toBe("update");
    expect(dfOp?.sha).toBe("df-sha");
    const newOp = seenOps.find((o) => o.path === "src/main.js");
    expect(newOp?.operation).toBe("create");
    expect(newOp?.sha).toBeUndefined();
    // ChangeFiles request hit the right endpoint with branch + message
    const changeCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/contents"));
    expect(changeCall).toBeDefined();
    const changeBody = changeCall!.body as { branch: string; message: string };
    expect(changeBody.branch).toBe("main");
    expect(changeBody.message).toBe("deploy v2");
  });

  it("commitFiles base64-encodes content on the wire", async () => {
    const { f } = fakeForgejo((c) => {
      if (c.url.includes("/git/trees/")) return { data: { tree: [] } };
      const body = c.body as { files: Array<{ content: string }> };
      // content must be base64; decoding should give us the original utf8.
      const decoded = Buffer.from(body.files[0]!.content, "base64").toString("utf8");
      expect(decoded).toBe("hello\n");
      return { data: { commit: { sha: "sha1" } } };
    });
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await admin.commitFiles("habits", [{ path: "x.txt", content: "hello\n" }], "init");
  });

  it("commitFiles falls back to all-create when listTreePaths sees an empty repo (404)", async () => {
    const ops: Array<{ operation: string; path: string }> = [];
    const { f } = fakeForgejo((c) => {
      if (c.url.includes("/git/trees/")) {
        return { ok: false, status: 404, data: "branch not found" };
      }
      const body = c.body as { files: Array<{ operation: string; path: string }> };
      for (const op of body.files) ops.push({ operation: op.operation, path: op.path });
      return { data: { commit: { sha: "first-commit" } } };
    });
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const r = await admin.commitFiles(
      "habits",
      [
        { path: "flagship.app.json", content: "{}\n" },
        { path: "Dockerfile", content: "FROM busybox\n" },
      ],
      "first deploy",
    );
    expect(r.commitSha).toBe("first-commit");
    expect(ops.every((o) => o.operation === "create")).toBe(true);
  });

  it("commitFiles rejects an empty file list", async () => {
    const { f } = fakeForgejo(() => ({ data: {} }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await expect(admin.commitFiles("habits", [], "msg")).rejects.toThrow(/at least one file/);
  });

  it("commitFiles rejects unsafe paths (traversal, absolute, empty)", async () => {
    const { f } = fakeForgejo(() => ({ data: {} }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await expect(
      admin.commitFiles("habits", [{ path: "../etc/passwd", content: "x" }], "m"),
    ).rejects.toThrow(/unsafe path/);
    await expect(
      admin.commitFiles("habits", [{ path: "/etc/passwd", content: "x" }], "m"),
    ).rejects.toThrow(/unsafe path/);
    await expect(
      admin.commitFiles("habits", [{ path: "", content: "x" }], "m"),
    ).rejects.toThrow(/empty path/);
  });

  it("commitFiles surfaces ChangeFiles failures", async () => {
    const { f } = fakeForgejo((c) => {
      if (c.url.includes("/git/trees/")) return { data: { tree: [] } };
      return { ok: false, status: 500, data: "internal" };
    });
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    await expect(
      admin.commitFiles("habits", [{ path: "x", content: "y" }], "m"),
    ).rejects.toThrow(/500/);
  });

  it("createRevertPr opens a PR with the right title format", async () => {
    let prCreated = false;
    const { f } = fakeForgejo((c) => {
      if (c.url.endsWith("/branches")) return { data: {} };
      prCreated = true;
      return {
        data: {
          number: 9,
          title: "Revert abc12345",
          state: "open",
          head: { ref: "revert-abc12345-1" },
          user: { login: "system" },
          created_at: "2026-01-01",
        },
      };
    });
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const out = await admin.createRevertPr("habit-tracker", "abc1234567890");
    expect(prCreated).toBe(true);
    expect(out.number).toBe(9);
    expect(out.title).toMatch(/Revert abc12345/);
  });
});

describe("daemon HTTP — /apps/:serviceId/git/*", () => {
  function makeCtx(forgejo?: ForgejoAppAdmin) {
    const apps = new Map<string, AppMembership>();
    apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", ownerIrk.publicKey, swk));
    const sessions = new Map<string, Uint8Array>([["phone-token", ownerIrk.publicKey]]);
    const deployedApps = new Map<string, DeployedApp>();
    deployedApps.set("habit-tracker", { manifest: manifest(), deployedAt: 1 });
    const ctx: DaemonContext = {
      serverId: "srv-1",
      userId: "harry",
      bootCoordinator: new BootCoordinator("srv-1", ownerIrk.publicKey),
      apps,
      resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
      injectors: new Map<string, IdentityInjector>(),
      appRunner: new AppRunner(new NopRunner()),
      deployedApps,
      forgejo,
    };
    return ctx;
  }

  it("returns 503 when no forgejo admin is configured", async () => {
    const http = buildDaemonHttp(makeCtx(undefined));
    const r = await http.inject({
      method: "GET",
      url: "/apps/habit-tracker/git/commits?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(503);
  });

  it("returns the parsed commits list", async () => {
    const { f } = fakeForgejo(() => ({
      data: [{ sha: "deadbeef", commit: { message: "feat: x", author: { name: "harry", email: "", date: "" } } }],
    }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const http = buildDaemonHttp(makeCtx(admin));
    const r = await http.inject({
      method: "GET",
      url: "/apps/habit-tracker/git/commits?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.commits[0].sha).toBe("deadbeef");
  });

  it("rejects invalid PR numbers with 400", async () => {
    const { f } = fakeForgejo(() => ({ data: {} }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const http = buildDaemonHttp(makeCtx(admin));
    const r = await http.inject({
      method: "POST",
      url: "/apps/habit-tracker/git/prs/0/approve?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects malformed commit shas at /revert (must be 7–40 hex chars)", async () => {
    const { f } = fakeForgejo(() => ({ data: {} }));
    const admin = new ForgejoAppAdmin({
      baseUrl: "http://forgejo.local",
      orgName: "harry-flagship",
      serviceToken: "tk",
      fetchImpl: f,
    });
    const http = buildDaemonHttp(makeCtx(admin));
    // "abc" is too short — sha regex rejects.
    const r = await http.inject({
      method: "POST",
      url: "/apps/habit-tracker/git/commits/abc/revert?sessionToken=phone-token",
    });
    expect(r.statusCode).toBe(400);
    // Non-hex characters also rejected.
    const r2 = await http.inject({
      method: "POST",
      url: "/apps/habit-tracker/git/commits/zzzzzzz/revert?sessionToken=phone-token",
    });
    expect(r2.statusCode).toBe(400);
  });
});
