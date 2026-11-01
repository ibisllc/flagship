#!/usr/bin/env -S npx tsx
/**
 * Compare box artifacts (release plan G9: reproducible builds and owner builds).
 *
 *   files    <a.tar.gz> <b.tar.gz> [--report <out.json>]
 *            Every entry of both archives, by path: which are only in one, and which differ in
 *            content, mode, type, link target or mtime. Exit 0 when the two archives are identical
 *            byte for byte, 1 when they differ (the report says where), 2 on bad input.
 *   endorsed --artifact <local.tar.gz> --manifest <endorsed.manifest.json> --commit <40hex> --arch <arch>
 *            [--trust release/box-artifact-trust.json]
 *            Whether a locally built artifact is the endorsed one: its SHA-256 and size equal the
 *            signed manifest's AND that manifest verifies against the pinned release keys. Exit 0
 *            "matches" (the endorsement covers this build, unchanged); 1 "differs" (it needs the
 *            owner's local-build policy, docs/architecture-v2/owner-builds.md, and a box refuses it
 *            by default). It never signs or rewrites a manifest.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { NODE_SECURITY_FLOOR, verifyBoxArtifact, type BoxArch, type BoxArtifactManifest, type BoxArtifactSignature, type ReleaseTrust } from "../../packages/protocol/src/boxArtifact.js";
import { VERIFIER_VERSION } from "./build.js";

export interface TarItem {
  type: "file" | "dir" | "symlink" | "other";
  mode: number;
  mtime: number;
  size: number;
  sha256: string | null;
  link: string | null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function str(b: Uint8Array, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return Buffer.from(end >= 0 ? s.subarray(0, end) : s).toString("utf8");
}
const oct = (b: Uint8Array, start: number, len: number) => parseInt(str(b, start, len).trim() || "0", 8);

/** Read a (gzipped) ustar/GNU tar into a map of path to entry. Handles GNU long names and long links. */
export function readTar(gz: Uint8Array): Map<string, TarItem> {
  const tar = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : Buffer.from(gz);
  const out = new Map<string, TarItem>();
  let off = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const type = String.fromCharCode(h[156]!);
    const size = oct(h, 124, 12);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = str(data, 0, data.length); continue; }
    if (type === "K") { longLink = str(data, 0, data.length); continue; }
    const prefix = str(h, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const link = longLink ?? str(h, 157, 100);
    longName = longLink = null;
    if (name.endsWith("/")) name = name.slice(0, -1);
    const kind: TarItem["type"] = type === "0" || type === "\0" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : "other";
    out.set(name, {
      type: kind,
      mode: oct(h, 100, 8) & 0o7777,
      mtime: oct(h, 136, 12),
      size,
      sha256: kind === "file" ? sha256(data) : null,
      link: kind === "symlink" ? link : null,
    });
  }
  return out;
}

export interface FileDifference {
  path: string;
  fields: Array<keyof TarItem>;
  a: TarItem;
  b: TarItem;
}
export interface CompareReport {
  identical: boolean;
  a: { sha256: string; bytes: number; entries: number };
  b: { sha256: string; bytes: number; entries: number };
  onlyInA: string[];
  onlyInB: string[];
  differing: FileDifference[];
  /** True when every entry matches but the compressed bytes do not (a gzip difference only). */
  compressionOnly: boolean;
}

export function compareArtifacts(a: Uint8Array, b: Uint8Array): CompareReport {
  const ta = readTar(a);
  const tb = readTar(b);
  const onlyInA = [...ta.keys()].filter((k) => !tb.has(k)).sort();
  const onlyInB = [...tb.keys()].filter((k) => !ta.has(k)).sort();
  const differing: FileDifference[] = [];
  for (const [path, x] of [...ta.entries()].sort(([p], [q]) => (p < q ? -1 : 1))) {
    const y = tb.get(path);
    if (!y) continue;
    const fields = (["type", "mode", "mtime", "size", "sha256", "link"] as const).filter((f) => x[f] !== y[f]);
    if (fields.length) differing.push({ path, fields: [...fields], a: x, b: y });
  }
  const identical = sha256(a) === sha256(b);
  return {
    identical,
    a: { sha256: sha256(a), bytes: a.length, entries: ta.size },
    b: { sha256: sha256(b), bytes: b.length, entries: tb.size },
    onlyInA,
    onlyInB,
    differing,
    compressionOnly: !identical && onlyInA.length === 0 && onlyInB.length === 0 && differing.length === 0,
  };
}

/** Group differing paths the way a reader looks for causes: by top-level area of the release. */
export function summarizeDifferences(r: CompareReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of [...r.onlyInA, ...r.onlyInB, ...r.differing.map((d) => d.path)]) {
    const parts = p.split("/");
    const area = parts[1] === "app" ? parts.slice(0, parts[2] === "node_modules" || parts[2] === "packages" || parts[2] === "installer" ? 4 : 3).join("/") : parts.slice(0, 2).join("/");
    out[area] = (out[area] ?? 0) + 1;
  }
  return out;
}

export type EndorsedVerdict =
  | { verdict: "matches"; sha256: string; signers: number }
  | { verdict: "differs"; sha256: string; endorsedSha256: string; reason: string };

/** A local build may use the endorsement only when it is the endorsed bytes and the endorsement verifies. */
export function checkAgainstEndorsed(o: {
  artifact: Uint8Array;
  manifestDoc: { manifest: BoxArtifactManifest; signatures: BoxArtifactSignature[]; pqBindings?: unknown[] };
  commit: string;
  arch: BoxArch;
  trust: ReleaseTrust & { pq?: { keyIds?: string[]; legacyManifests?: string[] } };
}): EndorsedVerdict {
  const measured = sha256(o.artifact);
  const m = o.manifestDoc.manifest;
  if (measured !== m.artifactSha256 || o.artifact.length !== m.artifactBytes) {
    return { verdict: "differs", sha256: measured, endorsedSha256: m.artifactSha256, reason: "the local build is not the endorsed bytes" };
  }
  const pqPin = o.trust.pq ? { version: 1 as const, keyIds: o.trust.pq.keyIds ?? [], legacyManifests: o.trust.pq.legacyManifests ?? [] } : undefined;
  const r = verifyBoxArtifact(m, o.manifestDoc.signatures, {
    trust: o.trust,
    ...(pqPin ? { pqPin } : {}),
    pqBindings: (o.manifestDoc.pqBindings ?? []) as never,
    expectedArtifactSha256: m.artifactSha256,
    expectedCommit: o.commit,
    expectedArch: o.arch,
    measuredSha256: measured,
    measuredBytes: o.artifact.length,
    verifierVersion: VERIFIER_VERSION,
    nodeFloor: NODE_SECURITY_FLOOR,
  });
  if (!r.ok) return { verdict: "differs", sha256: measured, endorsedSha256: m.artifactSha256, reason: `the endorsement does not verify: ${r.code}` };
  return { verdict: "matches", sha256: measured, signers: r.signers.length };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && basename(process.argv[1]).startsWith("compare")) {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    if (cmd === "files") {
      const [a, b] = argv.filter((x, i) => !x.startsWith("--") && argv[i - 1] !== "--report");
      if (!a || !b) throw new Error("usage: compare.ts files <a.tar.gz> <b.tar.gz> [--report out.json]");
      const r = compareArtifacts(readFileSync(a), readFileSync(b));
      const report = arg(argv, "report");
      if (report) writeFileSync(report, JSON.stringify({ ...r, areas: summarizeDifferences(r) }, null, 2) + "\n");
      console.log(`a ${r.a.sha256} (${r.a.entries} entries)\nb ${r.b.sha256} (${r.b.entries} entries)`);
      if (r.identical) console.log("identical: the two builds are byte for byte the same");
      else {
        console.log(`DIFFER: ${r.differing.length} entries differ, ${r.onlyInA.length} only in a, ${r.onlyInB.length} only in b${r.compressionOnly ? " (compression only)" : ""}`);
        for (const [area, n] of Object.entries(summarizeDifferences(r)).sort(([, x], [, y]) => y - x).slice(0, 30)) console.log(`  ${n}\t${area}`);
        for (const d of r.differing.slice(0, 30)) console.log(`  ${d.path}: ${d.fields.join(", ")}`);
      }
      process.exit(r.identical ? 0 : 1);
    } else if (cmd === "endorsed") {
      const manifestPath = arg(argv, "manifest");
      const artifactPath = arg(argv, "artifact");
      const commit = arg(argv, "commit");
      const arch = arg(argv, "arch") as BoxArch | undefined;
      if (!manifestPath || !artifactPath || !commit || !arch) throw new Error("usage: compare.ts endorsed --artifact F --manifest F --commit C --arch A");
      const here = dirname(new URL(import.meta.url).pathname);
      const trust = JSON.parse(readFileSync(arg(argv, "trust") ?? join(resolve(here, "../.."), "release/box-artifact-trust.json"), "utf8"));
      const v = checkAgainstEndorsed({ artifact: readFileSync(artifactPath), manifestDoc: JSON.parse(readFileSync(manifestPath, "utf8")), commit, arch, trust });
      if (v.verdict === "matches") {
        console.log(`matches: ${v.sha256} is the endorsed artifact (${v.signers} release signature(s) verify); the endorsement covers this build`);
        process.exit(0);
      }
      console.log(`differs: local ${v.sha256}, endorsed ${v.endorsedSha256}: ${v.reason}. A box refuses it unless the owner's local-build policy names this digest.`);
      process.exit(1);
    } else {
      console.error("usage: compare.ts files|endorsed ...");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
