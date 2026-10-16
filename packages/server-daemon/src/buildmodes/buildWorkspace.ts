/**
 * Build workspace — the in-memory file tree a build is assembling,
 * shared by the modes that don't stream from the LLM parser:
 *   - git (deterministic import): seeded from the cloned tree
 *   - mcp: mutated by an external IDE/agent over the MCP pipe
 *
 * It is the same artifact shape the deploy path consumes
 * (`Record<path, content>` with a top-level `flagship.app.json`), so a
 * workspace hands straight to the existing install flow.
 *
 * Path safety is enforced on every write: relative POSIX paths only, no
 * `..`, no leading `/`, no NUL, bounded length — the same guard
 * `deploySession` applies before writing to disk, pulled forward so a
 * malicious MCP client can't escape the app dir or stage a path the
 * deploy step would later reject.
 */

import { isBuildFilePath } from "@flagship/protocol";

const MAX_PATH_LEN = 512;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per file
const MAX_FILES = 2000;

export type WriteResult = { ok: true } | { ok: false; reason: string };

/** The box writes a runtime app's build; an AI never writes these (docs/app-runtimes.md §6.3). */
export const isBuildFile = isBuildFilePath;

export const BUILD_FILE_REFUSED =
  "the box writes the build itself: set runtime.base in flagship.app.json (node-24, python-3.13 or static) instead of writing a Dockerfile";

/** A copy of `files` without the build files an AI may have produced. */
export function withoutBuildFiles<T>(files: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(files).filter(([p]) => !isBuildFile(p)));
}

export function isSafeBuildPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LEN) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\0")) return false;
  if (path.includes("\\")) return false; // POSIX-only; backslash is a Windows path smell
  const parts = path.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") return false;
  }
  return true;
}

export class BuildWorkspace {
  private files = new Map<string, string>();
  private changed: (() => void) | null = null;

  constructor(initial?: Record<string, string>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }

  /** Called after every write or delete (the orchestrator saves the build). */
  onChange(fn: (() => void) | null): void {
    this.changed = fn;
  }

  list(): string[] {
    return [...this.files.keys()].sort();
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, content: string): WriteResult {
    if (!isSafeBuildPath(path)) return { ok: false, reason: `unsafe path: ${path}` };
    if (isBuildFile(path)) return { ok: false, reason: BUILD_FILE_REFUSED };
    if (typeof content !== "string") return { ok: false, reason: "content must be a string" };
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return { ok: false, reason: `file exceeds ${MAX_FILE_BYTES} bytes` };
    }
    if (!this.files.has(path) && this.files.size >= MAX_FILES) {
      return { ok: false, reason: `workspace exceeds ${MAX_FILES} files` };
    }
    this.files.set(path, content);
    this.changed?.();
    return { ok: true };
  }

  delete(path: string): boolean {
    const gone = this.files.delete(path);
    if (gone) this.changed?.();
    return gone;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  manifestJson(): string | null {
    return this.files.get("flagship.app.json") ?? null;
  }

  count(): number {
    return this.files.size;
  }
}
