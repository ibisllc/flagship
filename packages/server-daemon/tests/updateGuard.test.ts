import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UPDATE_GUARD_DROPIN,
  UPDATE_GUARD_DROPIN_PATH,
  UPDATE_GUARD_SCRIPT_PATH,
  buildUpdateGuardScript,
  installUpdateGuard,
} from "../src/updateGuard.js";

const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe("update guard script", () => {
  let dir: string;
  let repo: string;
  let data: string;
  let bin: string;
  let script: string;
  let prev: string;
  let target: string;

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "update-guard-"));
    repo = join(dir, "repo");
    data = join(dir, "data");
    bin = join(dir, "bin");
    for (const d of [repo, data, bin]) mkdirSync(d);
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "old");
    prev = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "f.txt"), "new\n");
    git("commit", "-qam", "new");
    target = git("rev-parse", "HEAD");
    // Fake npm/npx record each call; FAIL_NPM=ci|all makes them fail.
    for (const tool of ["npm", "npx"]) {
      writeFileSync(
        join(bin, tool),
        `#!/bin/bash\necho "${tool} $*" >> "${dir}/calls"\n` +
          `case "\${FAIL_NPM:-}:$1" in all:*|ci:ci) exit 1;; esac\nexit 0\n`,
      );
      chmodSync(join(bin, tool), 0o755);
    }
    script = join(dir, "guard.sh");
    writeFileSync(script, buildUpdateGuardScript({ repoPath: repo, dataDir: data, maxStarts: 2 }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) =>
    execFileSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  const writeMarker = (m: Record<string, unknown>) =>
    writeFileSync(join(data, "update-pending.json"), JSON.stringify(m));
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");

  it("parses as bash", () => {
    execFileSync("bash", ["-n", script]);
  });

  it("does nothing without a marker", () => {
    writeFileSync(join(data, "update-guard-starts"), "5");
    run();
    expect(git("rev-parse", "HEAD")).toBe(target);
    expect(existsSync(join(data, "update-guard-starts"))).toBe(false);
    expect(calls()).toBe("");
  });

  it.skipIf(!hasJq)("rolls back an interrupted apply on the first start, stale git lock and all", () => {
    writeMarker({ previousCommit: prev, targetCommit: target, bootAttempts: 0, stage: "applying" });
    writeFileSync(join(repo, "f.txt"), "half-written\n");
    writeFileSync(join(repo, ".git", "index.lock"), "");
    run();
    expect(git("rev-parse", "HEAD")).toBe(prev);
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("old\n");
    expect(calls()).toContain("npm ci --no-audit --no-fund --include-workspace-root --workspace=packages/server-daemon");
    expect(calls()).toContain("npx tsc -b packages/server-daemon");
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);
    const outcome = JSON.parse(readFileSync(join(data, "update-outcome.json"), "utf8"));
    expect(outcome).toMatchObject({ outcome: "rolled-back", previousCommit: prev, targetCommit: target });
  });

  it.skipIf(!hasJq)("leaves a staged update to the daemon's gate until it exceeds its starts", () => {
    git("checkout", "-q", target);
    writeMarker({ previousCommit: prev, targetCommit: target, bootAttempts: 1 });
    run();
    run();
    expect(git("rev-parse", "HEAD")).toBe(target);
    expect(calls()).toBe("");
    run();
    expect(git("rev-parse", "HEAD")).toBe(prev);
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);
    expect(existsSync(join(data, "update-guard-starts"))).toBe(false);
  });

  it.skipIf(!hasJq)("never carries a start count over from an earlier update", () => {
    git("checkout", "-q", target);
    writeFileSync(join(data, "update-guard-starts"), `${prev} 9\n`);
    writeMarker({ previousCommit: prev, targetCommit: target, bootAttempts: 0 });
    run();
    expect(git("rev-parse", "HEAD")).toBe(target);
    expect(readFileSync(join(data, "update-guard-starts"), "utf8")).toBe(`${target} 1\n`);
  });

  it.skipIf(!hasJq)("falls back to npm install, and keeps the marker when the rebuild can't finish", () => {
    writeMarker({ previousCommit: prev, targetCommit: target, bootAttempts: 0, stage: "applying" });
    run({ FAIL_NPM: "ci" });
    expect(calls()).toMatch(/npm ci[^\n]*\nnpm install/);
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);

    writeMarker({ previousCommit: prev, targetCommit: target, bootAttempts: 0, stage: "applying" });
    run({ FAIL_NPM: "all" });
    expect(existsSync(join(data, "update-pending.json"))).toBe(true);
  });

  it.skipIf(!hasJq)("rolls a 0-byte marker back to the last verified commit, rewriting truncated files", () => {
    // home2: power cut 2 s after the update; the marker, the checkout and
    // node_modules all came back as 0-byte files.
    writeFileSync(join(data, "update-pending.json"), "");
    writeFileSync(
      join(data, "update-outcome.json"),
      JSON.stringify({ outcome: "applied", at: 1, previousCommit: "0".repeat(40), targetCommit: prev, bootAttempts: 1 }),
    );
    writeFileSync(join(repo, "f.txt"), "");
    mkdirSync(join(repo, "packages"));
    writeFileSync(join(repo, "packages", "only-in-target.ts"), "");
    run();
    expect(git("rev-parse", "HEAD")).toBe(prev);
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("old\n");
    expect(existsSync(join(repo, "packages", "only-in-target.ts"))).toBe(false);
    expect(calls()).toContain("npx tsc -b packages/server-daemon");
    expect(existsSync(join(data, "update-pending.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, "update-outcome.json"), "utf8"))).toMatchObject({
      outcome: "rolled-back",
      previousCommit: prev,
      targetCommit: target,
    });
  });

  it.skipIf(!hasJq)("leaves a 0-byte marker alone when there's no known-good commit", () => {
    writeFileSync(join(data, "update-pending.json"), "");
    run();
    expect(git("rev-parse", "HEAD")).toBe(target);
    expect(calls()).toBe("");
  });

  it.skipIf(!hasJq)("ignores a marker it can't trust", () => {
    writeMarker({ previousCommit: "$(reboot)", targetCommit: target, bootAttempts: 0, stage: "applying" });
    run();
    expect(git("rev-parse", "HEAD")).toBe(target);
    expect(calls()).toBe("");
  });

  it("refuses paths that could break out of the script", () => {
    expect(() => buildUpdateGuardScript({ repoPath: "/opt/x'; reboot; '", dataDir: "/var/flagship" })).toThrow();
    expect(() => buildUpdateGuardScript({ repoPath: "/opt/flagship", dataDir: "relative" })).toThrow();
  });
});

describe("installUpdateGuard", () => {
  it("installs once, reloads systemd only on change, and skips non-systemd hosts", async () => {
    const files = new Map<string, string>();
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
    expect(files.get(UPDATE_GUARD_SCRIPT_PATH)).toContain("repo='/opt/flagship'");
    expect(UPDATE_GUARD_DROPIN).toContain(`ExecStartPre=-${UPDATE_GUARD_SCRIPT_PATH}`);
    expect(await installUpdateGuard(opts)).toBe(false);
    expect(runs).toEqual(["systemctl daemon-reload"]);
    expect(await installUpdateGuard({ ...opts, hasSystemd: () => false })).toBe(false);
  });
});
