import { describe, expect, it } from "vitest";
import { APP_ONELINER_MAX_LEN, parseManifest } from "@flagship/protocol";
import { shortenLabel, tidyAiManifest } from "../../src/llm/manifestTidy.js";
import { VibeCodeSession } from "../../src/llm/vibeCodeSession.js";

describe("tidyAiManifest", () => {
  it("shortens an over-long description on a word boundary", () => {
    const json = JSON.stringify({ name: "chores", description: "A family chore tracker with points, streaks and rewards" });
    const out = JSON.parse(tidyAiManifest(json)) as { name: string; description: string };
    expect(out.description).toBe("A family chore tracker with");
    expect(out.description.length).toBeLessThanOrEqual(APP_ONELINER_MAX_LEN);
    expect(out.name).toBe("chores");
  });

  it("leaves a valid description, other problems and non-JSON alone", () => {
    const ok = JSON.stringify({ description: "Household shopping list" });
    expect(tidyAiManifest(ok)).toBe(ok);
    const noDescription = JSON.stringify({ name: "x" });
    expect(tidyAiManifest(noDescription)).toBe(noDescription);
    expect(tidyAiManifest("{ not json")).toBe("{ not json");
  });

  it("cuts a single long word rather than leaving it empty", () => {
    expect(shortenLabel("Supercalifragilisticexpialidocious-tracker", 30)).toBe("Supercalifragilisticexpialidoc");
    expect(shortenLabel("Recipes, notes - and more", 16)).toBe("Recipes, notes");
  });

  it("hands the session's deploy a manifest the validator accepts", () => {
    const s = new VibeCodeSession({ username: "a", serverFqdn: "home.a.flagship.services" });
    const manifest = {
      schema_version: 1,
      name: "chores",
      version: "0.1.0",
      description: "Track household chores and weekly rewards for the kids",
    };
    s.feedAssistant(`=== flagship.app.json ===\n${JSON.stringify(manifest)}\n=== END ===\n`);
    s.endAssistant();
    const out = JSON.parse(s.manifestJson()!) as { description: string };
    expect(out.description.length).toBeLessThanOrEqual(APP_ONELINER_MAX_LEN);
    const errors = parseManifest(out);
    if (!errors.ok) expect(errors.errors.join("; ")).not.toMatch(/description/);
  });
});
