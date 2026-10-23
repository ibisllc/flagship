import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ROLLBACK_SCRIPT_PATH,
  UPDATE_GUARD_DROPIN,
  UPDATE_GUARD_DROPIN_PATH,
  UPDATE_GUARD_SCRIPT_PATH,
  buildUpdateGuardScript,
  installUpdateGuard,
} from "../src/updateGuard.js";

const ROLLBACK_SH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../installer/rollback-box-artifact.sh");

const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const PREV = "a".repeat(40);
const TARGET = "b".repeat(40);

describe("update guard script", () => {
  let dir: string;
  let releases: string;
  let current: string;
  let data: string;
  let bin: string;
  let script: string;

  const installRelease = (commit: string) => {
    const app = join(releases, commit, "app");
    mkdirSync(join(app, ".runtime/node/bin"), { recursive: true });
    writeFileSync(join(app, ".runtime/node/bin/node"), "#!/bin/sh\n");
    chmodSync(join(app, ".runtime/node/bin/node"), 0o755);
    writeFileSync(join(releases, commit, "INSTALLED.json"), JSON.stringify({ commit, arch: "amd64", sequence: commit === PREV ? 1 : 2 }));
  };
  const running = () => readlinkSync(current);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "update-guard-"));
    releases = join(dir, "releases");
    current = join(dir, "current");
    data = join(dir, "data");
    bin = join(dir, "bin");
    for (const d of [releases, data, bin]) mkdirSync(d);
    installRelease(PREV);
    installRelease(TARGET);
    symlinkSync(join(releases, TARGET, "app"), current);
    // The real rollback script, pointed at the fixture directories.
    const rollback = join(dir, "rollback.sh");
    writeFileSync(
      rollback,
      `#!/bin/bash\necho "rollback $1" >> "${dir}/calls"\n` +
        `exec bash "${ROLLBACK_SH}" "$1" --releases "${releases}" --current "${current}" --state "${data}" --bin "${bin}"\n`,
    );
    chmodSync(rollback, 0o755);
    script = join(dir, "guard.sh");
    writeFileSync(script, buildUpdateGuardScript({ repoPath: current, dataDir: data, maxStarts: 2, rollbackScript: rollback }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => execFileSync("bash", [script], { encoding: "utf8" });
  const writeMarker = (m: Record<string, unknown>) =>
    writeFileSync(join(data, "update-pending.json"), JSON.stringify(m));
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");

  it("parses as bash", () => {
    execFileSync("bash", ["-n", script]);
  });

  it("does nothing without a marker", () => {
    writeFileSync(join(data, "update-guard-starts"), "5");
    run();
    expect(running()).toBe(join(releases, TARGET, "app"));
    expect(existsSync(join(data, "update-guard-starts"))).toBe(false);
    expect(calls()).toBe("");
  });

  it.skipIf(!hasJq)("rolls back an interrupted apply on the first start by flipping the release link", () => {
    writeMarker({ previousCommit: PREV, targetCommit: TARGET, bootAttempts: 0, stage: "applying" });
    run();
    expect(running()).toBe(join(releases, PREV, "app"));
    expect(calls()).toBe(`rollback ${PREV}\n`);
    expect(JSON.parse(readFileSync(join(data, "artifact-current.json"), "utf8"))).toMatchObject({ commit: PREV });
    expect(readlinkSync(join(bin, "node"))).toBe(join(releases, PREV, "app/.runtime/node/bin/node"));
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);
    const outcome = JSON.parse(readFileSync(join(data, "update-outcome.json"), "utf8"));
    expect(outcome).toMatchObject({ outcome: "rolled-back", previousCommit: PREV, targetCommit: TARGET });
  });

  it.skipIf(!hasJq)("leaves a staged update to the daemon's gate until it exceeds its starts", () => {
    writeMarker({ previousCommit: PREV, targetCommit: TARGET, bootAttempts: 1 });
    run();
    run();
    expect(running()).toBe(join(releases, TARGET, "app"));
    expect(calls()).toBe("");
    run();
    expect(running()).toBe(join(releases, PREV, "app"));
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);
    expect(existsSync(join(data, "update-guard-starts"))).toBe(false);
  });

  it.skipIf(!hasJq)("never carries a start count over from an earlier update", () => {
    writeFileSync(join(data, "update-guard-starts"), `${PREV} 9\n`);
    writeMarker({ previousCommit: PREV, targetCommit: TARGET, bootAttempts: 0 });
    run();
    expect(running()).toBe(join(releases, TARGET, "app"));
    expect(readFileSync(join(data, "update-guard-starts"), "utf8")).toBe(`${TARGET} 1\n`);
  });

  it.skipIf(!hasJq)("keeps the marker when the previous release is no longer on disk", () => {
    rmSync(join(releases, PREV), { recursive: true });
    writeMarker({ previousCommit: PREV, targetCommit: TARGET, bootAttempts: 0, stage: "applying" });
    run();
    expect(running()).toBe(join(releases, TARGET, "app"));
    expect(existsSync(join(data, "update-pending.json"))).toBe(true);
  });

  it.skipIf(!hasJq)("rolls a 0-byte marker back to the last verified commit", () => {
    // home2: power cut 2 s after the update; the marker came back as a 0-byte file.
    writeFileSync(join(data, "update-pending.json"), "");
    writeFileSync(join(data, "artifact-current.json"), JSON.stringify({ commit: TARGET }));
    writeFileSync(
      join(data, "update-outcome.json"),
      JSON.stringify({ outcome: "applied", at: 1, previousCommit: "0".repeat(40), targetCommit: PREV, bootAttempts: 1 }),
    );
    run();
    expect(running()).toBe(join(releases, PREV, "app"));
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, "update-outcome.json"), "utf8"))).toMatchObject({
      outcome: "rolled-back",
      previousCommit: PREV,
      targetCommit: TARGET,
    });
  });

  it.skipIf(!hasJq)("leaves a 0-byte marker alone when there's no known-good commit", () => {
    writeFileSync(join(data, "update-pending.json"), "");
    run();
    expect(running()).toBe(join(releases, TARGET, "app"));
    expect(calls()).toBe("");
  });

  it.skipIf(!hasJq)("ignores a marker it can't trust", () => {
    writeMarker({ previousCommit: "$(reboot)", targetCommit: TARGET, bootAttempts: 0, stage: "applying" });
    run();
    expect(running()).toBe(join(releases, TARGET, "app"));
    expect(calls()).toBe("");
  });

  it("uses no git, npm or compiler to roll back", () => {
    const text = readFileSync(script, "utf8");
    expect(text).not.toMatch(/\bgit\b|\bnpm\b|\bnpx\b|\btsc\b/);
  });

  it("refuses paths that could break out of the script", () => {
    expect(() => buildUpdateGuardScript({ repoPath: "/opt/x'; reboot; '", dataDir: "/var/flagship" })).toThrow();
    expect(() => buildUpdateGuardScript({ repoPath: "/opt/flagship", dataDir: "relative" })).toThrow();
    expect(() => buildUpdateGuardScript({ repoPath: "/opt/flagship", dataDir: "/var/flagship", rollbackScript: "x; reboot" })).toThrow();
  });
});

describe("rollback-box-artifact.sh", () => {
  it("refuses anything but a full commit and a release that is not installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollback-"));
    try {
      const args = ["--releases", dir, "--current", join(dir, "cur"), "--state", dir, "--bin", dir];
      expect(() => execFileSync("bash", [ROLLBACK_SH, "main", ...args], { stdio: "pipe" })).toThrow();
      expect(() => execFileSync("bash", [ROLLBACK_SH, PREV, ...args], { stdio: "pipe" })).toThrow();
      expect(existsSync(join(dir, "cur"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installUpdateGuard", () => {
  it("installs once, reloads systemd only on change, and skips non-systemd hosts", async () => {
    const files = new Map<string, string>([["/opt/flagship/installer/rollback-box-artifact.sh", "#!/bin/bash\necho rollback\n"]]);
    const runs: string[] = [];
    const opts = {
      repoPath: "/opt/flagship",
      dataDir: "/var/flagship",
      hasSystemd: () => true,
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      run: async (cmd: string, args: string[]) => void runs.push([cmd, ...args].join(" ")),
    };
    expect(await installUpdateGuard(opts)).toBe(true);
    expect(files.get(UPDATE_GUARD_DROPIN_PATH)).toBe(UPDATE_GUARD_DROPIN);
    expect(files.get(UPDATE_GUARD_SCRIPT_PATH)).toContain("state='/var/flagship'");
    expect(files.get(ROLLBACK_SCRIPT_PATH)).toContain("echo rollback");
    expect(UPDATE_GUARD_DROPIN).toContain(`ExecStartPre=-${UPDATE_GUARD_SCRIPT_PATH}`);
    expect(await installUpdateGuard(opts)).toBe(false);
    expect(runs).toEqual(["systemctl daemon-reload"]);
    expect(await installUpdateGuard({ ...opts, hasSystemd: () => false })).toBe(false);
  });
});
