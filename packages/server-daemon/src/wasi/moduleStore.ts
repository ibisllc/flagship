/**
 * The box's store of WASI modules, by content digest (docs/wasi-apps.md).
 * A module is only bytes here: the owner's signed install order names the
 * digest, and the worker compiles those bytes itself and refuses anything
 * precompiled. Putting a module in the store grants nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WASI_MODULES_DIR } from "./unit.js";

export const MAX_MODULE_BYTES = 64 * 1024 * 1024;
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

export function moduleDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isModuleDigest(d: unknown): d is string {
  return typeof d === "string" && DIGEST_RE.test(d);
}

/** A WebAssembly core module (magic + version 1). Components and anything else are refused here, and again by the worker. */
export function looksLikeCoreModule(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d && bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0;
}

export class WasiModuleStore {
  constructor(private readonly dir: string = WASI_MODULES_DIR) {}

  path(digest: string): string {
    const m = DIGEST_RE.exec(digest);
    if (!m) throw new Error("not a module digest");
    return join(this.dir, `${m[1]}.wasm`);
  }

  /** Store a module; resolves to its digest. */
  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.length > MAX_MODULE_BYTES) throw new Error(`a module may be at most ${MAX_MODULE_BYTES / (1024 * 1024)} MiB`);
    if (!looksLikeCoreModule(bytes)) throw new Error("not a WebAssembly core module (a .wasm built for wasm32-wasip1)");
    const digest = moduleDigest(bytes);
    const final = this.path(digest);
    if (await this.has(digest)) return digest;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${final}.${randomBytes(6).toString("hex")}.partial`;
    await writeFile(tmp, bytes, { mode: 0o644 });
    await rename(tmp, final);
    return digest;
  }

  async has(digest: string): Promise<boolean> {
    try {
      return (await stat(this.path(digest))).isFile();
    } catch {
      return false;
    }
  }

  /** The bytes, checked against their digest. */
  async read(digest: string): Promise<Buffer> {
    const bytes = await readFile(this.path(digest));
    if (moduleDigest(bytes) !== digest) throw new Error("the stored module does not match its digest");
    return bytes;
  }

  /** Drop modules no installed app names. */
  async sweep(keep: ReadonlySet<string>): Promise<string[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const dropped: string[] = [];
    for (const n of names) {
      const m = /^([0-9a-f]{64})\.wasm$/.exec(n);
      if (!m || keep.has(`sha256:${m[1]}`)) continue;
      await rm(join(this.dir, n), { force: true });
      dropped.push(`sha256:${m[1]}`);
    }
    return dropped;
  }
}
