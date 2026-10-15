import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_SCENARIOS } from "../src/suites.js";

const GYM_SPECS = fileURLToPath(new URL("../../../apps/web/e2e/gym/", import.meta.url));

function specTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const f of readdirSync(GYM_SPECS).filter((n) => /^gym-.*\.spec\.ts$/.test(n))) {
    const src = readFileSync(join(GYM_SPECS, f), "utf8");
    for (const m of src.matchAll(/^\s+test\(\s*"([^"]+)"/gm)) titles.set(m[1]!, f);
  }
  return titles;
}

// A web scenario runs by grepping its harness title; a spec test nobody
// registers never runs in the gym. Both drift silently, so pin them together.
describe("web gym registry ↔ apps/web/e2e/gym specs", () => {
  const titles = specTitles();
  const harnesses = new Set(ALL_SCENARIOS.filter((s) => s.surface === "web").map((s) => s.harness));

  it("every web scenario names a test that exists", () => {
    const missing = [...harnesses].filter((h) => !titles.has(h));
    expect(missing).toEqual([]);
  });

  it("every gym spec test is registered as a scenario", () => {
    const unregistered = [...titles.keys()].filter((t) => !harnesses.has(t));
    expect(unregistered).toEqual([]);
  });

  it("every gym spec file is matched by the gym Playwright config", () => {
    const cfg = readFileSync(join(GYM_SPECS, "playwright.gym.config.ts"), "utf8");
    const m = cfg.match(/testMatch:\s*(\/.*\/)\s*,/);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]!.slice(1, -1));
    for (const file of new Set(titles.values())) expect(re.test(file)).toBe(true);
  });
});
