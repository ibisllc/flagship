import { describe, expect, it, vi } from "vitest";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS module
import * as archive from "../public/webapp/lib/serverArchive.js";
// @ts-expect-error plain JS module
import { boxEntryRow, mergeFeed } from "../public/webapp/lib/activityFeed.js";
// @ts-expect-error plain JS module
import { deriveServerArchiveKeyFromSeed } from "../public/webapp/keystore.js";
// @ts-expect-error plain JS module
import { importTargets } from "../public/webapp/views/import-backup.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/protocol/test-vectors/server-archive/vectors.json"), "utf8"),
) as { cases: Array<{ umkSeedHex: string; archiveIdHex: string; keyHex: string }>; invalidArchiveIds: string[] };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("the webapp's archive key", () => {
  it.each(V.cases.map((c) => [c.archiveIdHex, c] as const))("matches the shared vector %s", async (_id, c) => {
    expect(hex(await deriveServerArchiveKeyFromSeed(seed(c.umkSeedHex), c.archiveIdHex))).toBe(c.keyHex);
  });
  it.each(V.invalidArchiveIds.map((r) => [JSON.stringify(r), r] as const))("refuses id %s", async (_l, r) => {
    await expect(deriveServerArchiveKeyFromSeed(seed(V.cases[0]!.umkSeedHex), r)).rejects.toThrow();
  });
  it("is the same HKDF the box side uses", async () => {
    const c = V.cases[0]!;
    const direct = hkdf(sha256, seed(c.umkSeedHex), new Uint8Array(0), new TextEncoder().encode(`flagship/server-archive/v1|${c.archiveIdHex}`), 32);
    expect(hex(direct)).toBe(c.keyHex);
  });
});

function headerFile(extra: Record<string, unknown> = {}, bytes = 100) {
  const h = { magic: "flagship-archive", v: 1, archiveId: "00112233445566778899aabbccddeeff", createdAt: 5, sourceServer: "home.alice.flagship.services", frameBytes: 1048576, apps: [{ serviceId: "alice--wiki", name: "Wiki" }], ...extra };
  const buf = Buffer.concat([Buffer.from(`${JSON.stringify(h)}\n`), Buffer.alloc(bytes, 1)]);
  return new Blob([buf]);
}

describe("reading a picked file", () => {
  it("reads the header", async () => {
    const h = await archive.readArchiveHeader(headerFile());
    expect(h).toMatchObject({ archiveId: "00112233445566778899aabbccddeeff", sourceServer: "home.alice.flagship.services", apps: [{ name: "Wiki" }] });
  });
  it.each([
    [new Blob(["hello"]), /isn't a Flagship backup/],
    [headerFile({ magic: "other" }), /isn't a Flagship backup/],
    [headerFile({ v: 2 }), /newer version/],
    [headerFile({ archiveId: "xx" }), /damaged/],
  ])("refuses a bad file %#", async (f, why) => {
    await expect(archive.readArchiveHeader(f)).rejects.toThrow(why);
  });
});

describe("backup and import calls", () => {
  it("starts a backup with an id and the derived key, never the UMK", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const client = {
      fetch: async (path: string, init: any) => {
        if (!init) return { archive: null };
        calls.push({ path, body: JSON.parse(init.body) });
      },
    };
    const umk = seed(V.cases[0]!.umkSeedHex);
    const id = await archive.startServerBackup({ client, umk, rng: () => seed(V.cases[0]!.archiveIdHex) });
    expect(id).toBe(V.cases[0]!.archiveIdHex);
    expect(calls[0]).toEqual({ path: "/api/screens/server-archive/start", body: { archiveId: id, key: V.cases[0]!.keyHex } });
    expect(JSON.stringify(calls)).not.toContain(V.cases[0]!.umkSeedHex);
  });

  it("follows a backup already being made instead of starting another", async () => {
    const posts: string[] = [];
    const client = {
      fetch: async (path: string, init: any) => {
        if (!init) return { archive: { archiveId: "aa".repeat(16), state: "building" } };
        posts.push(path);
      },
    };
    expect(await archive.startServerBackup({ client, umk: seed(V.cases[0]!.umkSeedHex) })).toBe("aa".repeat(16));
    expect(posts).toEqual([]);
  });

  it("uploads in order, then commits with the key for the archive's own id", async () => {
    const puts: number[] = [];
    const posts: string[] = [];
    const client = {
      baseUrl: "https://clone.alice.flagship.services",
      token: () => "tok",
      fetch: vi.fn(async (path: string, init: any) => void posts.push(`${path} ${init.body}`)),
    };
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(init.method).toBe("POST");
      puts.push(Number(new URL(url).searchParams.get("offset")));
      expect(init.headers["x-flagship-session"]).toBe("tok");
      return new Response(JSON.stringify({ received: 1 }), { status: 200 });
    });
    const file = headerFile({ archiveId: V.cases[0]!.archiveIdHex }, archive.UPLOAD_CHUNK_BYTES + 10);
    await archive.importBackup({ client, file, umk: seed(V.cases[0]!.umkSeedHex), fetchImpl });
    expect(puts).toEqual([0, archive.UPLOAD_CHUNK_BYTES]);
    expect(posts[0]).toContain("server-restore/start");
    expect(posts[1]).toContain(V.cases[0]!.keyHex);
  });

  it("shows the server's own words when a chunk is refused", async () => {
    const client = { baseUrl: "https://x", token: () => "t", fetch: async () => ({}) };
    const fetchImpl = async () => new Response(JSON.stringify({ error: "chunk out of order" }), { status: 409 });
    await expect(archive.importBackup({ client, file: headerFile({ archiveId: V.cases[0]!.archiveIdHex }), umk: seed(V.cases[0]!.umkSeedHex), fetchImpl })).rejects.toThrow("chunk out of order");
  });

  it("names the saved file after the server and the day", () => {
    expect(archive.backupFileName("Home.alice.flagship.services", Date.UTC(2026, 9, 15))).toBe("Home-2026-10-15.flagship-backup");
  });
  it("sizes read the way people say them", () => {
    expect(archive.formatBytes(900 * 1024)).toBe("900 KB");
    expect(archive.formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(archive.formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("import targets", () => {
  it("lists only online servers this device has a session for", () => {
    const now = 1_000_000;
    const pods = [
      { serverDomain: "a.alice.flagship.services", online: true, lastReportAt: now },
      { serverDomain: "b.alice.flagship.services", online: false, lastReportAt: 0 },
    ];
    const got = importTargets(pods, { hasSession: () => true, now });
    expect(got.map((t: any) => t.fqdn)).not.toContain("b.alice.flagship.services");
    for (const t of got) expect(t.label).not.toContain("[object");
  });
});

describe("the Activity list", () => {
  it("labels box events and drops the generic write lines", () => {
    expect(boxEntryRow({ ts: 1, seq: 1, actor: { kind: "owner" }, action: "post /api/screens/x", ok: true })).toBeNull();
    expect(boxEntryRow({ ts: 1, seq: 2, actor: { kind: "owner" }, action: "server.backup.created", kind: "server.backup.created", detail: "Backup ready: 2 apps.", ok: true })).toMatchObject({ title: "Backup ready", detail: "Backup ready: 2 apps.", ok: true });
    expect(boxEntryRow({ ts: 1, seq: 3, actor: { kind: "share", shareId: "s", label: "Sam" }, action: "share.granted", ok: true })).toMatchObject({ title: "Shared this server by Sam" });
    expect(boxEntryRow({ ts: 1, seq: 4, actor: { kind: "owner" }, action: "x", kind: "server.something.new", ok: false })).toMatchObject({ title: "Server something new", ok: false });
  });
  it("merges both sources newest first", () => {
    const rows = mergeFeed({
      boxes: [{ serverName: "home", entries: [{ ts: 30, seq: 1, actor: { kind: "owner" }, action: "app.installed", kind: "app.installed", ok: true }] }],
      audit: [{ postedAt: 40, eventKind: "server-migration-taken-over" }, { postedAt: 10, eventKind: "device-added" }],
      auditLabel: (k: string) => k,
      auditIcon: () => "i",
      auditDetail: () => "",
    });
    expect(rows.map((r: any) => r.at)).toEqual([40, 30, 10]);
    expect(rows[1]).toMatchObject({ source: "server", server: "home" });
  });
});
