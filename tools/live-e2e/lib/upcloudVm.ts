/**
 * A throwaway UpCloud VM for the live groups that need a plain Debian 13 machine rather than a
 * fleet box (the GPU groups). Every resource carries the gym label so the fleet sweep reaps a VM a
 * crashed run left behind; `destroy` is always called in the group's `finally`.
 *
 *   GYM_UPCLOUD_TOKEN_FILE  the API token (default ~/.config/flagship/upcloud-token)
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.upcloud.com/1.3";
const TOKEN_FILE = process.env.GYM_UPCLOUD_TOKEN_FILE || join(homedir(), ".config/flagship/upcloud-token");
const LABEL = { key: "flagship-env", value: "gym" };

export interface Vm {
  uuid: string;
  ip: string;
  key: string;
}

async function up(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: r.status, json };
}

export function run(cmd: string, args: string[], timeoutMs = 3_600_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const sshOpts = (key: string) => ["-i", key, "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10"];

export async function ssh(vm: Vm, command: string, timeoutMs?: number) {
  return await run("ssh", [...sshOpts(vm.key), `root@${vm.ip}`, command], timeoutMs);
}

export async function scp(vm: Vm, local: string, remote: string) {
  return await run("scp", [...sshOpts(vm.key), local, `root@${vm.ip}:${remote}`]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Debian 13 VM from UpCloud's public template, reachable over SSH with a fresh key. */
export async function createDebianVm(o: { dir: string; title: string; zone?: string; plan?: string; log: (s: string) => void }): Promise<Vm> {
  if (!existsSync(TOKEN_FILE)) throw new Error(`no UpCloud token at ${TOKEN_FILE}`);
  mkdirSync(o.dir, { recursive: true });
  const key = join(o.dir, "id_ed25519");
  if (!existsSync(key)) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  const templates = await up("GET", "/storage/template");
  const tpl = (templates.json?.storages?.storage ?? []).find((s: { title: string }) => /Debian GNU\/Linux 13/i.test(s.title));
  if (!tpl) throw new Error("no Debian 13 template on UpCloud");
  const r = await up("POST", "/server", {
    server: {
      zone: o.zone ?? "de-fra1",
      title: o.title,
      hostname: o.title.replace(/[^a-z0-9-]/g, "-").slice(0, 60),
      plan: o.plan ?? "4xCPU-8GB",
      labels: { label: [LABEL] },
      metadata: "yes",
      login_user: { username: "root", create_password: "no", ssh_keys: { ssh_key: [pub] } },
      storage_devices: { storage_device: [{ action: "clone", storage: tpl.uuid, title: `${o.title}-disk`, size: 60, tier: "maxiops" }] },
      networking: { interfaces: { interface: [{ type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }] } },
    },
  });
  if (r.status !== 202) throw new Error(`UpCloud create ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  const uuid: string = r.json.server.uuid;
  const ip: string = (r.json.server.ip_addresses?.ip_address ?? []).find((a: { access: string; family: string }) => a.access === "public" && a.family === "IPv4")?.address;
  const vm: Vm = { uuid, ip, key };
  o.log(`VM ${uuid} at ${ip}`);
  for (let i = 0; i < 90; i++) {
    const s = await up("GET", `/server/${uuid}`);
    if (s.json?.server?.state === "started" && (await ssh(vm, "true", 20_000)).code === 0) return vm;
    await sleep(10_000);
  }
  throw new Error("the VM never answered on SSH");
}

export async function destroyVm(vm: Vm, log: (s: string) => void): Promise<void> {
  await up("POST", `/server/${vm.uuid}/stop`, { stop_server: { stop_type: "hard", timeout: "60" } });
  for (let i = 0; i < 30; i++) {
    const s = await up("GET", `/server/${vm.uuid}`);
    if (s.json?.server?.state === "stopped") break;
    await sleep(5_000);
  }
  const d = await up("DELETE", `/server/${vm.uuid}?storages=1&backups=delete`);
  log(`VM ${vm.uuid} deleted (${d.status})`);
}

/** rust/ (without build output), the GPU check workloads, the drill scripts and the release trust files, as one tarball. */
export async function packRust(repo: string, out: string): Promise<void> {
  const r = await run("tar", ["--exclude=rust/target", "--exclude=.git", "-czf", out, "-C", repo, "rust", "tools/gpu", "tools/arch-drills/m7", "release/box-artifact-trust.json", "release/gpu-catalog"]);
  if (r.code !== 0) throw new Error(`tar: ${r.stderr.slice(0, 200)}`);
}
