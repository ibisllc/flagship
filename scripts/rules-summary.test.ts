import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Owner rule (2026-11-14): the page and message rules are the legal minimum only, no use in furtherance of anything
// illegal plus lawful takedowns. Topic rules (sex, nudity, violence...) come back only if a store or a government
// requires them, so the summaries and Terms §8.2 must not name any.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SUMMARIES: Array<[string, () => string]> = [
  ["webapp", () => /VOICI_RULES_TEXT = \(\) =>\s*tr\("([^"]+)"\)/.exec(read("apps/web/public/webapp/lib/voiciCopy.js"))?.[1] ?? ""],
  ["iOS", () => /struct VoiciRulesSheet[\s\S]*?Text\("([^"]+)"\)/.exec(read("apps/mobile/ios/Sources/FlagshipUI/Screens/Messages/PageEditorScreen.swift"))?.[1] ?? ""],
  ["Android", () => /<string name="voici_rules_body">([^<]+)<\/string>/.exec(read("apps/mobile/android/app/src/main/res/values/strings.xml"))?.[1] ?? ""],
];

const TOPIC_RULES = /nudity|sexual content|graphic real-world violence|hateful/i;

describe("page and message rules summary", () => {
  it("Terms §8.2 forbids only illegal use and names no topic rules", () => {
    const terms = read("apps/web/public/terms.html");
    const s82 = terms.slice(terms.indexOf("<h3>8.2"), terms.indexOf("<h3>8.3"));
    expect(s82).toContain("in furtherance of anything illegal");
    expect(s82).toContain("takedown requests as the law requires");
    expect(s82).not.toMatch(TOPIC_RULES);
  });
  for (const [app, summary] of SUMMARIES) {
    it(`${app} summary says no illegal use and names no topic rules`, () => {
      const text = summary();
      expect(text).toContain("anything illegal");
      expect(text).not.toMatch(TOPIC_RULES);
    });
  }
});
