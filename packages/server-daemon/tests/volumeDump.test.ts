import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILES_HELPER_IMAGE,
  dumpDataVolumes,
  reloadDataVolumes,
  loadDataServicesCreds,
  isRawDataMount,
  isDumpSubtree,
  type DataServicesCreds,
  type VolumeDumpRunner,
} from "../src/volumeDump.js";
import { assertNoHostPathInDockerArgs } from "../src/serviceRunner.js";

const CREDS: DataServicesCreds = {
  postgresUser: "flagship_admin",
  postgresPassword: "pg-secret",
};

const RUNNING: Record<string, string> = {
  "flagship-files-harry--notes": "c-harry--notes",
  "flagship-files-bob--pics": "c-bob--pics",
};
const VOLUMES = ["flagship-files-harry--notes", "flagship-devfiles-harry--notes", "flagship-files-bob--pics", "unrelated"];

interface Rec {
  kind: "run" | "capture" | "runToFile" | "runFromFile";
  cmd: string;
  args: string[];
  outPath?: string;
  inPath?: string;
}

/**
 * Recording runner. Real docker/tar are never touched. `runToFile` actually
 * writes a placeholder at the target so the on-disk `_dumps/` tree exists for
 * the walker + reload's presence checks. `fail` injects a rejection for every
 * command whose argv joins to a string containing the given needle.
 */
function recordingRunner(opts: { fail?: string; volumes?: string[]; inUse?: string[]; running?: Record<string, string> } = {}): {
  runner: VolumeDumpRunner;
  calls: Rec[];
} {
  const calls: Rec[] = [];
  const maybeFail = (cmd: string, args: string[]) => {
    if (opts.fail && `${cmd} ${args.join(" ")}`.includes(opts.fail)) {
      throw new Error(`injected failure for ${opts.fail}`);
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
      if (args[0] === "volume" && args[1] === "ls") return { stdout: (opts.volumes ?? VOLUMES).join("\n") + "\n" };
      if (args[0] === "ps") {
        const v = args[args.length - 1]!.replace("volume=", "");
        // `ps -q` lists running users (the app); `ps -aq` any container at all.
        if (args[1] === "-q") return { stdout: (opts.running ?? RUNNING)[v] ? `${(opts.running ?? RUNNING)[v]}\n` : "" };
        return { stdout: opts.inUse?.includes(v) ? "abc\n" : "" };
      }
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
  // The host bind-mount file dumpForgejo copies OUT of.
  await mkdir(join(dataRoot, "forgejo", "data"), { recursive: true });
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

function tarRuns(calls: Rec[]): Rec[] {
  return calls.filter((c) => c.cmd === "docker" && c.args[0] === "run");
}

describe("dumpDataVolumes", () => {
  it("issues the right consistent-dump command per store, into the `_dumps/` subtree", async () => {
    const { runner, calls } = recordingRunner();
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(true);
    expect(report.stores).toEqual({ postgres: "ok", files: "ok", forgejo: "ok" });

    // postgres: pg_dumpall via docker exec, password via -e PGPASSWORD, → all.dump
    const pg = calls.find((c) => c.args.includes("pg_dumpall"));
    expect(pg?.kind).toBe("runToFile");
    expect(pg?.cmd).toBe("docker");
    expect(pg?.args).toContain(`PGPASSWORD=${CREDS.postgresPassword}`);
    expect(pg?.args).toContain("flagship-postgres");
    expect(pg?.args).toContain("--clean");
    expect(pg?.outPath).toBe(join(dataRoot, "_dumps", "postgres", "all.dump"));

    // forgejo: sqlite .backup + repos tar
    expect(calls.some((c) => c.args.includes("sqlite3"))).toBe(true);
    const tar = calls.find((c) => c.kind === "runToFile" && c.args[0] === "exec" && c.args.includes("tar"));
    expect(tar?.outPath).toBe(join(dataRoot, "_dumps", "forgejo", "repos.tar"));
    expect(await exists(join(dataRoot, "_dumps", "forgejo", "forgejo.db"))).toBe(true);
  });

  it("archives each PROD files volume (never a dev one) with the app paused, in a locked-down throwaway container", async () => {
    const { runner, calls } = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    const runs = tarRuns(calls);
    expect(runs.map((r) => r.outPath)).toEqual([
      join(dataRoot, "_dumps", "files", "flagship-files-bob--pics.tar"),
      join(dataRoot, "_dumps", "files", "flagship-files-harry--notes.tar"),
    ]);
    const args = runs[1]!.args;
    expect(args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "DAC_READ_SEARCH",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--user",
      "0:0",
      "--mount",
      "type=volume,src=flagship-files-harry--notes,dst=/data,readonly",
      "--entrypoint",
      "tar",
      FILES_HELPER_IMAGE,
      "--numeric-owner",
      "-cf",
      "-",
      "-C",
      "/data",
      ".",
    ]);
    expect(() => assertNoHostPathInDockerArgs(args)).not.toThrow();
    // Paused for its archive, unpaused after, in that order.
    const seq = calls.map((c) => `${c.args[0]} ${c.args[1] ?? ""}`);
    const pause = seq.indexOf("pause c-harry--notes");
    const unpause = seq.indexOf("unpause c-harry--notes");
    expect(pause).toBeGreaterThan(-1);
    expect(unpause).toBeGreaterThan(pause);
    expect(calls.indexOf(runs[1]!)).toBeGreaterThan(pause);
    expect(calls.indexOf(runs[1]!)).toBeLessThan(unpause);
    expect(calls.some((c) => c.args.join(" ").includes("dev--"))).toBe(false);
  });

  it("an app that isn't running is archived without a pause or unpause", async () => {
    const { runner, calls } = recordingRunner({ volumes: ["flagship-files-harry--notes"], running: {} });
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS, only: ["files"] });
    expect(report.stores.files).toBe("ok");
    expect(calls.some((c) => c.args[0] === "pause" || c.args[0] === "unpause")).toBe(false);
    expect(tarRuns(calls)).toHaveLength(1);
  });

  it("drops the archive of an app that's gone", async () => {
    await mkdir(join(dataRoot, "_dumps", "files"), { recursive: true });
    await writeFile(join(dataRoot, "_dumps", "files", "flagship-files-gone--app.tar"), "old");
    const { runner } = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner, creds: CREDS, only: ["files"] });
    expect(await exists(join(dataRoot, "_dumps", "files", "flagship-files-gone--app.tar"))).toBe(false);
    expect(await exists(join(dataRoot, "_dumps", "files", "flagship-files-harry--notes.tar"))).toBe(true);
  });

  it("dumps the files folders even without the data-services credentials", async () => {
    const { runner, calls } = recordingRunner();
    const report = await dumpDataVolumes({ dataRoot, runner, creds: null });
    expect(report.stores).toEqual({ postgres: "skipped", files: "ok", forgejo: "skipped" });
    expect(tarRuns(calls)).toHaveLength(2);
    expect(calls.some((c) => c.args.includes("pg_dumpall"))).toBe(false);
  });

  it("the dumps land where the walker (excluding raw mounts) will ship them", async () => {
    const { runner } = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    const rels = [
      "_dumps/postgres/all.dump",
      "_dumps/files/flagship-files-harry--notes.tar",
      "_dumps/forgejo/forgejo.db",
      "_dumps/forgejo/repos.tar",
    ];
    for (const r of rels) {
      expect(await exists(join(dataRoot, r))).toBe(true);
      expect(isDumpSubtree(r)).toBe(true); // walker raises the cap for these
      expect(isRawDataMount(r)).toBe(false); // and does NOT exclude them
    }
    for (const m of ["postgres", "postgres/18/docker/base", "forgejo/data/y", "chromium/z"]) {
      expect(isRawDataMount(m)).toBe(true);
    }
  });

  it("a store's dump FAILURE surfaces in the report (others still dump), and leaves nothing torn", async () => {
    const { runner } = recordingRunner({ fail: "pg_dumpall" });
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(false);
    expect(report.stores.postgres).toBe("error");
    expect(report.errors.map((e) => e.store)).toContain("postgres");
    expect(report.stores.files).toBe("ok");
    expect(report.stores.forgejo).toBe("ok");
    expect(await exists(join(dataRoot, "_dumps", "postgres", "all.dump"))).toBe(false);
  });

  it("one volume's failure fails the files store but the others are still archived and unpaused", async () => {
    const { runner, calls } = recordingRunner({ fail: "src=flagship-files-bob--pics" });
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS, only: ["files"] });
    expect(report.stores.files).toBe("error");
    expect(report.errors[0]!.message).toMatch(/flagship-files-bob--pics/);
    expect(await exists(join(dataRoot, "_dumps", "files", "flagship-files-harry--notes.tar"))).toBe(true);
    expect(calls.some((c) => c.args[0] === "unpause" && c.args[1] === "c-bob--pics")).toBe(true);
  });

  it("honors `only` to dump a subset of stores", async () => {
    const { runner, calls } = recordingRunner();
    const report = await dumpDataVolumes({ dataRoot, runner, creds: CREDS, only: ["postgres"] });
    expect(report.stores).toEqual({ postgres: "ok", files: "skipped", forgejo: "skipped" });
    expect(tarRuns(calls)).toHaveLength(0);
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
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS });

    const { runner, calls } = recordingRunner();
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(true);
    expect(report.stores).toEqual({ postgres: "ok", files: "ok", forgejo: "ok" });

    // postgres: psql fed the all.dump on stdin (pg_dumpall --clean output is idempotent)
    const psql = calls.find((c) => c.args.includes("psql"));
    expect(psql?.kind).toBe("runFromFile");
    expect(psql?.inPath).toBe(join(dataRoot, "_dumps", "postgres", "all.dump"));
    expect(psql?.args).toContain("-i");

    // files: each archive goes into a FRESH, labelled volume of its name
    const v = "flagship-files-harry--notes";
    const seq = calls.map((c) => c.args.join(" "));
    const rmAt = seq.indexOf(`volume rm -f ${v}`);
    const createAt = seq.indexOf(`volume create --label flagship.files=prod --label flagship.app=harry--notes ${v}`);
    const untar = calls.findIndex((c) => c.kind === "runFromFile" && c.args.includes(`type=volume,src=${v},dst=/data`));
    expect(rmAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(rmAt);
    expect(untar).toBeGreaterThan(createAt);
    const restoreArgs = calls[untar]!.args;
    expect(restoreArgs.slice(0, 3)).toEqual(["run", "-i", "--rm"]);
    expect(restoreArgs).toContain("--read-only");
    expect(restoreArgs).toContain("none");
    expect(restoreArgs.slice(-5)).toEqual(["--numeric-owner", "-xpf", "-", "-C", "/data"]);
    expect(calls[untar]!.inPath).toBe(join(dataRoot, "_dumps", "files", `${v}.tar`));
    expect(() => assertNoHostPathInDockerArgs(restoreArgs)).not.toThrow();

    // forgejo: compose stop → restore sqlite + untar repos → compose start
    const composeCalls = calls.filter((c) => c.args.includes("compose"));
    expect(composeCalls.some((c) => c.args.includes("stop") && c.args.includes("forgejo"))).toBe(true);
    expect(composeCalls.some((c) => c.args.includes("start") && c.args.includes("forgejo"))).toBe(true);
    expect(calls.some((c) => c.kind === "runFromFile" && c.cmd === "tar" && c.args.includes("-xf"))).toBe(true);
    expect(await exists(join(dataRoot, "forgejo", "data", "forgejo.db"))).toBe(true);
  });

  it("never replaces a files volume a container still uses", async () => {
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS, only: ["files"] });
    const { runner, calls } = recordingRunner({ inUse: ["flagship-files-harry--notes"] });
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS, only: ["files"] });
    expect(report.stores.files).toBe("error");
    expect(report.errors[0]!.message).toMatch(/flagship-files-harry--notes: a container still uses it/);
    expect(calls.some((c) => c.args.join(" ") === "volume rm -f flagship-files-harry--notes")).toBe(false);
    expect(calls.some((c) => c.args.join(" ") === "volume rm -f flagship-files-bob--pics")).toBe(true);
  });

  it("reloads the files folders without the data-services credentials", async () => {
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS });
    const { runner, calls } = recordingRunner();
    const report = await reloadDataVolumes({ dataRoot, runner, creds: null });
    expect(report.stores).toEqual({ postgres: "absent", files: "ok", forgejo: "absent" });
    expect(calls.some((c) => c.args.includes("psql"))).toBe(false);
  });

  it("skips a store whose dump is absent (not an error)", async () => {
    await mkdir(join(dataRoot, "_dumps", "postgres"), { recursive: true });
    await writeFile(join(dataRoot, "_dumps", "postgres", "all.dump"), "SQL");

    const { runner, calls } = recordingRunner();
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(true);
    expect(report.stores).toEqual({ postgres: "ok", files: "absent", forgejo: "absent" });
    expect(calls.some((c) => c.args.includes("psql"))).toBe(true);
  });

  it("a reload failure surfaces per store", async () => {
    const dump = recordingRunner();
    await dumpDataVolumes({ dataRoot, runner: dump.runner, creds: CREDS });
    const { runner } = recordingRunner({ fail: "psql" });
    const report = await reloadDataVolumes({ dataRoot, runner, creds: CREDS });
    expect(report.ok).toBe(false);
    expect(report.stores.postgres).toBe("error");
    expect(report.stores.files).toBe("ok");
  });
});

describe("files helpers", () => {
  it("the archive image is the compose file's pinned Postgres image", async () => {
    const compose = await readFile(
      fileURLToPath(new URL("../../../installer/data-services/docker-compose.yml", import.meta.url)),
      "utf8",
    );
    const m = /^\s*image:\s*(pgvector\/pgvector:\S+)\s*$/m.exec(compose);
    expect(m?.[1]).toBe(FILES_HELPER_IMAGE);
    expect(FILES_HELPER_IMAGE).toMatch(/:0\.8\.7-pg18-trixie@sha256:[0-9a-f]{64}$/);
  });
});

describe("loadDataServicesCreds", () => {
  it("parses the compose-written env file", async () => {
    const p = join(workdir, "data-services.env");
    await writeFile(
      p,
      ["# comment", "POSTGRES_ADMIN_USER=flagship_admin", "POSTGRES_ADMIN_PASSWORD=pgpw", "DATA_NAME_KEY=k", ""].join("\n"),
    );
    expect(await loadDataServicesCreds(p)).toEqual({ postgresUser: "flagship_admin", postgresPassword: "pgpw" });
  });

  it("returns null when the file is missing or incomplete (data layer disabled)", async () => {
    expect(await loadDataServicesCreds(join(workdir, "nope.env"))).toBeNull();
    const partial = join(workdir, "partial.env");
    await writeFile(partial, "POSTGRES_ADMIN_USER=x\n");
    expect(await loadDataServicesCreds(partial)).toBeNull();
  });
});
