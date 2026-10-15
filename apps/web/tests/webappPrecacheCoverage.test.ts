// Every module the webapp loads at start-up (app.js and everything it imports
// statically, transitively) must be in the service worker's precache, or an
// installed webapp opened offline fails to start on the first one missing.
// Dynamic `import()`s load on demand and are runtime-cached, so they're not
// required here.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(__dirname, "..", "public", "webapp");
const SW = readFileSync(resolve(ROOT, "service-worker.js"), "utf8");

/** Static `import … from "x"` / `export … from "x"` / `import "x"` specifiers. */
function staticImports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]!);
  return out;
}

/** The webapp-root paths ("/lib/x.js") app.js reaches through static imports. */
function startupGraph(): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    const rel = "/" + relative(ROOT, file).split("\\").join("/");
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const spec of staticImports(readFileSync(file, "utf8"))) {
      const target = spec.startsWith("/") ? resolve(ROOT, "." + spec) : resolve(dirname(file), spec);
      if (!target.startsWith(ROOT) || !existsSync(target)) continue;
      walk(target);
    }
  };
  walk(resolve(ROOT, "app.js"));
  return [...seen].sort();
}

function shellList(): string[] {
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: () => {}, location: { origin: "https://webapp.example" } },
    caches: {},
    fetch: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SW, sandbox);
  return vm.runInContext("SHELL", sandbox) as string[];
}

describe("service worker precache covers the start-up module graph", () => {
  it("walks a real graph", () => {
    const graph = startupGraph();
    expect(graph).toContain("/app.js");
    expect(graph).toContain("/lib/router.js");
    expect(graph.length).toBeGreaterThan(50);
  });

  it("every statically imported module is precached", () => {
    const shell = new Set(shellList());
    const missing = startupGraph().filter((p) => !shell.has(p));
    expect(missing, "add these to OPTIONAL_SHELL in service-worker.js").toEqual([]);
  });

  it("every precached module exists (a stale entry is a skipped fetch at install)", () => {
    const stale = shellList()
      .filter((p) => p.endsWith(".js"))
      .filter((p) => !existsSync(resolve(ROOT, "." + posix.normalize(p))));
    expect(stale).toEqual([]);
  });
});
