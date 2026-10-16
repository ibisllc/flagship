import { describe, expect, it, vi } from "vitest";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS module
import * as archive from "../public/webapp/lib/serverArchive.js";
// @ts-expect-error plain JS module
import * as fmt from "../public/webapp/lib/serverBackupFormat.js";
// @ts-expect-error plain JS module
import { boxEntryRow, mergeFeed } from "../public/webapp/lib/activityFeed.js";
// @ts-expect-error plain JS module
import { deriveServerArchiveKeyFromSeed, signWithIrk } from "../public/webapp/keystore.js";
// @ts-expect-error plain JS module
import { restoreNameFor, restoreNameProblem, serverWaitingFor, takenServerNames, savedSettingsLine } from "../public/webapp/views/import-backup.js";
// @ts-expect-error plain JS module
import { classifyServer, statusBucketForKind, renderServerCard } from "../public/webapp/views/home.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(here, "../../..", path), "utf8"));
const V = read("packages/protocol/test-vectors/server-archive/vectors.json") as { cases: Array<{ umkSeedHex: string; archiveIdHex: string; keyHex: string }>; invalidArchiveIds: string[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const B = read("packages/protocol/test-vectors/server-backup/vectors.json") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R = read("packages/protocol/test-vectors/server-restore/vectors.json") as any;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("the webapp's account key for backups", () => {
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

describe("server-backup vectors (webapp port)", () => {
  it("derives both slot keys, including Argon2id at the default cost", async () => {
    expect(hex(await deriveServerArchiveKeyFromSeed(seed(B.umkSeedHex), B.archiveId))).toBe(B.accountKekHex);
    expect(hex(await fmt.passcodeKek(B.passcode, B.slots.passcode.kdf))).toBe(B.passcodeKekHex);
    expect(hex(await fmt.passcodeKek(B.defaultParamsKdf.passcode, B.defaultParamsKdf.kdf))).toBe(B.defaultParamsKdf.kekHex);
  }, 60_000);

  it("normalizes passcodes", async () => {
    for (const n of B.normalize) expect(hex(await fmt.passcodeKek(n.input, B.slots.passcode.kdf))).toBe(n.kekHex);
  });

  it("re-creates the slots and the file byte for byte", async () => {
    const key = seed(B.contentKeyHex);
    const n = B.slotNonces;
    const p = await fmt.wrapPasscodeSlot(B.archiveId, key, B.passcode, seed(n.passcodeSaltHex), seed(n.passcodeNonceHex), B.slots.passcode.kdf);
    const a = await fmt.wrapAccountSlot(B.archiveId, key, seed(B.accountKekHex), seed(n.accountNonceHex));
    expect(p).toEqual(B.slots.passcode);
    expect(a).toEqual(B.slots.account);
    expect(fmt.serializeBackupFile(await fmt.sealBackupFile(B.archiveId, key, [p, a], B.body, seed(n.bodyNonceHex)))).toBe(B.file);
  });

  it("opens with the account key or the passcode, and refuses the wrong ones", async () => {
    const f = fmt.parseBackupFile(B.file);
    const viaAccount = await fmt.openWithAccountKey(f, seed(B.accountKekHex));
    expect(hex(viaAccount.contentKey)).toBe(B.contentKeyHex);
    expect(viaAccount.body).toEqual(B.body);
    const viaPass = await fmt.openWithPasscode(f, B.passcode);
    expect(viaPass.body).toEqual(B.body);
    await expect(fmt.openWithPasscode(f, B.wrongPasscode)).rejects.toThrow(/doesn't open/);
    const other = await deriveServerArchiveKeyFromSeed(seed(B.wrongUmkSeedHex), B.archiveId);
    expect(await fmt.openWithAccountKey(f, other)).toBeNull();
  });

  it.each(B.tampered.map((t: { why: string }) => [t.why, t]))("refuses a tampered file: %s", async (why, t) => {
    const f = fmt.parseBackupFile((t as { file: string }).file);
    await expect(fmt.openWithPasscode(f, B.passcode)).rejects.toThrow();
    const acct = await fmt.openWithAccountKey(f, seed(B.accountKekHex)).catch(() => null);
    if (why === "passcode params changed") expect(acct?.via).toBe("account");
    else expect(acct).toBeNull();
  });

  it.each(B.malformed.map((t: { why: string }) => [t.why, t]))("refuses a malformed file: %s", (_why, t) => {
    const m = t as { file: string; code: string };
    let err: { code?: string } | null = null;
    try {
      fmt.parseBackupFile(m.file);
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe(m.code);
  });

  it("generates passcodes and applies the rules", () => {
    const bytes = seed(B.generatedPasscode.rngBytesHex);
    let i = 0;
    expect(fmt.generatePasscode((n: number) => bytes.slice(i, (i += n)))).toBe(B.generatedPasscode.passcode);
    for (const p of B.passcodeRules.ok) expect(fmt.passcodeProblem(p)).toBeNull();
    for (const p of B.passcodeRules.weak) expect(fmt.passcodeProblem(p)).not.toBeNull();
    expect(fmt.BACKUP_PASSCODE_ALPHABET).toBe(B.alphabet);
  });
});

describe("server-restore vectors (webapp port)", () => {
  it.each(R.cases.map((c: unknown, i: number) => [i, c]))("signs case #%i beside the pairing order", async (_i, c) => {
    const k = c as { order: { serverDomain: string; archiveId: string; bytes: number; sha256: string; issuedAt: number }; canonical: string; signature: string };
    expect(new TextDecoder().decode(fmt.serverRestoreCanonicalBytes(k.order))).toBe(k.canonical);
    const json = await fmt.attachRestoreOrder(JSON.stringify({ request: { type: "add-paired-session" }, signature: "ab" }), {
      ...k.order,
      sign: (bytes: Uint8Array) => signWithIrk(seed(R.umkSeedHex), bytes),
    });
    const o = JSON.parse(json);
    expect(o.request).toEqual({ type: "add-paired-session" });
    expect(o.restore).toEqual({ order: k.order, signatureHex: k.signature });
  });
  it.each(R.invalid.map((c: unknown, i: number) => [i, c]))("refuses invalid #%i", (_i, c) => {
    expect(() => fmt.serverRestoreCanonicalBytes(c)).toThrow();
  });
});

describe("picked files", () => {
  const dataBlob = (body: Buffer) => new Blob([Buffer.concat([Buffer.from(fmt.BACKUP_DATA_MAGIC), body])]);
  it("tells the backup file from the data file", async () => {
    expect(await fmt.classifyPicked(new Blob([B.file]))).toBe("backup");
    expect(await fmt.classifyPicked(dataBlob(Buffer.alloc(10)))).toBe("data");
    expect(await fmt.classifyPicked(new Blob(["hello"]))).toBeNull();
    expect(await fmt.classifyPicked(new Blob(['{"magic":"other"}']))).toBeNull();
  });
  it("checks the data file's size and SHA-256 in slices", async () => {
    const blob = dataBlob(Buffer.alloc(5000, 3));
    const raw = Buffer.from(await blob.arrayBuffer());
    const data = { fileName: "home.flagship-data", bytes: raw.length, sha256: hex(sha256(raw)), frameBytes: 1048576 };
    const seen: number[] = [];
    await fmt.checkDataFile(blob, data, { sliceBytes: 1000, onProgress: (n: number) => seen.push(n) });
    expect(seen.at(-1)).toBe(raw.length);
    expect(seen.length).toBe(Math.ceil(raw.length / 1000));
    await expect(fmt.checkDataFile(blob, { ...data, bytes: raw.length + 1 })).rejects.toThrow(/isn't this backup's/);
    await expect(fmt.checkDataFile(blob, { ...data, sha256: "00".repeat(32) })).rejects.toThrow(/doesn't match/);
    const notData = new Blob([Buffer.alloc(raw.length, 1)]);
    await expect(fmt.checkDataFile(notData, data)).rejects.toThrow(/isn't a Flagship backup's data file/);
  });
});

describe("backup and restore calls", () => {
  it("starts a backup with the content key and both slots, never the UMK or the passcode", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const client = {
      fetch: async (path: string, init: any) => {
        if (!init) return { archive: null };
        calls.push({ path, body: JSON.parse(init.body) });
      },
    };
    const umk = seed(B.umkSeedHex);
    const id = await archive.startServerBackup({ client, umk, passcode: B.passcode, argonParams: { m: 64, t: 1, p: 1 } });
    expect(calls).toHaveLength(1);
    const { archiveId, key, slots } = calls[0]!.body;
    expect(archiveId).toBe(id);
    expect(slots.map((s: any) => s.kind)).toEqual(["passcode", "account"]);
    // The slots the box writes open with both the passcode and this account.
    const file = fmt.parseBackupFile(fmt.serializeBackupFile(await fmt.sealBackupFile(archiveId, seed(key), slots, B.body, new Uint8Array(12))));
    expect(hex((await fmt.openWithPasscode(file, B.passcode)).contentKey)).toBe(key);
    expect(hex((await fmt.openWithAccountKey(file, await deriveServerArchiveKeyFromSeed(umk, archiveId))).contentKey)).toBe(key);
    expect(JSON.stringify(calls)).not.toContain(B.umkSeedHex);
    expect(JSON.stringify(calls)).not.toContain(B.passcode);
  });

  it("follows a backup already being made instead of starting another", async () => {
    const posts: string[] = [];
    const client = {
      fetch: async (path: string, init: any) => {
        if (!init) return { archive: { archiveId: "aa".repeat(16), state: "building" } };
        posts.push(path);
      },
    };
    expect(await archive.startServerBackup({ client, umk: seed(B.umkSeedHex) })).toBe("aa".repeat(16));
    expect(posts).toEqual([]);
  });

  it("shows a finished backup again when the dialog reopens, and a new passcode starts a new one", async () => {
    const posts: string[] = [];
    const client = {
      fetch: async (path: string, init: any) => {
        if (!init) return { archive: { archiveId: "bb".repeat(16), state: "ready" } };
        posts.push(path);
      },
    };
    expect(await archive.startServerBackup({ client, umk: seed(B.umkSeedHex) })).toBe("bb".repeat(16));
    expect(posts).toEqual([]);
    const id = await archive.startServerBackup({ client, umk: seed(B.umkSeedHex), passcode: B.passcode, argonParams: { m: 64, t: 1, p: 1 } });
    expect(id).not.toBe("bb".repeat(16));
    expect(posts).toHaveLength(1);
  });

  it("uploads from where the server has got to, and follows its count after a refusal", async () => {
    const offsets: number[] = [];
    const client = {
      baseUrl: "https://clone.alice.flagship.services",
      token: () => "tok",
      fetch: vi.fn(async () => ({ archiveId: "aa", received: 3 })),
    };
    let refused = false;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      expect(init.headers["x-flagship-session"]).toBe("tok");
      if (offset === 7 && !refused) {
        refused = true;
        return new Response(JSON.stringify({ error: "chunk out of order", received: 5 }), { status: 409 });
      }
      return new Response(JSON.stringify({ received: offset + init.body.length }), { status: 200 });
    });
    await archive.uploadDataFile({ client, blob: new Blob([Buffer.alloc(12)]), archiveId: "aa", fetchImpl, chunkBytes: 4 });
    expect(offsets).toEqual([3, 7, 5, 9]);
  });

  it("shows the server's own words when a chunk is refused", async () => {
    const client = { baseUrl: "https://x", token: () => "t", fetch: async () => ({ received: 0 }) };
    const fetchImpl = async () => new Response(JSON.stringify({ error: "bad chunk size" }), { status: 400 });
    const e = await archive.uploadDataFile({ client, blob: new Blob(["abc"]), archiveId: "aa", fetchImpl }).catch((x: unknown) => x);
    expect(archive.archiveErrorText(e)).toBe("Bad chunk size.");
  });

  it("hands over the content key, and shows the restore's own reason when it fails", async () => {
    const posts: any[] = [];
    await archive.commitRestore({ client: { fetch: async (p: string, i: any) => void posts.push([p, JSON.parse(i.body)]) }, contentKey: seed(B.contentKeyHex) });
    expect(posts).toEqual([["/api/screens/server-restore/commit", { key: B.contentKeyHex }]]);
    const client = { fetch: async () => ({ waiting: { archiveId: "aa" }, restore: { state: "failed", reason: "wrong key" } }) };
    const e = await archive.waitForRestore({ client }).catch((x: unknown) => x);
    expect(archive.archiveErrorText(e)).toBe("The restore failed: wrong key.");
  });

  it("downloading here approves a fresh request, then lets the browser fetch both files", async () => {
    const calls: string[] = [];
    const client = {
      baseUrl: "https://home.alice.flagship.services",
      fetch: async (path: string) => {
        calls.push(path);
        return path.endsWith("/link") ? { path: `/api/archive-download/${"ab".repeat(32)}`, backupFileName: "home.flagship-backup", dataFileName: "home.flagship-data", expiresAt: 1 } : {};
      },
    };
    const clicked: Array<{ href: string; download: string }> = [];
    const doc = { body: { appendChild: () => {} }, createElement: () => ({ click() { clicked.push({ href: (this as any).href, download: (this as any).download }); }, remove() {} }) };
    await archive.downloadHere({
      client,
      serverDomain: "home.alice.flagship.services",
      archiveId: "00112233445566778899aabbccddeeff",
      umk: seed(B.umkSeedHex),
      signWithIrk: async () => new Uint8Array(64),
      rng: () => seed("0f1e2d3c4b5a69788796a5b4c3d2e1f0"),
      doc,
      gapMs: 0,
    });
    const base = `https://home.alice.flagship.services/api/archive-download/${"ab".repeat(32)}`;
    expect(calls).toEqual(["/api/screens/server-archive/link", "/api/screens/server-archive/approve"]);
    expect(clicked).toEqual([
      { href: `${base}/backup?r=0f1e2d3c4b5a69788796a5b4c3d2e1f0`, download: "home.flagship-backup" },
      { href: `${base}/file?r=0f1e2d3c4b5a69788796a5b4c3d2e1f0`, download: "home.flagship-data" },
    ]);
  });

  it("names the two files after the server and the day", () => {
    expect(archive.backupFileNames("Home.alice.flagship.services", Date.UTC(2026, 9, 15))).toEqual({
      backup: "Home-2026-10-15.flagship-backup",
      data: "Home-2026-10-15.flagship-data",
    });
  });
  it("sizes read the way people say them", () => {
    expect(archive.formatBytes(900 * 1024)).toBe("900 KB");
    expect(archive.formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(archive.formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
  it("routes the download approval to the admin root like every owner order", async () => {
    // @ts-expect-error plain JS module
    const { SENSITIVE_TAGS } = await import("../public/webapp/lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/archive-download/v1")).toBe(true);
  });
});

describe("the restore form", () => {
  const pods = [
    { serverDomain: "home.alice.flagship.services" },
    { serverDomain: "old.alice.flagship.services", revokedAt: 5 },
    { serverDomain: "clone.alice.flagship.services", awaitingBackup: { archiveId: "aa".repeat(16), state: "waiting" } },
  ];
  const pending = [{ fqdn: "new.alice.flagship.services", serverName: "new" }];
  const taken = takenServerNames(pods, pending);

  it("fills in the saved name only when the account doesn't use it", () => {
    expect([...taken].sort()).toEqual(["clone", "home", "new", "old"]);
    expect(restoreNameFor("home", taken)).toBe("");
    expect(restoreNameFor("media", taken)).toBe("media");
    expect(restoreNameFor("www", taken)).toBe("");
  });
  it("checks names as the user types", () => {
    expect(restoreNameProblem("home", taken)).toMatch(/already have a server called "home"/);
    expect(restoreNameProblem("-bad", taken)).toMatch(/Lowercase/);
    expect(restoreNameProblem("", taken)).toMatch(/Pick a name/);
    expect(restoreNameProblem("media", taken)).toBeNull();
  });
  it("finds a server waiting for this backup", () => {
    expect(serverWaitingFor(pods, "aa".repeat(16))).toBe("clone.alice.flagship.services");
    expect(serverWaitingFor(pods, "bb".repeat(16))).toBeNull();
  });
  it("says which settings come from the backup", () => {
    expect(savedSettingsLine({ bootUnlockMode: "approve", diskEncryption: "luks" })).toMatch(/asks your phone at every start, disk encrypted/);
  });
});

describe("Home shows a server waiting for its backup", () => {
  const server = { serverId: "clone.alice.flagship.services" };
  const pod = (awaitingBackup: unknown) => ({ liveness: "live", lastReported: Date.now(), awaitingBackup });
  it("labels it, keeps it out of the online bucket, and offers Send and Delete", () => {
    const c = classifyServer(server, pod({ archiveId: "aa".repeat(16), state: "waiting" }));
    expect(c).toEqual({ kind: "awaiting-backup", label: "Waiting for its backup" });
    expect(statusBucketForKind(c.kind)).toBe("pending");
    expect(classifyServer(server, pod({ archiveId: "aa".repeat(16), state: "restoring" })).label).toBe("Restoring its backup");
    const html = renderServerCard(server, pod({ archiveId: "aa".repeat(16), state: "waiting" }));
    expect(html).toContain("js-send-backup");
    expect(html).toContain("js-delete-server");
    expect(classifyServer(server, pod(undefined)).kind).toBe("online");
  });
});

describe("the Activity list", () => {
  it("labels box events and drops the generic write lines", () => {
    expect(boxEntryRow({ ts: 1, seq: 1, actor: { kind: "owner" }, action: "post /api/screens/x", ok: true })).toBeNull();
    expect(boxEntryRow({ ts: 1, seq: 2, actor: { kind: "owner" }, action: "server.backup.created", kind: "server.backup.created", detail: "Backup ready: 2 apps.", ok: true })).toMatchObject({ title: "Backup ready", detail: "Backup ready: 2 apps.", ok: true });
    expect(boxEntryRow({ ts: 1, seq: 3, actor: { kind: "share", shareId: "s", label: "Sam" }, action: "share.granted", ok: true })).toMatchObject({ title: "Shared this server by Sam" });
    expect(boxEntryRow({ ts: 1, seq: 4, actor: { kind: "owner" }, action: "x", kind: "server.something.new", ok: false })).toMatchObject({ title: "Server something new", icon: "⚠️", ok: false });
    expect(boxEntryRow({ ts: 1, seq: 5, actor: { kind: "owner" }, action: "x", kind: "server.something.newer", ok: true })).toMatchObject({ title: "Server something newer", icon: "•" });
  });
  it("shows a corrupt state file as a warning with the box's detail", () => {
    const detail = "service-access.json couldn't be read and was set aside. Every app on this server is members-only until you open it again.";
    expect(boxEntryRow({ ts: 1, seq: 6, actor: { kind: "owner" }, action: "server.state.corrupt", kind: "server.state.corrupt", detail, ok: false })).toMatchObject({
      title: "This server found a damaged settings file and locked it down",
      icon: "⚠️",
      detail,
      ok: false,
    });
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

describe("browser download approval (flagship/archive-download/v1)", () => {
  const AD = read("packages/protocol/test-vectors/archive-download/vectors.json") as { umkSeedHex: string; cases: Array<{ serverDomain: string; archiveId: string; requestId: string; issuedAt: number; canonical: string; code: string; signature: string }>; invalid: any[] };

  it("matches the shared vectors: canonical bytes, code, and the IRK signature", async () => {
    for (const c of AD.cases) {
      const a = { serverDomain: c.serverDomain, archiveId: c.archiveId, requestId: c.requestId, issuedAt: c.issuedAt };
      expect(new TextDecoder().decode(archive.archiveDownloadCanonicalBytes(a))).toBe(c.canonical);
      expect(archive.archiveDownloadCode(c.requestId)).toBe(c.code);
      const posted: any[] = [];
      await archive.approveArchiveDownload({
        client: { fetch: async (path: string, init: any) => void posted.push({ path, body: JSON.parse(init.body) }) },
        ...a,
        umk: seed(AD.umkSeedHex),
        signWithIrk,
        now: () => c.issuedAt,
      });
      expect(posted).toEqual([{ path: "/api/screens/server-archive/approve", body: { approval: a, signature: c.signature } }]);
    }
    for (const bad of AD.invalid) expect(() => archive.archiveDownloadCanonicalBytes(bad)).toThrow();
  });
});

describe("backup and restore errors keep their reason", () => {
  const screensError = (status: number, error: string) => Object.assign(new Error(error), { name: "ScreensError", status, body: { error } });

  it("shows the box's refusal of a backup that doesn't fit, as a sentence", async () => {
    const need = "this server needs about 12 GB free to make this backup and has 3 GB. Free some space (or remove apps you don't need) and try again";
    const client = {
      fetch: async (_p: string, init: any) => {
        if (!init) return { archive: null };
        throw screensError(409, need);
      },
    };
    const e = await archive.startServerBackup({ client, umk: seed(B.umkSeedHex), passcode: B.passcode, argonParams: { m: 64, t: 1, p: 1 } }).catch((x: unknown) => x);
    expect(archive.archiveErrorText(e)).toBe(`T${need.slice(1)}.`);
  });

  it("shows a failed backup's own reason", async () => {
    const client = { fetch: async () => ({ archive: { archiveId: "aa".repeat(16), state: "failed", reason: "the disk filled up." } }) };
    const e = await archive.waitForBackup({ client }).catch((x: unknown) => x);
    expect(archive.archiveErrorText(e)).toBe("The backup failed: the disk filled up.");
  });

  it("says a vanished backup, or a server waiting for another backup, in words", async () => {
    const gone = await archive.waitForBackup({ client: { fetch: async () => ({ archive: null }) } }).catch((x: unknown) => x);
    expect(archive.archiveErrorText(gone)).toBe("The backup disappeared from the server.");
    expect(archive.archiveErrorText(screensError(409, "this server is waiting for a different backup"))).toBe("This server is waiting for a different backup.");
  });

  it("shows a wrong passcode as such", async () => {
    const e = await fmt.openWithPasscode(fmt.parseBackupFile(B.file), B.wrongPasscode).catch((x: unknown) => x);
    expect(archive.archiveErrorText(e)).toBe("That passcode doesn't open this backup.");
  });

  it("falls back to the plain-language copy when the box sent no reason", () => {
    expect(archive.archiveErrorText({ status: 503 })).toMatch(/briefly unavailable/);
  });
});
