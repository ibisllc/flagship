import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
// @ts-expect-error plain JS module
import * as saved from "../public/webapp/lib/savedBackups.js";
// @ts-expect-error plain JS module
import * as policy from "../public/webapp/lib/backupPolicy.js";
// @ts-expect-error plain JS module
import * as fmt from "../public/webapp/lib/serverBackupFormat.js";
// @ts-expect-error plain JS module
import * as mig from "../public/webapp/lib/migrateArchive.js";
// @ts-expect-error plain JS module
import { signWithIrk } from "../public/webapp/keystore.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(here, "../../..", path), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const K = read("packages/protocol/test-vectors/server-archive-keys/vectors.json") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = read("packages/protocol/test-vectors/backup-policy/vectors.json") as any;
const seed = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const GB = 1024 ** 3;

describe("server-archive-keys in the webapp (shared vectors)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each(K.cases.map((c: any, i: number) => [i, c] as const))("case #%i", async (_i, c: any) => {
    expect(await saved.archiveKeysDigest(c.keys)).toBe(c.digest);
    const d = { serverDomain: c.serverDomain, count: c.keys.length, digest: c.digest, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(saved.archiveKeysCanonicalBytes(d))).toBe(c.canonical);
    expect(hex(await signWithIrk(seed(K.umkSeedHex), saved.archiveKeysCanonicalBytes(d)))).toBe(c.signature);
    let n = 0;
    const minted = await saved.mintArchiveKeys(seed(K.umkSeedHex), 1, () => seed(c.keys[n++]!.archiveId));
    expect(minted[0]).toEqual(c.keys[0]);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each(K.invalid.map((c: any, i: number) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(() => saved.archiveKeysCanonicalBytes(c)).toThrow();
  });
  it("deposits only on an admin device, and only when the box asks", () => {
    expect(saved.shouldDepositKeys({ keysWanted: 400 }, true)).toBe(true);
    expect(saved.shouldDepositKeys({ keysWanted: 0 }, true)).toBe(false);
    expect(saved.shouldDepositKeys({ keysWanted: 400 }, false)).toBe(false);
  });
});

describe("backup-policy in the webapp (shared vectors)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each(P.cases.map((c: any, i: number) => [i, c] as const))("case #%i", async (_i, c: any) => {
    const o = { serverDomain: c.serverDomain, policy: c.policy, phoneReserveBytes: c.phoneReserveBytes, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(policy.backupPolicyCanonicalBytes(o))).toBe(c.canonical);
    expect(hex(await signWithIrk(seed(P.umkSeedHex), policy.backupPolicyCanonicalBytes(o)))).toBe(c.signature);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each(P.invalid.map((c: any, i: number) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(() => policy.backupPolicyCanonicalBytes(c)).toThrow();
  });
  it("rides beside the pairing order, signed", async () => {
    const umk = seed(P.umkSeedHex);
    const json = await policy.attachBackupPolicy(JSON.stringify({ request: { a: 1 }, signature: "ab" }), {
      serverDomain: "Home.Harry.flagship.services",
      policy: policy.policyFromDraft("phone-only"),
      reserveGb: 32,
      issuedAt: 1700000000000,
      sign: (b: Uint8Array) => signWithIrk(umk, b),
    });
    const o = JSON.parse(json);
    expect(o.request).toEqual({ a: 1 });
    expect(o.backupPolicy.order).toEqual({ serverDomain: "home.harry.flagship.services", policy: "phone", phoneReserveBytes: 32 * GB, issuedAt: 1700000000000 });
    expect(o.backupPolicy.signatureHex).toBe(P.cases[0].signature);
    expect(ed25519.verify(seed(o.backupPolicy.signatureHex), policy.backupPolicyCanonicalBytes(o.backupPolicy.order), seed(P.pub))).toBe(true);
    expect(policy.policyFromDraft("none")).toBe("none");
    expect(policy.policyFromDraft("peer")).toBe("peer");
    expect(policy.policyFromDraft(undefined)).toBe("phone");
  });
  it("describes the policy, the usage and the peer engine", () => {
    const v = { policy: { policy: "phone", phoneReserveBytes: 32 * GB }, cap: { limitBytes: 32 * GB, usedBytes: 3.2 * GB } };
    expect(policy.policyLine(v)).toBe("On my devices · up to 32 GB");
    expect(policy.usageLine(v)).toBe("Apps use 3.2 GB of 32 GB");
    expect(policy.usageFraction(v)).toBeCloseTo(0.1);
    expect(policy.usageLine({ policy: { policy: "peer" }, cap: { limitBytes: 120 * GB, usedBytes: GB } })).toBe("Apps use 1.0 GB of 120 GB (a third of this server's disk)");
    expect(policy.usageLine({ policy: { policy: "none" }, cap: { limitBytes: null, usedBytes: GB } })).toBe("Apps use 1.0 GB");
    expect(policy.policyLine({ policy: { policy: "unset" }, cap: {} })).toBe("Not chosen yet");
    expect(policy.peerLines({ state: "at-risk", reason: "two servers holding pieces went away.", healthyBricks: 3, totalBricks: 5, holders: 4, hostingBytes: 2 * GB }, { formatTime: () => "t" })).toEqual([
      "At risk: two servers holding pieces went away.",
      "3 of 5 pieces safe on 4 servers",
      "Holds 2.0 GB for other servers",
    ]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BB = read("packages/protocol/test-vectors/server-backup-bundle/vectors.json") as any;

describe("the one .flagship file in the webapp (shared vectors)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each(BB.headers.map((c: any) => [c.metaLength, c] as const))("reads the header for %i", (_l, c: any) => {
    expect(fmt.parseBundleHeader(seed(c.headerHex), 16 + c.metaLength + 1)).toEqual({ metaOffset: 16, metaLength: c.metaLength, dataOffset: 16 + c.metaLength, dataLength: 1 });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each(BB.invalid.map((c: any) => [c.why, c] as const))("refuses %s, with a sentence", (_w, c: any) => {
    expect(() => fmt.parseBundleHeader(seed(c.headHex), c.fileBytes)).toThrow(/\.$/);
  });
  it("splits a picked file into the backup text and a lazy data slice", async () => {
    const b = seed(BB.example.bundleHex);
    const { backupText, data, dataOffset } = await fmt.splitBundle(new Blob([b]));
    expect(Buffer.from(backupText).toString("hex")).toBe(BB.example.metaHex);
    expect(dataOffset).toBe(BB.example.dataOffset);
    expect(hex(new Uint8Array(await data.arrayBuffer()))).toBe(BB.example.dataHex);
  });
  it("opens a multi-GB file without reading its data part", async () => {
    const SIZE = 6 * GB;
    const meta = new TextEncoder().encode('{"magic":"flagship-backup","v":2}');
    const reads: Array<[number, number]> = [];
    const header = Uint8Array.from([...new TextEncoder().encode("FLGSHBK1"), 0, 0, 0, 0, 0, 0, 0, meta.length]);
    // A File-like object: slices are lazy; only what is actually read is recorded.
    const fakeFile = (start: number, end: number): any => ({
      size: end - start,
      slice: (a: number, b: number) => fakeFile(start + a, start + Math.min(b, end - start)),
      arrayBuffer: async () => {
        reads.push([start, end]);
        const out = new Uint8Array(end - start);
        for (let i = start; i < end; i++) out[i - start] = i < 16 ? header[i]! : i < 16 + meta.length ? meta[i - 16]! : 0;
        return out.buffer;
      },
      text: async () => {
        reads.push([start, end]);
        return new TextDecoder().decode(meta.subarray(start - 16, end - 16));
      },
    });
    const { backupText, data } = await fmt.splitBundle(fakeFile(0, SIZE));
    expect(backupText).toBe('{"magic":"flagship-backup","v":2}');
    expect(data.size).toBe(SIZE - 16 - meta.length);
    expect(reads.every(([a, b]) => b - a <= 1024)).toBe(true);
  });
  it("a truncated file is refused before anything is uploaded", async () => {
    const b = seed(BB.example.bundleHex);
    await expect(fmt.splitBundle(new Blob([b.subarray(0, BB.example.dataOffset)]))).rejects.toThrow(/cut short/);
    await expect(fmt.splitBundle(new Blob([new Uint8Array(4)]))).rejects.toThrow(/too short/);
    await expect(fmt.splitBundle(new Blob([new TextEncoder().encode('{"magic":"flagship-backup"}')]))).rejects.toThrow(/isn't a Flagship backup/);
  });
});

describe("Migrate's downtime estimate", () => {
  it("adds the backup, the transfer at the measured speed, the restore and a little per app", () => {
    // 2 GiB: 34 s to back up, 102 s at 20 MiB/s, 51 s to restore, 2 apps × 30 s.
    expect(mig.estimateDowntimeSec({ archiveBytes: 2 * GB, bytesPerSecond: 20 * 1024 * 1024, apps: 2 })).toBe(248);
    expect(mig.downtimeText(248)).toBe("about 4 minutes");
    expect(mig.downtimeText(30)).toBe("about a minute");
    expect(mig.downtimeText(3 * 3600)).toBe("about 3 hours");
    // A link too slow to measure still gives a (long) estimate, never infinity.
    expect(Number.isFinite(mig.estimateDowntimeSec({ archiveBytes: GB, bytesPerSecond: 0, apps: 1 }))).toBe(true);
  });
});

describe("saved backups on the server page", () => {
  it("converts the schedule between local time and the box's UTC both ways", () => {
    for (const frequency of ["daily", "weekly"]) {
      for (const [hour, minute, weekday] of [[3, 0, 0], [23, 30, 6], [0, 15, 1]] as const) {
        const utc = saved.localToUtc({ hour, minute, weekday, frequency });
        const back = saved.utcToLocal({ ...utc, frequency });
        expect(back.hour).toBe(hour);
        expect(back.minute).toBe(minute);
        if (frequency === "weekly") expect(back.weekday).toBe(weekday);
      }
    }
  });
  it("says what happened, what's next, and the box's own failure", () => {
    const fmt = { formatBytes: (n: number) => `${n}B`, formatTime: (t: number) => `T${t}` };
    expect(saved.statusLines({ backups: [], waitingReason: "an admin device of your account hasn't approved backups for this server yet" }, fmt)).toEqual({
      status: "No backups yet.",
      failed: "",
      next: "An admin device of your account hasn't approved backups for this server yet.",
    });
    const v = {
      backups: [{ createdAt: 5, bytes: 10, backupBytes: 2, trigger: "schedule", apps: [{}], left: [] }],
      lastRun: { ok: false, reason: "this server needs about 7.0 GB free to make this backup and has 6.0 GB." },
      nextRunAt: 9,
      scheduleActive: true,
      schedule: { frequency: "daily" },
    };
    expect(saved.statusLines(v, fmt)).toEqual({
      status: "Last backup: T5 · 12B",
      failed: "The last backup failed: this server needs about 7.0 GB free to make this backup and has 6.0 GB.",
      next: "Next backup: T9",
    });
    expect(saved.statusLines({ running: { progress: { app: "notes", done: 1, total: 3 } } }, fmt).status).toBe("Backing up… notes (1/3)");
    expect(saved.statusLines({ ...v, scheduleActive: false }, fmt).next).toBe("Scheduled backups are off.");
    expect(saved.rowText({ createdAt: 5, bytes: 10, backupBytes: 2, trigger: "now", apps: [{}, {}], left: [{ name: "old" }] }, fmt)).toEqual({
      main: "T5 · 12B · Back up now · 2 apps",
      left: "Left out: old",
    });
    expect(saved.scheduleLine({ frequency: "off" })).toBe("Scheduled backups are off.");
    expect(saved.scheduleLine({ frequency: "daily", minuteOfDayUtc: 180, weekdayUtc: 0, keepDaily: 7, keepWeekly: 4 })).toMatch(/^Daily at .* · keeps 7 daily and 4 weekly$/);
  });
});
