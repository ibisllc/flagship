import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivdClient, PrivdError, PrivdServer, brokerCommandRunner, dockerExec, nftExec, powerExec, restartExec, type Exec, type RunResult } from "../src/index.js";
import { privdUnit } from "../src/unit.js";

const docker = (...argv: string[]) => dockerExec({ argv });
const refused = (f: () => unknown, re?: RegExp) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(PrivdError); if (re) expect((e as Error).message).toMatch(re); return; }
  throw new Error("expected a refusal");
};

describe("what the broker will run", () => {
  it("power and unit restarts come from a closed list", () => {
    expect(powerExec({ action: "poweroff" })).toMatchObject({ file: "/usr/bin/systemctl", args: ["poweroff"] });
    refused(() => powerExec({ action: "halt; rm -rf /" }));
    refused(() => powerExec({ action: "reboot", extra: 1 }), /unknown field/);
    expect(restartExec({ unit: "docker.service" }).args).toEqual(["restart", "docker.service"]);
    refused(() => restartExec({ unit: "ssh.service" }), /cannot be restarted/);
    refused(() => restartExec({ unit: "docker.service; id" }));
  });

  it("a container is never the host", () => {
    const ok = docker("run", "--rm", "--runtime=runsc", "--network=flagship-apps", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "10001:10001", "--memory", "512m", "img@sha256:" + "a".repeat(64));
    expect(ok.file).toBe("/usr/bin/docker");
    for (const bad of [
      ["run", "--privileged", "img"], ["run", "--cap-add=SYS_ADMIN", "img"], ["run", "--cap-add", "ALL", "img"], ["run", "--device=/dev/sda", "img"],
      ["run", "--pid=host", "img"], ["run", "--ipc", "host", "img"], ["run", "--userns=host", "img"], ["run", "--network=host", "img"], ["run", "--net", "host", "img"],
      ["run", "--security-opt", "seccomp=unconfined", "img"], ["run", "--security-opt=apparmor=unconfined", "img"], ["run", "-v", "/:/host", "img"], ["run", "--volume=/etc:/etc", "img"],
      ["run", "--mount", "type=bind,src=/,dst=/h", "img"], ["run", "--mount=type=bind,src=/var/flagship,dst=/x", "img"], ["run", "--user", "root", "img"], ["run", "-u", "0:0", "img"],
      ["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "img"], ["run", "--volumes-from", "other", "img"], ["run", "--runtime=weird", "img"], ["run", "--sysctl", "kernel.x=1", "img"],
    ]) refused(() => docker(...bad), undefined);
  });

  it("only an app's own files volume, or the egress resolver, may be mounted", () => {
    expect(() => docker("run", "--mount", "type=volume,src=flagship-files-alice--chess,dst=/data", "img")).not.toThrow();
    expect(() => docker("run", "--mount", "type=bind,src=/run/flagship-resolv-apps.conf,dst=/etc/resolv.conf,readonly", "img")).not.toThrow();
    refused(() => docker("run", "--mount", "type=volume,src=somebody-elses,dst=/data", "img"));
    refused(() => docker("create", "--mount", "type=volume,src=flagship-files-x,dst=/data", "img")); // only `run` mounts
  });

  it("docker subcommands outside the list, and exec/cp into containers, are refused", () => {
    for (const bad of [["exec", "c", "sh"], ["system", "prune"], ["plugin", "install", "x"], ["swarm", "init"], ["cp", "c:/etc/shadow", "/var/flagship/x"], ["save", "-o", "/tmp/x", "i"], ["load", "-i", "/tmp/x"], ["context", "use", "x"], ["login"], ["image", "build", "."], ["network", "prune"]]) refused(() => docker(...bad));
    for (const ok of [["ps", "-a"], ["inspect", "c"], ["stop", "c"], ["rm", "-f", "c"], ["image", "inspect", "i"], ["network", "create", "--internal", "n"], ["volume", "ls"], ["info"]]) expect(() => docker(...ok)).not.toThrow();
  });

  it("a build may use only an app-clone context", () => {
    expect(() => docker("build", "-t", "x", "--network", "flagship-build", "/var/flagship/data/app-clones/alice--chess")).not.toThrow();
    refused(() => docker("build", "-t", "x", "/var/flagship"));
    refused(() => docker("build", "-t", "x", "/var/flagship/data/app-clones/../../secrets"));
    refused(() => docker("build", "-f", "/etc/passwd", "/var/flagship/data/app-clones/alice--chess"));
    refused(() => docker("build", "-t", "x", "/var/flagship/data/app-clones/./hidden/.."));
  });

  it("compose manages only the box's data services", () => {
    const f = "/opt/flagship/installer/data-services/docker-compose.yml";
    expect(() => docker("compose", "-f", f, "--env-file", "/var/flagship/data-services.env", "up", "-d", "postgres")).not.toThrow();
    refused(() => docker("compose", "-f", "/tmp/evil.yml", "up"));
    refused(() => docker("compose", "-f", f, "exec", "postgres", "sh"));
    refused(() => docker("compose", "-f", f, "up", "-d", "--build"));
    refused(() => docker("compose", "-f", f, "--env-file", "/etc/shadow", "up"));
  });

  it("malformed docker requests are refused before anything is built", () => {
    refused(() => dockerExec({ argv: [] }));
    refused(() => dockerExec({ argv: "run img" }));
    refused(() => dockerExec({ argv: ["run", 5] }));
    refused(() => dockerExec({ argv: ["run", "a\u0000b"] }));
    refused(() => dockerExec({ argv: ["ps"], shell: "true" }));
  });

  it("the firewall script may touch only the box's own table", () => {
    const ok = [
      "add table inet flagship_egress", "flush table inet flagship_egress",
      "add chain inet flagship_egress forward { type filter hook forward priority 0; policy drop; }",
      'add rule inet flagship_egress forward iifname "fs-apps" ip daddr 10.0.0.1 tcp dport 443 accept',
    ].join("\n");
    expect(nftExec({ script: ok }).input).toBe(ok);
    for (const bad of [
      "flush ruleset", "delete table inet filter", "add table inet other", "add rule inet flagship_egress forward exec /bin/sh",
      "add rule inet flagship_egress forward accept; flush ruleset", "include \"/etc/x.nft\"", "add rule ip nat prerouting accept", "add rule inet flagship_egress forward `id`",
    ]) refused(() => nftExec({ script: bad }));
  });
});

describe("the broker over its socket", () => {
  async function rig(run: (e: Exec) => Promise<RunResult>) {
    const dir = await mkdtemp(join(tmpdir(), "privd-"));
    const socketPath = join(dir, "p.sock");
    const auditPath = join(dir, "audit.log");
    const server = new PrivdServer({ socketPath, run, auditPath });
    await server.start();
    const client = new PrivdClient(socketPath);
    return { server, client, auditPath, stop: async () => { client.close(); await server.stop(); } };
  }
  const ran: Exec[] = [];
  const ok: (e: Exec) => Promise<RunResult> = async (e) => { ran.push(e); return { code: 0, stdout: "done", stderr: "", timedOut: false }; };

  it("runs an allowed operation, refuses a forbidden one without running it, and audits both without bodies", async () => {
    ran.length = 0;
    const r = await rig(ok);
    expect(await r.client.docker(["ps", "-a"])).toMatchObject({ stdout: "done" });
    await expect(r.client.docker(["run", "--privileged", "img"])).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.client.call("shell", { cmd: "id" })).rejects.toMatchObject({ code: "unknown-op" });
    await r.client.nft("flush table inet flagship_egress");
    expect(ran.map((e) => e.file)).toEqual(["/usr/bin/docker", "/usr/sbin/nft"]);
    const audit = await readFile(r.auditPath, "utf8");
    expect(audit).toContain('"op":"docker"');
    expect(audit).toContain('"ok":false');
    expect(audit).not.toContain("flush table"); // the script body is not logged
    await r.stop();
  });

  it("reports a failing command and a timeout honestly", async () => {
    const failing = await rig(async () => ({ code: 3, stdout: "", stderr: "no such container", timedOut: false }));
    await expect(failing.client.docker(["stop", "c"])).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("no such container") });
    await failing.stop();
    const slow = await rig(async () => ({ code: null, stdout: "", stderr: "", timedOut: true }));
    await expect(slow.client.power("reboot")).rejects.toMatchObject({ code: "timed-out" });
    await slow.stop();
  });

  it("the unprivileged daemon's runner forwards docker and refuses every other binary", async () => {
    ran.length = 0;
    const r = await rig(ok);
    const runner = brokerCommandRunner(r.client);
    await runner.run("docker", ["ps"]);
    expect((await runner.capture("docker", ["info"])).stdout).toBe("done");
    await expect(runner.run("sh", ["-c", "id"])).rejects.toThrow(/not available/);
    await expect(runner.capture("mount", ["/dev/loop0", "/mnt"])).rejects.toThrow(/not available/);
    await r.stop();
  });

  it("a caller that skips hello gets nothing", async () => {
    const r = await rig(ok);
    const { Socket } = await import("node:net");
    const { encodeFrame, FrameReader } = await import("../src/wire.js");
    const res = await new Promise<unknown>((resolve) => {
      const s = new Socket();
      const reader = new FrameReader();
      s.connect((r.server as unknown as { o: { socketPath: string } }).o.socketPath, () => s.write(encodeFrame({ id: 1, op: "power", args: { action: "poweroff" } })));
      s.on("data", (d) => { resolve(reader.push(d)[0]); s.destroy(); });
    });
    expect(res).toMatchObject({ ok: false, code: "not-hello" });
    expect(ran.filter((e) => e.args.includes("poweroff"))).toEqual([]);
    await r.stop();
  });
});

describe("units", () => {
  it("the broker has no network, no new privileges and a narrow capability set, and the daemon's group can reach it", () => {
    const u = privdUnit();
    expect(u).toMatch(/PrivateNetwork=yes/);
    expect(u).toMatch(/NoNewPrivileges=yes/);
    expect(u).toMatch(/ProtectSystem=strict/);
    expect(u).toMatch(/Group=flagship/);
    expect(u).toMatch(/UMask=0007/);
    expect(u).not.toMatch(/CAP_SYS_PTRACE|CAP_SYS_MODULE|CAP_SYS_RAWIO/);
  });
});
