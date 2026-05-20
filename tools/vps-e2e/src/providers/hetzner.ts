/**
 * Reference `VpsProvider` adapter — Hetzner Cloud, rescue-mode + `dd`
 * bridge.
 *
 * Hetzner Cloud has NO public custom-ISO upload API: server images come
 * from Hetzner's catalogue or your own snapshots, full stop. The
 * realistic boot path for a Flagship-personalized Alpine + apkovl ISO
 * is therefore:
 *
 *   1. POST /v1/servers                                       (ubuntu-22.04 + ssh_keys)
 *   2. POST /v1/servers/{id}/actions/enable_rescue            (linux64 + ssh_keys)
 *   3. POST /v1/servers/{id}/actions/reset                    (boot into rescue)
 *   4. wait until rescue SSHD is reachable (nc -z <ip> 22)
 *   5. ssh root@<ip> "wget <presigned-iso-url> | dd of=/dev/sda ... && reboot"
 *   6. the server reboots from disk into the Flagship Alpine ISO
 *   7. apkovl + install.sh take over; the existing harness drives the
 *      rest of the chain (awaitInstallRegistered, awaitUnlock, ...).
 *   8. DELETE /v1/servers/{id}                                (teardown — always)
 *
 * The `--iso` arg the CLI hands the provider is now a URL to the
 * already-uploaded personalized ISO (typically a 1-hour R2 presigned
 * URL the harness mints + cleans up around the run). A local path is
 * rejected with an actionable message (the bytes have to be reachable
 * from the rescue VPS — `dd` is run on the cloud node, not here).
 *
 * Auth is a single bearer token (`HCLOUD_TOKEN`). SSH key auth is the
 * only way into the rescue system from outside; the operator's local
 * `.demo-ssh-key` is uploaded idempotently as a named Hetzner SSH key.
 *
 * Pure helpers (URL/payload builders + response parsers) are
 * unit-tested with fixture payloads; the `fetch` / `ssh` calls are
 * authored + typechecked but not exercised by the test suite (a real
 * run incurs cloud cost). The CLI surfaces a `--plan` mode that
 * provisions nothing.
 *
 * No new runtime dep: `fetch` is global on Node ≥ 20; SSH is a
 * `child_process` shell-out (documented in `tools/vps-e2e/README.md`).
 */

import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import type {
  ProvisionRequest,
  VpsInstance,
  VpsProvider,
} from "../ports.js";

const API = "https://api.hetzner.cloud/v1";

/** Default name we use for the SSH key Hetzner sees. Idempotent. */
export const SSH_KEY_NAME = "flagship-vps-e2e";

/* ───────────────────────── pure helpers (unit-tested) ──────────────── */

/**
 * Build the create-server body for the rescue-mode boot path. The
 * placeholder image (`ubuntu-22.04`) is irrelevant — we never let it
 * boot from disk. `start_after_create: true` is fine because Hetzner's
 * rescue mode kicks in on the NEXT reset, not on first poweron.
 */
export function buildCreateServerBody(
  req: ProvisionRequest,
  sshKeyId: number | string,
  placeholderImage = "ubuntu-22.04",
): Record<string, unknown> {
  return {
    name: sanitizeServerName(req.label),
    server_type: req.size,
    location: req.region,
    image: placeholderImage,
    ssh_keys: [sshKeyId],
    start_after_create: true,
    labels: { "flagship-e2e": "1" },
    // Explicit public-network config. Modern Hetzner accounts can
    // default to private-only (Primary-IPs feature), which would
    // create a server with NO public IPv4/IPv6 — and then
    // `enable_rescue` 422s with "no public network interfaces
    // found, rescue system cannot be used". Force both on so the
    // rescue+dd flow works regardless of account default.
    public_net: { enable_ipv4: true, enable_ipv6: true },
  };
}

/** Hetzner server names: lowercase RFC-1035-ish, ≤63 chars. */
export function sanitizeServerName(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (s || "flagship-e2e").slice(0, 63);
}

/**
 * Reject anything that's not an http(s) URL: the rescue system needs
 * to `wget` the bytes itself, so a local path or a bare Hetzner ISO
 * name is incoherent here.
 */
export function assertIsoUrl(iso: string): string {
  if (!/^https?:\/\//i.test(iso)) {
    throw new Error(
      `Hetzner rescue-dd needs an http(s) URL the rescue VPS can fetch ` +
        `(got: ${iso}). Upload the personalized ISO to R2 and pass the ` +
        `presigned read URL as --iso.`,
    );
  }
  return iso;
}

export function enableRescueBody(
  sshKeyId: number | string,
): Record<string, unknown> {
  return { type: "linux64", ssh_keys: [sshKeyId] };
}

/** Parse POST /servers → server id + public IPv4. */
export function parseCreateServerResponse(json: unknown): {
  id: string;
  ip: string;
} {
  const j = json as {
    server?: {
      id?: number | string;
      public_net?: { ipv4?: { ip?: string } };
    };
  };
  const id = j.server?.id;
  if (id === undefined || id === null) {
    throw new Error("Hetzner create-server response had no server.id");
  }
  const ip = j.server?.public_net?.ipv4?.ip ?? "";
  return { id: String(id), ip };
}

export function parseServerStatus(json: unknown): {
  status: string;
  running: boolean;
  ip: string;
} {
  const j = json as {
    server?: { status?: string; public_net?: { ipv4?: { ip?: string } } };
  };
  const status = j.server?.status ?? "unknown";
  return {
    status,
    running: status === "running",
    ip: j.server?.public_net?.ipv4?.ip ?? "",
  };
}

/**
 * Parse POST /servers/{id}/actions/create_image → `{ image: { id } }`.
 * Hetzner returns an action envelope; we want the image id so the CLI
 * can poll `GET /images/{id}` until `status: "available"`.
 */
export function parseCreateImageResponse(json: unknown): {
  imageId: string;
} {
  const j = json as { image?: { id?: number | string } };
  const id = j.image?.id;
  if (id === undefined || id === null) {
    throw new Error("Hetzner create_image response had no image.id");
  }
  return { imageId: String(id) };
}

/** Parse GET /images/{id} → `{ status }` ("creating" | "available" | …). */
export function parseImageStatus(json: unknown): {
  status: string;
  available: boolean;
} {
  const j = json as { image?: { status?: string } };
  const status = j.image?.status ?? "unknown";
  return { status, available: status === "available" };
}

/** Build the create_image body (snapshot type + description). */
export function buildCreateImageBody(description: string): Record<string, unknown> {
  return { type: "snapshot", description };
}

/** Parse GET /ssh_keys → list of {id, name, public_key}. */
export function parseSshKeyList(json: unknown): Array<{
  id: number;
  name: string;
  public_key: string;
}> {
  const j = json as {
    ssh_keys?: Array<{ id?: number; name?: string; public_key?: string }>;
  };
  return (j.ssh_keys ?? [])
    .filter((k) => typeof k.id === "number" && typeof k.name === "string")
    .map((k) => ({
      id: k.id as number,
      name: k.name as string,
      public_key: k.public_key ?? "",
    }));
}

export function parseSshKeyCreate(json: unknown): {
  id: number;
  name: string;
} {
  const j = json as { ssh_key?: { id?: number; name?: string } };
  const id = j.ssh_key?.id;
  const name = j.ssh_key?.name;
  if (typeof id !== "number" || typeof name !== "string") {
    throw new Error("Hetzner create-ssh-key response was malformed");
  }
  return { id, name };
}

/**
 * Build the dd command run on the rescue VPS. We stream the ISO over
 * HTTPS straight into /dev/sda with `dd conv=fsync` so the write is
 * flushed before reboot. `set -euo pipefail` and `bash -lc` make the
 * pipeline failure-tolerant (a wget error must NOT lead to a partial
 * dd + reboot into a half-written disk).
 */
export function buildDdCommand(isoUrl: string): string {
  // Hetzner rescue images expose the primary disk as /dev/sda on
  // x86_64 CX22; nothing in this codebase is multi-disk-aware yet.
  return (
    "bash -lc " +
    JSON.stringify(
      [
        "set -euo pipefail",
        "echo '[flagship-e2e] downloading ISO + writing to /dev/sda…'",
        // -O- streams to stdout; pipefail makes the dd see a SIGPIPE if
        // wget dies. status=none keeps the rescue serial console clean.
        `wget --no-verbose -O- ${shellQuote(isoUrl)} | dd of=/dev/sda bs=4M conv=fsync status=none`,
        "sync",
        "echo '[flagship-e2e] dd complete; rebooting into the freshly-written disk…'",
        // `nohup … &` + exit so SSH can return cleanly before the box vanishes.
        "nohup bash -c 'sleep 2 && reboot -f' >/dev/null 2>&1 &",
        "exit 0",
      ].join("; "),
    )
  );
}

/** Minimal single-arg shell quoter (no command injection). */
export function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

/* ──────────────────────── the real-I/O adapter ─────────────────────── */

export interface HetznerOptions {
  token: string;
  /** Local SSH key path (PRIVATE half; the .pub sibling is uploaded). */
  sshKeyPath: string;
  /** Defaults are sensible but the operator can override. */
  bootPollIntervalMs?: number;
  bootPollMaxAttempts?: number;
  sshReachIntervalMs?: number;
  sshReachMaxAttempts?: number;
  /** Optional spawn shim — exported so tests can fake `ssh`. */
  spawnFn?: typeof spawn;
}

export class HetznerProvider implements VpsProvider {
  readonly name = "hetzner";
  private readonly token: string;
  private readonly sshKeyPath: string;
  private readonly pollMs: number;
  private readonly pollMax: number;
  private readonly sshIntervalMs: number;
  private readonly sshMaxAttempts: number;
  private readonly spawn: typeof spawn;
  /** The Hetzner SSH key id, resolved on first `provision`. */
  private cachedSshKeyId: number | null = null;

  constructor(opts: HetznerOptions) {
    if (!opts.token) {
      throw new Error("HetznerProvider requires a token (HCLOUD_TOKEN)");
    }
    if (!opts.sshKeyPath) {
      throw new Error("HetznerProvider requires sshKeyPath (private half)");
    }
    this.token = opts.token;
    this.sshKeyPath = opts.sshKeyPath;
    this.pollMs = opts.bootPollIntervalMs ?? 10_000;
    this.pollMax = opts.bootPollMaxAttempts ?? 60;
    this.sshIntervalMs = opts.sshReachIntervalMs ?? 5_000;
    this.sshMaxAttempts = opts.sshReachMaxAttempts ?? 24;
    this.spawn = opts.spawnFn ?? spawn;
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Hetzner ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 240)}`,
      );
    }
    return text ? JSON.parse(text) : {};
  }

  /** Upload the local SSH pubkey (idempotent — name-keyed). */
  async ensureSshKey(pubKeyContent: string): Promise<number> {
    if (this.cachedSshKeyId !== null) return this.cachedSshKeyId;
    const list = parseSshKeyList(
      await this.api("GET", `/ssh_keys?name=${encodeURIComponent(SSH_KEY_NAME)}`),
    );
    const existing = list.find((k) => k.name === SSH_KEY_NAME);
    if (existing) {
      this.cachedSshKeyId = existing.id;
      return existing.id;
    }
    const created = parseSshKeyCreate(
      await this.api("POST", "/ssh_keys", {
        name: SSH_KEY_NAME,
        public_key: pubKeyContent.trim(),
      }),
    );
    this.cachedSshKeyId = created.id;
    return created.id;
  }

  /**
   * Real provisioning path:
   *   1. POST /servers (ubuntu-22.04, ssh_keys: [id], start_after_create: true)
   *   2. POST /servers/{id}/actions/enable_rescue (linux64 + same key)
   *   3. POST /servers/{id}/actions/reset (boot into rescue)
   *   4. Poll rescue SSH reachability (tcp 22) on the public IP
   *   5. SSH in + run the `wget | dd | reboot` pipeline
   *   6. Return the VpsInstance for the rest of the chain to assert on.
   *
   * The caller MUST `ensureSshKey(pubkey)` once before the first
   * `provision` so the Hetzner-side SSH key id is cached on the
   * provider. (Failing that, we throw a deterministic error rather
   * than a confusing 4xx from /servers.)
   */
  async provision(req: ProvisionRequest): Promise<VpsInstance> {
    assertIsoUrl(req.iso);
    const sshKeyId = this.cachedSshKeyId;
    if (sshKeyId === null) {
      throw new Error(
        "HetznerProvider.provision called before ensureSshKey() — the " +
          "CLI must upload the local SSH pubkey first.",
      );
    }
    const created = parseCreateServerResponse(
      await this.api("POST", "/servers", buildCreateServerBody(req, sshKeyId)),
    );

    // From here on, any failure leaks a billable server unless we
    // destroy it. Wrap every subsequent step in a try/catch that
    // best-effort cleans up before re-throwing the original error.
    try {
      // Enable rescue + reset. Hetzner queues both actions; the next
      // boot lands in the rescue image rather than the placeholder Ubuntu.
      await this.api(
        "POST",
        `/servers/${created.id}/actions/enable_rescue`,
        enableRescueBody(sshKeyId),
      );
      await this.api("POST", `/servers/${created.id}/actions/reset`);

      // Re-poll for IP if the create response didn't carry one.
      let ip = created.ip;
      if (!ip) {
        const refreshed = parseServerStatus(
          await this.api("GET", `/servers/${created.id}`),
        );
        ip = refreshed.ip;
      }
      if (!ip) {
        throw new Error(
          `Hetzner server ${created.id} did not expose a public IPv4`,
        );
      }

      // Wait for rescue SSHD: status=running + tcp 22 open.
      await this.awaitRescueReady(created.id, ip);

      // Stream the ISO into /dev/sda and reboot.
      await this.ddIsoOnto(ip, req.iso);

      return { id: created.id, ip };
    } catch (e) {
      // POST /servers already succeeded so a server EXISTS on Hetzner
      // — destroy it before re-raising so the retry loop doesn't
      // accumulate billable orphans.
      try {
        await this.destroy(created.id);
      } catch {
        // Surface the ORIGINAL error, not a secondary cleanup error.
        // The orphan is now an operational concern surfaced in the
        // re-thrown error's text.
      }
      throw e;
    }
  }

  /** Poll until status=running AND `nc -z <ip> 22` succeeds. */
  async awaitRescueReady(id: string, ip: string): Promise<void> {
    let running = false;
    for (let i = 0; i < this.pollMax; i++) {
      const s = parseServerStatus(await this.api("GET", `/servers/${id}`));
      if (s.running) {
        running = true;
        break;
      }
      await sleep(this.pollMs);
    }
    if (!running) {
      throw new Error(
        `Hetzner server ${id} did not reach status=running within ` +
          `${this.pollMax} polls`,
      );
    }
    for (let i = 0; i < this.sshMaxAttempts; i++) {
      if (await tcpReachable(ip, 22, 5_000)) return;
      await sleep(this.sshIntervalMs);
    }
    throw new Error(
      `rescue SSHD on ${ip}:22 never became reachable within ` +
        `${this.sshMaxAttempts * this.sshIntervalMs}ms`,
    );
  }

  /** Run `wget … | dd … && reboot` on the rescue host as root. */
  async ddIsoOnto(ip: string, isoUrl: string): Promise<void> {
    const cmd = buildDdCommand(isoUrl);
    const args = [
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=30",
      "-i",
      this.sshKeyPath,
      `root@${ip}`,
      cmd,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = this.spawn("ssh", args, { stdio: "pipe" });
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.stdout?.on("data", (_c: Buffer) => {
        // Stream silently; the rescue command echoes progress lines
        // we could surface via logger but the CLI is logger-aware.
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        // The reboot pipeline backgrounds + exits 0 before the box
        // vanishes; an OpenSSH 255 means the connection was dropped by
        // the reboot itself, which is the expected happy path.
        if (code === 0) return resolve();
        if (code === 255) {
          // Soft success: stderr will mention "Connection closed" or
          // "broken pipe" — both are the reboot taking down sshd.
          if (/closed|reset|broken pipe|Connection closed/i.test(stderr)) {
            return resolve();
          }
        }
        reject(
          new Error(
            `ssh root@${ip} dd exited with code ${code}: ${stderr.slice(0, 400)}`,
          ),
        );
      });
    });
  }

  async awaitBoot(id: string): Promise<void> {
    // After the rescue dd + reboot, the box reboots once into the
    // freshly-written disk. Hetzner's API status flips off briefly
    // during reboot then back to "running". Poll until it's running
    // again — the install.sh + register happens on this boot and is
    // observed downstream by `awaitInstallRegistered`.
    for (let i = 0; i < this.pollMax; i++) {
      try {
        const s = parseServerStatus(await this.api("GET", `/servers/${id}`));
        if (s.running) return;
      } catch {
        // tolerate transient API blips during the reboot itself
      }
      await sleep(this.pollMs);
    }
    throw new Error(
      `Hetzner server ${id} did not return to status=running within ` +
        `${this.pollMax} polls after dd-reboot`,
    );
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.api("DELETE", `/servers/${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("HTTP 404")) throw e;
    }
  }

  /**
   * Snapshot the server's disk into a Hetzner image. Used by
   * `create-sample-user`: after the rescue-dd install + ACME finishes
   * on a temp VPS, snapshot it so subsequent on-connect provisions can
   * boot from the image in ~30s instead of doing the full install.
   *
   * Two-step on the wire:
   *   1. POST /servers/{id}/actions/create_image  → image.id, status=creating
   *   2. GET  /images/{id}  (poll until status=available)
   *
   * Returns the numeric image id as a string — the CLI persists it as
   * the demo user's `snapshot_id` via `/install-complete`.
   */
  async snapshot(
    serverId: string,
    description: string,
  ): Promise<{ snapshotId: string }> {
    const { imageId } = parseCreateImageResponse(
      await this.api(
        "POST",
        `/servers/${serverId}/actions/create_image`,
        buildCreateImageBody(description),
      ),
    );
    // Poll until the image leaves `creating`. Snapshots on a quiet
    // 40 GB CX22 disk take ~1-3 min in practice; budget 6 min.
    const maxAttempts = this.pollMax;
    for (let i = 0; i < maxAttempts; i++) {
      const s = parseImageStatus(await this.api("GET", `/images/${imageId}`));
      if (s.available) return { snapshotId: imageId };
      if (s.status === "unavailable" || s.status === "failed") {
        throw new Error(
          `Hetzner snapshot ${imageId} entered terminal status ${s.status}`,
        );
      }
      await sleep(this.pollMs);
    }
    throw new Error(
      `Hetzner snapshot ${imageId} did not become available within ` +
        `${maxAttempts} polls`,
    );
  }

  /**
   * Delete a Hetzner image (snapshot) by id. Idempotent — a 404 is
   * treated as success, mirroring `destroy(serverId)`.
   */
  async destroyImage(imageId: string): Promise<void> {
    try {
      await this.api("DELETE", `/images/${imageId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("HTTP 404")) throw e;
    }
  }
}

/* ───────────────────────── small unit-pure helpers ──────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port, family: 4 });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* swallow */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}
