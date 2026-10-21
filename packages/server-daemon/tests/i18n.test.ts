import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, languageFor, t, tj } from "../src/i18n/index.js";
import { buildInvitePage } from "../src/invitePage.js";
import { denialResponse } from "../src/serviceAccessGate.js";
import { movingPage } from "../src/serverArchive/migratePause.js";
import { disambiguationResponse, defaultApexPage } from "../src/runtime.js";
import { invitePage } from "../src/inviteHandler.js";
import { renderDownloadPage } from "../src/serverArchive/downloadPage.js";

afterEach(() => {
  for (const k of Object.keys(CATALOGS)) delete CATALOGS[k];
});

describe("box page language", () => {
  it("ships no catalog until a language is ga, so every page is English", () => {
    expect(Object.keys(CATALOGS)).toEqual([]);
    expect(languageFor({ "accept-language": "es-ES,es;q=0.9" })).toBe("en");
    expect(t("es", "Sign in")).toBe("Sign in");
  });

  it("negotiates among the languages that have a catalog", () => {
    CATALOGS.es = {};
    CATALOGS["pt-BR"] = {};
    CATALOGS["zh-Hans"] = {};
    expect(languageFor({ "accept-language": "fr, es;q=0.8, en;q=0.5" })).toBe("es");
    expect(languageFor({ "accept-language": "pt-PT" })).toBe("pt-BR");
    expect(languageFor({ "accept-language": "zh-CN" })).toBe("zh-Hans");
    expect(languageFor({ "accept-language": "zh-TW" })).toBe("en");
    expect(languageFor({ "accept-language": "de, es;q=0" })).toBe("en");
    expect(languageFor({})).toBe("en");
  });

  it("fills placeholders and escapes script text", () => {
    CATALOGS.es = { "Hi {0}": "Hola {0}", "a</script>": "b</script>" };
    expect(t("es", "Hi {0}", "Ana")).toBe("Hola Ana");
    expect(t("es", "Hi {0} {1}", "Ana")).toBe("Hi Ana {1}");
    expect(tj("es", "a</script>")).toBe('"b\\u003c/script>"');
  });

  it("renders every page in the visitor's language, and in English when there is none", async () => {
    CATALOGS.es = {
      "You're invited": "Te han invitado",
      "Access restricted · Flagship": "Acceso restringido · Flagship",
      "This app is moving to a new server": "Esta app se está mudando",
      "No app here yet.": "Aquí todavía no hay ninguna app.",
      "This is a Flagship server.": "Este es un servidor de Flagship.",
      "Download a server backup": "Descargar una copia",
      "You've been invited.": "Te han invitado.",
    };
    const es = { "accept-language": "es" };
    const invite = await buildInvitePage({ serverId: "box.test" })({ method: "GET", path: "/invite", headers: { host: "box.test", ...es }, body: Buffer.alloc(0) } as never);
    expect(invite?.body).toContain('<html lang="es">');
    expect(invite?.body).toContain("<h1>Te han invitado</h1>");
    expect(invite?.headers?.vary).toBe("Accept-Language");
    const en = await buildInvitePage({ serverId: "box.test" })({ method: "GET", path: "/invite", headers: { host: "box.test" }, body: Buffer.alloc(0) } as never);
    expect(en?.body).toContain("<h1>You're invited</h1>");

    const decision = { pass: false, reason: "x", matched: null } as never;
    expect(denialResponse(decision, { accept: "text/html", ...es }).body).toContain("Acceso restringido");
    expect(denialResponse(decision, { accept: "text/html" }).body).toContain("Access restricted");
    expect(movingPage("es").body).toContain("Esta app se está mudando");
    expect(disambiguationResponse("x.box.test", "es").body).toContain("Aquí todavía no hay ninguna app.");
    expect(defaultApexPage("box.test", "es")).toContain("Este es un servidor de Flagship.");
    expect(invitePage("es").body).toContain("Te han invitado.");
    const dl = renderDownloadPage({ appLink: "https://x/y", code: "123456", fileName: "a.flagship", sizeText: "1 GB", statusUrl: "/s", fileUrl: "/f", expiresText: "later" }, "es");
    expect(dl).toContain("Descargar una copia");
  });
});
