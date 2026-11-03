/**
 * The Linux Studio provisions a hosted server through this package's `appliance-provision`, so the CLI holds
 * the same rule as the Mac and Windows Studios for which prebuilt appliance can host a recipe
 * (vm-core-vectors.json "applianceMatch").
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { applianceMatchesRecipe, appliancePublishedAs } from "../src/applianceMatch.js";

const cases = JSON.parse(
  readFileSync(new URL("../../../apps/desktop-shared/golden/vm-core-vectors.json", import.meta.url), "utf8"),
).applianceMatch.cases as {
  name: string; installerGitRef: string; commit: string | null; recipeRef: string; matches: boolean; published: string;
}[];

describe("applianceMatch vectors", () => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(0));
  for (const c of cases) {
    it(c.name, () => {
      const manifest = { installerGitRef: c.installerGitRef, commit: c.commit };
      expect(applianceMatchesRecipe(manifest, c.recipeRef)).toBe(c.matches);
      expect(appliancePublishedAs(manifest, c.recipeRef)).toBe(c.published);
    });
  }
});
