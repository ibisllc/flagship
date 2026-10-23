/**
 * A deterministic tar writer (ustar with GNU long names) for the box artifact.
 *
 * The same inputs must give the same bytes on any builder, so nothing here
 * reads the clock, the user or the filesystem order: entries are sorted
 * bytewise, owners are root, modes are normalized to 0644 / 0755 / 0777, and
 * every mtime is the one the caller gives (the source commit's time).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { gzipSync } from "node:zlib";

export type TarEntry =
  | { kind: "dir"; path: string }
  | { kind: "file"; path: string; data: Uint8Array; executable: boolean }
  | { kind: "symlink"; path: string; target: string };

const BLOCK = 512;
const te = new TextEncoder();

function octal(n: number, width: number): Uint8Array {
  const s = n.toString(8).padStart(width - 1, "0");
  if (s.length > width - 1) throw new Error(`tar: ${n} does not fit in ${width} bytes`);
  return te.encode(s + "\0");
}

function field(h: Uint8Array, offset: number, value: Uint8Array, max: number): void {
  if (value.length > max) throw new Error("tar: field overflow");
  h.set(value, offset);
}

function header(name: string, type: string, mode: number, size: number, mtime: number, link: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const nameBytes = te.encode(name);
  field(h, 0, nameBytes.subarray(0, 100), 100);
  field(h, 100, octal(mode, 8), 8);
  field(h, 108, octal(0, 8), 8); // uid
  field(h, 116, octal(0, 8), 8); // gid
  field(h, 124, octal(size, 12), 12);
  field(h, 136, octal(mtime, 12), 12);
  h.fill(0x20, 148, 156); // checksum placeholder: eight spaces
  h[156] = type.charCodeAt(0);
  field(h, 157, te.encode(link).subarray(0, 100), 100);
  field(h, 257, te.encode("ustar\0"), 6);
  field(h, 263, te.encode("00"), 2);
  field(h, 265, te.encode("root"), 32);
  field(h, 297, te.encode("root"), 32);
  field(h, 329, octal(0, 8), 8);
  field(h, 337, octal(0, 8), 8);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, te.encode(sum.toString(8).padStart(6, "0") + "\0 "), 8);
  return h;
}

function pad(len: number): Uint8Array {
  return new Uint8Array((BLOCK - (len % BLOCK)) % BLOCK);
}

function longEntry(type: "L" | "K", value: string, mtime: number): Uint8Array[] {
  const data = te.encode(value + "\0");
  return [header("././@LongLink", type, 0o644, data.length, mtime, ""), data, pad(data.length)];
}

/** Validate a path that goes into the archive: relative, no `..`, no NUL, no backslash. */
export function checkArchivePath(p: string): void {
  if (!p || p.startsWith("/") || p.includes("\0") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new Error(`tar: unsafe path ${JSON.stringify(p)}`);
  }
}

/** Build the (uncompressed) tar for these entries. */
export function buildTar(entries: readonly TarEntry[], mtime: number): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const e of sorted) {
    checkArchivePath(e.path);
    if (seen.has(e.path)) throw new Error(`tar: duplicate entry ${e.path}`);
    seen.add(e.path);
    const name = e.kind === "dir" ? e.path + "/" : e.path;
    if (te.encode(name).length > 100) out.push(...longEntry("L", name, mtime));
    if (e.kind === "dir") {
      out.push(header(name, "5", 0o755, 0, mtime, ""));
    } else if (e.kind === "symlink") {
      if (te.encode(e.target).length > 100) out.push(...longEntry("K", e.target, mtime));
      out.push(header(name, "2", 0o777, 0, mtime, e.target));
    } else {
      out.push(header(name, "0", e.executable ? 0o755 : 0o644, e.data.length, mtime, ""), e.data, pad(e.data.length));
    }
  }
  out.push(new Uint8Array(BLOCK * 2));
  return Buffer.concat(out);
}

/** gzip with a fixed header, so the compressed bytes do not depend on the platform's zlib OS code. */
export function gzipDeterministic(tar: Uint8Array): Buffer {
  const z = gzipSync(tar, { level: 9 });
  z[4] = z[5] = z[6] = z[7] = 0; // mtime
  z[8] = 2; // max compression flag, as zlib sets for level 9
  z[9] = 3; // OS = Unix, whatever the builder is
  return z;
}

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * Collect a directory tree as entries under `prefix`. Symlinks are kept as
 * symlinks and must stay inside the tree (an absolute target or one that climbs
 * out is refused: the artifact must not point at the builder's machine).
 */
export function collectTree(
  root: string,
  prefix: string,
  opts: { skip?: (rel: string) => boolean; /** where `root` sits inside the tree links must stay within */ base?: string } = {},
): TarEntry[] {
  const base = opts.base ?? "";
  const out: TarEntry[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (opts.skip?.(childRel)) continue;
      const st = lstatSync(childAbs);
      const path = `${prefix}/${childRel}`;
      if (st.isSymbolicLink()) {
        const target = readlinkSync(childAbs);
        const resolved = posix.normalize(posix.join(base, posix.dirname(childRel), target));
        if (target.startsWith("/") || resolved.startsWith("..")) throw new Error(`tar: symlink ${childRel} points outside the tree (${target})`);
        out.push({ kind: "symlink", path, target });
      } else if (st.isDirectory()) {
        out.push({ kind: "dir", path });
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        out.push({ kind: "file", path, data: readFileSync(childAbs), executable: (st.mode & 0o111) !== 0 });
      } else {
        throw new Error(`tar: ${childRel} is not a file, directory or symlink`);
      }
    }
  };
  out.push({ kind: "dir", path: prefix });
  walk(root, "");
  return out;
}
