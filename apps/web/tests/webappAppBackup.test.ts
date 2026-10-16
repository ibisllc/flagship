// An app's "Back up now" on the webapp, as iOS and Android do it: the box packs
// the app (data optional, optional password), then this device fetches the
// archive ONCE from /api/backups/<id> with its paired session and saves the
// Blob. A plain <a href> to that path could never send the session header.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}
const loadBackup = () => load("lib/appBackup.js");

async function asset(path: string): Promise<string> {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: path });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const BASE = "https://home.alice.flagship.services";
const FETCH_PATH = "/api/backups/0123456789abcdef0123456789abcdef";

function client(answer: unknown, token = "tok-home") {
  const calls: Array<{ path: string; init: any }> = [];
  return {
    calls,
    baseUrl: BASE,
    token: () => token,
    fetch: async (path: string, init: any) => {
      calls.push({ path, init });
      return answer;
    },
  };
}

function fakeFetch(res: Response) {
  const calls: Array<{ url: string; init: any }> = [];
  const f = async (url: string, init: any) => {
    calls.push({ url, init });
    return res;
  };
  return { calls, f };
}

describe("app backup file name", () => {
  it("is <slug>-backup-<UTC yyyy-MM-dd-HHmm>.tar.gz, .enc when encrypted (iOS's naming)", async () => {
    const { appBackupFileName } = await loadBackup();
    const at = new Date(Date.UTC(2026, 9, 15, 7, 5));
    expect(appBackupFileName("alice--notes", false, at)).toBe("notes-backup-2026-10-15-0705.tar.gz");
    expect(appBackupFileName("alice--notes", true, at)).toBe("notes-backup-2026-10-15-0705.tar.gz.enc");
    expect(appBackupFileName("notes", false, at)).toBe("notes-backup-2026-10-15-0705.tar.gz");
  });
});

describe("Back up now", () => {
  it("asks the box to pack the app with the owner's options, omitting an empty password", async () => {
    const { startAppBackup } = await loadBackup();
    const c = client({ backupId: "ab", fetchPath: FETCH_PATH, encrypted: false, bytes: 3 });
    await startAppBackup({ client: c, serviceId: "alice--notes", includeUserData: true, password: "" });
    expect(c.calls[0]!.path).toBe("/api/screens/app-backup/start");
    expect(c.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(c.calls[0]!.init.body)).toEqual({ serviceId: "alice--notes", includeUserData: true });
    await startAppBackup({ client: c, serviceId: "alice--notes", includeUserData: false, password: "s3cret" });
    expect(JSON.parse(c.calls[1]!.init.body)).toEqual({ serviceId: "alice--notes", includeUserData: false, password: "s3cret" });
  });

  it("refuses an offline-queued start and a start that names no archive", async () => {
    const { startAppBackup } = await loadBackup();
    await expect(startAppBackup({ client: client({ queued: true }), serviceId: "alice--notes" })).rejects.toMatchObject({ status: 0 });
    await expect(startAppBackup({ client: client({ fetchPath: "https://evil.example/x" }), serviceId: "alice--notes" })).rejects.toThrow(/where to fetch/);
  });

  it("fetches the archive from the same box with the session header and hands back a Blob", async () => {
    const { fetchAppBackup } = await loadBackup();
    const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    const { calls, f } = fakeFetch(new Response(bytes, { status: 200, headers: { "content-type": "application/gzip" } }));
    const blob = await fetchAppBackup({ client: client(null), fetchPath: FETCH_PATH, fetchImpl: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}${FETCH_PATH}`);
    expect(calls[0]!.init.headers).toEqual({ "x-flagship-session": "tok-home" });
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("turns a box refusal into a ScreensError with its status, and needs a session", async () => {
    const { fetchAppBackup } = await loadBackup();
    const { ScreensError } = await load("lib/api.js");
    const gone = fakeFetch(new Response(JSON.stringify({ error: "backup not found or expired" }), { status: 404 }));
    const err = await fetchAppBackup({ client: client(null), fetchPath: FETCH_PATH, fetchImpl: gone.f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScreensError);
    expect(err).toMatchObject({ status: 404, message: "backup not found or expired" });
    const never = fakeFetch(new Response(""));
    await expect(fetchAppBackup({ client: client(null, ""), fetchPath: FETCH_PATH, fetchImpl: never.f })).rejects.toMatchObject({ status: 0 });
    await expect(fetchAppBackup({ client: client(null), fetchPath: "/api/screens/x", fetchImpl: never.f })).rejects.toThrow(/invalid backup path/);
    expect(never.calls).toHaveLength(0);
  });

  it("packs, then fetches, reporting each phase, and names the file for the encryption the box applied", async () => {
    const { backUpApp } = await loadBackup();
    const c = client({ backupId: "ab", fetchPath: FETCH_PATH, encrypted: true, bytes: 4 });
    const { f } = fakeFetch(new Response(new Uint8Array([9, 9, 9, 9])));
    const phases: string[] = [];
    const r = await backUpApp({
      client: c,
      serviceId: "alice--notes",
      includeUserData: true,
      password: "pw",
      onPhase: (p: string) => phases.push(p),
      fetchImpl: f,
      now: () => new Date(Date.UTC(2026, 0, 2, 3, 4)),
    });
    expect(phases).toEqual(["creating", "downloading"]);
    expect(r).toMatchObject({ bytes: 4, encrypted: true, fileName: "notes-backup-2026-01-02-0304.tar.gz.enc" });
    expect(r.blob.size).toBe(4);
  });
});

describe("the app page's Backup card", () => {
  it("matches the phones' card: data toggle, optional password, Back up now", async () => {
    const { renderBackupCard, BACKUP_CARD_NOTE } = await load("views/service-detail.js");
    const html: string = renderBackupCard(undefined);
    expect(html).toContain(BACKUP_CARD_NOTE);
    expect(html).toContain('id="sd-include-data"');
    expect(html).toContain("Include the app's data");
    expect(html).toContain('placeholder="Password to encrypt it (optional)"');
    expect(html).toContain(">Back up now</button>");
    expect(html).not.toContain("Last backup");
    expect(renderBackupCard({ backupId: "ab", createdAt: Date.now() - 60_000, bytes: 3 * 1024 * 1024 })).toContain("Last backup: 3.0 MB");
  });

  it("saves through an object URL, never a bare link to the session-gated path; the shell precaches the lib", async () => {
    const detail = await asset("/webapp/views/service-detail.js");
    expect(detail).toContain("backUpApp({");
    expect(detail).toContain("client: boxClient(),");
    expect(detail).toContain("URL.createObjectURL(r.blob)");
    expect(detail).toContain('download="${escapeHtml(r.fileName)}"');
    expect(detail).not.toContain("body.fetchPath}");
    const sw = await asset("/webapp/service-worker.js");
    expect(sw).toContain('"/lib/appBackup.js"');
    expect(sw).toContain('SHELL_VERSION = "v116"');
  });
});
