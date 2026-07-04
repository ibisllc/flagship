import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dumpDataVolumes,
  reloadDataVolumes,
  loadDataServicesCreds,
  isRawDataMount,
  isDumpSubtree,
  type DataServicesCreds,
  type VolumeDumpRunner,
} from "../src/volumeDump.js";

const CREDS: DataServicesCreds = {
  postgresUser: "flagship_admin",
  postgresPassword: "pg-secret",
  minioRootUser: "flagship_root",
  minioRootPassword: "minio-secret",
  redisPassword: "redis-secret",
};

interface Rec {
  kind: "run" | "capture" | "runToFile" | "runFromFile";
  cmd: string;
  args: string[];
  outPath?: string;
  inPath?: string;
}

/**
 * Recording runner. Real docker/mc/tar are never touched. `runToFile` actually
 * writes a placeholder at the target so the on-disk `_dumps/` tree exists for
 * the walker + reload's presence checks. `fail` injects a rejection for the
 * FIRST command whose argv joins to a string containing the given needle.
 */
function recordingRunner(fail?: { needle: string }): { runner: VolumeDumpRunner; calls: Rec[] } {
  const calls: Rec[] = [];
  let lastSaveCounter = 0;
  const maybeFail = (cmd: string, args: string[]) => {
    if (fail && `${cmd} ${args.join(" ")}`.includes(fail.needle)) {
      throw new Error(`injected failure for ${fail.needle}`);
    }
  };
  const runner: VolumeDumpRunner = {
    async run(cmd, args) {
      calls.push({ kind: "run", cmd, args });
      maybeFail(cmd, args);
    },
    async capture(cmd, args) {
      calls.push({ kind: "capture", cmd, args });
      maybeFail(cmd, args);
      // LASTSAVE returns a monotonically increasing value so the BGSAVE-poll
      // loop sees the timestamp advance and completes on the first check.
      if (args.includes("LASTSAVE")) return { stdout: String(++lastSaveCounter) };
      return { stdout: "" };
    },
    async runToFile(cmd, args, outPath) {
      calls.push({ kind: "runToFile", cmd, args, outPath });
      maybeFail(cmd, args);
      await mkdir(join(outPath, ".."), { recursive: true });
      await writeFile(outPath, `dump:${args.join(" ")}`);
    },
    async runFromFile(cmd, args, inPath) {
      calls.push({ kind: "runFromFile", cmd, args, inPath });
      maybeFail(cmd, args);
    },
  };
  return { runner, calls };
}

let workdir = "";
let dataRoot = "";

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "voldump-"));
  dataRoot = join(workdir, "data");
  // The host bind-mount files that dumpRedis/dumpForgejo copy OUT of.
  await mkdir(join(dataRoot, "redis"), { recursive: true });
  await mkdir(join(dataRoot, "forgejo", "data"), { recursive: true });
  await writeFile(join(dataRoot, "redis", "dump.rdb"), "live-rdb-bytes");
  await writeFile(join(dataRoot, "forgejo", "data", "_flagship_backup.db"), "sqlite-snapshot");
});
afterEach(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = "";
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("dumpDataVolumes", () => {
  it("issues the right consistent-dump command per store, into the `_dumps/` subtree", async () => {
    const { runner, calls } = recordingRunner();
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(true);
    expect(report.stores).toEqual({
      postgres: "ok",
      minio: "ok",
      redis: "ok",
      forgejo: "ok",
    });

    // postgres: pg_dumpall via docker exec, password via -e PGPASSWORD, → all.dump
    const pg = calls.find((c) => c.args.includes("pg_dumpall"));
    expect(pg?.kind).toBe("runToFile");
    expect(pg?.cmd).toBe("docker");
    expect(pg?.args).toContain("-e");
    expect(pg?.args).toContain(`PGPASSWORD=${CREDS.postgresPassword}`);
    expect(pg?.args).toContain("flagship-postgres");
    expect(pg?.outPath).toBe(join(dataRoot, "_dumps", "postgres", "all.dump"));

    // redis: LASTSAVE → BGSAVE → LASTSAVE (poll), then the rdb is copied out.
    expect(calls.some((c) => c.args.includes("BGSAVE"))).toBe(true);
    expect(calls.filter((c) => c.args.includes("LASTSAVE")).length).toBeGreaterThanOrEqual(2);
    expect(await exists(join(dataRoot, "_dumps", "redis", "dump.rdb"))).toBe(true);

    // minio: alias set (idempotent) + mirror of all buckets → _dumps/minio
    const mirror = calls.find((c) => c.cmd === "mc" && c.args.includes("mirror"));
    expect(mirror?.args).toContain("--overwrite");
    expect(mirror?.args).toContain("flagship/");
    expect(mirror?.args).toContain(join(dataRoot, "_dumps", "minio"));

    // forgejo: sqlite .backup + repos tar
    expect(calls.some((c) => c.args.includes("sqlite3"))).toBe(true);
    const tar = calls.find((c) => c.kind === "runToFile" && c.args.includes("tar"));
    expect(tar?.outPath).toBe(join(dataRoot, "_dumps", "forgejo", "repos.tar"));
    expect(await exists(join(dataRoot, "_dumps", "forgejo", "forgejo.db"))).toBe(true);
  });

  it("the dumps land where the walker (excluding raw mounts) will ship them", async () => {
    const { runner } = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    const rels = [
      "_dumps/postgres/all.dump",
      "_dumps/redis/dump.rdb",
      "_dumps/forgejo/forgejo.db",
      "_dumps/forgejo/repos.tar",
    ];
    for (const r of rels) {
      expect(await exists(join(dataRoot, r))).toBe(true);
      expect(isDumpSubtree(r)).toBe(true); // walker raises the cap for these
      expect(isRawDataMount(r)).toBe(false); // and does NOT exclude them
    }
    // raw mounts ARE excluded
    for (const m of ["postgres", "minio/x", "redis/dump.rdb", "forgejo/data/y", "chromium/z"]) {
      expect(isRawDataMount(m)).toBe(true);
    }
  });

  it("a store's dump FAILURE surfaces in the report + does NOT silently skip (others still dump)", async () => {
    const { runner, calls } = recordingRunner({ needle: "pg_dumpall" });
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(false);
    expect(report.stores.postgres).toBe("error");
    expect(report.errors.map((e) => e.store)).toContain("postgres");
    // The OTHER stores still dumped — one failure isn't a wholesale skip.
    expect(report.stores.redis).toBe("ok");
    expect(report.stores.minio).toBe("ok");
    expect(report.stores.forgejo).toBe("ok");
    // No torn/partial all.dump was left behind (the failing runToFile wrote nothing).
    expect(await exists(join(dataRoot, "_dumps", "postgres", "all.dump"))).toBe(false);
    expect(calls.some((c) => c.args.includes("BGSAVE"))).toBe(true);
  });

  it("honors `only` to dump a subset of stores", async () => {
    const { runner, calls } = recordingRunner();
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS, only: ["postgres"] });
    expect(report.stores.postgres).toBe("ok");
    expect(report.stores.redis).toBe("skipped");
    expect(report.stores.minio).toBe("skipped");
    expect(calls.some((c) => c.args.includes("BGSAVE"))).toBe(false);
  });

  it("is idempotent — re-dumping issues the same command shape", async () => {
    const a = recordingRunner();
    const b = recordingRunner();
    const r1 = await dumpDataVolumes({ dataRoot, runner: a.runner, creds: CREDS });
    const r2 = await dumpDataVolumes({ dataRoot, runner: b.runner, creds: CREDS });
    expect(r1).toEqual(r2);
    const shape = (calls: Rec[]) => calls.map((c) => `${c.kind}:${c.cmd}:${c.args.join(",")}`);
    expect(shape(a.calls)).toEqual(shape(b.calls));
  });
});

describe("reloadDataVolumes", () => {
  it("issues the INVERSE command per store from the dumped tree", async () => {
    // First produce a dump tree on disk.
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS });

    const { runner, calls } = recordingRunner();
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(true);
    expect(report.stores).toEqual({ postgres: "ok", minio: "ok", redis: "ok", forgejo: "ok" });

    // postgres: psql fed the all.dump on stdin (pg_dumpall --clean output is idempotent)
    const psql = calls.find((c) => c.args.includes("psql"));
    expect(psql?.kind).toBe("runFromFile");
    expect(psql?.inPath).toBe(join(dataRoot, "_dumps", "postgres", "all.dump"));
    expect(psql?.args).toContain("-i");

    // minio: reverse mirror local → alias
    const mirror = calls.find((c) => c.cmd === "mc" && c.args.includes("mirror"));
    expect(mirror?.args).toContain(join(dataRoot, "_dumps", "minio"));
    expect(mirror?.args).toContain("flagship/");
    expect(mirror?.args.indexOf(join(dataRoot, "_dumps", "minio"))).toBeLessThan(
      mirror!.args.indexOf("flagship/"),
    );

    // redis: compose stop redis → (rdb dropped in) → compose start redis
    const composeCalls = calls.filter((c) => c.args.includes("compose"));
    expect(composeCalls.some((c) => c.args.includes("stop") && c.args.includes("redis"))).toBe(true);
    expect(composeCalls.some((c) => c.args.includes("start") && c.args.includes("redis"))).toBe(true);
    expect(await exists(join(dataRoot, "redis", "dump.rdb"))).toBe(true);

    // forgejo: compose stop → restore sqlite + untar repos → compose start
    expect(composeCalls.some((c) => c.args.includes("stop") && c.args.includes("forgejo"))).toBe(true);
    expect(composeCalls.some((c) => c.args.includes("start") && c.args.includes("forgejo"))).toBe(true);
    expect(calls.some((c) => c.kind === "runFromFile" && c.cmd === "tar" && c.args.includes("-xf"))).toBe(
      true,
    );
    expect(await exists(join(dataRoot, "forgejo", "data", "forgejo.db"))).toBe(true);
  });

  it("skips a store whose dump is absent (not an error)", async () => {
    // Only a postgres dump present.
    await mkdir(join(dataRoot, "_dumps", "postgres"), { recursive: true });
    await writeFile(join(dataRoot, "_dumps", "postgres", "all.dump"), "SQL");

    const { runner, calls } = recordingRunner();
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(true);
    expect(report.stores.postgres).toBe("ok");
    expect(report.stores.redis).toBe("absent");
    expect(report.stores.minio).toBe("absent");
    expect(report.stores.forgejo).toBe("absent");
    expect(calls.some((c) => c.args.includes("psql"))).toBe(true);
    expect(calls.some((c) => c.args.includes("mirror"))).toBe(false);
  });

  it("a reload failure surfaces per store", async () => {
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS });
    const { runner } = recordingRunner({ needle: "psql" });
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(false);
    expect(report.stores.postgres).toBe("error");
    expect(report.stores.minio).toBe("ok");
  });

  it("round-trip: dump → reload issues the inverse of each store's dump", async () => {
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS });
    const reload = recordingRunner();
    await reloadDataVolumes({ dataRoot, runner: reload.runner, creds: CREDS });

    const dumped = dump.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    const reloaded = reload.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    // dump used pg_dumpall (read) ⇒ reload uses psql (write)
    expect(dumped.some((s) => s.includes("pg_dumpall"))).toBe(true);
    expect(reloaded.some((s) => s.includes("psql"))).toBe(true);
    // dump created the tar ⇒ reload extracts it
    expect(dumped.some((s) => s.includes("tar -cf -"))).toBe(true);
    expect(reloaded.some((s) => s.includes("tar -xf -"))).toBe(true);
    // dump mirrored alias→local ⇒ reload mirrors local→alias (already asserted above)
    expect(reloaded.some((s) => s.includes("mirror"))).toBe(true);
  });
});

describe("loadDataServicesCreds", () => {
  it("parses the compose-written env file", async () => {
    const p = join(workdir, "data-services.env");
    await writeFile(
      p,
      [
        "# comment",
        "POSTGRES_ADMIN_USER=flagship_admin",
        "POSTGRES_ADMIN_PASSWORD=pgpw",
        "MINIO_ROOT_USER=flagship_root",
        "MINIO_ROOT_PASSWORD=miniopw",
        "REDIS_ADMIN_PASSWORD=redispw",
        "",
      ].join("\n"),
    );
    const creds = await loadDataServicesCreds(p);
    expect(creds).toEqual({
      postgresUser: "flagship_admin",
      postgresPassword: "pgpw",
      minioRootUser: "flagship_root",
      minioRootPassword: "miniopw",
      redisPassword: "redispw",
    });
  });

  it("returns null when the file is missing or incomplete (data layer disabled)", async () => {
    expect(await loadDataServicesCreds(join(workdir, "nope.env"))).toBeNull();
    const partial = join(workdir, "partial.env");
    await writeFile(partial, "POSTGRES_ADMIN_USER=x\n");
    expect(await loadDataServicesCreds(partial)).toBeNull();
  });
});
