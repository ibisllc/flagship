import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppBackupService } from "../src/appBackup.js";
import { buildAppBackupHttpHandlers } from "../src/appBackupHttp.js";
import type { PairedSessionGate } from "../src/alertInboxHttp.js";
import type { HttpRequest } from "../src/runtime.js";

const TOKEN = "paired-session-token-123";

const gate: PairedSessionGate = {
  check(req: HttpRequest) {
    const auth = req.headers["authorization"];
    if (auth === `Flagship-Session ${TOKEN}`) return null;
    return {
      status: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "missing paired-session token" }),
    };
  },
};

function req(opts: { method?: string; path: string; token?: string }): HttpRequest {
  return {
    method: opts.method ?? "GET",
    path: opts.path,
    headers: opts.token ? { authorization: `Flagship-Session ${opts.token}` } : {},
    body: Buffer.alloc(0),
  };
}

describe("/api/backups/<id>", () => {
  let workdir: { dir: string; cleanup: () => Promise<void> };
  let svc: AppBackupService;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "appbackup-http-test-"));
    workdir = { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
    const sourceDir = join(dir, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "flagship.app.json"), '{"name":"x"}', "utf8");
    svc = new AppBackupService({
      backupDir: join(dir, "backups"),
      resolveSource: async () => sourceDir,
    });
  });
  afterEach(async () => {
    await workdir.cleanup();
  });

  it("returns the backup bytes when the paired-session token is valid", async () => {
    const rec = await svc.createBackup({ creator: "alice", slug: "x", includeUserData: false });
    const handle = buildAppBackupHttpHandlers({ backups: svc, gate });
    const r = await handle(req({ path: rec.fetchPath, token: TOKEN }));
    expect(r?.status).toBe(200);
    expect((r!.body as Buffer).length).toBeGreaterThan(0);
    expect(r!.headers?.["content-type"]).toBe("application/gzip");
    expect(r!.headers?.["x-flagship-encrypted"]).toBe("0");
  });

  it("returns 401 without a paired-session token", async () => {
    const rec = await svc.createBackup({ creator: "alice", slug: "x", includeUserData: false });
    const handle = buildAppBackupHttpHandlers({ backups: svc, gate });
    const r = await handle(req({ path: rec.fetchPath })); // no token
    expect(r?.status).toBe(401);
  });

  it("returns 404 for an unknown backupId", async () => {
    const handle = buildAppBackupHttpHandlers({ backups: svc, gate });
    const r = await handle(req({ path: "/api/backups/0123456789abcdef", token: TOKEN }));
    expect(r?.status).toBe(404);
  });

  it("rejects malformed backupId", async () => {
    const handle = buildAppBackupHttpHandlers({ backups: svc, gate });
    const r = await handle(req({ path: "/api/backups/NOT-HEX!", token: TOKEN }));
    expect(r?.status).toBe(400);
  });

  it("evicts after fetch — second GET 404s", async () => {
    const rec = await svc.createBackup({ creator: "alice", slug: "x", includeUserData: false });
    const handle = buildAppBackupHttpHandlers({ backups: svc, gate });
    const r1 = await handle(req({ path: rec.fetchPath, token: TOKEN }));
    expect(r1?.status).toBe(200);
    // wait for the stream's close → evict scheduling
    await new Promise((r) => setTimeout(r, 30));
    const r2 = await handle(req({ path: rec.fetchPath, token: TOKEN }));
    expect(r2?.status).toBe(404);
  });

  it("encrypted backup returns octet-stream + x-flagship-encrypted=1", async () => {
    const rec = await svc.createBackup({
      creator: "alice",
      slug: "x",
      includeUserData: false,
      password: "pw",
    });
    const handle = buildAppBackupHttpHandlers({ backups: svc, gate });
    const r = await handle(req({ path: rec.fetchPath, token: TOKEN }));
    expect(r?.status).toBe(200);
    expect(r!.headers?.["content-type"]).toBe("application/octet-stream");
    expect(r!.headers?.["x-flagship-encrypted"]).toBe("1");
  });
});
