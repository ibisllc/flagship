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

describe("placeholders across surfaces (i18n-reuse)", () => {
  it("keeps each value attached to its own argument", async () => {
    // @ts-expect-error plain .mjs
    const { convertPlaceholders } = await import("./lib/i18n-kv.mjs");
    // the webapp's trn() passes the count as {0}, so its English numbers the date {1}
    expect(convertPlaceholders("Restore by %@ (%lld days left).", "Restaura antes del %@ (quedan %lld días).", "Restore by {1} ({0} days left)."))
      .toBe("Restaura antes del {1} (quedan {0} días).");
    expect(convertPlaceholders("Restore by %1$s (%2$s days left).", "%1$s までに復元してください（残り %2$s 日）。", "Restore by {1} ({0} days left)."))
      .toBe("{1} までに復元してください（残り {0} 日）。");
    expect(convertPlaceholders("%1$s of %2$s", "%2$s 中 %1$s", "{0} of {1}")).toBe("{1} 中 {0}");
    expect(convertPlaceholders("{0} of {1}", "{1} 中 {0}", "%1$s of %2$s")).toBe("%2$s 中 %1$s");
    // bare %@ in the target cannot be reordered
    expect(convertPlaceholders("{0} of {1}", "{1} 中 {0}", "%@ of %@")).toBeNull();
    expect(convertPlaceholders("{0} of {1}", "{0} sur {1}", "%@ of %@")).toBe("%@ sur %@");
  });
});

describe("plural count placement", () => {
  it("flags a translation whose plural wording follows the wrong argument", async () => {
    // @ts-expect-error plain .mjs
    const { pluralArgProblem } = await import("./lib/i18n-kv.mjs");
    const en = ["Restore by {1} ({0} day left).", "Restore by {1} ({0} days left)."];
    expect(pluralArgProblem(en[0], en[1], "Restaura antes del {0} (queda {1} día).", "Restaura antes del {0} (quedan {1} días).")).toContain("{0}");
    expect(pluralArgProblem(en[0], en[1], "Restaura antes del {1} (queda {0} día).", "Restaura antes del {1} (quedan {0} días).")).toBeNull();
    expect(pluralArgProblem("{0} line from {1}.", "{0} lines from {1}.", "{0} línea de {1}.", "{0} líneas de {1}.")).toBeNull();
    expect(pluralArgProblem("%1$s row re-anchored · %2$s unchanged", "%1$s rows re-anchored · %2$s unchanged", "%1$s fila reasociada · %2$s sin cambios", "%1$s filas reasociadas · %2$s sin cambios")).toBeNull();
    // one form for both (Japanese, Chinese): nothing to compare
    expect(pluralArgProblem(en[0], en[1], "{0} までに復元（残り {1} 日）", "{0} までに復元（残り {1} 日）")).toBeNull();
  });
});
