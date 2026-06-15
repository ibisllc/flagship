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

const MAX_PATH_LEN = 512;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per file
const MAX_FILES = 500;

export type WriteResult = { ok: true } | { ok: false; reason: string };

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

  constructor(initial?: Record<string, string>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
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
    if (typeof content !== "string") return { ok: false, reason: "content must be a string" };
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return { ok: false, reason: `file exceeds ${MAX_FILE_BYTES} bytes` };
    }
    if (!this.files.has(path) && this.files.size >= MAX_FILES) {
      return { ok: false, reason: `workspace exceeds ${MAX_FILES} files` };
    }
    this.files.set(path, content);
    return { ok: true };
  }

  delete(path: string): boolean {
    return this.files.delete(path);
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
