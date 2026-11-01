/**
 * Release plan G9: retained TypeScript runs on one pinned Node, launched by absolute path, from a
 * sanitized environment, as an unprivileged user that cannot change its runtime or code; and a box
 * refuses an owner's build that is not the endorsed artifact unless the owner's policy names it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { KEYD_UNSET_ENV_LINE, keydServiceUnit } from "@flagship/keyd/unit";
import {
  DAEMON_HARDENING_DROPIN_PATH,
  PRIVD_DAEMON_DROPIN_PATH,
  RELEASE_DROPINS,
  UNSAFE_ENV,
  UNSET_ENV_LINE,
  daemonHardeningDropIn,
  daemonPrivdDropIn,
  privdUnit,
} from "@flagship/privd/unit";
import { noteSandboxDisabled, refreshDaemonHardening } from "../src/privdInstall.js";
import { buildUpdateGuardScript } from "../src/updateGuard.js";
import { accessServiceUnit, brokerServiceUnit, coreServiceUnit, keydRustDropIn } from "../src/rustStack/units.js";
import { LOCAL_BUILD_POLICY_MAX_MS, admitArtifact, canonicalLocalBuildPolicy, type LocalBuildPolicy } from "../src/localBuildPolicy.js";

const REPO = new URL("../../../", import.meta.url).pathname;
const prop = (unit: string, key: string) => unit.split("\n").filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));

const UNITS: Record<string, string> = {
  privd: privdUnit(),
  keyd: keydServiceUnit(),
  "keyd (Rust drop-in)": keydRustDropIn({ keydEntry: "/opt/flagship/packages/keyd/dist/main.js" }),
  broker: brokerServiceUnit(),
  core: coreServiceUnit(),
  access: accessServiceUnit(),
};

describe("one qualified Node, launched by absolute path", () => {
  it("every ExecStart names an absolute executable; Node is the release's link, never a PATH lookup", () => {
    for (const [name, unit] of Object.entries(UNITS)) {
      for (const line of [...prop(unit, "ExecStart"), ...prop(unit, "ExecStartPre")].filter(Boolean)) {
        const exe = line.replace(/^[+!@:-]+/, "").split(/\s+/)[0]!;
        expect(exe, `${name}: ${line}`).toMatch(/^\//);
        for (const tok of line.split(/\s+/)) if (/(^|\/)node$/.test(tok)) expect(tok, `${name}: ${line}`).toBe("/usr/local/bin/node");
      }
    }
    const userdata = readFileSync(join(REPO, "packages/flagship-builder/src/userdata.ts"), "utf8");
    expect(userdata).toMatch(/^ExecStart=\/usr\/local\/bin\/node --disable-warning=ExperimentalWarning packages\/server-daemon\/dist\/index\.js$/m);
  });

  it("/usr/local/bin/node is root's link to the installed release's own runtime, which the installers check against the lock", () => {
    const install = readFileSync(join(REPO, "installer/install-box-artifact.sh"), "utf8");
    expect(install).toContain(`ln -sfn "$current/.runtime/node/bin/node" "$bin/node.new"`);
    expect(install).toContain(`[ -x "$staging/app/.runtime/node/bin/node" ]`);
    const rollback = readFileSync(join(REPO, "installer/rollback-box-artifact.sh"), "utf8");
    expect(rollback).toContain(`ln -sfn "$dest/app/.runtime/node/bin/node"`);
  });
});

describe("a sanitized environment", () => {
  it("every unit that runs Flagship code drops the loader, Node and OpenSSL variables", () => {
    for (const v of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "OPENSSL_CONF", "NODE_EXTRA_CA_CERTS"]) expect(UNSAFE_ENV).toContain(v);
    for (const [name, unit] of Object.entries(UNITS)) {
      if (name.includes("drop-in")) continue; // inherits keyd's unit
      expect(unit, name).toContain(`\n${UNSET_ENV_LINE}\n`);
    }
    expect(daemonHardeningDropIn()).toContain(`\n${UNSET_ENV_LINE}\n`);
    expect(KEYD_UNSET_ENV_LINE).toBe(UNSET_ENV_LINE);
  });
});

describe("the unprivileged daemon's sandbox", () => {
  const h = daemonHardeningDropIn();

  it("runs as flagship with one capability and no new privileges (the privd drop-in)", () => {
    const d = daemonPrivdDropIn();
    expect(prop(d, "User")).toEqual(["flagship"]);
    expect(prop(d, "CapabilityBoundingSet")).toEqual(["CAP_NET_BIND_SERVICE"]);
    expect(prop(d, "NoNewPrivileges")).toEqual(["yes"]);
  });

  it("cannot write its runtime or approved code, the system, or the kernel's settings", () => {
    expect(prop(h, "ProtectSystem")).toEqual(["full"]);
    expect(prop(h, "ReadOnlyPaths")[0]!.split(" ")).toEqual(["-/opt/flagship-releases", "-/opt/flagship"]);
    for (const k of ["ProtectHome", "ProtectKernelTunables", "ProtectKernelLogs", "ProtectControlGroups", "ProtectHostname", "RestrictNamespaces", "RestrictRealtime", "RestrictSUIDSGID", "LockPersonality"]) {
      expect(prop(h, k), k).toEqual(["yes"]);
    }
    const denied = prop(h, "SystemCallFilter")[0]!;
    expect(denied.startsWith("~")).toBe(true);
    for (const g of ["@mount", "@module", "@raw-io", "@debug", "@reboot", "@swap"]) expect(denied.slice(1).split(" ")).toContain(g);
    expect(prop(h, "RestrictAddressFamilies")).toEqual(["AF_UNIX AF_INET AF_INET6 AF_NETLINK"]);
  });

  it("has resource limits", () => {
    expect(prop(h, "TasksMax")).toEqual(["4096"]);
    expect(prop(h, "MemoryMax")).toEqual(["75%"]);
    expect(prop(h, "LimitNOFILE")).toEqual(["65536"]);
    expect(prop(h, "LimitCORE")).toEqual(["0"]);
  });

  it("leaves out what the daemon still needs: the JIT (and so WebAssembly and fetch), the shared /tmp, GPU devices", () => {
    for (const k of ["MemoryDenyWriteExecute", "PrivateTmp", "PrivateDevices", "ProtectClock", "PrivateNetwork", "User"]) expect(prop(h, k), k).toEqual([]);
    expect(h).not.toMatch(/--jitless/);
  });

  it("is kept current by the root setup step: present exactly while the daemon runs as flagship", async () => {
    const files = new Map<string, string>();
    const runs: string[] = [];
    const o = {
      run: async (c: string, a: string[]) => void runs.push([c, ...a].join(" ")),
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      remove: async (p: string) => void files.delete(p),
    };
    expect(await refreshDaemonHardening(o)).toBe(false);
    expect(files.has(DAEMON_HARDENING_DROPIN_PATH)).toBe(false);
    files.set(PRIVD_DAEMON_DROPIN_PATH, daemonPrivdDropIn());
    expect(await refreshDaemonHardening(o)).toBe(true);
    expect(files.get(DAEMON_HARDENING_DROPIN_PATH)).toBe(h);
    expect(runs).toEqual(["systemctl daemon-reload"]);
    expect(await refreshDaemonHardening(o)).toBe(false);
    files.set(DAEMON_HARDENING_DROPIN_PATH, "stale");
    expect(await refreshDaemonHardening(o)).toBe(true);
    expect(files.get(DAEMON_HARDENING_DROPIN_PATH)).toBe(h);
    files.delete(PRIVD_DAEMON_DROPIN_PATH);
    expect(await refreshDaemonHardening(o)).toBe(true);
    expect(files.has(DAEMON_HARDENING_DROPIN_PATH)).toBe(false);
  });

  it("the root setup step that runs on every boot refreshes it", () => {
    const setup = readFileSync(join(REPO, "packages/server-daemon/src/setup.ts"), "utf8");
    expect(setup).toMatch(/"update-guard": async \(\) => \{[\s\S]*?refreshDaemonHardening\(/);
  });
});

describe("an owner's own build", () => {
  const seed = new Uint8Array(32).fill(5);
  const verifyAdminRoot = (m: Uint8Array, s: Uint8Array) => ed.verify(s, m, ed.getPublicKey(seed));
  const now = 1_780_000_000_000;
  const record: LocalBuildPolicy = {
    serverDomain: "home.alice.flagship.services", commit: "c".repeat(40), arch: "amd64",
    artifactSha256: "1".repeat(64), provenanceSha256: "2".repeat(64), issuedAtMs: now - 1000, expiresAtMs: now + 3_600_000,
  };
  const policy = { record, signature: ed.sign(canonicalLocalBuildPolicy(record), seed) };
  const base = {
    measured: { sha256: "1".repeat(64), bytes: 100 }, commit: record.commit, arch: "amd64" as const, serverDomain: record.serverDomain,
    provenanceSha256: record.provenanceSha256, verifyAdminRoot, nowMs: now,
  };

  it("is the endorsed release when it is byte for byte the endorsed artifact", () => {
    expect(admitArtifact({ ...base, endorsed: { artifactSha256: "1".repeat(64), artifactBytes: 100 } })).toEqual({ ok: true, basis: "endorsed" });
    expect(admitArtifact({ ...base, endorsed: { artifactSha256: "1".repeat(64), artifactBytes: 101 } })).toEqual({ ok: false, code: "not-endorsed" });
  });

  it("is refused by default when it differs, even with a valid owner record", () => {
    expect(admitArtifact({ ...base, endorsed: { artifactSha256: "9".repeat(64), artifactBytes: 100 } })).toEqual({ ok: false, code: "not-endorsed" });
    expect(admitArtifact({ ...base, policy })).toEqual({ ok: false, code: "local-build-policy-off" });
  });

  it("with owner builds allowed, needs the admin root's record for exactly this server, build and time", () => {
    const on = { ...base, policy, ownerBuildsAllowed: true };
    expect(admitArtifact(on)).toEqual({ ok: true, basis: "owner-local-build" });
    expect(admitArtifact({ ...on, verifyAdminRoot: () => false })).toEqual({ ok: false, code: "policy-signature" });
    expect(admitArtifact({ ...on, measured: { sha256: "3".repeat(64), bytes: 100 } })).toEqual({ ok: false, code: "policy-mismatch" });
    expect(admitArtifact({ ...on, serverDomain: "other.alice.flagship.services" })).toEqual({ ok: false, code: "policy-mismatch" });
    expect(admitArtifact({ ...on, provenanceSha256: "4".repeat(64) })).toEqual({ ok: false, code: "policy-mismatch" });
    expect(admitArtifact({ ...on, nowMs: record.expiresAtMs })).toEqual({ ok: false, code: "policy-expired" });
    const long = { ...record, expiresAtMs: record.issuedAtMs + LOCAL_BUILD_POLICY_MAX_MS + 1 };
    expect(admitArtifact({ ...on, policy: { record: long, signature: policy.signature } })).toEqual({ ok: false, code: "policy-bad" });
  });

  it("signs fixed canonical bytes", () => {
    expect(new TextDecoder().decode(canonicalLocalBuildPolicy(record))).toBe(
      `flagship/local-build-policy/v1|home.alice.flagship.services|${"c".repeat(40)}|amd64|${"1".repeat(64)}|${"2".repeat(64)}|${now - 1000}|${now + 3_600_000}`,
    );
    expect(() => canonicalLocalBuildPolicy({ ...record, commit: "abc" })).toThrow(/commit/);
  });
});

describe("the sandbox can never keep a box down", () => {
  const hasJq = spawnSync("jq", ["--version"]).status === 0;
  const PREV = "a".repeat(40);
  const TARGET = "b".repeat(40);
  let dir: string, releases: string, current: string, data: string, bin: string, sysd: string, hdir: string, script: string;
  const dropin = () => join(sysd, "flagship-daemon.service.d/45-hardening.conf");
  const installRelease = (commit: string) => {
    const app = join(releases, commit, "app");
    mkdirSync(join(app, ".runtime/node/bin"), { recursive: true });
    writeFileSync(join(app, ".runtime/node/bin/node"), "#!/bin/sh\n");
    chmodSync(join(app, ".runtime/node/bin/node"), 0o755);
    writeFileSync(join(releases, commit, "INSTALLED.json"), JSON.stringify({ commit, arch: "amd64", sequence: commit === PREV ? 1 : 2 }));
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandbox-guard-"));
    [releases, current, data, bin, sysd, hdir] = ["releases", "current", "data", "bin", "systemd", "hardening"].map((d) => join(dir, d)) as [string, string, string, string, string, string];
    for (const d of [releases, data, bin, join(sysd, "flagship-daemon.service.d")]) mkdirSync(d, { recursive: true });
    installRelease(PREV);
    installRelease(TARGET);
    symlinkSync(join(releases, TARGET, "app"), current);
    writeFileSync(join(data, "artifact-current.json"), JSON.stringify({ commit: TARGET }));
    writeFileSync(dropin(), daemonHardeningDropIn());
    writeFileSync(join(sysd, "flagship-daemon.service.d/40-privd.conf"), daemonPrivdDropIn());
    const rollback = join(dir, "rollback.sh");
    writeFileSync(rollback, `#!/bin/bash\nexec bash "${join(REPO, "installer/rollback-box-artifact.sh")}" "$1" --releases "${releases}" --current "${current}" --state "${data}" --bin "${bin}" --systemd "${sysd}"\n`);
    chmodSync(rollback, 0o755);
    script = join(dir, "guard.sh");
    writeFileSync(script, buildUpdateGuardScript({ repoPath: current, dataDir: data, maxStarts: 2, rollbackScript: rollback, systemdDir: sysd, hardeningStateDir: hdir }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => execFileSync("bash", [script], { encoding: "utf8" });

  it.skipIf(!hasJq)("rollback-box-artifact.sh removes this release line's drop-ins, and only those", () => {
    execFileSync("bash", [join(REPO, "installer/rollback-box-artifact.sh"), PREV, "--releases", releases, "--current", current, "--state", data, "--bin", bin, "--systemd", sysd]);
    expect(readlinkSync(current)).toBe(join(releases, PREV, "app"));
    expect(existsSync(dropin())).toBe(false);
    expect(existsSync(join(sysd, "flagship-daemon.service.d/40-privd.conf"))).toBe(true);
  });

  it.skipIf(!hasJq)("the guard's rollback of a crashing update takes the drop-in with it", () => {
    writeFileSync(join(data, "update-pending.json"), JSON.stringify({ previousCommit: PREV, targetCommit: TARGET, bootAttempts: 0, stage: "applying" }));
    const out = run();
    expect(out).toMatch(/rolled back to a{40}/);
    expect(existsSync(dropin())).toBe(false);
  });

  it.skipIf(!hasJq)("removes itself after five quick starts in a row and records it; a slow start resets the count", () => {
    for (let i = 1; i <= 4; i++) {
      run();
      expect(existsSync(dropin()), `start ${i}`).toBe(true);
    }
    expect(readFileSync(join(hdir, "starts"), "utf8").split(" ")[0]).toBe("4");
    const out = run();
    expect(out).toMatch(/sandbox drop-in was removed after 5 quick starts/);
    expect(existsSync(dropin())).toBe(false);
    expect(JSON.parse(readFileSync(join(hdir, "disabled.json"), "utf8"))).toMatchObject({ commit: TARGET, starts: 5 });

    writeFileSync(dropin(), daemonHardeningDropIn());
    rmSync(join(hdir, "disabled.json"));
    writeFileSync(join(hdir, "starts"), `4 ${Math.floor(Date.now() / 1000) - 3600}\n`);
    run();
    expect(existsSync(dropin())).toBe(true);
    expect(readFileSync(join(hdir, "starts"), "utf8").split(" ")[0]).toBe("1");
  });

  it("the root step does not write it back for the same release, and does for the next one", async () => {
    const files = new Map<string, string>([[PRIVD_DAEMON_DROPIN_PATH, daemonPrivdDropIn()]]);
    const o = {
      run: async () => undefined,
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      remove: async (p: string) => void files.delete(p),
      dataDir: "/d",
      hardeningStateDir: "/h",
    };
    files.set("/h/disabled.json", JSON.stringify({ at: 1, commit: TARGET, starts: 5 }));
    files.set("/d/artifact-current.json", JSON.stringify({ commit: TARGET }));
    expect(await refreshDaemonHardening(o)).toBe(false);
    expect(files.has(DAEMON_HARDENING_DROPIN_PATH)).toBe(false);
    files.set("/d/artifact-current.json", JSON.stringify({ commit: PREV }));
    expect(await refreshDaemonHardening(o)).toBe(true);
    expect(files.get(DAEMON_HARDENING_DROPIN_PATH)).toBe(daemonHardeningDropIn());
    expect(files.has("/h/disabled.json")).toBe(false);
  });

  it("the daemon says so once in Activity", async () => {
    const files = new Map<string, string>([["/h/disabled.json", JSON.stringify({ at: 7, commit: TARGET, starts: 5 })]]);
    const notes: Array<[string, boolean | undefined]> = [];
    const o = {
      note: (k: string, _d: string, x?: { ok?: boolean }) => void notes.push([k, x?.ok]),
      dataDir: "/d", hardeningStateDir: "/h",
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
    };
    expect(await noteSandboxDisabled(o)).toBe(true);
    expect(await noteSandboxDisabled(o)).toBe(false);
    expect(notes).toEqual([["server.sandbox.removed", false]]);
  });

  it("every rollback path names the same drop-ins", () => {
    const rb = readFileSync(join(REPO, "installer/rollback-box-artifact.sh"), "utf8");
    const rs = readFileSync(join(REPO, "rust/crates/flagship-updater/src/release.rs"), "utf8");
    expect(/^for d in (.+); do$/m.exec(rb)?.[1]?.split(" ")).toEqual([...RELEASE_DROPINS]);
    expect(/RELEASE_DROPINS: &\[&str\] = &\[(.+)\];/.exec(rs)?.[1]?.split(", ").map((x) => JSON.parse(x))).toEqual([...RELEASE_DROPINS]);
    expect(DAEMON_HARDENING_DROPIN_PATH.endsWith(RELEASE_DROPINS[0]!)).toBe(true);
  });
});
