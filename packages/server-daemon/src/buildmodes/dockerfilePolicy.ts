/**
 * What a build's Dockerfile may make dockerd fetch.
 *
 * RUN steps are fenced by the box's egress gateway (package registries only),
 * but dockerd itself pulls base images and `ADD <url>` sources from the HOST
 * network, outside that fence. So the box refuses a Dockerfile that would have
 * dockerd reach anything other than the public image registries:
 *  - `ADD <url>` / `ADD <git repo>` (fetch it in a RUN step instead);
 *  - `FROM`, `COPY --from`, `RUN --mount=from=` and the `# syntax=` frontend
 *    naming an image outside PUBLIC_REGISTRIES.
 * Earlier stage names and `scratch` are fine. A `$VAR` in an image reference
 * must resolve from an `ARG` default (the box never passes --build-arg).
 */

export const PUBLIC_REGISTRIES = [
  "docker.io",
  "ghcr.io",
  "quay.io",
  "mcr.microsoft.com",
  "public.ecr.aws",
  "gcr.io",
] as const;

const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

export type DockerfilePolicyResult = { ok: true } | { ok: false; problems: string[] };

interface Instruction {
  line: number;
  keyword: string;
  rest: string;
}

/** The registry host an image reference pulls from. */
export function imageRegistry(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash < 0) return "docker.io";
  const first = ref.slice(0, slash);
  if (first.includes(".") || first.includes(":") || first === "localhost") return first.toLowerCase();
  return "docker.io";
}

export function isPublicRegistryImage(ref: string): boolean {
  const reg = imageRegistry(ref);
  return DOCKER_HUB_ALIASES.has(reg) || (PUBLIC_REGISTRIES as readonly string[]).includes(reg);
}

const URL_SOURCE = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i;

export function checkDockerfile(text: string): DockerfilePolicyResult {
  const problems: string[] = [];
  const { instructions, escape, syntax } = parse(text);
  if (syntax !== null && !isPublicRegistryImage(syntax)) {
    problems.push(`line 1: the "# syntax=" frontend ${syntax} is not on a public registry (${PUBLIC_REGISTRIES.join(", ")})`);
  }
  const globalArgs = new Map<string, string>();
  let stageArgs = new Map<string, string>();
  const stages = new Set<string>();
  let seenFrom = false;
  let stageCount = 0;

  const resolve = (s: string, line: number, what: string): string | null => {
    let unresolved = false;
    const out = s.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-+]([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, a, dflt, b) => {
      const name = (a ?? b) as string;
      const v = stageArgs.get(name) ?? globalArgs.get(name);
      if (v !== undefined && v !== "") return v;
      if (typeof dflt === "string") return dflt;
      unresolved = true;
      return "";
    });
    if (unresolved) {
      problems.push(`line ${line}: ${what} uses a variable with no ARG default; name the image directly`);
      return null;
    }
    return out;
  };

  const checkImage = (raw: string, line: number, what: string): void => {
    const ref = resolve(raw, line, what);
    if (ref === null) return;
    const lower = ref.toLowerCase();
    if (lower === "scratch" || stages.has(lower) || /^[0-9]+$/.test(ref)) return;
    if (!isPublicRegistryImage(ref)) {
      problems.push(
        `line ${line}: ${what} ${ref} is not on a public registry (${PUBLIC_REGISTRIES.join(", ")}); the box pulls images only from those`,
      );
    }
  };

  for (const ins of instructions) {
    const words = splitWords(ins.rest, escape);
    switch (ins.keyword) {
      case "ARG": {
        for (const w of words) {
          const eq = w.indexOf("=");
          const name = eq < 0 ? w : w.slice(0, eq);
          if (!seenFrom) globalArgs.set(name, eq < 0 ? "" : unquote(w.slice(eq + 1)));
          else stageArgs.set(name, eq < 0 ? (globalArgs.get(name) ?? "") : unquote(w.slice(eq + 1)));
        }
        break;
      }
      case "FROM": {
        seenFrom = true;
        stageArgs = new Map();
        const args = words.filter((w) => !w.startsWith("--"));
        if (args.length === 0) {
          problems.push(`line ${ins.line}: FROM names no image`);
          break;
        }
        checkImage(args[0]!, ins.line, "FROM image");
        if (args.length >= 3 && args[1]!.toLowerCase() === "as") stages.add(args[2]!.toLowerCase());
        stages.add(String(stageCount++));
        break;
      }
      case "COPY": {
        for (const w of words) {
          const m = /^--from=(.+)$/i.exec(w);
          if (m) checkImage(unquote(m[1]!), ins.line, "COPY --from image");
        }
        break;
      }
      case "RUN": {
        for (const w of words) {
          if (!/^--mount=/i.test(w)) continue;
          for (const kv of w.slice("--mount=".length).split(",")) {
            const m = /^from=(.+)$/i.exec(kv);
            if (m) checkImage(unquote(m[1]!), ins.line, "RUN --mount from image");
          }
        }
        break;
      }
      case "ADD": {
        const srcs = sourcesOf(ins.rest, words);
        for (const src of srcs) {
          if (URL_SOURCE.test(src)) {
            problems.push(
              `line ${ins.line}: ADD ${src} fetches from the internet outside the build sandbox; download it in a RUN step (curl/wget from a package registry) or COPY it from the repo`,
            );
          }
        }
        break;
      }
      case "ONBUILD": {
        const inner = /^\s*(\S+)\s*(.*)$/s.exec(ins.rest);
        if (inner && inner[1]!.toUpperCase() === "ADD") {
          for (const src of sourcesOf(inner[2]!, splitWords(inner[2]!, escape))) {
            if (URL_SOURCE.test(src)) problems.push(`line ${ins.line}: ONBUILD ADD ${src} fetches from the internet`);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** ADD/COPY sources: every non-flag word but the last (the destination). */
function sourcesOf(rest: string, words: string[]): string[] {
  const t = rest.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return (arr as string[]).slice(0, -1);
    } catch {
      /* shell form below */
    }
  }
  const args = words.filter((w) => !w.startsWith("--"));
  return args.slice(0, -1).map(unquote);
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function splitWords(s: string, escape: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === escape && i + 1 < s.length) {
      cur += s[++i]!;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function parse(text: string): { instructions: Instruction[]; escape: string; syntax: string | null } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let escape = "\\";
  let syntax: string | null = null;
  let i = 0;
  // Parser directives: leading `# key=value` comments, before anything else.
  for (; i < lines.length; i++) {
    const m = /^\s*#\s*([a-zA-Z]+)\s*=\s*(\S+)\s*$/.exec(lines[i]!);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    if (key === "escape" && (m[2] === "`" || m[2] === "\\")) escape = m[2]!;
    else if (key === "syntax") syntax = m[2]!;
  }
  const instructions: Instruction[] = [];
  let buf = "";
  let start = 0;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (buf === "" && /^\s*(#|$)/.test(raw)) continue;
    if (buf !== "" && /^\s*(#|$)/.test(raw)) continue;
    if (buf === "") start = i + 1;
    const trimmed = raw.replace(/\s+$/, "");
    if (trimmed.endsWith(escape)) {
      buf += trimmed.slice(0, -1) + " ";
      continue;
    }
    buf += trimmed;
    push();
  }
  if (buf !== "") push();
  return { instructions, escape, syntax };

  function push(): void {
    const m = /^\s*([A-Za-z]+)\s*(.*)$/s.exec(buf);
    if (m) instructions.push({ line: start, keyword: m[1]!.toUpperCase(), rest: m[2]! });
    buf = "";
  }
}

/** Read the build context's Dockerfile (docker falls back to `dockerfile`). */
export async function checkBuildContextDockerfile(contextDir: string): Promise<DockerfilePolicyResult | null> {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["Dockerfile", "dockerfile"]) {
    try {
      return checkDockerfile(await readFile(`${contextDir}/${name}`, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}
