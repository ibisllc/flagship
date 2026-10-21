import { describe, expect, it } from "vitest";
import { pickWebLocale, type WebLocale } from "../src/localeRedirect.js";

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
