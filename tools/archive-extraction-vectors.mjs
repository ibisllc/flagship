#!/usr/bin/env node
// Shared vectors for the archive extraction check (plan G6/R6): tar streams, benign and crafted,
// with the verdict the Rust checker (rust/crates/flagship-broker/src/tarcheck.rs) and its TS twin
// (packages/server-daemon/src/serverArchive/tarCheck.ts) must both give. The tars are built byte
// by byte here, so a header no tar writer would make (an escaping link, a device, a lying size)
// can be expressed. Writes packages/protocol/test-vectors/archive-extraction/vectors.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/protocol/test-vectors/archive-extraction/vectors.json");

function octal(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** One 512-byte header. `magic`: "posix" (ustar\0 00), "gnu" (ustar  \0) or "none". */
function header(h) {
  const b = Buffer.alloc(512);
  const name = Buffer.from(h.name ?? "", "latin1");
  name.copy(b, 0, 0, Math.min(100, name.length));
  b.write(octal(h.mode ?? 0o644, 8), 100, "latin1");
  b.write(octal(0, 8), 108, "latin1");
  b.write(octal(0, 8), 116, "latin1");
  if (h.sizeField) h.sizeField.copy(b, 124);
  else b.write(octal(h.size ?? 0, 12), 124, "latin1");
  b.write(octal(1_700_000_000, 12), 136, "latin1");
  b.write(h.type ?? "0", 156, "latin1");
  if (h.link) Buffer.from(h.link, "latin1").copy(b, 157, 0, 100);
  const magic = h.magic ?? "gnu";
  if (magic === "posix") {
    b.write("ustar\0", 257, "latin1");
    b.write("00", 263, "latin1");
  } else if (magic === "gnu") {
    b.write("ustar  \0", 257, "latin1");
  } else if (magic === "bogus") {
    b.write("tarx!\0", 257, "latin1");
  }
  if (h.prefix) Buffer.from(h.prefix, "latin1").copy(b, 345, 0, 155);
  b.fill(0x20, 148, 156);
  let sum = 0;
  for (const x of b) sum += x;
  if (h.badSum) sum += 1;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return b;
}

function pad(data) {
  const r = data.length % 512;
  return r === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - r)]);
}

const file = (name, text = "", extra = {}) => ({ name, data: Buffer.from(text), type: "0", ...extra });
const dir = (name, extra = {}) => ({ name, type: "5", mode: 0o755, ...extra });
const sym = (name, link) => ({ name, link, type: "2", mode: 0o777 });
const hard = (name, link) => ({ name, link, type: "1" });
const special = (name, type) => ({ name, type });

function paxRecords(kv) {
  let out = "";
  for (const [k, v] of Object.entries(kv)) {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
    out += `${len}${body}`;
  }
  return Buffer.from(out, "latin1");
}

/** Entries to a tar. `end`: 2 zero blocks (default), 1, or 0 (cut short). */
function tar(entries, { end = 2 } = {}) {
  const parts = [];
  for (const e of entries) {
    if (e.raw) {
      parts.push(e.raw);
      continue;
    }
    if (e.longName !== undefined) {
      const d = Buffer.from(e.longName + "\0", "latin1");
      parts.push(header({ name: "././@LongLink", type: "L", size: d.length }), pad(d));
    }
    if (e.longLink !== undefined) {
      const d = Buffer.from(e.longLink + "\0", "latin1");
      parts.push(header({ name: "././@LongLink", type: "K", size: d.length }), pad(d));
    }
    if (e.pax) {
      const d = paxRecords(e.pax);
      parts.push(header({ name: "PaxHeaders/x", type: e.paxType ?? "x", size: d.length, magic: "posix" }), pad(d));
      if (e.paxType === "g") continue;
    }
    const data = e.data ?? Buffer.alloc(0);
    parts.push(header({ ...e, size: e.size ?? data.length }));
    if (e.dataBytes !== undefined) parts.push(Buffer.alloc(e.dataBytes, 0x61));
    else if (data.length) parts.push(pad(data));
  }
  for (let i = 0; i < end; i++) parts.push(Buffer.alloc(512));
  return Buffer.concat(parts);
}

const base256 = (n) => {
  const f = Buffer.alloc(12);
  f[0] = 0x80;
  let v = BigInt(n);
  for (let i = 11; i >= 1; i--) {
    f[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return f;
};

const long = "d".repeat(60) + "/" + "n".repeat(150);
const cases = [];
const add = (name, profile, entries, expect, opts = {}) => {
  const bytes = opts.bytes ?? tar(entries, opts);
  cases.push({ name, profile, ...(opts.limits ? { limits: opts.limits } : {}), expect, tarB64: bytes.toString("base64") });
};

// ── accepted ──
add("a GNU tar of a files folder: root, files, a folder, an inside link, a hard link", "volume", [
  dir("./"),
  file("./a.txt", "hello"),
  dir("./sub/"),
  file("./sub/b.bin", "\u0001\u0002"),
  sym("./sub/link", "../a.txt"),
  hard("./hard", "./a.txt"),
], { ok: true, entries: 6, bytes: 7 });
add("an empty archive", "volume", [], { ok: true, entries: 0, bytes: 0 });
add("one end block is enough", "volume", [file("x", "1")], { ok: true, entries: 1, bytes: 1 }, { end: 1 });
add("a GNU long name", "volume", [{ ...file("././@ignored", "z"), longName: long }], { ok: true, entries: 1, bytes: 1 });
add("a pax path and a ustar prefix", "volume", [
  { ...file("short", "p"), pax: { path: long, mtime: "1700000000.5" } },
  file("name.txt", "q", { prefix: "some/deep/folder", magic: "posix" }),
], { ok: true, entries: 2, bytes: 2 });
add("links that stay inside: to the root and back up to it", "volume", [
  sym("x", "."),
  dir("d/"),
  sym("d/up", ".."),
  sym("d/sib", "../d/./other"),
], { ok: true, entries: 4, bytes: 0 });
add("a contiguous file (type 7) and a NUL type are regular files", "volume", [
  file("c7", "abc", { type: "7" }),
  file("c0", "de", { type: "\0" }),
], { ok: true, entries: 2, bytes: 5 });
add("a large file whose size is base-256", "volume", [{ ...file("big"), sizeField: base256(1024), size: 1024, dataBytes: 1024 }], { ok: true, entries: 1, bytes: 1024 });
add("a server archive: manifest and an app's parts", "archive", [
  file("manifest.json", "{}"),
  file("apps/alice--notes/meta.json", "{}"),
  file("apps/alice--notes/files.tar", "x"),
], { ok: true, entries: 3, bytes: 5 });

// ── paths ──
add("an absolute path", "volume", [file("/etc/passwd", "root")], { ok: false, code: "absolute-path" });
add("a path that climbs out", "volume", [file("../evil", "x")], { ok: false, code: "path-escape" });
add("a path that climbs out from inside", "volume", [file("a/../../evil", "x")], { ok: false, code: "path-escape" });
add("a dot-dot even when it would stay inside", "volume", [file("a/../b", "x")], { ok: false, code: "path-escape" });
add("an empty name", "volume", [file("", "x")], { ok: false, code: "bad-name" });
add("the root as a file", "volume", [file("./", "x")], { ok: false, code: "bad-name" });
add("a pax path that climbs out", "volume", [{ ...file("ok", "x"), pax: { path: "../../root/.ssh/authorized_keys" } }], { ok: false, code: "path-escape" });
add("a GNU long name that is absolute", "volume", [{ ...file("ok", "x"), longName: "/var/flagship/keys/x" }], { ok: false, code: "absolute-path" });
add("the same path twice", "volume", [file("a", "1"), file("a", "2")], { ok: false, code: "duplicate" });

// ── links ──
add("a symlink to an absolute path", "volume", [sym("s", "/etc")], { ok: false, code: "symlink-escape" });
add("a symlink that climbs out", "volume", [sym("s", "../..")], { ok: false, code: "symlink-escape" });
add("a symlink in a folder that climbs out", "volume", [dir("d/"), sym("d/s", "../../x")], { ok: false, code: "symlink-escape" });
add("a symlink with no target", "volume", [sym("s", "")], { ok: false, code: "symlink-escape" });
add("a pax linkpath that climbs out", "volume", [{ ...sym("s", "fine"), pax: { linkpath: "../../../etc/shadow" } }], { ok: false, code: "symlink-escape" });
add("a GNU long link that is absolute", "volume", [{ ...sym("s", "fine"), longLink: "/proc/self/root" }], { ok: false, code: "symlink-escape" });
add("writing through a symlink", "volume", [sym("s", "d"), file("s/x", "1")], { ok: false, code: "through-link" });
add("a link whose target walks through another link", "volume", [sym("x", "."), sym("y", "x/..")], { ok: false, code: "through-link" });
add("a link made where an earlier target walked as a folder", "volume", [sym("y", "x/.."), sym("x", ".")], { ok: false, code: "through-link" });
add("a symlink over a folder already used", "volume", [file("a/b", "1"), sym("a", "c")], { ok: false, code: "through-link" });
add("a hard link to an absolute path", "volume", [hard("h", "/etc/shadow")], { ok: false, code: "hardlink-escape" });
add("a hard link that climbs out", "volume", [hard("h", "../x")], { ok: false, code: "hardlink-escape" });
add("a hard link to nothing in the archive", "volume", [hard("h", "missing")], { ok: false, code: "hardlink-escape" });
add("a hard link to a folder", "volume", [dir("d/"), hard("h", "d")], { ok: false, code: "hardlink-escape" });
add("a hard link to a symlink", "volume", [sym("s", "x"), hard("h", "s")], { ok: false, code: "hardlink-escape" });

// ── kinds ──
add("a character device", "volume", [special("dev/mem", "3")], { ok: false, code: "special-file" });
add("a block device", "volume", [special("sda", "4")], { ok: false, code: "special-file" });
add("a FIFO", "volume", [special("pipe", "6")], { ok: false, code: "special-file" });
add("a GNU sparse file", "volume", [{ ...file("sp", ""), type: "S" }], { ok: false, code: "special-file" });
add("a pax sparse file", "volume", [{ ...file("sp", "x"), pax: { "GNU.sparse.major": "1" } }], { ok: false, code: "special-file" });
add("a pax global header", "volume", [{ pax: { path: "x" }, paxType: "g" }, file("a", "1")], { ok: false, code: "unsupported" });
add("a GNU volume label", "volume", [{ name: "label", type: "V" }], { ok: false, code: "unsupported" });
add("a server archive with a folder", "archive", [dir("apps/")], { ok: false, code: "not-allowed" });
add("a server archive with a symlink", "archive", [sym("apps/alice--notes/files.tar", "/etc/shadow")], { ok: false, code: "not-allowed" });
add("a server archive with a hard link", "archive", [file("manifest.json", "{}"), hard("apps/alice--notes/meta.json", "manifest.json")], { ok: false, code: "not-allowed" });
add("a server archive with a path that climbs out", "archive", [file("../../etc/flagship-evil", "x")], { ok: false, code: "path-escape" });

// ── sizes ──
add("too many entries", "volume", [file("a", "1"), file("b", "1"), file("c", "1")], { ok: false, code: "too-many-entries" }, { limits: { maxEntries: 2 } });
add("names held for checking exceed their budget", "volume", [file("aaaaaaaaaa", "1"), file("bbbbbbbbbb", "1")], { ok: false, code: "too-many-entries" }, { limits: { maxNameTotalBytes: 15 } });
add("an entry larger than allowed", "volume", [file("a", "x".repeat(11))], { ok: false, code: "entry-too-large" }, { limits: { maxEntryBytes: 10 } });
add("more in all than allowed", "volume", [file("a", "x".repeat(8)), file("b", "x".repeat(8)), file("c", "x".repeat(8))], { ok: false, code: "total-too-large" }, { limits: { maxTotalBytes: 20 } });
add("a base-256 size claiming a terabyte", "volume", [{ ...file("big"), sizeField: base256(2 ** 40), size: 0 }], { ok: false, code: "entry-too-large" }, { limits: { maxEntryBytes: 1024 ** 3 } });
add("a GNU long name longer than allowed", "volume", [{ ...file("ok", "x"), longName: "n".repeat(5000) }], { ok: false, code: "bad-header" });
add("a pax header longer than allowed", "volume", [{ ...file("ok", "x"), pax: { comment: "c".repeat(70 * 1024) } }], { ok: false, code: "bad-header" });

// ── damage ──
add("a header with a wrong checksum", "volume", [file("a", "1", { badSum: true })], { ok: false, code: "bad-header" });
add("a header with no tar magic", "volume", [file("a", "1", { magic: "bogus" })], { ok: false, code: "bad-header" });
add("a size that is not octal", "volume", [{ ...file("a", "1"), sizeField: Buffer.from("0000000009z\0", "latin1") }], { ok: false, code: "bad-header" });
add("a pax record that lies about its length", "volume", [{ ...file("a", "1"), pax: {} }], { ok: false, code: "bad-header" }, {
  bytes: (() => {
    const d = Buffer.from("99 path=x\n", "latin1");
    return Buffer.concat([header({ name: "p", type: "x", size: d.length, magic: "posix" }), pad(d), header({ name: "a", size: 1 }), pad(Buffer.from("1")), Buffer.alloc(1024)]);
  })(),
});
add("data cut short", "volume", [{ ...file("a"), size: 1000, dataBytes: 512 }], { ok: false, code: "truncated" }, { end: 0 });
add("no end-of-archive block", "volume", [file("a", "1")], { ok: false, code: "truncated" }, { end: 0 });
add("a stream that stops inside a header", "volume", [], { ok: false, code: "truncated" }, { bytes: header({ name: "a", size: 0 }).subarray(0, 300) });

const out = {
  about:
    "Archive extraction check (plan G6/R6). Each case is a tar stream (base64), the profile it is read under and the verdict: {ok:true, entries, bytes} or {ok:false, code}. Profiles: 'volume' (an app's files folder: regular files, folders, symlinks and hard links that stay inside) and 'archive' (a server archive: regular files only). Default limits unless the case sets them. Rules, in order per entry: header (checksum, ustar/GNU magic, octal or base-256 size), GNU L/K and pax x (path, linkpath, size; GNU.sparse.* is a sparse file; g is unsupported), entry count, name (absolute, any '..', empty), kind (devices, FIFOs, sparse; the profile), duplicate and through-link, link targets (symlink resolved lexically from its folder, never through a link; hard link to an earlier regular file), declared sizes, then the data. Built by tools/archive-extraction-vectors.mjs.",
  defaults: { maxEntries: 100000, maxEntryBytes: 64 * 1024 ** 3, maxTotalBytes: 512 * 1024 ** 3, maxNameBytes: 4096, maxPaxBytes: 64 * 1024, maxNameTotalBytes: 32 * 1024 * 1024 },
  codes: [
    "bad-header",
    "truncated",
    "unsupported",
    "too-many-entries",
    "bad-name",
    "absolute-path",
    "path-escape",
    "special-file",
    "not-allowed",
    "duplicate",
    "through-link",
    "symlink-escape",
    "hardlink-escape",
    "entry-too-large",
    "total-too-large",
  ],
  cases,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`${cases.length} cases → ${OUT}`);
