// The pages a box serves itself speak the visitor's language (docs/i18n.md):
// the apex landing page and the /invite page are rendered from the
// Accept-Language header with the box's own catalog
// (packages/server-daemon/src/i18n), and say `Vary: Accept-Language` so a shared
// cache never hands one language's page to another visitor. Needs a box on a
// release that carries the catalogs (an endorsed release after
// feat/multilingual; gym boxes clone the `gym` branch). Not yet run live.
import { t } from "../../../packages/server-daemon/src/i18n/index.js";
import { assert, http, short, type Resp } from "../lib/harness.js";
import type { Group } from "./types.js";

const LANDING = "This is a Flagship server.";
const INVITE = "You're invited";

function langOf(html: string): string {
  return /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1] ?? "";
}

function varies(r: Resp): boolean {
  return (r.headers.get("vary") ?? "")
    .split(",")
    .some((v) => v.trim().toLowerCase() === "accept-language");
}

/** The page in `want`, with `text` (looked up in the box's own catalog) on it and the Vary header. */
function inLanguage(r: Resp, want: string, text: string): string {
  const expected = t(want, text);
  assert(r.status === 200, `status ${r.status}: ${short(r.text)}`);
  assert(langOf(r.text) === want, `html lang "${langOf(r.text)}", wanted "${want}"`);
  assert(r.text.includes(expected), `no "${expected}" on the page`);
  assert(varies(r), `vary "${r.headers.get("vary") ?? ""}"`);
  return `${want}: "${expected}"`;
}

export const languages: Group = {
  name: "languages",
  title: "the box's own pages follow Accept-Language (fr / en) and vary on it",
  needs: ["A1"],
  phase: 1,
  async run({ rec, box }) {
    const b = box("A1");
    const get = (path: string, lang: string) => http(`https://${b.fqdn}${path}`, { headers: { accept: "text/html", "accept-language": lang } });

    await rec.check("the catalog has French for the checked sentences", async () => {
      for (const s of [LANDING, INVITE]) assert(t("fr", s) !== s, `no French for "${s}" in the box catalog`);
      return `${t("fr", LANDING)} / ${t("fr", INVITE)}`;
    });
    await rec.check("the landing page is French for Accept-Language: fr", async () => inLanguage(await get("/", "fr-FR,fr;q=0.9,en;q=0.5"), "fr", LANDING));
    await rec.check("the landing page is English for Accept-Language: en", async () => inLanguage(await get("/", "en-US,en;q=0.9"), "en", LANDING));
    await rec.check("the landing page follows q-values (fr 0.9 over de 0.5)", async () => inLanguage(await get("/", "de;q=0.5, fr;q=0.9"), "fr", LANDING));
    await rec.check("the invite page is French for Accept-Language: fr", async () => inLanguage(await get("/invite", "fr"), "fr", INVITE));
    await rec.check("the invite page is English for Accept-Language: en", async () => inLanguage(await get("/invite", "en"), "en", INVITE));
    await rec.check("no Accept-Language gets English", async () => {
      const r = await http(`https://${b.fqdn}/`, { headers: { accept: "text/html" } });
      return inLanguage(r, "en", LANDING);
    });
  },
};
