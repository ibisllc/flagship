import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, chownSync, closeSync, constants, existsSync, fchownSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { BOX_RELEASE } from "@flagship/protocol";
import { DAEMON_TRANSFER_ROOTS, transferPath, validateRequest, type Exec, type ReleaseTrust } from "./policy.js";
import { readActiveEngine, type EngineKind } from "./podman.js";
import { FrameReader, PRIVD_PROTOCOL_VERSION, PrivdError, encodeFrame, parseRequest, type PrivdRequest, type PrivdResponse } from "./wire.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (e: Exec) => Promise<RunResult>;

/** The trust the running release pins (release/box-artifact-trust.json through BOX_RELEASE). */
export const THIS_RELEASE_TRUST: ReleaseTrust = {
  keys: BOX_RELEASE.trust.keys,
  threshold: BOX_RELEASE.trust.threshold,
  nodeFloor: BOX_RELEASE.nodeFloor,
  minSequence: BOX_RELEASE.minSequence,
  pqKeyIds: BOX_RELEASE.trust.pq.keyIds,
  legacyManifests: BOX_RELEASE.trust.pq.legacyManifests,
};

export function hostArch(): string {
  return process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
}

const MAX_OUTPUT = 256 * 1024;

/** The daemon's account, whose files are the only ones the broker streams. */
export interface DaemonAccount {
  uid: number;
  gid: number;
}

export function groupId(name: string, groupFile = "/etc/group"): number | null {
  try {
    for (const line of readFileSync(groupFile, "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === name && f.length >= 3) return Number(f[2]);
    }
  } catch {
    /* no group file */
  }
  return null;
}

/** Look the daemon's account up in /etc/passwd (null when it does not exist yet: then nothing is streamed). */
export function daemonAccount(name = "flagship", passwd = "/etc/passwd"): DaemonAccount | null {
  try {
    for (const line of readFileSync(passwd, "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === name && f.length >= 4) return { uid: Number(f[2]), gid: Number(f[3]) };
    }
  } catch {
    /* no passwd: no account */
  }
  return null;
}

/**
 * Open the files a `docker.file` stream reads or writes, as the broker, never following a link: an
 * input must be a regular file the daemon's account owns; an output is a NEW file in a folder that
 * account owns, handed to it afterwards. Both must resolve under the daemon's transfer roots.
 */
export function openTransferFds(e: Exec, account: DaemonAccount | null): { stdin?: number; stdout?: number; close: () => void } {
  const fds: number[] = [];
  const close = () => {
    for (const fd of fds) try { closeSync(fd); } catch { /* */ }
  };
  try {
    const under = (real: string) => DAEMON_TRANSFER_ROOTS.some((r) => real.startsWith(r) || `${real}/`.startsWith(r));
    let stdin: number | undefined;
    let stdout: number | undefined;
    if (e.stdinFile || e.stdoutFile) {
      if (!account) throw new PrivdError("failed", "the daemon's account does not exist");
    }
    if (e.stdinFile) {
      const p = transferPath(e.stdinFile);
      if (!under(realpathSync(dirname(p)))) throw new PrivdError("forbidden", "that file is outside the daemon's transfer folders");
      stdin = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      fds.push(stdin);
      const st = fstatSync(stdin);
      if (!st.isFile() || st.uid !== account!.uid) throw new PrivdError("forbidden", "the broker reads only the daemon's own regular files");
    }
    if (e.stdoutFile) {
      const p = transferPath(e.stdoutFile);
      const dir = realpathSync(dirname(p));
      if (!under(dir) || statSync(dir).uid !== account!.uid) throw new PrivdError("forbidden", "the broker writes only into the daemon's own folders");
      stdout = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fds.push(stdout);
      // The folder may have been swapped for a link between the check above and the open: the file
      // is handed to the daemon only if it really landed in one of its folders (an empty root-owned
      // file left elsewhere is removed).
      if (existsSync("/proc/self/fd")) {
        const landed = realpathSync(`/proc/self/fd/${stdout}`);
        if (!under(dirname(landed)) || statSync(dirname(landed)).uid !== account!.uid) {
          try {
            unlinkSync(landed);
          } catch {
            /* already gone */
          }
          throw new PrivdError("forbidden", "the broker writes only into the daemon's own folders");
        }
      }
      fchownSync(stdout, account!.uid, account!.gid);
    }
    return { ...(stdin !== undefined ? { stdin } : {}), ...(stdout !== undefined ? { stdout } : {}), close };
  } catch (err) {
    close();
    if (err instanceof PrivdError) throw err;
    throw new PrivdError("forbidden", `that transfer file cannot be used: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/**
 * Copy the daemon's files the command will read into the broker's own folder first (`Exec.copyIn`):
 * each must be a regular file the daemon owns, opened without following a link, and the copy is
 * root's, where the daemon can neither swap nor edit it once checked.
 */
export function copyInFiles(e: Exec, account: DaemonAccount | null): void {
  if (!e.copyIn?.length) return;
  if (!account) throw new PrivdError("failed", "the daemon's account does not exist");
  for (const { from, to } of e.copyIn) {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    rmSync(to, { force: true });
    let src: number;
    try {
      src = openSync(transferPath(from), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      if (err instanceof PrivdError) throw err;
      throw new PrivdError("forbidden", `that file cannot be used: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    try {
      const st = fstatSync(src);
      if (!st.isFile() || st.uid !== account.uid) throw new PrivdError("forbidden", "the broker copies only the daemon's own regular files");
      const dst = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const buf = Buffer.alloc(1 << 20);
        for (let n; (n = readSync(src, buf, 0, buf.length, null)) > 0; ) writeSync(dst, buf, 0, n);
      } finally {
        closeSync(dst);
      }
    } finally {
      closeSync(src);
    }
  }
}

/** Run one validated command: fixed binary, argument vector, no shell, a clean environment, bounded time and output. */
export const realRunner: Runner = (e) =>
  new Promise((resolve) => {
    let opened: ReturnType<typeof openTransferFds>;
    const dropCopies = () => {
      for (const c of e.copyIn ?? []) rmSync(c.to, { force: true });
    };
    try {
      copyInFiles(e, daemonAccount());
      opened = openTransferFds(e, daemonAccount());
    } catch (err) {
      dropCopies();
      resolve({ code: null, stdout: "", stderr: (err as Error).message, timedOut: false });
      return;
    }
    const stdio: Array<"pipe" | "ignore" | number> = [
      opened.stdin ?? (e.input !== undefined ? "pipe" : "ignore"),
      opened.stdout ?? "pipe",
      "pipe",
    ];
    const child = spawn(e.file, e.args, { stdio, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", ...(e.env ?? {}) } });
    child.on("spawn", () => opened.close());
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, e.timeoutMs);
    child.stdout?.on("data", (d) => (stdout = (stdout + d).slice(-MAX_OUTPUT)));
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
    child.on("error", (err) => {
      clearTimeout(timer);
      opened.close();
      dropCopies();
      resolve({ code: null, stdout, stderr: String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      dropCopies();
      resolve({ code, stdout, stderr, timedOut });
    });
    if (e.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(e.input);
    }
  });

export interface PrivdServerOptions {
  socketPath: string;
  run?: Runner;
  auditPath?: string;
  now?: () => number;
  /** Requests per second per connection before refusal. */
  maxPerSecond?: number;
  /** The mount table loop checks read (tests). Default /proc/self/mounts. */
  mounts?: () => string;
  /** The box's architecture for a release install (tests). */
  arch?: string;
  /** The group whose members may open the socket (the daemon's). */
  socketGroup?: string;
  /** The box's container engine, read for each request (default: the box's engine-active record). */
  engine?: () => EngineKind;
  /** The release trust a release install is checked against (tests). Default: this release's own. */
  trust?: ReleaseTrust;
  helloTimeoutMs?: number;
}

/**
 * The root broker. It speaks only to the daemon's group over a Unix socket, answers a closed set of
 * operations, audits each one without bodies or secrets, and rate limits a runaway caller.
 */
export class PrivdServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly run: Runner;

  constructor(private readonly o: PrivdServerOptions) {
    this.run = o.run ?? realRunner;
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.o.socketPath), { recursive: true, mode: 0o750 });
    if (existsSync(this.o.socketPath)) unlinkSync(this.o.socketPath);
    const server = createServer((s) => this.onConnection(s));
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.socketPath, () => resolve());
    });
    chmodSync(this.o.socketPath, 0o660);
    if (this.o.socketGroup) {
      const gid = groupId(this.o.socketGroup);
      if (gid === null) throw new Error(`no group ${this.o.socketGroup}`);
      chownSync(this.o.socketPath, 0, gid);
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.o.socketPath)) unlinkSync(this.o.socketPath);
  }

  private audit(rec: Record<string, unknown>): void {
    if (!this.o.auditPath) return;
    try {
      appendFileSync(this.o.auditPath, JSON.stringify({ t: (this.o.now ?? Date.now)(), ...rec }) + "\n", { mode: 0o640 });
    } catch {
      /* an audit failure never blocks power-off or a revocation the box needs */
    }
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    const reader = new FrameReader();
    let hello = false;
    let window = { start: Date.now(), n: 0 };
    const timer = setTimeout(() => socket.destroy(), this.o.helloTimeoutMs ?? 5000);
    timer.unref?.();
    const send = (r: PrivdResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(r));
    };
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", async (chunk) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const raw of frames) {
        let req: PrivdRequest;
        try {
          req = parseRequest(raw);
        } catch (e) {
          const id = typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : 0;
          send({ id, ok: false, code: e instanceof PrivdError ? e.code : "bad-request", message: (e as Error).message });
          continue;
        }
        const now = Date.now();
        if (now - window.start > 1000) window = { start: now, n: 0 };
        if (++window.n > (this.o.maxPerSecond ?? 20)) {
          send({ id: req.id, ok: false, code: "forbidden", message: "slow down" });
          continue;
        }
        if (req.op === "hello") {
          if (req.args.version !== PRIVD_PROTOCOL_VERSION) {
            send({ id: req.id, ok: false, code: "unsupported-version", message: "this broker speaks version 1 only" });
            socket.destroy();
            return;
          }
          hello = true;
          clearTimeout(timer);
          send({ id: req.id, ok: true, result: { version: PRIVD_PROTOCOL_VERSION } });
          continue;
        }
        if (!hello) {
          send({ id: req.id, ok: false, code: "not-hello", message: "say hello first" });
          continue;
        }
        send(await this.handle(req));
      }
    });
  }

  private validate(req: PrivdRequest): Exec {
    return validateRequest(req.op, req.args, {
      engine: (this.o.engine ?? readActiveEngine)(),
      mounts: this.o.mounts ?? (() => readFileSync("/proc/self/mounts", "utf8")),
      trust: this.o.trust ?? THIS_RELEASE_TRUST,
      arch: this.o.arch ?? hostArch(),
    });
  }

  private async handle(req: PrivdRequest): Promise<PrivdResponse> {
    let exec: Exec;
    try {
      exec = this.validate(req);
    } catch (e) {
      const code = e instanceof PrivdError ? e.code : "bad-request";
      this.audit({ op: req.op, ok: false, code, what: summary(req) });
      return { id: req.id, ok: false, code, message: (e as Error).message };
    }
    const r = await this.run(exec);
    this.audit({ op: req.op, ok: r.code === 0, exit: r.code, timedOut: r.timedOut, what: summary(req) });
    if (r.timedOut) return { id: req.id, ok: false, code: "timed-out", message: "the command ran too long and was stopped" };
    if (r.code !== 0) return { id: req.id, ok: false, code: "failed", message: `exited with code ${r.code}: ${r.stderr.trim().split("\n").slice(-4).join(" | ").slice(0, 600)}` };
    return { id: req.id, ok: true, result: { stdout: r.stdout, stderr: r.stderr } };
  }
}

/**
 * A line for the audit log: what was asked, never the bodies or secrets that came with it. A request
 * whose argv is not a list says only that, since its other fields may carry stdin or a password.
 */
export function summary(req: PrivdRequest): string {
  const argv = Array.isArray(req.args.argv) ? (req.args.argv as unknown[]).map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? "")) : null;
  if (req.op === "docker" || req.op === "docker.file" || req.op === "systemctl") {
    return argv ? argv.slice(0, 3).map((a) => (a.startsWith("PGPASSWORD=") ? "PGPASSWORD=…" : a)).join(" ") : "malformed request";
  }
  if (req.op === "host") return argv && typeof req.args.file === "string" ? `${req.args.file} ${argv.slice(0, 2).join(" ")}` : "malformed request";
  if (req.op === "nft.apply" || req.op === "iptables.restore") return "firewall rules";
  return JSON.stringify(req.args).slice(0, 120);
}
