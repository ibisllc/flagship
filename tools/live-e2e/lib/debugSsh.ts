/**
 * The owner's debug access to an installer box (docs/recipe-delivery-and-remote-install.md "Debug access";
 * packages/server-daemon/src/debugAccessGate.ts): a `flagship/debug-access/v2` grant signed by the admin
 * root, carried in the recipe as the unsigned `debugGrant` sibling and read once at first boot. It opens the
 * `debug` user (SSH key only, passwordless sudo) until the grant ends. Scripts go over stdin to `sudo sh -s`
 * so no quoting reaches a remote command line.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import { signDebugAccessGrant, type DebugAccessGrant, type Keypair } from "@flagship/protocol";
import { run } from "./upcloudVm.js";

export interface DebugKey {
  path: string;
  publicKey: string;
}

/** An ed25519 key in `dir` (made once). */
export async function debugKey(dir: string): Promise<DebugKey> {
  const path = join(dir, "debug_ed25519");
  if (!existsSync(path)) {
    const r = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "flagship-gym-lane", "-f", path]);
    if (r.code !== 0) throw new Error(`ssh-keygen: ${r.stderr.slice(0, 200)}`);
  }
  // The grant takes `<type> <base64>`; the comment is dropped.
  const publicKey = readFileSync(`${path}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  return { path, publicKey };
}

/** The recipe's `debugGrant` sibling: `{grant, signatureHex}`, at most `hours` long (the box caps it at 7 days). */
export function debugGrantSibling(serverDomain: string, key: DebugKey, adminRoot: Keypair, hours = 8, now = Date.now()): { grant: DebugAccessGrant; signatureHex: string } {
  const grant: DebugAccessGrant = { serverDomain, sshPublicKey: key.publicKey, issuedAt: now, expiresAt: now + hours * 3_600_000 };
  return { grant, signatureHex: bytesToHex(signDebugAccessGrant(grant, adminRoot)) };
}

/** Runs `script` as root on the box (`ssh debug@ip sudo sh -s`, the script on stdin). */
export function sudoScript(ip: string, key: DebugKey, script: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      "ssh",
      ["-i", key.path, "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", `debug@${ip}`, "sudo", "-n", "sh", "-s"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += String(d)));
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    p.stdin.end(`${script}\n`);
  });
}
