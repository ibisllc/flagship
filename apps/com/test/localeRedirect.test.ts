import { describe, expect, it } from "vitest";
import { localisedAssetPath, pickWebLocale, type WebLocale } from "../src/localeRedirect.js";

const live: WebLocale[] = [
  { code: "es", webPath: "es" },
  { code: "pt-BR", webPath: "pt-br" },
  { code: "zh-Hans", webPath: "zh-hans" },
];

describe("pickWebLocale", () => {
  it("does nothing while no language is live", () => {
    expect(pickWebLocale("es", null, [])).toBeNull();
  });

  it("matches a regional tag to its language", () => {
    expect(pickWebLocale("es-MX,es;q=0.9,en;q=0.8", null, live)?.webPath).toBe("es");
    expect(pickWebLocale("pt-PT", null, live)?.webPath).toBe("pt-br");
  });

  it("keeps English when English is asked for first", () => {
    expect(pickWebLocale("en-GB,es;q=0.5", null, live)).toBeNull();
  });

  it("sends Simplified Chinese but not Traditional", () => {
    expect(pickWebLocale("zh-CN,zh;q=0.9", null, live)?.webPath).toBe("zh-hans");
    expect(pickWebLocale("zh-TW", null, live)).toBeNull();
  });

  it("lets the chosen-language cookie win, including English", () => {
    expect(pickWebLocale("es", "a=1; fs-lang=en", live)).toBeNull();
    expect(pickWebLocale("en", "fs-lang=es", live)?.webPath).toBe("es");
  });

  it("ignores a language that is not live", () => {
    expect(pickWebLocale("fr", null, live)).toBeNull();
    expect(pickWebLocale("en", "fs-lang=fr", live)).toBeNull();
  });
});

describe("language negotiation vectors (test-vectors/language-negotiation.json)", () => {
  it("chooses the same language as the webapp and the box pages", async () => {
    const { readFileSync } = await import("node:fs");
    const v = JSON.parse(readFileSync(new URL("../../../test-vectors/language-negotiation.json", import.meta.url), "utf8")) as { ga: string[]; cases: Array<{ accept: string; expect: string }> };
    const all: WebLocale[] = v.ga.map((code) => ({ code, webPath: code.toLowerCase() }));
    for (const c of v.cases) expect([c.accept, pickWebLocale(c.accept, null, all)?.code ?? "en"]).toEqual([c.accept, c.expect]);
  });
});

describe("localisedAssetPath (pages the Worker serves at a fixed URL)", () => {
  it("picks the built copy for the visitor's language, English otherwise", () => {
    expect(localisedAssetPath("/open/index.html", "es-MX,es;q=0.9", null, live)).toBe("/es/open/index.html");
    expect(localisedAssetPath("/open/index.html", "pt-PT", null, live)).toBe("/pt-br/open/index.html");
    expect(localisedAssetPath("/studio/index.html", "en-US,es;q=0.8", null, live)).toBe("/studio/index.html");
    expect(localisedAssetPath("/studio/index.html", "zh-TW", null, live)).toBe("/studio/index.html");
    expect(localisedAssetPath("/open/index.html", null, null, live)).toBe("/open/index.html");
  });

  it("follows the footer's language choice", () => {
    expect(localisedAssetPath("/open/index.html", "es", "fs-lang=en", live)).toBe("/open/index.html");
    expect(localisedAssetPath("/open/index.html", "en", "fs-lang=zh-Hans", live)).toBe("/zh-hans/open/index.html");
  });
});
