// voi.ci: the public page of a Flagship account (docs/voici-and-messages.md §4). Static and open source; the same
// shell for every page. It fetches the signed index and the account's keys, verifies the signature in this browser,
// then each piece against the hash the index names, and only then shows anything. Any failure shows one sentence
// and nothing from the index.

import * as lib from "./flagship-web/index.js";
import { routeOf, siteConfig } from "./config.js";
import { h } from "./dom.js";
import { LOCALES, initLocale, locale, setLocale, t } from "./i18n.js";
import { openMessages } from "./messages.js";
import { footer, renderPage, renderState } from "./page.js";
import { openReport } from "./report.js";

const doc = document;
const win = window;
const root = doc.getElementById("app");
const P = lib.protocol;

let rerender = () => {};
let storePromise = null;
const store = () => (storePromise ??= lib.openIndexedDbStore());

function languagePicker() {
  const sel = h(
    doc,
    "select",
    { class: "lang", "aria-label": t("Language") },
    LOCALES.map((l) => h(doc, "option", { value: l.code, ...(l.code === locale() ? { selected: true } : {}) }, l.native)),
  );
  for (const o of sel.options) o.selected = o.value === locale();
  sel.addEventListener("change", () => {
    setLocale(sel.value);
    doc.documentElement.setAttribute("lang", locale());
    rerender();
  });
  return sel;
}

function reloadAction() {
  return { label: t("Reload"), run: () => win.location.reload() };
}

function stateFooter(cfg) {
  return footer(doc, { apex: cfg?.apex ?? "flagshipserver.com", languagePicker: languagePicker() });
}

function showState(cfg, s) {
  doc.title = "voi.ci";
  renderState(doc, root, { ...s, footer: stateFooter(cfg) });
}

const FAILURES = {
  "not-found": (u) => ({ icon: "globe", title: t("There's no page here."), body: t("voi.ci/{0} hasn't published a page.", u) }),
  "rolled-back": () => ({ title: t("This page is out of date."), body: t("You've seen a newer version of it. Reload to get it."), action: reloadAction() }),
  unavailable: () => ({ title: t("Couldn't load this page."), body: t("Check your connection and try again."), action: reloadAction() }),
};

function failure(cfg, code, username) {
  rerender = () =>
    showState(
      cfg,
      FAILURES[code]?.(username) ?? { title: t("This page couldn't be checked."), body: t("What arrived doesn't match what its owner signed, so nothing of it is shown."), action: reloadAction() },
    );
  rerender();
}

async function blobUrlOf(bytes) {
  return bytes ? URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) : null;
}

async function showPage(cfg, username) {
  renderState(doc, root, { kind: "loading" });
  const r = await lib.loadVoiciPage({ username, filesBase: cfg.files, apiBase: cfg.apiBase });
  if (!r.ok) return failure(cfg, r.code, username);
  const { index, reader } = r;
  const profile = await reader.profile();
  if (!profile) return failure(cfg, "bad-piece", username);
  const avatarUrl = profile.avatar ? await blobUrlOf(await reader.image(profile.avatar)) : null;
  if (profile.avatar && !avatarUrl) return failure(cfg, "bad-piece", username);

  const images = new Map();
  const posts = [];
  let next = reader.chunkCount() - 1;
  const loadChunk = async () => {
    while (next >= 0) {
      const c = await reader.chunk(next);
      next -= 1;
      if (!c) return false;
      const shas = [...new Set(c.posts.flatMap((p) => p.links.map((l) => l.card?.image).filter(Boolean)))];
      const urls = await Promise.all(shas.map(async (s) => [s, await blobUrlOf(await reader.image(s))]));
      for (const [s, u] of urls) if (u) images.set(s, u);
      posts.push(...[...c.posts].reverse());
      if (c.posts.length) return true;
    }
    return true;
  };
  if (!(await loadChunk())) return failure(cfg, "bad-piece", username);

  const page = { username, index, profile, avatarUrl };
  doc.documentElement.setAttribute("data-theme", profile.theme);
  const ctx = () => ({ doc, win, cfg, lib, store: null, page });
  const withStore = async (fn) => fn({ ...ctx(), store: await store() });
  rerender = () => {
    doc.title = `${profile.displayName} · voi.ci`;
    renderPage(doc, root, {
      ...page,
      host: cfg.host,
      apex: cfg.apex,
      posts,
      hasOlder: next >= 0,
      cardImageUrl: (sha) => images.get(sha) ?? null,
      lib: P,
      onMessage: () => withStore(openMessages),
      onReport: () => withStore(openReport),
      onOlder: async () => {
        if (!(await loadChunk())) return failure(cfg, "bad-piece", username);
        rerender();
      },
      languagePicker: languagePicker(),
    });
  };
  rerender();
}

function showAbout(cfg) {
  const build = doc.querySelector('meta[name="voici-build"]')?.getAttribute("content") ?? "";
  const dir = /^[0-9a-f]{64}$/.test(build) ? build.slice(0, 16) : null;
  doc.title = t("About voi.ci");
  rerender = () =>
    renderState(doc, root, {
      icon: "lock",
      title: t("About voi.ci"),
      body: t("voi.ci shows the public pages of Flagship accounts. Your browser checks every page against its owner's signature before showing it. The site is open source, and every file of this build is listed with its SHA-256 in its manifest."),
      footer: h(
        doc,
        "div",
        { class: "about" },
        h(doc, "p", { class: "label" }, t("This build")),
        h(doc, "p", { class: "mono-value" }, build || "dev"),
        dir ? h(doc, "a", { class: "inline-link", href: `${win.location.origin.startsWith("https://") ? win.location.origin : "https://voi.ci"}/-/${dir}/MANIFEST.json` }, t("Manifest")) : null,
        stateFooter(cfg),
      ),
    });
  rerender();
}

function main() {
  initLocale();
  doc.documentElement.setAttribute("lang", locale());
  const cfg = siteConfig(win.location, doc);
  const route = routeOf(win.location.pathname, doc.querySelector('meta[name="voici-status"]')?.getAttribute("content") ?? null);
  if (!cfg) {
    rerender = () => showState(null, { title: t("This page couldn't be checked."), body: t("This copy of the site isn't running on voi.ci.") });
    return rerender();
  }
  if (route.view === "about") return showAbout(cfg);
  if (route.view === "missing") {
    rerender = () => showState(cfg, { icon: "globe", title: t("There's no page here."), body: t("Check the address and try again.") });
    return rerender();
  }
  if (route.view === "gone") {
    rerender = () => showState(cfg, { icon: "globe", title: t("This link was removed."), body: t("It doesn't lead anywhere any more. Ask whoever shared it for a new one.") });
    return rerender();
  }
  showPage(cfg, route.username).catch(() => failure(cfg, "bad-piece", route.username));
}

main();
