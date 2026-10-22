// The webapp's language choice and catalog URL (lib/i18n.js). The catalogs themselves are checked by
// scripts/i18n-pwa.mjs check; this pins the runtime rules around them.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pickLanguage, catalogUrl, tr, trn } from "../public/webapp/lib/i18n.js";
import { GA_LOCALES, CATALOG_VERSIONS } from "../public/webapp/lib/i18nLocales.js";

const GA = ["es", "fr", "de", "pt-BR", "ja", "zh-Hans"];

describe("pickLanguage", () => {
  it("keeps a saved choice only while that language still ships", () => {
    expect(pickLanguage("de", ["fr-FR"], GA)).toBe("de");
    expect(pickLanguage("it", ["fr-FR"], GA)).toBe("fr");
  });

  it("matches the browser's tags by exact tag, then by language", () => {
    expect(pickLanguage(null, ["pt-BR"], GA)).toBe("pt-BR");
    expect(pickLanguage(null, ["pt-PT"], GA)).toBe("pt-BR");
    expect(pickLanguage(null, ["ja-JP"], GA)).toBe("ja");
    expect(pickLanguage(null, ["zh-CN"], GA)).toBe("zh-Hans");
    expect(pickLanguage(null, ["zh-Hans-SG"], GA)).toBe("zh-Hans");
  });

  it("stops at English when the browser prefers it, instead of taking a later language", () => {
    expect(pickLanguage(null, ["en-US", "fr"], GA)).toBe("en");
    expect(pickLanguage(null, ["it-IT", "en", "fr"], GA)).toBe("en");
  });

  it("does not show Simplified Chinese to a Traditional-Chinese browser", () => {
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"]) expect(pickLanguage(null, [tag], GA)).toBe("en");
    expect(pickLanguage(null, ["zh-TW", "ja"], GA)).toBe("ja");
  });

  it("falls back to English with nothing usable", () => {
    expect(pickLanguage(null, [], GA)).toBe("en");
    expect(pickLanguage(null, [undefined, ""], GA)).toBe("en");
    expect(pickLanguage(null, ["it"], [])).toBe("en");
  });
});

describe("catalogUrl", () => {
  it("names each built catalog by its content hash", () => {
    expect(GA_LOCALES).toEqual(GA);
    for (const code of GA_LOCALES) {
      const body = readFileSync(resolve(__dirname, "..", "public", "webapp", "i18n", `${code}.json`), "utf8");
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
      expect(CATALOG_VERSIONS[code]).toBe(hash);
      const url = catalogUrl(code, "https://webapp.example/lib/i18n.js");
      expect(url.href).toBe(`https://webapp.example/i18n/${code}.json?v=${hash}`);
    }
  });
});

describe("tr / trn without a catalog", () => {
  it("returns the English with its arguments filled in", () => {
    expect(tr("Invite for {0} created.", "Ana")).toBe("Invite for Ana created.");
    expect(tr("{1} before {0}", "b", "a")).toBe("a before b");
    expect(tr("Keeps {0} when missing {1}", "x")).toBe("Keeps x when missing {1}");
    expect(trn(1, "{0} app", "{0} apps")).toBe("1 app");
    expect(trn(3, "{0} app", "{0} apps")).toBe("3 apps");
  });
});
