// The per-string checks every key/value surface runs (scripts/lib/i18n-kv.mjs lintEntry), so a
// translation that breaks a placeholder, a link or a product name fails `npm run i18n`.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { lintEntry, tokensOf, markupOf } from "./lib/i18n-kv.mjs";

const lint = (en: string | Record<string, string>, tr: string | Record<string, string>) => lintEntry("k", { en }, tr, "fr") as string[];

describe("i18n lint", () => {
  it("accepts a faithful translation", () => {
    expect(lint("Delete {0}?", "Supprimer {0} ?")).toEqual([]);
    expect(lint("Read the <strong>docs</strong> on %1$s.", "Lisez la <strong>doc</strong> sur %1$s.")).toEqual([]);
    expect(lint({ one: "{0} app", other: "{0} apps" }, { one: "{0} app", other: "{0} apps" })).toEqual([]);
  });

  it("lets placeholders and tags move, but not disappear or multiply", () => {
    expect(tokensOf("%1$s of %2$s")).toEqual(tokensOf("%2$s sur %1$s"));
    expect(lint("{1} of {0}", "{0} sur {1}")).toEqual([]);
    expect(lint("{0} of {1}", "{0} sur")).toEqual([expect.stringContaining("placeholders differ")]);
    expect(lint("Open <1>Settings</1>.", "Ouvrez Réglages.")).toEqual([expect.stringContaining("markup differs")]);
    expect(lint('See <a href="/x">why</a>.', 'Voir <a href="/y">pourquoi</a>.')).toEqual([expect.stringContaining("markup differs")]);
    expect(markupOf("a <br> b <code>x</code>")).toEqual(["</code>", "<br>", "<code>"]);
  });

  it("flags an entity where the English is plain text", () => {
    expect(lint("Wipe & restart", "Effacer &amp; redémarrer")).toEqual([expect.stringContaining("HTML entity")]);
    expect(lint("Wipe &amp; restart", "Effacer et redémarrer")).toEqual([]);
  });

  it("keeps product names and catches empties and runaway length", () => {
    expect(lint("Open Flagship Studio", "Ouvrir le Studio")).toContainEqual(expect.stringContaining('drops "Flagship Studio"'));
    expect(lint("Save", "")).toEqual([expect.stringContaining("empty")]);
    expect(lint("Save", "Enregistrer toutes les modifications maintenant")).toEqual([expect.stringContaining("much longer")]);
  });
});

describe("translations of changed English (name-keyed surfaces)", () => {
  it("flags a key whose English changed after it was translated, until it is accepted", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    // @ts-expect-error plain .mjs
    const { ROOT, targets, staleSources, acceptEnglish } = await import("./lib/i18n-kv.mjs");
    const surface = `zz-test-${process.pid}`;
    const dir = join(ROOT, "i18n", surface);
    const write = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
    mkdirSync(dir, { recursive: true });
    try {
      write("en.json", { save_button: { en: "Save" } });
      for (const l of targets as Array<{ code: string }>) write(`${l.code}.json`, { save_button: "Enregistrer" });
      expect(staleSources(surface)).toEqual([expect.stringContaining("translated-from.json is missing")]);
      acceptEnglish(surface);
      expect(staleSources(surface)).toEqual([]);
      write("en.json", { save_button: { en: "Save changes" } });
      expect(staleSources(surface)).toEqual([expect.stringContaining("save_button: the English changed")]);
      acceptEnglish(surface, ["save_button"]);
      expect(staleSources(surface)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
