// Which of the site's languages a visitor gets (docs/voici-front-door.md, "Language"). The shared rule first
// (test-vectors/language-negotiation.json: preferences in order, English anywhere stops the search, an exact tag
// wins, Traditional Chinese never gets Simplified, otherwise the same base language). Then voi.ci's own step: a
// visitor none of whose preferences we ship, and who never asked for English, gets French when a preference names a
// French-speaking country or a language commonly read alongside French (wo-SN, bm-ML, dyu-CI, ln-CD, ar-MA …).
// Pure data and functions: the browser site and the build (which hands the tables to the Worker) both read it.

/** Regions where French is an official or everyday written language. Belgium, Switzerland, Canada and Luxembourg
 *  are left out: there a non-French tag (nl-BE, gsw-CH, iu-CA) says the visitor reads another language. */
export const FRANCOPHONE_REGIONS = [
  "bf", "bi", "bj", "bl", "cd", "cf", "cg", "ci", "cm", "dj", "dz", "fr", "ga", "gf", "gn", "gp", "gq", "ht", "km",
  "ma", "mc", "mf", "mg", "ml", "mq", "mr", "nc", "ne", "pf", "pm", "re", "rw", "sc", "sn", "td", "tg", "tn", "vu",
  "wf", "yt",
];

/** Languages whose readers mostly read French too (ISO 639 codes as browsers send them). */
export const FRANCOPHONE_LANGUAGES = [
  "bci", "bm", "br", "co", "dyu", "ff", "ht", "kg", "ln", "lu", "mfe", "mg", "mos", "oc", "rn", "rw", "sg", "wo",
];

/** "fr-CA,fr;q=0.9,en;q=0.5" → ["fr-ca","fr","en"]: tags in preference order, q=0 dropped. */
export function parseAcceptLanguage(header) {
  return String(header ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(/q=([\d.]+)/.exec(params.join(";"))?.[1] ?? 1);
      return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

function matches(code, tag) {
  const c = code.toLowerCase();
  if (tag === c) return true;
  const [base] = c.split("-");
  const [tagBase, ...rest] = tag.split("-");
  if (tagBase !== base) return false;
  if (base === "zh") return rest.length === 0 || rest.includes("hans") || rest.includes("cn") || rest.includes("sg");
  return true;
}

/** Whether a tag points at a French reader: a francophone language, or any language from a francophone region. */
export function isFrancophoneTag(tag) {
  const parts = String(tag).toLowerCase().split("-");
  if (FRANCOPHONE_LANGUAGES.includes(parts[0])) return true;
  return parts.slice(1).some((p) => p.length === 2 && FRANCOPHONE_REGIONS.includes(p));
}

/**
 * The language to show: one of `codes` (the shipped ones, "en" among them). `tags`: the browser's preferences in
 * order (navigator.languages, or parseAcceptLanguage of the header).
 */
export function pickLanguage(tags, codes) {
  const list = (tags ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);
  for (const tag of list) {
    if (tag === "en" || tag.startsWith("en-")) return "en";
    const hit = codes.find((c) => c !== "en" && matches(c, tag));
    if (hit) return hit;
  }
  if (codes.includes("fr") && list.some(isFrancophoneTag)) return "fr";
  return "en";
}
