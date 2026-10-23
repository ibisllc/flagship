/**
 * The operations the daemon needs once it runs without root (SEC-DAEMON-001): each allowed form, and
 * the refusals that keep the broker from being a way back to root.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FILES_HELPER_IMAGE,
  PrivdClient,
  PrivdError,
  PrivdServer,
  copyInFiles,
  dockerExec,
  dockerFileExec,
  hostExec,
  iptablesRestoreExec,
  releaseExec,
  setupExec,
  systemctlExec,
  wipeExec,
  type Exec,
  type RunResult,
} from "../src/index.js";

const refused = (f: () => unknown, re?: RegExp) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(PrivdError);
    if (re) expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error("expected a refusal");
};
const docker = (...argv: string[]) => dockerExec({ argv });
const VOL = "flagship-files-alice--chess";
const ROOT = "/var/lib/flagship-files";
const host = (file: string, argv: string[], mounts = "") => hostExec({ file, argv }, () => mounts);

describe("systemctl", () => {
  it("manages the daemon's own units with known verbs", () => {
    expect(systemctlExec({ argv: ["daemon-reload"] }).args).toEqual(["daemon-reload"]);
    expect(() => systemctlExec({ argv: ["start", "--no-block", "containerd.service", "docker.socket", "docker.service"] })).not.toThrow();
    expect(() => systemctlExec({ argv: ["show", "docker.service", "--property=ActiveState", "--property=SubState"] })).not.toThrow();
    expect(() => systemctlExec({ argv: ["enable", "--now", "ssh"] })).not.toThrow();
    expect(() => systemctlExec({ argv: ["is-active", "flagship-data-services.service"] })).not.toThrow();
  });

  it("refuses any other unit, verb or flag", () => {
    refused(() => systemctlExec({ argv: ["start", "getty@tty1.service"] }), /manages/);
    refused(() => systemctlExec({ argv: ["stop", "flagship-keyd.service; id"] }));
    refused(() => systemctlExec({ argv: ["enable", "docker.service"] }), /not enabled/);
    refused(() => systemctlExec({ argv: ["mask", "ssh"] }), /not allowed/);
    refused(() => systemctlExec({ argv: ["edit", "flagship-daemon.service"] }));
    refused(() => systemctlExec({ argv: ["set-property", "flagship-daemon.service", "CPUQuota=1%"] }));
    refused(() => systemctlExec({ argv: ["start", "--root=/tmp", "ssh"] }), /flag/);
    refused(() => systemctlExec({ argv: ["poweroff"] }));
  });
});

describe("docker for the unprivileged daemon", () => {
  it("never lets the root docker client read or write a host file", () => {
    for (const bad of [
      ["run", "--env-file", "/etc/shadow", "img"], ["run", "--env-file=/etc/shadow", "img"], ["run", "--label-file", "/root/.ssh/id_ed25519", "img"],
      ["run", "--cidfile", "/etc/cron.d/x", "img"], ["run", "--gpus", "all", "img"], ["run", "--cgroup-parent", "/", "img"],
    ]) refused(() => docker(...bad));
    const ctx = "/var/flagship/data/app-clones/alice--chess";
    expect(() => docker("build", "--network", "flagship-build", "--add-host", "registry.npmjs.org:10.0.0.1", "--memory", "2g", "--cpu-period", "100000", "--cpu-quota", "200000", "--ulimit", "nproc=256:256", "-t", "img", ctx)).not.toThrow();
    for (const bad of [
      ["build", "-o", "/etc", ctx], ["build", "--output=type=local,dest=/etc", ctx], ["build", "--secret", "id=x,src=/etc/shadow", ctx], ["build", "--build-context", "h=/", ctx],
      ["build", "--iidfile", "/etc/x", ctx], ["build", "--cache-to", "type=local,dest=/etc", ctx], ["build", "-t", "img", "/var/tmp/.flagship-x"], ["build", "-t", "img", "/"],
    ]) refused(() => docker(...bad));
  });

  it("a volume binds only its own app's disk image", () => {
    expect(() => docker("volume", "create", "--label", "flagship.files=prod", VOL)).not.toThrow();
    expect(() => docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/${VOL}/data`, "--label", "flagship.quota=loop", VOL)).not.toThrow();
    refused(() => docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", "device=/etc", VOL), /binds only/);
    refused(() => docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${ROOT}/flagship-files-bob--x/data`, VOL));
    refused(() => docker("volume", "create", "--opt", "type=ext4", "--opt", "device=/dev/sda1", VOL));
    refused(() => docker("volume", "create", "--driver", "rexray", VOL));
  });

  it("exec reaches only the data services, with only their tools, passing only PGPASSWORD", () => {
    expect(() => docker("exec", "-e", "PGPASSWORD=x", "flagship-postgres", "pg_dumpall", "-U", "a")).not.toThrow();
    expect(() => docker("exec", "flagship-forgejo", "sqlite3", "/var/lib/gitea/data/forgejo.db", ".backup '/x'")).not.toThrow();
    refused(() => docker("exec", "flagship-postgres", "sh", "-c", "id"), /may not run/);
    refused(() => docker("exec", "flagship-myapp", "pg_dump"), /data services/);
    refused(() => docker("exec", "-u", "0", "flagship-postgres", "psql"), /flag/);
    refused(() => docker("exec", "--privileged", "flagship-postgres", "psql"));
    refused(() => docker("exec", "-e", "LD_PRELOAD=/x", "flagship-postgres", "psql"), /PGPASSWORD/);
  });

  it("the files helper alone runs as uid 0, and only in its locked-down shape", () => {
    const helper = (...over: string[]) => ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH", "--security-opt", "no-new-privileges", "--read-only", "--user", "0:0", ...over, "--mount", `type=volume,src=${VOL},dst=/data,readonly`, "--entrypoint", "tar", FILES_HELPER_IMAGE, "-cf", "-", "-C", "/data", "."];
    expect(() => docker(...helper())).not.toThrow();
    expect(() => docker("run", "-i", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "FSETID", "--security-opt", "no-new-privileges", "--read-only", "--user", "0:0", "--mount", `type=volume,src=${VOL},dst=/data`, "--entrypoint", "tar", FILES_HELPER_IMAGE, "-xpf", "-", "-C", "/data")).not.toThrow();
    // The same with any loosening is an ordinary run, and an ordinary run is never root.
    refused(() => docker(...helper("--cap-add", "SYS_ADMIN")));
    refused(() => docker(...helper().map((a) => (a === "none" ? "bridge" : a))));
    refused(() => docker(...helper().map((a) => (a === FILES_HELPER_IMAGE ? "alpine" : a))));
    refused(() => docker(...helper().map((a) => (a === "--read-only" ? "--rm" : a))));
    refused(() => docker(...helper().map((a) => (a.startsWith("type=volume") ? "type=bind,src=/,dst=/data" : a))));
    refused(() => docker(...helper().map((a) => (a === "tar" ? "bash" : a))));
    refused(() => docker(...helper("--pid", "host")));
  });

  it("save, load and dumps stream through the daemon's own files, never a key", () => {
    expect(dockerFileExec({ argv: ["save", "img:1"], stdoutPath: "/var/flagship/data/app-copies/x/image.tar.partial" })).toMatchObject({ stdoutFile: "/var/flagship/data/app-copies/x/image.tar.partial" });
    expect(dockerFileExec({ argv: ["load", "-q"], stdinPath: "/var/tmp/.flagship-copy/image.tar" }).stdinFile).toBe("/var/tmp/.flagship-copy/image.tar");
    expect(dockerFileExec({ argv: ["exec", "-i", "-e", "PGPASSWORD", "flagship-postgres", "pg_restore", "-l"], stdinPath: "/var/flagship/x.dump", env: { PGPASSWORD: "p" } }).env).toEqual({ PGPASSWORD: "p" });
    for (const p of ["/etc/shadow", "/var/flagship/identity/box.key", "/var/flagship/keyd/x", "/var/flagship/swk.hex", "/var/flagship/acme/cert/a.pem", "/var/flagship/../../etc/shadow", "/var/flagshipx/y", "relative"]) {
      refused(() => dockerFileExec({ argv: ["save", "img"], stdoutPath: p }));
      refused(() => dockerFileExec({ argv: ["load", "-q"], stdinPath: p }));
    }
    refused(() => dockerFileExec({ argv: ["save", "-o", "/etc/x", "img"], stdoutPath: "/var/flagship/a" }));
    refused(() => dockerFileExec({ argv: ["load", "-i", "/etc/x"], stdinPath: "/var/flagship/a" }));
    refused(() => dockerFileExec({ argv: ["exec", "flagship-postgres", "psql"], env: { LD_PRELOAD: "/x" } }), /PGPASSWORD/);
    refused(() => dockerFileExec({ argv: ["cp", "c:/etc", "-"], stdoutPath: "/var/flagship/a" }));
  });
});

describe("host operations", () => {
  const mounts = `/dev/loop3 ${ROOT}/${VOL} ext4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n`;
  it("mount, unmount and resize only the apps' own images", () => {
    expect(host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/${VOL}.img`, `${ROOT}/${VOL}`]).file).toBe("/usr/bin/mount");
    expect(() => host("mount", ["-o", "remount,ro", `${ROOT}/${VOL}`])).not.toThrow();
    expect(() => host("umount", ["-l", `${ROOT}/${VOL}`])).not.toThrow();
    expect(() => host("resize2fs", ["/dev/loop3"], mounts)).not.toThrow();
    expect(() => host("losetup", ["-c", "/dev/loop3"], mounts)).not.toThrow();
    refused(() => host("resize2fs", ["/dev/sda1"], mounts));
    refused(() => host("resize2fs", ["/dev/loop4"], mounts));
    refused(() => host("mount", ["-o", "loop", `${ROOT}/${VOL}.img`, `${ROOT}/${VOL}`]));
    refused(() => host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", `${ROOT}/${VOL}.img`, "/etc"]));
    refused(() => host("mount", ["-o", "loop,nodev,nosuid,discard,noinit_itable", "/var/flagship/evil.img", `${ROOT}/${VOL}`]));
    refused(() => host("mount", ["--bind", "/", `${ROOT}/${VOL}`]));
    refused(() => host("umount", ["/"]));
  });

  it("makes, sizes, moves and removes only the images' own entries", () => {
    expect(host("mkdir", ["0755", ROOT]).args).toEqual(["-p", "-m", "0755", "--", ROOT]);
    expect(() => host("mkdir", ["0777", `${ROOT}/${VOL}/data`])).not.toThrow();
    expect(() => host("truncate", ["1073741824", `${ROOT}/${VOL}.img`])).not.toThrow();
    expect(() => host("truncate", ["0", `${ROOT}/${VOL}/.flagship-ballast`])).not.toThrow();
    expect(() => host("fallocate", ["-l", "4096", `${ROOT}/${VOL}/.flagship-ballast`])).not.toThrow();
    expect(() => host("mkfs.ext4", ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard", `${ROOT}/${VOL}.img`])).not.toThrow();
    expect(() => host("touch", [`${ROOT}/${VOL}.pending`])).not.toThrow();
    expect(() => host("rm", [`${ROOT}/orphaned/${VOL}.1760000000000.img`])).not.toThrow();
    expect(() => host("mv", [`${ROOT}/${VOL}.img`, `${ROOT}/orphaned/${VOL}.1760000000000.img`])).not.toThrow();
    expect(() => host("chattr", ["+i", `${ROOT}/${VOL}`])).not.toThrow();
    for (const [f, a] of [
      ["mkdir", ["0777", "/etc/cron.d"]], ["mkdir", ["4755", `${ROOT}/${VOL}`]], ["truncate", ["0", "/etc/shadow"]], ["fallocate", ["-l", "1", "/var/flagship/x"]],
      ["mkfs.ext4", ["/dev/sda1"]], ["mkfs.ext4", ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "root_owner=0:0", `${ROOT}/${VOL}.img`]], ["touch", ["/etc/nologin"]],
      ["rm", [ROOT]], ["rm", ["-rf", ROOT]], ["rm", ["/etc/shadow"]], ["rmdir", ["/etc"]], ["mv", [`${ROOT}/${VOL}.img`, `${ROOT}/orphaned/flagship-files-bob--x.1.img`]],
      ["mv", ["/etc/shadow", `${ROOT}/orphaned/${VOL}.1.img`]], ["chattr", ["-i", "/etc/passwd"]], ["chmod", ["4755", "/var/lib/docker/volumes/x/_data"]], ["chmod", ["0777", "/etc"]],
      ["cp", ["-a", "--", "/etc/.", `${ROOT}/${VOL}/data`]], ["du", ["-sk", "/root"]], ["fingerprint", ["/root"]], ["networkctl", ["up", "eth0"]],
    ] as Array<[string, string[]]>) refused(() => host(f, a));
    refused(() => host("sh", ["-c", "id"]), /unknown host operation/);
  });

  it("touches only the box's own egress chains", () => {
    expect(host("iptables", ["-t", "filter", "-N", "DOCKER-USER"]).args).toEqual(["-w", "-t", "filter", "-N", "DOCKER-USER"]);
    expect(() => host("iptables", ["-t", "nat", "-I", "PREROUTING", "1", "-j", "FLAGSHIP-EGRESS-NAT"])).not.toThrow();
    expect(() => host("ip6tables", ["-t", "filter", "-F", "FLAGSHIP-EGRESS6"])).not.toThrow();
    refused(() => host("iptables", ["-t", "filter", "-F", "INPUT"]));
    refused(() => host("iptables", ["-P", "INPUT", "ACCEPT"]));
    refused(() => host("iptables", ["-t", "filter", "-I", "INPUT", "1", "-j", "ACCEPT"]));
    const rules = ["*filter", ":FLAGSHIP-EGRESS-FWD - [0:0]", "-A FLAGSHIP-EGRESS-FWD -i fs-apps -p tcp -j REJECT --reject-with tcp-reset", "-A FLAGSHIP-EGRESS-FWD -j RETURN", "COMMIT", ""].join("\n");
    expect(iptablesRestoreExec({ family: 4, rules }).args).toEqual(["-w", "--noflush"]);
    for (const bad of ["*filter\n-A INPUT -j ACCEPT\nCOMMIT", "*raw\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -j DOCKER\nCOMMIT", "*filter\n-F\nCOMMIT", "*filter\n-A FLAGSHIP-EGRESS-FWD -g INPUT\nCOMMIT", "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT"]) {
      refused(() => iptablesRestoreExec({ family: 4, rules: bad }));
    }
  });
});

describe("releases, wipes and root steps", () => {
  const trust = { keys: ["a".repeat(64)], threshold: 1, nodeFloor: "24.0.0", minSequence: 3 };
  it("installs a release from a root copy of what the daemon downloaded, with the release's own trust", () => {
    const e = releaseExec({ action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, trust, "arm64");
    expect(e.copyIn).toEqual([
      { from: `/var/tmp/.flagship-update-${"b".repeat(12)}/flagship-box-${"b".repeat(12)}-arm64.manifest.json`, to: `/var/lib/flagship-privd/release/flagship-box-${"b".repeat(12)}-arm64.manifest.json` },
      { from: `/var/tmp/.flagship-update-${"b".repeat(12)}/flagship-box-${"b".repeat(12)}-arm64.tar.gz`, to: `/var/lib/flagship-privd/release/flagship-box-${"b".repeat(12)}-arm64.tar.gz` },
    ]);
    expect(e.args).toContain("--min-sequence");
    expect(e.args[e.args.indexOf("--artifact") + 1]).toMatch(/^\/var\/lib\/flagship-privd\//);
    expect(e.args[e.args.indexOf("--trust-keys") + 1]).toBe("a".repeat(64));
    expect(releaseExec({ action: "restore", commit: "d".repeat(40) }, trust, "arm64").args).toEqual(["/opt/flagship/installer/rollback-box-artifact.sh", "d".repeat(40)]);
    refused(() => releaseExec({ action: "install", commit: "main", sha256: "c".repeat(64) }, trust, "arm64"));
    refused(() => releaseExec({ action: "install", commit: "b".repeat(40), sha256: "c".repeat(64), trustKeys: "evil" }, trust, "arm64"), /unknown field/);
    refused(() => releaseExec({ action: "restore", commit: `${"d".repeat(40)} --state /etc` }, trust, "arm64"));
  });

  it("wipes only the data folder, and runs root steps by name from the release", () => {
    expect(wipeExec({ target: "data" }).args).toEqual(["-rf", "--one-file-system", "/var/flagship/data"]);
    refused(() => wipeExec({ target: "/" }));
    expect(setupExec({ step: "debug-access" }).args).toEqual(["/opt/flagship/packages/server-daemon/dist/setup.js", "debug-access"]);
    refused(() => setupExec({ step: "../../tmp/x" }), /unknown setup step/);
    refused(() => setupExec({ step: "gvisor", script: "/tmp/x.js" }), /unknown field/);
  });

  it("copies only a regular file the daemon owns, never through a link", async () => {
    const dir = await mkdtemp("/var/tmp/.flagship-privd-test-");
    const to = await mkdtemp(join(tmpdir(), "privd-stage-"));
    try {
      await writeFile(join(dir, "a.tar.gz"), "release");
      const me = { uid: process.getuid!(), gid: process.getgid!() };
      copyInFiles({ file: "/bin/true", args: [], timeoutMs: 1, copyIn: [{ from: join(dir, "a.tar.gz"), to: join(to, "r/a.tar.gz") }] } as Exec, me);
      expect(await readFile(join(to, "r/a.tar.gz"), "utf8")).toBe("release");
      await symlink("/etc/hosts", join(dir, "link"));
      refused(() => copyInFiles({ file: "/bin/true", args: [], timeoutMs: 1, copyIn: [{ from: join(dir, "link"), to: join(to, "l") }] } as Exec, me));
      refused(() => copyInFiles({ file: "/bin/true", args: [], timeoutMs: 1, copyIn: [{ from: join(dir, "a.tar.gz"), to: join(to, "o") }] } as Exec, { uid: me.uid + 1, gid: me.gid }), /daemon's own/);
      refused(() => copyInFiles({ file: "/bin/true", args: [], timeoutMs: 1, copyIn: [{ from: "/etc/hosts", to: join(to, "h") }] } as Exec, me));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(to, { recursive: true, force: true });
    }
  });
});

describe("over the socket", () => {
  it("never writes a database password into the audit log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "privd-"));
    await mkdir(dir, { recursive: true });
    const ran: Exec[] = [];
    const server = new PrivdServer({
      socketPath: join(dir, "p.sock"),
      auditPath: join(dir, "audit.log"),
      run: async (e): Promise<RunResult> => {
        ran.push(e);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await server.start();
    const c = new PrivdClient(join(dir, "p.sock"));
    await c.docker(["exec", "-e", "PGPASSWORD=s3cret", "flagship-postgres", "psql"]);
    await expect(c.systemctl(["start", "sshd-keygen@x.service"])).rejects.toMatchObject({ code: "forbidden" });
    await expect(c.docker(["run", "-v", "/:/host", "img"])).rejects.toMatchObject({ code: "forbidden" });
    await expect(c.dockerFile(["load", "-q"], { stdinPath: "/var/flagship/identity/box.key" })).rejects.toMatchObject({ code: "forbidden" });
    const audit = await readFile(join(dir, "audit.log"), "utf8");
    expect(audit).not.toContain("s3cret");
    expect(audit.split("\n").filter((l) => l.includes('"ok":false')).length).toBe(3);
    expect(ran.length).toBe(1);
    c.close();
    await server.stop();
  });
});
