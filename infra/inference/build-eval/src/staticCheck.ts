/**
 * The build check without Docker: what of `docker build` and the start
 * check can be judged from the files alone, answered in the box's own words
 * so the AI fix loop sees what it would see on a box.
 *
 *   - the manifest parses and validates (the staging copy's own checks);
 *   - migrations have a Postgres store to run in;
 *   - the box writes the runtime's build (`prepareRuntimeContext`, the
 *     box's code): a node app needs a package.json, a python one a start
 *     command, a static one port 8080;
 *   - package.json parses; the start command finds its script and file;
 *   - every JS file passes `node --check`, TS files TypeScript's syntax
 *     check, Python files `py_compile`;
 *   - a JS import names a dependency package.json lists (or a file that
 *     exists), a Python import is the stdlib, the app's own, or in
 *     requirements.txt;
 *   - something reads PORT (or uses the manifest's port).
 *
 * What it can't see: packages that don't exist on the registry, a crash
 * after start, a route that answers 500. The Docker stage (`dockerStage.ts`)
 * does those for real.
 */

import { execFile } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { parseManifest, type AppManifest } from "@flagship/protocol";
import { writeSourceTree } from "../../../../packages/server-daemon/src/llm/serviceSource.js";
import { migrationFiles } from "../../../../packages/server-daemon/src/llm/serviceName.js";
import { prepareRuntimeContext } from "../../../../packages/server-daemon/src/runtimes/buildContext.js";

const run = promisify(execFile);

export type CheckResult =
  | { ok: true; manifest: AppManifest }
  /** `started`: the build would succeed and the container start, then fail (its logs exist). */
  | { ok: false; reason: string; started: boolean; output?: string };

export interface StaticCheckOptions {
  /** A python3 to run py_compile with; null skips Python syntax checks. */
  python?: string | null;
  /** Where to write the source tree (a temp dir by default). */
  tmpRoot?: string;
}

const STOPPED = "the app didn't start: it stopped (exit code 1). Its last output:\n";

function buildFailed(why: string): CheckResult {
  return { ok: false, reason: `docker build failed: ${why}`, started: false };
}

function crashed(raw: string): CheckResult {
  const output = raw.replace(/\n{3,}/g, "\n\n");
  return { ok: false, reason: `${STOPPED}${output.trim()}`, started: true, output: output.trim() };
}

/** Bare package name of an import specifier, or null for a relative/absolute one. */
export function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return spec.slice(5).split("/")[0]!;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]!]));

/** Module specifiers a JS/TS file imports or requires. */
export function importsOf(source: string): string[] {
  const out = new Set<string>();
  const res = [
    /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[\w*{}\s,$]+\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  // Comments can quote imports; drop them first.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const re of res) for (const m of code.matchAll(re)) out.add(m[1]!);
  return [...out];
}

const PY_ALIASES: Record<string, string[]> = {
  yaml: ["pyyaml"],
  PIL: ["pillow"],
  dotenv: ["python-dotenv"],
  jwt: ["pyjwt"],
  bs4: ["beautifulsoup4"],
  dateutil: ["python-dateutil"],
  multipart: ["python-multipart"],
  psycopg2: ["psycopg2", "psycopg2-binary"],
  psycopg: ["psycopg", "psycopg-binary", "psycopg-pool"],
  psycopg_pool: ["psycopg-pool", "psycopg"],
  sklearn: ["scikit-learn"],
  jose: ["python-jose"],
  magic: ["python-magic"],
  slugify: ["python-slugify"],
  markdown: ["markdown"],
  attr: ["attrs"],
  google: ["google-auth", "google-api-python-client", "protobuf"],
};

function normalisePkg(s: string): string {
  return s.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Package names a requirements.txt installs. */
export function requirementNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m) out.add(normalisePkg(m[1]!));
  }
  return out;
}

/** Top-level modules a Python file imports (absolute imports only). */
export function pythonImportsOf(source: string): string[] {
  const out = new Set<string>();
  for (const line of source.split("\n")) {
    const from = /^\s*from\s+([A-Za-z_][\w]*)[\w.]*\s+import\b/.exec(line);
    if (from) out.add(from[1]!);
    const imp = /^\s*import\s+(.+)$/.exec(line);
    if (imp) for (const part of imp[1]!.split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
      if (name) out.add(name);
    }
  }
  return [...out];
}

let stdlibCache: Promise<Set<string> | null> | null = null;
async function pythonStdlib(python: string): Promise<Set<string> | null> {
  stdlibCache ??= run(python, ["-c", "import sys; print('\\n'.join(sorted(sys.stdlib_module_names)))"], { timeout: 10_000 })
    .then(({ stdout }) => new Set(stdout.split("\n").map((s) => s.trim()).filter(Boolean)))
    .catch(() => null);
  return stdlibCache;
}

function scrub(text: string, dir: string): string {
  const bare = dir.replace(/^\/private(?=\/)/, "");
  return text.split(`/private${bare}`).join("/app").split(bare).join("/app");
}

/** Which tokens of a start command name a file to run. */
function entryOf(argv: readonly string[]): string | null {
  const [cmd, ...rest] = argv;
  if (!cmd) return null;
  if (!/^(node|python3?)$/.test(cmd)) return null;
  for (const a of rest) {
    if (a === "-m" || a === "-c" || a === "-e") return null;
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

/** `npm start`'s command from package.json, as argv (simple scripts only). */
function npmStartArgv(script: string): string[] {
  return script.trim().split(/\s+/);
}

export async function staticBuildCheck(files: Record<string, string>, opts: StaticCheckOptions = {}): Promise<CheckResult> {
  const manifestJson = files["flagship.app.json"];
  if (!manifestJson) return { ok: false, reason: "nothing to deploy: write flagship.app.json first", started: false };
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch (e) {
    return { ok: false, reason: `flagship.app.json is not valid JSON: ${(e as Error).message}`, started: false };
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok) return { ok: false, reason: `flagship.app.json is invalid: ${parsed.errors.join("; ")}`, started: false };
  const manifest = parsed.manifest;
  const stores = manifest.data.stores ?? {};
  const migrations = migrationFiles(files).sort((x, y) => x.filename.localeCompare(y.filename));
  const base = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), "build-eval-"));
  const dir = join(base, "app");
  try {
    const w = await writeSourceTree(dir, files);
    if (!w.ok) return { ok: false, reason: `unsafe path in artifact files: ${w.unsafePath}`, started: false };
    let runtime: string | null;
    try {
      runtime = await prepareRuntimeContext(dir);
    } catch (e) {
      return buildFailed((e as Error).message);
    }
    if (!runtime) return buildFailed("failed to read dockerfile: open Dockerfile: no such file or directory");

    if (migrations.length > 0 && !stores.postgres) {
      return { ok: false, reason: `migration ${migrations[0]!.filename} needs a Postgres store, and the manifest declares none`, started: false };
    }

    if (runtime === "static") {
      const root = (manifest.runtime.root ?? ".").replace(/^\.\/?/, "").replace(/\/$/, "");
      if (root && !Object.keys(files).some((p) => p.startsWith(`${root}/`))) {
        return buildFailed(`COPY failed: file not found in build context: stat ${root}: file does not exist`);
      }
      return { ok: true, manifest };
    }

    const sources = Object.entries(files).filter(([p]) => !p.split("/").includes("node_modules"));
    if (runtime === "node-24") {
      let pkg: { type?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(files["package.json"]!);
      } catch (e) {
        return buildFailed(`npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json: ${(e as Error).message}`);
      }
      if (files["package-lock.json"] !== undefined) {
        try {
          JSON.parse(files["package-lock.json"]);
        } catch (e) {
          return buildFailed(`npm error code EJSONPARSE\nnpm error JSON.parse Invalid package-lock.json: ${(e as Error).message}`);
        }
      }
      const argv = manifest.runtime.start ?? (pkg.scripts?.start ? npmStartArgv(pkg.scripts.start) : null);
      if (!argv) return crashed('npm error Missing script: "start"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run');
      const entry = entryOf(argv);
      if (entry && files[posix.normalize(entry)] === undefined) {
        return crashed(`Error: Cannot find module '/app/${posix.normalize(entry)}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader)\n  code: 'MODULE_NOT_FOUND'`);
      }
      const deps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]);
      const esmPackage = pkg.type === "module";
      for (const [path, content] of sources) {
        const ext = posix.extname(path);
        if ([".js", ".mjs", ".cjs"].includes(ext)) {
          const asModule = ext === ".js" && !esmPackage && /^\s*(import|export)\s/m.test(content);
          const target = asModule ? join(base, "check", `${path}.mjs`) : join(dir, path);
          if (asModule) {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content);
          }
          try {
            await run(process.execPath, ["--check", target], { timeout: 20_000 });
          } catch (e) {
            const err = e as { stderr?: string; message: string };
            const out = scrub((err.stderr || err.message).replace(join(base, "check"), dir).replace(`${path}.mjs`, path), dir);
            return crashed(out.replace(/\nNode\.js v[\d.]+\s*$/, "").replace(/^\s+at .*$\n?/gm, ""));
          }
        } else if ([".ts", ".mts", ".cts", ".tsx", ".jsx"].includes(ext)) {
          const r = ts.transpileModule(content, { fileName: path, reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } });
          const d = r.diagnostics?.find((x) => x.category === ts.DiagnosticCategory.Error);
          if (d) {
            const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
            return crashed(`/app/${path}${pos ? `:${pos.line + 1}` : ""}\nSyntaxError: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
          }
        } else continue;
        for (const spec of importsOf(content)) {
          const pkgName = packageOf(spec);
          if (pkgName === null) {
            if (spec.startsWith("/")) continue;
            const resolved = posix.normalize(posix.join(posix.dirname(path), spec));
            const candidates = [resolved, `${resolved}.js`, `${resolved}.mjs`, `${resolved}.cjs`, `${resolved}.ts`, `${resolved}.json`, `${resolved}/index.js`];
            const stripped = resolved.replace(/\.js$/, ".ts");
            if (!candidates.some((c) => files[c] !== undefined) && files[stripped] === undefined) {
              return crashed(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/${resolved}' imported from /app/${path}`);
            }
            continue;
          }
          if (spec.startsWith("node:") || BUILTINS.has(pkgName)) continue;
          if (!deps.has(pkgName)) {
            return crashed(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${pkgName}' imported from /app/${path}`);
          }
        }
      }
    }

    if (runtime === "python-3.13") {
      const argv = manifest.runtime.start ?? [];
      const entry = entryOf(argv);
      if (entry && files[posix.normalize(entry)] === undefined) {
        return crashed(`python: can't open file '/app/${posix.normalize(entry)}': [Errno 2] No such file or directory`);
      }
      const reqs = requirementNames(files["requirements.txt"] ?? "");
      const cmd = argv[0] ?? "";
      if (cmd && !/^python3?$/.test(cmd) && !reqs.has(normalisePkg(cmd))) {
        return crashed(`exec: "${cmd}": executable file not found in $PATH`);
      }
      const python = opts.python;
      const stdlib = python ? await pythonStdlib(python) : null;
      const local = new Set(
        Object.keys(files)
          .filter((p) => p.endsWith(".py") || p.includes("/"))
          .map((p) => p.split("/")[0]!.replace(/\.py$/, "")),
      );
      // Modules a src/ layout imports by their own names.
      for (const p of Object.keys(files)) if (p.endsWith(".py")) local.add(posix.basename(p, ".py"));
      for (const [path, content] of sources) {
        if (!path.endsWith(".py")) continue;
        if (python) {
          try {
            await run(python, ["-m", "py_compile", join(dir, path)], {
              timeout: 20_000,
              env: { ...process.env, PYTHONPYCACHEPREFIX: join(base, "pycache") },
            });
          } catch (e) {
            const err = e as { stderr?: string; message: string };
            return crashed(scrub(err.stderr || err.message, dir));
          }
        }
        if (!stdlib) continue;
        for (const mod of pythonImportsOf(content)) {
          if (stdlib.has(mod) || local.has(mod) || mod === "__future__") continue;
          const names = [mod, ...(PY_ALIASES[mod] ?? [])].map(normalisePkg);
          if (!names.some((n) => reqs.has(n))) {
            return crashed(`Traceback (most recent call last):\n  File "/app/${path}", line 1, in <module>\nModuleNotFoundError: No module named '${mod}'`);
          }
        }
      }
    }

    const code = sources
      .filter(([p]) => /\.(m|c)?(j|t)sx?$|\.py$/.test(p))
      .map(([, c]) => c)
      .join("\n");
    if (code && !/\bPORT\b/.test(code) && !code.includes(String(manifest.runtime.port))) {
      return {
        ok: false,
        reason:
          `the app is running but nothing answered on its port (${manifest.runtime.port}) within 60 s; it must listen on 0.0.0.0:$PORT.`,
        started: true,
      };
    }
    return { ok: true, manifest };
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/** A python3 on PATH, or null. */
export async function findPython(): Promise<string | null> {
  for (const p of ["python3", "python"]) {
    try {
      const { stdout, stderr } = await run(p, ["--version"], { timeout: 5_000 });
      if (/Python 3\./.test(stdout + stderr)) return p;
    } catch {
      /* next */
    }
  }
  return null;
}
