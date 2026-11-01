/**
 * The archive extraction check (plan G6/R6), TypeScript twin of the Rust checker in
 * rust/crates/flagship-broker/src/tarcheck.rs. Both pass the shared vectors in
 * packages/protocol/test-vectors/archive-extraction/vectors.json, code for code.
 *
 * A tar is read once, in 512-byte blocks, holding at most one GNU long name or pax header
 * (bounded) in memory, and refused at the first entry that could reach outside the folder it is
 * unpacked into or exhaust the box: absolute or climbing names, links whose target leaves the
 * folder or walks through another link, hard links to anything but an earlier regular file,
 * devices, FIFOs, sparse files, duplicates, and too many entries or bytes. Names are compared as
 * bytes (latin1), as the kernel sees them.
 *
 * `checkTarFile` uses the Rust checker (`flagship-broker check-tar`) when the release carries it,
 * and this twin otherwise.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { PassThrough, type Readable } from "node:stream";

export type TarProfile = "volume" | "archive";

export type TarRefusal =
  | "bad-header"
  | "truncated"
  | "unsupported"
  | "too-many-entries"
  | "bad-name"
  | "absolute-path"
  | "path-escape"
  | "special-file"
  | "not-allowed"
  | "duplicate"
  | "through-link"
  | "symlink-escape"
  | "hardlink-escape"
  | "entry-too-large"
  | "total-too-large";

export interface TarLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxNameBytes: number;
  maxPaxBytes: number;
  /** The names held to check later entries against, in all: bounds the checker's memory. */
  maxNameTotalBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxEntries: 100_000,
  maxEntryBytes: 64 * 1024 ** 3,
  maxTotalBytes: 512 * 1024 ** 3,
  maxNameBytes: 4096,
  maxPaxBytes: 64 * 1024,
  maxNameTotalBytes: 32 * 1024 * 1024,
};

export type TarVerdict =
  | { ok: true; entries: number; bytes: number; checker: "rust" | "ts" }
  | { ok: false; code: TarRefusal; message: string; checker: "rust" | "ts" };

const MESSAGES: Record<TarRefusal, string> = {
  "bad-header": "a header in the archive is damaged",
  truncated: "the archive is cut short",
  unsupported: "the archive holds a kind of entry this server does not unpack",
  "too-many-entries": "the archive holds too many entries",
  "bad-name": "an entry in the archive has no usable name",
  "absolute-path": "an entry in the archive names an absolute path",
  "path-escape": "an entry in the archive climbs out of its folder",
  "special-file": "the archive holds a device, a pipe or a sparse file",
  "not-allowed": "the archive holds something other than plain files",
  duplicate: "the archive lists the same path twice",
  "through-link": "an entry in the archive goes through a link",
  "symlink-escape": "a link in the archive points outside its folder",
  "hardlink-escape": "a hard link in the archive points outside its folder",
  "entry-too-large": "an entry in the archive is larger than it may be",
  "total-too-large": "the archive expands to more than it may",
};

class Refused extends Error {
  constructor(readonly code: TarRefusal) {
    super(MESSAGES[code]);
  }
}

/** Pulls exact byte counts from a chunk stream, holding no more than the current request. */
class BlockReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private readonly it: AsyncIterator<Buffer | Uint8Array | string>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else {
        const c = typeof r.value === "string" ? Buffer.from(r.value) : Buffer.from(r.value);
        this.buf = this.buf.length === 0 ? c : Buffer.concat([this.buf, c]);
      }
    }
    return this.buf.length >= n;
  }

  /** Exactly n bytes, or null at a clean end of stream (no bytes at all), or throws truncated. */
  async exact(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) {
      if (this.buf.length === 0) return null;
      throw new Refused("truncated");
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill(1))) throw new Refused("truncated");
      const take = Math.min(left, this.buf.length);
      this.buf = this.buf.subarray(take);
      left -= take;
    }
  }
}

function cstr(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString("latin1");
}

function parseOctal(field: Buffer): number {
  // GNU base-256: the high bit of the first byte set, then a big-endian number.
  if (field[0]! & 0x80) {
    if (field[0] !== 0x80) throw new Refused("bad-header");
    let v = 0n;
    for (let i = 1; i < field.length; i++) v = (v << 8n) | BigInt(field[i]!);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refused("bad-header");
    return Number(v);
  }
  let s = field.toString("latin1").replace(/^ +/, "");
  const end = s.search(/[\0 ]/);
  if (end >= 0) {
    if (!/^[\0 ]*$/.test(s.slice(end))) throw new Refused("bad-header");
    s = s.slice(0, end);
  }
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new Refused("bad-header");
  const v = Number.parseInt(s, 8);
  if (!Number.isSafeInteger(v)) throw new Refused("bad-header");
  return v;
}

function checksumOk(h: Buffer): boolean {
  const stored = cstr(h, 148, 8).trim();
  if (!/^[0-7]{1,7}$/.test(stored)) return false;
  const want = Number.parseInt(stored, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return want === unsigned || want === signed;
}

/** Pax records: `<len> <key>=<value>\n`, each length exact. */
function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    if (data[i] === 0) break;
    const sp = data.indexOf(0x20, i);
    if (sp < 0 || sp - i > 20) throw new Refused("bad-header");
    const lenText = data.subarray(i, sp).toString("latin1");
    if (!/^[0-9]+$/.test(lenText)) throw new Refused("bad-header");
    const len = Number(lenText);
    if (len <= sp - i + 1 || i + len > data.length || data[i + len - 1] !== 0x0a) throw new Refused("bad-header");
    const rec = data.subarray(sp + 1, i + len - 1).toString("latin1");
    const eq = rec.indexOf("=");
    if (eq <= 0) throw new Refused("bad-header");
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/** Components of a name, `.` and empty dropped; refuses absolute, `..`, empty. */
function components(name: string, absolute: TarRefusal, escape: TarRefusal): string[] {
  if (name.startsWith("/")) throw new Refused(absolute);
  const out: string[] = [];
  for (const c of name.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === "..") throw new Refused(escape);
    out.push(c);
  }
  return out;
}

const BLOCK = 512;

/** Check a tar stream. Never throws for a bad archive: the verdict says why. */
export async function checkTarStream(src: AsyncIterable<Buffer | Uint8Array | string>, profile: TarProfile, limits: Partial<TarLimits> = {}): Promise<TarVerdict> {
  const L: TarLimits = { ...DEFAULT_TAR_LIMITS, ...limits };
  const r = new BlockReader(src[Symbol.asyncIterator]());
  let entries = 0;
  let total = 0;
  let nameBytes = 0;
  const seen = new Set<string>();
  const files = new Set<string>();
  const links = new Set<string>();
  /** Every path used as a folder: by an entry's name, or walked by a symlink's target. */
  const dirs = new Set<string>([""]);
  try {
    let longName: string | null = null;
    let longLink: string | null = null;
    let pax: Map<string, string> | null = null;
    for (;;) {
      const h = await r.exact(BLOCK);
      if (!h) throw new Refused("truncated");
      if (h.every((b) => b === 0)) return { ok: true, entries, bytes: total, checker: "ts" };
      if (!checksumOk(h)) throw new Refused("bad-header");
      const magic = h.subarray(257, 265).toString("latin1");
      const posix = magic.startsWith("ustar\0");
      if (!posix && magic !== "ustar  \0") throw new Refused("bad-header");
      const type = String.fromCharCode(h[156]!);
      let size = parseOctal(h.subarray(124, 136));

      if (type === "L" || type === "K") {
        if (size > L.maxNameBytes) throw new Refused("bad-header");
        const d = await r.exact(Math.ceil(size / BLOCK) * BLOCK);
        if (!d && size > 0) throw new Refused("truncated");
        const text = cstr(d ?? Buffer.alloc(0), 0, size);
        if (type === "L") longName = text;
        else longLink = text;
        continue;
      }
      if (type === "x" || type === "g") {
        if (size > L.maxPaxBytes) throw new Refused("bad-header");
        const d = (await r.exact(Math.ceil(size / BLOCK) * BLOCK)) ?? Buffer.alloc(0);
        if (d.length < size) throw new Refused("truncated");
        const recs = parsePax(d.subarray(0, size));
        if (type === "g") throw new Refused("unsupported");
        pax = recs;
        continue;
      }

      entries++;
      if (entries > L.maxEntries) throw new Refused("too-many-entries");

      let name = cstr(h, 0, 100);
      const prefix = posix ? cstr(h, 345, 155) : "";
      if (prefix) name = `${prefix}/${name}`;
      if (longName !== null) name = longName;
      if (pax?.has("path")) name = pax.get("path")!;
      let link = cstr(h, 157, 100);
      if (longLink !== null) link = longLink;
      if (pax?.has("linkpath")) link = pax.get("linkpath")!;
      if (pax?.has("size")) {
        const s = pax.get("size")!;
        if (!/^[0-9]{1,20}$/.test(s) || !Number.isSafeInteger(Number(s))) throw new Refused("bad-header");
        size = Number(s);
      }
      const sparse = pax ? [...pax.keys()].some((k) => k.startsWith("GNU.sparse.")) : false;
      longName = null;
      longLink = null;
      pax = null;

      if (name === "") throw new Refused("bad-name");
      const parts = components(name, "absolute-path", "path-escape");
      const path = parts.join("/");

      let kind: "file" | "dir" | "symlink" | "hardlink";
      if (sparse || type === "S" || type === "3" || type === "4" || type === "6") throw new Refused("special-file");
      if (type === "0" || type === "\0" || type === "7") kind = "file";
      else if (type === "5") kind = "dir";
      else if (type === "2") kind = "symlink";
      else if (type === "1") kind = "hardlink";
      else throw new Refused("unsupported");
      if (parts.length === 0 && kind !== "dir") throw new Refused("bad-name");
      if (profile === "archive" && (kind !== "file" || parts.length === 0)) throw new Refused("not-allowed");

      if (seen.has(path)) throw new Refused("duplicate");
      for (let i = 1; i < parts.length; i++) {
        if (links.has(parts.slice(0, i).join("/"))) throw new Refused("through-link");
      }
      if (kind === "symlink" && dirs.has(path)) throw new Refused("through-link");

      if (kind === "symlink") {
        if (link === "" || link.startsWith("/")) throw new Refused("symlink-escape");
        const at = parts.slice(0, -1);
        const steps = link.split("/").filter((c) => c !== "" && c !== ".");
        const walked: string[] = [];
        for (let i = 0; i < steps.length; i++) {
          const c = steps[i]!;
          if (c === "..") {
            if (at.length === 0) throw new Refused("symlink-escape");
            at.pop();
          } else at.push(c);
          // Every step but the last is walked as a folder: it must not be a link.
          if (i < steps.length - 1 && c !== "..") {
            const p = at.join("/");
            if (links.has(p)) throw new Refused("through-link");
            walked.push(p);
          }
        }
        for (const p of walked) dirs.add(p);
      } else if (kind === "hardlink") {
        const target = components(link, "hardlink-escape", "hardlink-escape");
        if (!files.has(target.join("/")) || target.length === 0) throw new Refused("hardlink-escape");
      }

      if (size > L.maxEntryBytes) throw new Refused("entry-too-large");
      total += size;
      if (total > L.maxTotalBytes) throw new Refused("total-too-large");
      nameBytes += Buffer.byteLength(path, "latin1");
      if (nameBytes > L.maxNameTotalBytes) throw new Refused("too-many-entries");

      seen.add(path);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      if (kind === "dir") dirs.add(path);
      if (kind === "file") files.add(path);
      if (kind === "symlink") links.add(path);

      await r.skip(Math.ceil(size / BLOCK) * BLOCK);
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, code: e.code, message: e.message, checker: "ts" };
    throw e;
  }
}

export async function checkTarBytes(bytes: Uint8Array, profile: TarProfile, limits: Partial<TarLimits> = {}): Promise<TarVerdict> {
  async function* one() {
    yield Buffer.from(bytes);
  }
  return checkTarStream(one(), profile, limits);
}

/** Where a release carries the Rust broker (its `check-tar` subcommand is the checker). */
export const RUST_TARCHECK_BIN = "/opt/flagship/installer/rust/flagship-broker";

let probed: { bin: string; ok: boolean } | null = null;

/** The Rust checker, when this release carries one that answers `check-tar` (asked once). */
export async function rustTarChecker(): Promise<string | null> {
  const bin = process.env.FLAGSHIP_TARCHECK_BIN ?? RUST_TARCHECK_BIN;
  if (!bin || !existsSync(bin)) return null;
  if (probed?.bin === bin) return probed.ok ? bin : null;
  const empty = new PassThrough();
  empty.end(Buffer.alloc(1024));
  const v = await runRust(bin, empty, "volume", {});
  probed = { bin, ok: v?.ok === true };
  return probed.ok ? bin : null;
}

/** Forget the probe (tests). */
export function resetTarCheckerProbe(): void {
  probed = null;
}

function limitArgs(limits: Partial<TarLimits>): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(limits)) args.push(`--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(v));
  return args;
}

/** Run `flagship-broker check-tar --profile <p>` over a stream; null when it gave no verdict. */
function runRust(bin: string, src: Readable, profile: TarProfile, limits: Partial<TarLimits>): Promise<TarVerdict | null> {
  return new Promise<TarVerdict | null>((resolve) => {
    const p = spawn(bin, ["check-tar", "--profile", profile, ...limitArgs(limits)], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      if (out.length < 4096) out += d.toString("utf8");
    });
    p.stdin.on("error", () => {
      // the checker stops reading at its verdict; the rest of the stream is not needed
    });
    src.on("error", () => p.kill("SIGKILL"));
    src.pipe(p.stdin);
    p.on("error", () => resolve(null));
    p.on("close", () => {
      src.unpipe(p.stdin);
      src.destroy();
      resolve(parseRustVerdict(out));
    });
  });
}

export function parseRustVerdict(out: string): TarVerdict | null {
  try {
    const v = JSON.parse(out.trim().split("\n").pop() ?? "") as { ok?: unknown; code?: unknown; entries?: unknown; bytes?: unknown };
    if (v.ok === true && typeof v.entries === "number" && typeof v.bytes === "number") return { ok: true, entries: v.entries, bytes: v.bytes, checker: "rust" };
    if (v.ok === false && typeof v.code === "string" && v.code in MESSAGES) return { ok: false, code: v.code as TarRefusal, message: MESSAGES[v.code as TarRefusal], checker: "rust" };
  } catch {
    /* no verdict */
  }
  return null;
}

/** Counts of the checks this process ran, for the owner's isolation view. */
export const tarCheckStats = { rust: 0, ts: 0, refused: 0, lastRefusal: null as null | { code: TarRefusal; checker: "rust" | "ts"; at: number } };

function noteVerdict(v: TarVerdict): TarVerdict {
  tarCheckStats[v.checker]++;
  if (!v.ok) {
    tarCheckStats.refused++;
    tarCheckStats.lastRefusal = { code: v.code, checker: v.checker, at: Date.now() };
  }
  return v;
}

const CRASHED: TarVerdict = { ok: false, code: "unsupported", message: "this server's archive check stopped without a verdict", checker: "rust" };

/** Check a tar file on disk: the Rust checker when present, else this twin. */
export async function checkTarFile(path: string, profile: TarProfile, limits: Partial<TarLimits> = {}): Promise<TarVerdict> {
  const bin = await rustTarChecker();
  if (bin) return noteVerdict((await runRust(bin, createReadStream(path), profile, limits)) ?? CRASHED);
  return noteVerdict(await checkTarStream(createReadStream(path), profile, limits));
}

/** A queue a producer pushes chunks into and the twin reads from; it drops chunks once closed. */
class ChunkQueue implements AsyncIterable<Buffer> {
  private items: Buffer[] = [];
  private ended = false;
  private closed = false;
  private wake: (() => void) | null = null;
  push(c: Buffer): void {
    if (this.closed || this.ended) return;
    this.items.push(c);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.items = [];
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      const c = this.items.shift();
      if (c) {
        yield c;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

/**
 * Check a tar as it streams past (the server archive's plaintext): `write` every chunk, then
 * `end()` for the verdict. The Rust checker reads it on its stdin when the release carries one,
 * else the twin reads it here; either stops holding chunks once it has a verdict.
 */
export async function tarCheckSink(profile: TarProfile, limits: Partial<TarLimits> = {}): Promise<{ write(chunk: Buffer): void; end(): Promise<TarVerdict> }> {
  const bin = await rustTarChecker();
  if (bin) {
    const feed = new PassThrough({ highWaterMark: 1024 * 1024 });
    let settled = false;
    const result = runRust(bin, feed, profile, limits).then((v) => {
      settled = true;
      return v ?? CRASHED;
    });
    return {
      write(chunk) {
        if (!settled && !feed.destroyed) feed.write(chunk);
      },
      async end() {
        if (!feed.destroyed) feed.end();
        return noteVerdict(await result);
      },
    };
  }
  const q = new ChunkQueue();
  const result = checkTarStream(q, profile, limits).then((v) => {
    q.close();
    return v;
  });
  return {
    write(chunk) {
      q.push(chunk);
    },
    async end() {
      q.end();
      return noteVerdict(await result);
    },
  };
}
