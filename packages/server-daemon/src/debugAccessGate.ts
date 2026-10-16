import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  DEBUG_ACCESS_MAX_MS,
  debugAccessGrantProblem,
  parseDebugAccessGrant,
  parseDebugAccessRevoke,
  sshKeyFingerprint,
  verifyDebugAccessGrant,
  verifyDebugAccessRevoke,
  type AdminGrantView,
  type DebugAccessGrant,
  type DebugAccessRevoke,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { keepCorruptAside, readStateFile, removeDurable, writeFileDurable } from "./durableFile.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

/**
 * Owner debug access (docs/recipe-delivery-and-remote-install.md "Debug
 * access"): the one place on the box that lets a person in over SSH. It is a
 * shipping feature, so the release guard holds this file to these rules:
 *
 *   - Only a verified `flagship/debug-access/v2` grant naming this box opens
 *     it: the admin root on an admin-pinned box, the IRK only where none is
 *     pinned. Co-managers and non-admin devices can't sign one.
 *   - SSH public key only. The `debug` user has no password; sshd takes only
 *     that key for it, from a root-owned file, with OpenSSH's own
 *     `expiry-time` on the key as a backstop.
 *   - It ends by itself at `expiresAt` (at most 7 days), or at once on a
 *     `flagship/debug-access-revoke/v1`: the key goes, the account is locked
 *     and its sessions are killed. A newer grant renews it.
 *   - State is written durably before access opens and after it closes, so a
 *     restart finishes a half-done close and never reopens an ended grant;
 *     grants and revokes older than the newest one taken are replays.
 *
 * Grants arrive in the recipe (`debugGrant`, read once at first boot) or from
 * an admin device through `POST /api/screens/debug-access`.
 */

const DEBUG_USER = "debug";
const KEY_FILE = "/etc/flagship/debug-ssh/authorized_keys";
const SSHD_DROPIN = "/etc/ssh/sshd_config.d/10-flagship-debug.conf";
const SUDOERS_DROPIN = "/etc/sudoers.d/90-flagship-debug";
/** Written by the v1 gate; its password login is closed on the first start. */
const LEGACY_BANNER = "/etc/issue.d/99-flagship-debug.issue";

const SSHD_CONFIG =
  "# Flagship debug access: owner-signed, SSH key only, ends on its own.\n" +
  `Match User ${DEBUG_USER}\n` +
  `    AuthorizedKeysFile ${KEY_FILE}\n` +
  "    AuthenticationMethods publickey\n" +
  "    PubkeyAuthentication yes\n" +
  "    PasswordAuthentication no\n" +
  "    KbdInteractiveAuthentication no\n";

export const DEBUG_PATH = "/api/screens/debug-access";
export const DEBUG_REVOKE_PATH = "/api/screens/debug-access/revoke";

const execFileP = promisify(execFile);

/** argv-only command runner (no shell), injected for tests. */
export interface DebugCommandRunner {
  run(cmd: string, args: string[]): Promise<void>;
}

export const realDebugCommandRunner: DebugCommandRunner = {
  async run(cmd, args) {
    await execFileP(cmd, args, { timeout: 30_000 });
  },
};

/** What the box does to the OS. Every step is best-effort and idempotent. */
export interface DebugSystem {
  open(key: { sshPublicKey: string; expiresAt: number }): Promise<void>;
  close(): Promise<void>;
}

export interface DebugSystemOptions {
  runner: DebugCommandRunner;
  writeFile?: (path: string, content: string, mode: number) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  log?: (m: string) => void;
}

/** OpenSSH `expiry-time` (UTC). */
export function sshExpiryTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function authorizedKeyLine(key: { sshPublicKey: string; expiresAt: number }): string {
  return `expiry-time="${sshExpiryTime(key.expiresAt)}" ${key.sshPublicKey} flagship-debug-access\n`;
}

export function buildDebugSystem(opts: DebugSystemOptions): DebugSystem {
  const log = opts.log ?? (() => {});
  const write =
    opts.writeFile ??
    (async (path: string, content: string, mode: number) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, content, { mode });
    });
  const remove = opts.removeFile ?? ((path: string) => rm(path, { force: true }));
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      log(`[debug-access] ${what} failed (continuing): ${(e as Error).message}`);
    }
  };
  const run = (cmd: string, args: string[]) => step(`${cmd} ${args.join(" ")}`, () => opts.runner.run(cmd, args));

  return {
    async open(key) {
      await run("useradd", ["-m", "-s", "/bin/bash", DEBUG_USER]);
      // `*` is "no password" (not "locked"), so key auth works and nothing else does.
      await run("usermod", ["-p", "*", "-e", "", "-s", "/bin/bash", DEBUG_USER]);
      await step(`write ${KEY_FILE}`, () => write(KEY_FILE, authorizedKeyLine(key), 0o644));
      await step(`write ${SUDOERS_DROPIN}`, () => write(SUDOERS_DROPIN, `${DEBUG_USER} ALL=(ALL:ALL) NOPASSWD: ALL\n`, 0o440));
      await step(`write ${SSHD_DROPIN}`, () => write(SSHD_DROPIN, SSHD_CONFIG, 0o644));
      // The VM appliance ships without host keys; -A makes only the missing ones.
      await run("ssh-keygen", ["-A"]);
      await run("systemctl", ["enable", "--now", "ssh"]);
      await run("systemctl", ["reload", "ssh"]);
    },
    async close() {
      await step(`remove ${KEY_FILE}`, () => remove(KEY_FILE));
      await step(`remove ${SUDOERS_DROPIN}`, () => remove(SUDOERS_DROPIN));
      // Locked with no password hash (this also drops the v1 gate's known one) and expired.
      await run("usermod", ["-p", "!", "-e", "1", DEBUG_USER]);
      await run("loginctl", ["terminate-user", DEBUG_USER]);
      await run("pkill", ["-KILL", "-u", DEBUG_USER]);
      // What else the v1 gate left: a sudo group, a home key, a banner.
      await run("gpasswd", ["-d", DEBUG_USER, "sudo"]);
      await step(`remove /home/${DEBUG_USER}/.ssh`, () => remove(`/home/${DEBUG_USER}/.ssh/authorized_keys`));
      await step(`remove ${LEGACY_BANNER}`, () => remove(LEGACY_BANNER));
      await step(`remove ${SSHD_DROPIN}`, () => remove(SSHD_DROPIN));
      await run("systemctl", ["reload", "ssh"]);
    },
  };
}

export type DebugGrantedBy = "admin" | "owner-key";

export interface DebugAccessView {
  on: boolean;
  /** Unix ms; null when off. */
  expiresAt: number | null;
  /** `SHA256:…` of the key let in; null when off. */
  keyFingerprint: string | null;
  /** `admin`: the account's admin root or an admin device; `owner-key`: the IRK (no admin root pinned). */
  grantedBy: DebugGrantedBy | null;
  /** How the last grant ended, when it is off. */
  lastEnded?: { at: number; why: "expired" | "revoked" };
}

interface ActiveGrant {
  grant: DebugAccessGrant;
  signatureHex: string;
  keyFingerprint: string;
  grantedBy: DebugGrantedBy;
  source: "install" | "owner";
  /** Box time it opened. */
  openedAt: number;
  /** Set before the OS is closed, so a restart finishes the close. */
  ending?: "expired" | "revoked";
}

interface DebugAccessState {
  version: 2;
  /** Newest `issuedAt` of any grant or revoke taken; anything not newer is a replay. */
  floorIssuedAt: number;
  /** The recipe's grant has been looked at (it is never taken twice). */
  installGrantSeen: boolean;
  active: ActiveGrant | null;
  lastEnded?: { at: number; why: "expired" | "revoked" };
}

export interface DebugAuthority {
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username: string;
  activeGrants?: readonly AdminGrantView[];
}

export interface DebugAccessOptions {
  serverDomain: string;
  authority: () => DebugAuthority;
  /** `<dataDir>/debug-access.json`. */
  statePath: string;
  /** The v1 gate's marker (`<dataDir>/debug-access-done.json`); its access is closed on start. */
  legacyMarkerPath?: string;
  system: DebugSystem;
  /** The recipe grant (the install blob's `debugGrant`), read once. */
  installGrant?: () => Promise<unknown>;
  /** Box activity: `server.debug-access.{granted,renewed,expired,revoked}`. */
  activity?: (kind: string, detail: string) => void;
  now?: () => number;
  /** How far a grant or revoke from a device may be from the box clock. Default 10 min. */
  maxSkewMs?: number;
  /** How often expiry is checked besides the exact timer. Default 30 s. */
  tickMs?: number;
  log?: (m: string) => void;
}

export type DebugResult =
  | { ok: true; view: DebugAccessView; change: "granted" | "renewed" | "revoked" | "unchanged" }
  | { ok: false; status: number; error: string };

function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z").replace("T", " ");
}

const REFUSED_SIGNER =
  "This server takes debug access only from an admin device of this account.";

export class DebugAccessController {
  private state: DebugAccessState = { version: 2, floorIssuedAt: 0, installGrantSeen: false, active: null };
  private ready: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: DebugAccessOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  /** Load state, finish or expire whatever was open, take the recipe grant once. Never throws. */
  start(): Promise<void> {
    if (!this.ready) this.ready = this.serial(() => this.boot()).catch((e) => this.log(`[debug-access] start failed: ${(e as Error).message}`));
    return this.ready;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
  }

  view(): DebugAccessView {
    const a = this.state.active;
    if (a && !a.ending && a.grant.expiresAt > this.now()) {
      return { on: true, expiresAt: a.grant.expiresAt, keyFingerprint: a.keyFingerprint, grantedBy: a.grantedBy };
    }
    return {
      on: false,
      expiresAt: null,
      keyFingerprint: null,
      grantedBy: null,
      ...(this.state.lastEnded ? { lastEnded: this.state.lastEnded } : {}),
    };
  }

  /** A grant from an admin device (`{grant, signatureHex}`). */
  async grant(body: unknown): Promise<DebugResult> {
    await this.start();
    return this.serial(() => this.take(body, "owner"));
  }

  /** A revoke from an admin device (`{revoke, signatureHex}`). */
  async revoke(body: unknown): Promise<DebugResult> {
    await this.start();
    return this.serial(() => this.takeRevoke(body));
  }

  /** Close it if it has run out. Exposed for tests; the timers call it. */
  async checkExpiry(): Promise<void> {
    await this.serial(async () => {
      const a = this.state.active;
      if (a && (a.ending || a.grant.expiresAt <= this.now())) await this.end(a.ending ?? "expired");
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async boot(): Promise<void> {
    await this.load();
    if (this.opts.legacyMarkerPath) await this.closeLegacy(this.opts.legacyMarkerPath);
    const a = this.state.active;
    if (a) {
      if (a.ending || a.grant.expiresAt <= this.now()) {
        await this.end(a.ending ?? "expired");
      } else {
        await this.opts.system.open({ sshPublicKey: a.grant.sshPublicKey, expiresAt: a.grant.expiresAt });
        this.arm();
      }
    }
    if (!this.state.installGrantSeen) {
      this.state.installGrantSeen = true;
      await this.save();
      let raw: unknown = null;
      try {
        raw = (await this.opts.installGrant?.()) ?? null;
      } catch (e) {
        this.log(`[debug-access] could not read the recipe grant: ${(e as Error).message}`);
      }
      if (raw) {
        const r = await this.take(raw, "install");
        this.log(r.ok ? "[debug-access] the recipe's grant opened debug access" : `[debug-access] the recipe's grant was refused: ${r.error}`);
      }
    }
  }

  private async load(): Promise<void> {
    const read = await readStateFile(this.opts.statePath);
    if (read.kind === "missing") return;
    if (read.kind === "ok") {
      try {
        const s = JSON.parse(read.text) as DebugAccessState;
        if (s && s.version === 2 && typeof s.floorIssuedAt === "number") {
          if (s.active && !parseDebugAccessGrant(s.active.grant)) throw new Error("the open grant can't be read");
          this.state = {
            version: 2,
            floorIssuedAt: s.floorIssuedAt,
            installGrantSeen: s.installGrantSeen === true,
            active: s.active ?? null,
            ...(s.lastEnded ? { lastEnded: s.lastEnded } : {}),
          };
          return;
        }
        throw new Error("not a debug-access state");
      } catch (e) {
        await keepCorruptAside(this.opts.statePath, e, "Debug access was turned off.");
      }
    } else {
      await keepCorruptAside(this.opts.statePath, read.error, "Debug access was turned off.");
    }
    // Fail closed: close whatever might be open and refuse every grant signed before now.
    await this.opts.system.close();
    this.state = { version: 2, floorIssuedAt: this.now(), installGrantSeen: true, active: null };
    await this.save();
  }

  private async closeLegacy(marker: string): Promise<void> {
    const read = await readStateFile(marker);
    if (read.kind === "missing") return;
    await this.opts.system.close();
    await removeDurable(marker);
    this.opts.activity?.("server.debug-access.revoked", "Old password debug access was turned off. Turn it on again with an SSH key.");
  }

  private async save(): Promise<void> {
    await writeFileDurable(this.opts.statePath, JSON.stringify(this.state));
  }

  private signer(grantOrRevoke: DebugAccessGrant | DebugAccessRevoke, sig: Uint8Array, isGrant: boolean): DebugGrantedBy | null {
    const a = this.opts.authority();
    const verify = (isGrant ? verifyDebugAccessGrant : verifyDebugAccessRevoke) as (
      o: DebugAccessGrant | DebugAccessRevoke,
      s: Uint8Array,
      p: Uint8Array,
    ) => boolean;
    const ok = authorizeSensitiveOrder({
      order: grantOrRevoke,
      signature: sig,
      verify,
      ownerIrkPub: a.ownerIrkPub,
      ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
      username: a.username,
      ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
      now: this.now(),
    });
    if (!ok) return null;
    return a.adminRootPub && a.adminRootPub.length === 32 ? "admin" : "owner-key";
  }

  private fresh(issuedAt: number): boolean {
    const skew = this.opts.maxSkewMs ?? 10 * 60 * 1000;
    return Math.abs(this.now() - issuedAt) <= skew;
  }

  private async take(body: unknown, source: "install" | "owner"): Promise<DebugResult> {
    let carrier: unknown = body;
    if (typeof carrier === "string") {
      try {
        carrier = JSON.parse(carrier);
      } catch {
        return { ok: false, status: 400, error: "That debug access grant can't be read." };
      }
    }
    const c = (carrier ?? {}) as { grant?: Record<string, unknown>; signatureHex?: unknown };
    if (c.grant && typeof c.grant === "object" && "sshAuthorizedKey" in c.grant) {
      return { ok: false, status: 422, error: "This debug access grant is from an older app. Update the app and turn debug access on again." };
    }
    const grant = parseDebugAccessGrant(c.grant);
    if (!grant) return { ok: false, status: 400, error: "That debug access grant can't be read." };
    const problem = debugAccessGrantProblem(grant);
    if (problem) return { ok: false, status: 422, error: problem };
    if (grant.serverDomain.toLowerCase() !== this.opts.serverDomain.toLowerCase()) {
      return { ok: false, status: 422, error: "That debug access grant is for another server." };
    }
    const sig = hexToBytes(String(c.signatureHex ?? ""));
    const by = sig && sig.length === 64 ? this.signer(grant, sig, true) : null;
    if (!by) return { ok: false, status: 403, error: REFUSED_SIGNER };
    if (grant.issuedAt <= this.state.floorIssuedAt) {
      return { ok: false, status: 409, error: "That debug access grant is older than the last change. Turn it on again." };
    }
    const now = this.now();
    if (source === "owner" && !this.fresh(grant.issuedAt)) {
      return { ok: false, status: 422, error: "This device's clock is too far from the server's. Check the time and try again." };
    }
    if (grant.issuedAt > now + (this.opts.maxSkewMs ?? 10 * 60 * 1000)) {
      return { ok: false, status: 422, error: "That debug access grant is dated in the future." };
    }
    if (grant.expiresAt <= now) return { ok: false, status: 422, error: "That debug access grant has already ended." };
    if (grant.expiresAt - now > DEBUG_ACCESS_MAX_MS + (this.opts.maxSkewMs ?? 10 * 60 * 1000)) {
      return { ok: false, status: 422, error: "Debug access can be on for at most 7 days at a time." };
    }

    const wasOn = this.view().on;
    const fp = sshKeyFingerprint(grant.sshPublicKey)!;
    // A different key: sessions opened with the old one end now.
    if (this.state.active && this.state.active.keyFingerprint !== fp) await this.opts.system.close();
    this.state.floorIssuedAt = grant.issuedAt;
    this.state.active = {
      grant,
      signatureHex: String(c.signatureHex).toLowerCase(),
      keyFingerprint: fp,
      grantedBy: by,
      source,
      openedAt: now,
    };
    delete this.state.lastEnded;
    await this.save();
    await this.opts.system.open({ sshPublicKey: grant.sshPublicKey, expiresAt: grant.expiresAt });
    this.arm();
    const change = wasOn ? "renewed" : "granted";
    this.opts.activity?.(
      `server.debug-access.${change}`,
      `Debug access ${wasOn ? "renewed" : "turned on"} for SSH key ${fp} until ${when(grant.expiresAt)}.`,
    );
    return { ok: true, view: this.view(), change };
  }

  private async takeRevoke(body: unknown): Promise<DebugResult> {
    const c = (body ?? {}) as { revoke?: unknown; signatureHex?: unknown };
    const revoke = parseDebugAccessRevoke(c.revoke);
    if (!revoke) return { ok: false, status: 400, error: "That request to turn off debug access can't be read." };
    if (revoke.serverDomain.toLowerCase() !== this.opts.serverDomain.toLowerCase()) {
      return { ok: false, status: 422, error: "That request is for another server." };
    }
    const sig = hexToBytes(String(c.signatureHex ?? ""));
    const by = sig && sig.length === 64 ? this.signer(revoke, sig, false) : null;
    if (!by) return { ok: false, status: 403, error: REFUSED_SIGNER };
    if (revoke.issuedAt <= this.state.floorIssuedAt) {
      return { ok: false, status: 409, error: "That request is older than the last change. Try again." };
    }
    if (!this.fresh(revoke.issuedAt)) {
      return { ok: false, status: 422, error: "This device's clock is too far from the server's. Check the time and try again." };
    }
    this.state.floorIssuedAt = revoke.issuedAt;
    if (this.state.active) {
      await this.end("revoked");
      return { ok: true, view: this.view(), change: "revoked" };
    }
    await this.save();
    return { ok: true, view: this.view(), change: "unchanged" };
  }

  private async end(why: "expired" | "revoked"): Promise<void> {
    const a = this.state.active;
    if (!a) return;
    if (a.ending !== why) {
      a.ending = why;
      await this.save();
    }
    await this.opts.system.close();
    const at = this.now();
    this.state.active = null;
    this.state.lastEnded = { at, why };
    await this.save();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.opts.activity?.(
      `server.debug-access.${why}`,
      why === "expired" ? `Debug access for SSH key ${a.keyFingerprint} ended.` : `Debug access for SSH key ${a.keyFingerprint} was turned off.`,
    );
    this.log(`[debug-access] closed (${why})`);
  }

  private arm(): void {
    const a = this.state.active;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!a) return;
    const wait = Math.max(0, Math.min(a.grant.expiresAt - this.now(), 2 ** 31 - 1));
    this.timer = setTimeout(() => void this.checkExpiry(), wait);
    this.timer.unref?.();
    if (!this.ticker) {
      this.ticker = setInterval(() => void this.checkExpiry(), this.opts.tickMs ?? 30_000);
      this.ticker.unref?.();
    }
  }
}

/** The install blob's `debugGrant` sibling (a JSON string, or an object); null when absent. */
export async function debugGrantFromInstallBlob(
  blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json",
): Promise<unknown> {
  const read = await readStateFile(blobPath);
  if (read.kind !== "ok") return null;
  try {
    const sibling = (JSON.parse(read.text) as { debugGrant?: unknown }).debugGrant;
    if (typeof sibling === "string" && sibling.length > 0) return JSON.parse(sibling);
    return sibling && typeof sibling === "object" ? sibling : null;
  } catch {
    return null;
  }
}

/**
 *   GET  /api/screens/debug-access          → DebugAccessView
 *   POST /api/screens/debug-access          {grant, signatureHex}  → {ok, change, debugAccess}
 *   POST /api/screens/debug-access/revoke   {revoke, signatureHex} → {ok, change, debugAccess}
 * A refusal is `{error}` with the sentence to show. Companion sessions can't post.
 */
export function buildDebugAccessHttp(deps: {
  controller: Pick<DebugAccessController, "view" | "grant" | "revoke">;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
}) {
  const J = { "content-type": "application/json" };
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== DEBUG_PATH && path !== DEBUG_REVOKE_PATH) return null;
    if (path === DEBUG_PATH && method === "GET") return json(200, deps.controller.view());
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    let body: unknown;
    try {
      body = req.body.length === 0 ? null : JSON.parse(req.body.toString("utf-8"));
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    const r = path === DEBUG_PATH ? await deps.controller.grant(body) : await deps.controller.revoke(body);
    if (!r.ok) return json(r.status, { error: r.error });
    return json(200, { ok: true, change: r.change, debugAccess: r.view });
  };
}
