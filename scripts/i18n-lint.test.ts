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
