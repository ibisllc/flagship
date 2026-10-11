/**
 * Repo adapters: how to turn a repo written for an ordinary server into a
 * Flagship app, written down instead of done in place. An adapter is the
 * repo's `flagship.app.json` with an `adapter` section: the commit it was
 * made against, the files it adds, the edits it makes (as line hunks) and the
 * files it removes. Applying it to that commit, or to a later one where the
 * edits still fit, gives the tree the box builds. The author's repo stays an
 * ordinary repo; the adapter is the only Flagship-specific thing.
 *
 * Shared by the box (derive after an AI adapt, apply on import) and
 * flagshipserver.com (check before storing in the adapter index). Pure: no
 * I/O, no dependencies. docs/repo-adapters.md.
 */

import { parseManifest } from "./manifest.js";

export const REPO_ADAPTER_VERSION = 1;
export const MANIFEST_PATH = "flagship.app.json";

/** One unified-diff hunk. `lines` carry a " ", "-" or "+" prefix. */
export interface RepoAdapterHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface RepoAdapterSource {
  /** Normalized https URL (`normalizeRepoUrl`). */
  repo: string;
  /** The full commit the edits were written against. */
  base: string;
  ref?: string;
}

export interface RepoAdapter {
  version: typeof REPO_ADAPTER_VERSION;
  source: RepoAdapterSource;
  /** New files, as lines (joined with "\n"; a trailing "" keeps a final newline). */
  add?: Record<string, string[]>;
  patch?: Array<{ path: string; hunks: RepoAdapterHunk[] }>;
  remove?: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const CONTEXT = 3;

/**
 * One spelling per repo: `https://host/owner/name`, lowercase host, no
 * `.git`, no trailing slash. scp-style `git@host:owner/name` maps to https.
 * Null for anything else (local paths, other schemes, credentials in URL).
 */
export function normalizeRepoUrl(raw: string): string | null {
  const t = raw.trim();
  let host: string;
  let path: string;
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(t);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.port) return null;
    host = u.hostname;
    path = u.pathname;
  }
  const parts = path.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === "." || p === ".." || !/^[A-Za-z0-9._~-]+$/.test(p))) return null;
  return `https://${host.toLowerCase()}/${parts.join("/")}`;
}

export function splitLines(content: string): string[] {
  return content.split("\n");
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

// ---- diff -----------------------------------------------------------------

type Op = { t: " " | "-" | "+"; line: string };

/** Myers' O(ND) line diff, after trimming the common head and tail. */
function diffLines(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const mid = myers(A, B);
  return [
    ...a.slice(0, head).map((line) => ({ t: " " as const, line })),
    ...mid,
    ...a.slice(a.length - tail).map((line) => ({ t: " " as const, line })),
  ];
}

const MAX_EDIT_DISTANCE = 20_000;

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ t: "+", line }));
  if (m === 0) return a.map((line) => ({ t: "-", line }));
  const max = n + m;
  const off = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) {
    // Too different to be worth aligning: replace the whole span.
    return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: " ", line: a[x]! });
    }
    if (x === prevX) {
      y--;
      ops.push({ t: "+", line: b[y]! });
    } else {
      x--;
      ops.push({ t: "-", line: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: " ", line: a[x]! });
  }
  return ops.reverse();
}

/** The hunks that turn `before` into `after`; empty when they are equal. */
export function diffHunks(before: string, after: string): RepoAdapterHunk[] {
  const ops = diffLines(splitLines(before), splitLines(after));
  const hunks: RepoAdapterHunk[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const pos: Array<{ o: number; n: number }> = [];
  for (const op of ops) {
    pos.push({ o: oldLine, n: newLine });
    if (op.t !== "+") oldLine++;
    if (op.t !== "-") newLine++;
  }
  while (i < ops.length) {
    if (ops[i]!.t === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend over changes separated by at most 2*CONTEXT unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.t === " ") gap++;
      if (gap < ops.length && gap - end <= 2 * CONTEXT) {
        end = gap;
        continue;
      }
      end = Math.min(ops.length, end + CONTEXT);
      break;
    }
    const slice = ops.slice(start, end);
    const lines = slice.map((o) => o.t + o.line);
    hunks.push({
      oldStart: pos[start]!.o,
      newStart: pos[start]!.n,
      oldLines: slice.filter((o) => o.t !== "+").length,
      newLines: slice.filter((o) => o.t !== "-").length,
      lines,
    });
    i = end;
  }
  return hunks;
}

// ---- apply ----------------------------------------------------------------

function matchesAt(file: string[], at: number, want: string[]): boolean {
  if (at < 0 || at + want.length > file.length) return false;
  for (let j = 0; j < want.length; j++) if (file[at + j] !== want[j]) return false;
  return true;
}

/** Nearest position at or after `from` (searching both ways from `guess`). */
function locate(file: string[], want: string[], guess: number, from: number): number {
  if (want.length === 0) return Math.max(from, Math.min(guess, file.length));
  for (let delta = 0; delta <= file.length; delta++) {
    const up = guess + delta;
    if (up >= from && matchesAt(file, up, want)) return up;
    const down = guess - delta;
    if (delta > 0 && down >= from && matchesAt(file, down, want)) return down;
    if (up > file.length && down < from) break;
  }
  return -1;
}

/**
 * Apply hunks to a file, letting each one move if the lines around it moved
 * (like `patch`), and, failing that, trimming up to two context lines from
 * its ends. Null when a hunk's lines are nowhere to be found.
 */
export function applyHunks(content: string, hunks: RepoAdapterHunk[]): { content: string; fuzzy: boolean } | null {
  let file = splitLines(content);
  let shift = 0;
  let from = 0;
  let fuzzy = false;
  for (const h of hunks) {
    let placed = false;
    for (let fuzz = 0; fuzz <= 2 && !placed; fuzz++) {
      const lines = trimContext(h.lines, fuzz);
      if (!lines) continue;
      const oldPart = lines.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
      const newPart = lines.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
      const guess = h.oldStart - 1 + lines.dropped + shift;
      const at = locate(file, oldPart, Math.max(0, guess), from);
      if (at < 0) continue;
      if (at !== guess || fuzz > 0) fuzzy = true;
      file = [...file.slice(0, at), ...newPart, ...file.slice(at + oldPart.length)];
      shift += newPart.length - oldPart.length + (at - guess);
      from = at + newPart.length;
      placed = true;
    }
    if (!placed) return null;
  }
  return { content: joinLines(file), fuzzy };
}

function trimContext(lines: string[], fuzz: number): { lines: string[]; dropped: number } | null {
  if (fuzz === 0) return { lines, dropped: 0 };
  let lead = 0;
  while (lead < fuzz && lines[lead]?.[0] === " ") lead++;
  let trail = 0;
  while (trail < fuzz && lines[lines.length - 1 - trail]?.[0] === " ") trail++;
  if (lead === 0 && trail === 0) return null;
  return { lines: lines.slice(lead, lines.length - trail), dropped: lead };
}

// ---- adapters -------------------------------------------------------------

/**
 * The adapter that turns the repo's `original` tree into `adapted`. The
 * manifest is not part of it: it is the file the adapter lives in.
 */
export function deriveRepoAdapter(
  original: Record<string, string>,
  adapted: Record<string, string>,
  source: RepoAdapterSource,
): RepoAdapter {
  const add: Record<string, string[]> = {};
  const patch: Array<{ path: string; hunks: RepoAdapterHunk[] }> = [];
  const remove: string[] = [];
  for (const path of Object.keys(adapted).sort()) {
    if (path === MANIFEST_PATH) continue;
    const before = original[path];
    const after = adapted[path]!;
    if (before == null) add[path] = splitLines(after);
    else if (before !== after) patch.push({ path, hunks: diffHunks(before, after) });
  }
  for (const path of Object.keys(original).sort()) {
    if (path !== MANIFEST_PATH && adapted[path] == null) remove.push(path);
  }
  return {
    version: REPO_ADAPTER_VERSION,
    source: { repo: source.repo, base: source.base, ...(source.ref ? { ref: source.ref } : {}) },
    ...(Object.keys(add).length ? { add } : {}),
    ...(patch.length ? { patch } : {}),
    ...(remove.length ? { remove } : {}),
  };
}

/** Whether applying the adapter would change nothing but the manifest. */
export function isEmptyAdapter(a: RepoAdapter): boolean {
  return !a.add && !a.patch?.length && !a.remove?.length;
}

/** The single file: the manifest, with the adapter inside it. */
export function buildAdapterFile(manifestJson: string, adapter: RepoAdapter): string {
  const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  delete manifest.adapter;
  return JSON.stringify({ ...manifest, adapter }, null, 2) + "\n";
}

export type SplitAdapterFile =
  | { ok: true; manifestJson: string; adapter: RepoAdapter | null }
  | { ok: false; reason: string };

/** Read a `flagship.app.json` into the manifest the box installs and its adapter, if any. */
export function splitAdapterFile(text: string): SplitAdapterFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not valid JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not a JSON object" };
  const { adapter, ...manifest } = parsed as Record<string, unknown>;
  const manifestJson = JSON.stringify(manifest);
  if (adapter === undefined) return { ok: true, manifestJson, adapter: null };
  const shape = adapterShapeProblem(adapter);
  if (shape) return { ok: false, reason: `adapter: ${shape}` };
  return { ok: true, manifestJson, adapter: adapter as RepoAdapter };
}

function adapterShapeProblem(a: unknown): string | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "must be an object";
  const o = a as Record<string, unknown>;
  if (o.version !== REPO_ADAPTER_VERSION) return `unsupported version ${String(o.version)}`;
  const s = o.source as Record<string, unknown> | undefined;
  if (!s || typeof s.repo !== "string" || typeof s.base !== "string") return "source.repo and source.base are required";
  if (o.add !== undefined) {
    if (!o.add || typeof o.add !== "object" || Array.isArray(o.add)) return "add must map paths to lines";
    for (const v of Object.values(o.add)) {
      if (!Array.isArray(v) || v.some((l) => typeof l !== "string")) return "add must map paths to lines";
    }
  }
  if (o.patch !== undefined) {
    if (!Array.isArray(o.patch)) return "patch must be a list";
    for (const p of o.patch as unknown[]) {
      const e = p as { path?: unknown; hunks?: unknown };
      if (typeof e?.path !== "string" || !Array.isArray(e.hunks)) return "each patch needs a path and hunks";
      for (const h of e.hunks as unknown[]) {
        const hh = h as Record<string, unknown>;
        if (
          typeof hh?.oldStart !== "number" || typeof hh.oldLines !== "number" ||
          typeof hh.newStart !== "number" || typeof hh.newLines !== "number" ||
          !Array.isArray(hh.lines) || (hh.lines as unknown[]).some((l) => typeof l !== "string" || !/^[ +-]/.test(l))
        ) return "malformed hunk";
      }
    }
  }
  if (o.remove !== undefined && (!Array.isArray(o.remove) || o.remove.some((p) => typeof p !== "string"))) {
    return "remove must be a list of paths";
  }
  return null;
}

export type ApplyAdapterResult =
  | { ok: true; files: Record<string, string>; fuzzy: boolean }
  | { ok: false; failed: string[] };

/**
 * The tree to build: the repo's files with the adapter applied and the
 * manifest (without its adapter section) as `flagship.app.json`.
 */
export function applyRepoAdapter(
  files: Record<string, string>,
  adapter: RepoAdapter,
  manifestJson: string,
): ApplyAdapterResult {
  const out: Record<string, string> = { ...files };
  const failed: string[] = [];
  let fuzzy = false;
  for (const p of adapter.remove ?? []) delete out[p];
  for (const { path, hunks } of adapter.patch ?? []) {
    const cur = out[path];
    const r = cur == null ? null : applyHunks(cur, hunks);
    if (!r) {
      failed.push(path);
      continue;
    }
    out[path] = r.content;
    fuzzy ||= r.fuzzy;
  }
  for (const [path, lines] of Object.entries(adapter.add ?? {})) {
    if (out[path] != null && out[path] !== joinLines(lines)) fuzzy = true;
    out[path] = joinLines(lines);
  }
  if (failed.length) return { ok: false, failed };
  out[MANIFEST_PATH] = manifestJson;
  return { ok: true, files: out, fuzzy };
}

/** Every path the adapter edits, which must already exist at its base. */
export function patchedPaths(a: RepoAdapter): string[] {
  return (a.patch ?? []).map((p) => p.path);
}

const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an OpenAI-style API key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{30,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
];

function unsafePath(p: string): boolean {
  return (
    p.length === 0 || p.startsWith("/") || p.includes("\\") || p.includes("\0") ||
    p.split("/").some((s) => s === ".." || s === "." || s === "") || p === ".git" || p.startsWith(".git/")
  );
}

/**
 * What's wrong with an adapter, before anyone stores or applies it: unsafe
 * paths, a manifest that isn't valid, secrets in what it writes. Empty: fine.
 */
export function repoAdapterProblems(adapter: RepoAdapter, manifestJson: string): string[] {
  const problems: string[] = [];
  if (!SHA.test(adapter.source.base)) problems.push("source.base must be a full commit hash");
  if (normalizeRepoUrl(adapter.source.repo) !== adapter.source.repo) problems.push("source.repo must be a normalized https URL");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    manifest = null;
  }
  const parsed = parseManifest(manifest);
  if (!parsed.ok) problems.push(`manifest: ${parsed.errors[0] ?? "invalid"}`);
  const paths = [
    ...Object.keys(adapter.add ?? {}),
    ...patchedPaths(adapter),
    ...(adapter.remove ?? []),
  ];
  for (const p of paths) {
    if (unsafePath(p)) problems.push(`unsafe path: ${p}`);
    if (p === MANIFEST_PATH) problems.push(`${MANIFEST_PATH} can't be added, edited or removed by its own adapter`);
  }
  const written = [
    ...Object.values(adapter.add ?? {}).flat(),
    ...(adapter.patch ?? []).flatMap((p) => p.hunks.flatMap((h) => h.lines.filter((l) => l[0] === "+"))),
    manifestJson,
  ];
  for (const [what, re] of SECRET_SHAPES) {
    if (written.some((l) => re.test(l))) problems.push(`it writes what looks like ${what}`);
  }
  return [...new Set(problems)];
}
