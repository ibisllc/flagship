import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The in-app "Page and message rules" summary must name every kind of content the terms forbid on pages and in
// messages (Terms §8.2, apps/web/public/terms.html). Google Play's content rating answers rest on it (journal F10).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SUMMARIES: Array<[string, () => string]> = [
  ["webapp", () => /VOICI_RULES_TEXT = \(\) =>\s*tr\("([^"]+)"\)/.exec(read("apps/web/public/webapp/lib/voiciCopy.js"))?.[1] ?? ""],
  ["iOS", () => /struct VoiciRulesSheet[\s\S]*?Text\("([^"]+)"\)/.exec(read("apps/mobile/ios/Sources/FlagshipUI/Screens/Messages/PageEditorScreen.swift"))?.[1] ?? ""],
  ["Android", () => /<string name="voici_rules_body">([^<]+)<\/string>/.exec(read("apps/mobile/android/app/src/main/res/values/strings.xml"))?.[1] ?? ""],
];

describe("page and message rules summary", () => {
  it("the terms still forbid nudity, sexual content and graphic violence", () => {
    expect(read("apps/web/public/terms.html")).toContain("nudity or sexual content, or graphic real-world violence");
  });
  for (const [app, summary] of SUMMARIES) {
    it(`${app} names nudity or sexual content and graphic real-world violence`, () => {
      const text = summary();
      expect(text).toContain("nudity or sexual content");
      expect(text).toContain("graphic real-world violence");
    });
  }
});
