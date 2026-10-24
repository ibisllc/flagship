/**
 * The daemon without root (SEC-DAEMON-001): what it sends the broker, that the broker accepts what
 * the daemon really runs, and the root steps' own check of a debug grant.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEBUG_ACCESS_HOUR_MS, ed, signAdminRootRotation, signDebugAccessGrant, type DebugAccessGrant, type Keypair } from "@flagship/protocol";
import { FILES_HELPER_IMAGE as BROKER_HELPER_IMAGE, FOLDER_FINGERPRINT_SCRIPT as BROKER_FINGERPRINT, PrivdServer, dockerExec, dockerFileExec, hostExec, type Exec, type RunResult } from "@flagship/privd";
import { FOLDER_FINGERPRINT_SCRIPT } from "../src/appQuota/loopVolumes.js";
import { UNPRIVILEGED_ENV, routePrivileged } from "../src/privileged.js";
import { installPrivd } from "../src/privdInstall.js";
import { dockerBuildArgs } from "../src/serviceRunner.js";
import { verifiedDebugGrant } from "../src/setup.js";
import { FILES_HELPER_IMAGE, filesArchiveDockerArgs, filesSizeDockerArgs } from "../src/volumeDump.js";

describe("the broker accepts what the daemon really runs", () => {
  it("pins the same helper image and folder fingerprint", () => {
    expect(BROKER_HELPER_IMAGE).toBe(FILES_HELPER_IMAGE);
    expect(BROKER_FINGERPRINT).toBe(FOLDER_FINGERPRINT_SCRIPT);
  });

  it("the files helpers and a build pass the broker's docker rules", () => {
    const vol = "flagship-files-alice--chess";
    expect(() => dockerExec({ argv: filesArchiveDockerArgs(vol, "dump") })).not.toThrow();
    expect(() => dockerExec({ argv: filesArchiveDockerArgs(vol, "restore") })).not.toThrow();
    expect(() => dockerExec({ argv: filesSizeDockerArgs(vol) })).not.toThrow();
    expect(() => dockerFileExec({ argv: filesArchiveDockerArgs(vol, "dump"), stdoutPath: "/var/flagship/data/_dumps/x.tar.partial" })).not.toThrow();
    const build = dockerBuildArgs("flagship-app:1", "/var/flagship/data/app-clones/alice--chess", { network: "flagship-build", memory: "2g", cpus: "2", pidsLimit: 256 } as Parameters<typeof dockerBuildArgs>[2]);
    expect(() => dockerExec({ argv: build })).not.toThrow();
  });

  it("the disk-image commands pass the broker's host rules", () => {
    const root = "/var/lib/flagship-files";
    const v = "flagship-files-alice--chess";
    const mkfs = ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard", `${root}/${v}.img`];
    expect(() => hostExec({ file: "mkfs.ext4", argv: mkfs }, () => "")).not.toThrow();
    expect(() => hostExec({ file: "fingerprint", argv: [`${root}/${v}/data`] }, () => "")).not.toThrow();
  });
});

describe("routing a command", () => {
  let dir: string;
  const ran: Exec[] = [];
  let server: PrivdServer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "route-"));
    server = new PrivdServer({
      socketPath: join(dir, "p.sock"),
      run: async (e): Promise<RunResult> => {
        ran.push(e);
        return { code: 0, stdout: "ran", stderr: "", timedOut: false };
      },
    });
    await server.start();
    process.env.FLAGSHIP_PRIVD_SOCKET = join(dir, "p.sock");
  });
  afterAll(async () => {
    delete process.env[UNPRIVILEGED_ENV];
    await server.stop();
  });

  it("runs everything itself without the drop-in's switch, as on a developer machine", async () => {
    delete process.env[UNPRIVILEGED_ENV];
    expect(await routePrivileged("docker", ["ps"])).toBeNull();
  });

  // Only an unprivileged process routes to the broker; run as root (a CI VM) it does everything itself.
  it.skipIf(process.getuid?.() === 0)("sends host commands to the broker once unprivileged, and keeps its own", async () => {
    process.env[UNPRIVILEGED_ENV] = "1";
    ran.length = 0;
    expect(await routePrivileged("docker", ["ps"])).toEqual({ stdout: "ran", stderr: "" });
    await routePrivileged("docker", ["save", "img"], { stdoutPath: "/var/flagship/data/x.tar.partial" });
    await routePrivileged("systemctl", ["reboot"]);
    await routePrivileged("rm", ["-rf", "/var/flagship/data"]);
    await routePrivileged("mount", ["-o", "remount,ro", "/var/lib/flagship-files/flagship-files-a"]);
    const rules = join(dir, "rules");
    await writeFile(rules, "*filter\n:FLAGSHIP-EGRESS-FWD - [0:0]\n-A FLAGSHIP-EGRESS-FWD -j RETURN\nCOMMIT\n");
    await routePrivileged("iptables-restore", ["-w", "--noflush", rules]);
    expect(ran.map((e) => `${e.file} ${e.args[0]}`)).toEqual([
      "/usr/bin/docker ps",
      "/usr/bin/docker save",
      "/usr/bin/systemctl reboot",
      "/usr/bin/rm -rf",
      "/usr/bin/mount -o",
      "/usr/sbin/iptables-restore -w",
    ]);
    expect(ran[1]!.stdoutFile).toBe("/var/flagship/data/x.tar.partial");
    expect(await routePrivileged("git", ["status"])).toBeNull();
    expect(await routePrivileged("du", ["-sk", "/var/flagship/data/app-clones"])).toBeNull();
    await expect(routePrivileged("sh", ["-c", "id"])).rejects.toThrow(/not available/);
    await expect(routePrivileged("bash", ["/tmp/x.sh"])).rejects.toThrow(/not available/);
    await expect(routePrivileged("docker", ["run", "--privileged", "img"])).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the root step's own check of a debug grant", () => {
  const DOMAIN = "home.alice.flagship.services";
  const NOW = 1_760_000_000_000;
  const kp = (n: number): Keypair => {
    const privateKey = new Uint8Array(32).fill(n);
    return { privateKey, publicKey: ed.getPublicKey(privateKey) };
  };
  const seed = kp(1);
  const rotated = kp(2);
  const irk = kp(3);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const sshKey = (n: number) => {
    const type = Buffer.from("ssh-ed25519");
    const blob = Buffer.alloc(4 + type.length + 4 + 32);
    blob.writeUInt32BE(type.length, 0);
    type.copy(blob, 4);
    blob.writeUInt32BE(32, 4 + type.length);
    Buffer.from(ed.getPublicKey(new Uint8Array(32).fill(n))).copy(blob, 8 + type.length);
    return `ssh-ed25519 ${blob.toString("base64")}`;
  };
  const state = (key: Keypair, g: Partial<DebugAccessGrant> = {}, extra: Record<string, unknown> = {}) => {
    const grant: DebugAccessGrant = { serverDomain: DOMAIN, sshPublicKey: sshKey(0x11), issuedAt: NOW - 1000, expiresAt: NOW + DEBUG_ACCESS_HOUR_MS, ...g };
    return { version: 2, floorIssuedAt: 0, active: { grant, signatureHex: hex(signDebugAccessGrant(grant, key)), ...extra } };
  };
  const check = (s: unknown, rotations?: Array<Record<string, unknown>>) =>
    verifiedDebugGrant({
      state: s,
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      adminRootPub: seed.publicKey,
      username: "alice",
      ...(rotations ? { rotations: async () => rotations as never } : {}),
      now: NOW,
    });

  it("opens for the admin root, and for the root it rotated to by a proof from the seed", async () => {
    expect((await check(state(seed))).ok).toBe(true);
    const rotation = { username: "alice", oldAdminRootPub: seed.publicKey, newAdminRootPub: rotated.publicKey, issuedAt: NOW - 5000 };
    const chain = [{ seq: 1, oldAdminRootPub: hex(seed.publicKey), newAdminRootPub: hex(rotated.publicKey), signatureHex: hex(signAdminRootRotation(rotation, seed)), issuedAt: rotation.issuedAt }];
    expect((await check(state(rotated), chain)).ok).toBe(true);
    // A chain the seed never signed moves nothing.
    const forged = [{ ...chain[0]!, signatureHex: hex(signAdminRootRotation(rotation, rotated)) }];
    expect((await check(state(rotated), forged)).ok).toBe(false);
  });

  it("refuses what the daemon could write on its own", async () => {
    expect(await check(state(kp(9)))).toMatchObject({ ok: false, reason: /owner/ });
    expect(await check(state(irk))).toMatchObject({ ok: false }); // the account key is not enough where an admin root is pinned
    expect(await check(state(seed, { serverDomain: "home.bob.flagship.services" }))).toMatchObject({ ok: false, reason: /another server/ });
    expect(await check(state(seed, { expiresAt: NOW - 1 }))).toMatchObject({ ok: false, reason: /ended/ });
    expect(await check(state(seed, { issuedAt: NOW + 20 * 24 * DEBUG_ACCESS_HOUR_MS, expiresAt: NOW + 21 * 24 * DEBUG_ACCESS_HOUR_MS }))).toMatchObject({ ok: false, reason: /dates/ });
    expect(await check(state(seed, {}, { ending: "revoked" }))).toMatchObject({ ok: false });
    expect(await check(null)).toMatchObject({ ok: false });
    const s = state(seed);
    s.active.grant.sshPublicKey = sshKey(0x12);
    expect((await check(s)).ok).toBe(false);
  });
});

describe("installing the broker", () => {
  const base = (over: Partial<Parameters<typeof installPrivd>[0]> = {}) => {
    const written: string[] = [];
    const runs: string[] = [];
    let handedOver = false;
    const o: Parameters<typeof installPrivd>[0] = {
      repoPath: "/opt/flagship",
      hasSystemd: () => true,
      fileExists: () => true,
      read: async () => null,
      write: async (p) => {
        written.push(p);
      },
      run: async (c, a) => {
        runs.push(`${c} ${a.join(" ")}`);
      },
      handOver: async () => {
        handedOver = true;
      },
      ...over,
    };
    return { o, written, runs, handedOver: () => handedOver };
  };

  it("switches the daemon only once the broker answers", async () => {
    const up = base({ brokerAnswers: async () => true });
    expect(await installPrivd(up.o)).toBe("switched");
    expect(up.written).toEqual(["/etc/systemd/system/flagship-privd.service", "/etc/systemd/system/flagship-daemon.service.d/40-privd.conf"]);
    expect(up.handedOver()).toBe(true);
    expect(up.runs).toContain("systemctl restart flagship-privd.service");

    const down = base({ brokerAnswers: async () => false });
    expect(await installPrivd(down.o)).toBe("failed");
    expect(down.written).toEqual(["/etc/systemd/system/flagship-privd.service"]);
    expect(down.handedOver()).toBe(false);
  });

  it("does nothing without systemd or the broker's build", async () => {
    expect(await installPrivd(base({ hasSystemd: () => false }).o)).toBe("skipped-no-systemd");
    expect(await installPrivd(base({ fileExists: () => false }).o)).toBe("skipped-no-build");
  });
});
