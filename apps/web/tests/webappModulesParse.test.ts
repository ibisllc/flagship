import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

// One module that fails to parse (a name imported twice, say) stops the whole module graph, so the page never
// leaves "Setting up…" (shell v226). Every shell file must parse as an ES module.
const ROOT = fileURLToPath(new URL("../public/webapp/", import.meta.url));

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return jsFiles(p);
    return d.name.endsWith(".js") || d.name.endsWith(".mjs") ? [p] : [];
  });
}

describe("webapp modules parse", () => {
  it("every .js file under public/webapp is a valid ES module", () => {
    const files = jsFiles(ROOT);
    expect(files.length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const f of files) {
      try {
        transformSync(readFileSync(f, "utf8"), { format: "esm", loader: "js", logLevel: "silent" });
      } catch (e) {
        const first = (e as { errors?: { text: string }[] }).errors?.[0]?.text ?? String(e);
        bad.push(`${relative(ROOT, f)}: ${first}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
