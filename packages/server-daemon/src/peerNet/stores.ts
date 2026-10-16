import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PbBlobStore, PbStateFile } from "./types.js";

const NAME = /^[a-z0-9-]{1,120}$/;

function check(name: string): string {
  if (!NAME.test(name)) throw new Error(`bad blob name ${name}`);
  return name;
}

/** One file per blob under `dir` (0600). */
export class FsBlobStore implements PbBlobStore {
  constructor(private readonly dir: string) {}

  async put(name: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, check(name));
    await writeFile(`${p}.tmp`, bytes, { mode: 0o600 });
    await rename(`${p}.tmp`, p);
  }

  async get(name: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(join(this.dir, check(name))));
    } catch {
      return null;
    }
  }

  async range(name: string, offset: number, length: number): Promise<Uint8Array | null> {
    let fh;
    try {
      fh = await open(join(this.dir, check(name)), "r");
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return bytesRead === length ? new Uint8Array(buf) : null;
    } finally {
      await fh.close();
    }
  }

  async delete(name: string): Promise<void> {
    await rm(join(this.dir, check(name)), { force: true });
  }
}

export class MemoryBlobStore implements PbBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(name: string, bytes: Uint8Array) {
    this.blobs.set(check(name), bytes.slice());
  }
  async get(name: string) {
    const b = this.blobs.get(name);
    return b ? b.slice() : null;
  }
  async range(name: string, offset: number, length: number) {
    const b = this.blobs.get(name);
    if (!b || offset + length > b.length) return null;
    return b.slice(offset, offset + length);
  }
  async delete(name: string) {
    this.blobs.delete(name);
  }
  bytes(): number {
    let n = 0;
    for (const b of this.blobs.values()) n += b.length;
    return n;
  }
}

export class FsStateFile<T> implements PbStateFile<T> {
  constructor(private readonly path: string) {}
  async load(): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch {
      return null;
    }
  }
  async save(v: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(`${this.path}.tmp`, JSON.stringify(v), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
}

export class MemoryStateFile<T> implements PbStateFile<T> {
  v: T | null = null;
  async load() {
    return this.v === null ? null : (structuredClone(this.v) as T);
  }
  async save(v: T) {
    this.v = structuredClone(v);
  }
}
