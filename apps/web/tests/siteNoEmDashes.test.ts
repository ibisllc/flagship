import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Owner, 2026-10-17: public copy uses commas, colons and full stops, not em
// dashes (they read as machine-written). Comments, scripts and styles are code
// and are not checked.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PAGES = [
  "index", "faq", "how-it-works", "security", "privacy", "terms", "open-source",
  "help", "abuse", "adapters", "404", "disambiguate", "coming-soon",
];

describe("public site copy has no em dashes", () => {
  for (const page of PAGES) {
    it(`${page}.html`, () => {
      const visible = readFileSync(join(PUBLIC, `${page}.html`), "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<style[\s\S]*?<\/style>/g, "");
      expect(visible.match(/.{0,30}(—|&mdash;|&#8212;).{0,30}/g) ?? []).toEqual([]);
    });
  }
});
