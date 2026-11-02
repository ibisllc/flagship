// The page renderer (docs/voici-and-messages.md §2.1): contact card, links, "Send me a message", posts, footer.
// Only ever given content that verify.js already checked against the signed index; it still treats every string as
// text and every URL as one more thing to check. The apps' editor preview reuses this module (§11.2): pass
// `pendingIds` for posts that are not published yet, and they render grayed with "Not published yet".

import { h, replace } from "./dom.js";
import { flagshipMark, icon, siteMark } from "./icons.js";
import { formatDate, t } from "./i18n.js";

/** Text with its https links made into anchors that open a new tab, nothing else interpreted. */
export function linkedText(doc, text, findLinks, onLink) {
  const out = [];
  let at = 0;
  for (const m of findLinks(text)) {
    if (m.start > at) out.push(text.slice(at, m.start));
    out.push(
      h(
        doc,
        "a",
        {
          class: "inline-link",
          href: m.url,
          target: "_blank",
          rel: "noopener noreferrer nofollow ugc",
          referrerpolicy: "no-referrer",
          ...(onLink ? { on: { click: (e) => onLink(e, m) } } : {}),
        },
        text.slice(m.start, m.end),
      ),
    );
    at = m.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function initialOf(name) {
  const c = [...(name ?? "").trim()][0];
  return c ? c.toLocaleUpperCase() : "?";
}

export function avatarEl(doc, profile, avatarUrl, size = "lg") {
  return avatarUrl
    ? h(doc, "img", { class: `avatar avatar-${size}`, src: avatarUrl, alt: "", width: size === "lg" ? 128 : 36, height: size === "lg" ? 128 : 36, decoding: "async" })
    : h(doc, "span", { class: `avatar avatar-${size} avatar-initial`, "aria-hidden": "true" }, initialOf(profile.displayName));
}

export function profileHeader(doc, m) {
  return h(
    doc,
    "header",
    { class: "card-head" },
    h(doc, "div", { class: "avatar-ring" }, avatarEl(doc, m.profile, m.avatarUrl)),
    h(doc, "h1", { class: "display-name" }, m.profile.displayName),
    h(doc, "p", { class: "handle" }, `${m.host}/${m.username}`),
    m.profile.bio ? h(doc, "p", { class: "bio" }, m.profile.bio) : null,
  );
}

export function linkList(doc, links, lib) {
  if (!links.length) return null;
  return h(
    doc,
    "nav",
    { class: "links", "aria-label": t("Links") },
    links.map((l) => {
      const host = lib.voiciUrlHost(l.url);
      const href = host ? l.url : null;
      if (!href) return null;
      const site = lib.VOICI_LINK_SITES.some((s) => s.id === l.site) || l.site === "email" ? l.site : null;
      return h(
        doc,
        "a",
        {
          class: "link-button",
          href,
          ...(l.url.startsWith("mailto:") ? {} : { target: "_blank", rel: "noopener noreferrer nofollow ugc", referrerpolicy: "no-referrer" }),
        },
        h(doc, "span", { class: "link-mark" }, siteMark(doc, site, lib.VOICI_LINK_SITES)),
        h(doc, "span", { class: "link-text" }, h(doc, "span", { class: "link-label" }, l.label), h(doc, "span", { class: "link-host" }, host)),
        icon(doc, "arrowUpRight", "icon link-arrow"),
      );
    }),
  );
}

export function messageButton(doc, onMessage) {
  return h(
    doc,
    "div",
    { class: "message-cta" },
    h(doc, "button", { class: "btn btn-primary btn-wide", type: "button", on: { click: onMessage } }, icon(doc, "message"), h(doc, "span", {}, t("Send me a message"))),
    h(doc, "p", { class: "cta-note" }, t("Private messages, with your Flagship app.")),
  );
}

function card(doc, link, cardImageUrl, lib) {
  const host = lib.voiciUrlHost(link.url);
  if (!host) return null;
  const c = link.card;
  const a = { class: c ? "link-card" : "link-card link-card-bare", href: link.url, target: "_blank", rel: "noopener noreferrer nofollow ugc", referrerpolicy: "no-referrer" };
  if (!c) return h(doc, "a", a, icon(doc, "link", "icon card-bare-icon"), h(doc, "span", { class: "card-host" }, host), icon(doc, "arrowUpRight", "icon link-arrow"));
  const img = c.image ? cardImageUrl(c.image) : null;
  return h(
    doc,
    "a",
    a,
    img ? h(doc, "img", { class: "card-image", src: img, alt: "", width: 400, height: 210, loading: "lazy", decoding: "async" }) : null,
    h(
      doc,
      "span",
      { class: "card-body" },
      h(doc, "span", { class: "card-site" }, c.site || host),
      h(doc, "span", { class: "card-title" }, c.title),
      c.description ? h(doc, "span", { class: "card-desc" }, c.description) : null,
      h(doc, "span", { class: "card-host" }, host),
    ),
  );
}

export function postEl(doc, post, o) {
  const pending = o.pendingIds?.has(post.id) ?? false;
  return h(
    doc,
    "article",
    { class: pending ? "post is-pending" : "post", "data-post": post.id },
    h(
      doc,
      "p",
      { class: "post-meta" },
      h(doc, "time", { datetime: new Date(post.createdAt).toISOString() }, formatDate(post.createdAt)),
      post.editedAt ? h(doc, "span", { class: "post-edited" }, t("Edited")) : null,
      pending ? h(doc, "span", { class: "tag tag-pending" }, t("Not published yet")) : null,
    ),
    h(doc, "p", { class: "post-text" }, linkedText(doc, post.text, o.lib.findVoiciLinks)),
    post.links.length ? h(doc, "div", { class: "post-links" }, post.links.map((l) => card(doc, l, o.cardImageUrl, o.lib))) : null,
  );
}

/** posts: newest first. */
export function postList(doc, posts, o) {
  return h(
    doc,
    "section",
    { class: "posts", "aria-label": t("Posts") },
    h(doc, "h2", { class: "eyebrow" }, t("Posts")),
    h(doc, "div", { class: "post-stream" }, posts.map((p) => postEl(doc, p, o))),
    o.hasOlder
      ? h(doc, "button", { class: "btn btn-secondary btn-wide older", type: "button", on: { click: o.onOlder } }, t("Show older posts"))
      : null,
  );
}

export function footer(doc, o) {
  return h(
    doc,
    "footer",
    { class: "site-footer" },
    o.onReport ? h(doc, "button", { class: "btn-ghost", type: "button", on: { click: o.onReport } }, icon(doc, "flag", "icon icon-sm"), t("Report this page")) : null,
    h(doc, "a", { class: "made-with", href: `https://${o.apex}/` }, flagshipMark(doc, "mark icon-sm"), t("Made with Flagship")),
    o.languagePicker ?? null,
  );
}

/**
 * The whole page into `root`. m = {username, host, apex, index, profile, avatarUrl, posts (newest first), hasOlder,
 * cardImageUrl(sha) → blob URL|null, pendingIds?, lib (the protocol module), onMessage, onReport, onOlder,
 * languagePicker}.
 */
export function renderPage(doc, root, m) {
  replace(
    root,
    h(
      doc,
      "main",
      { class: "page", "data-theme": m.profile.theme },
      h(
        doc,
        "div",
        { class: "column" },
        profileHeader(doc, m),
        linkList(doc, m.profile.links, m.lib),
        m.index.acceptsMessages === 1 && m.onMessage ? messageButton(doc, m.onMessage) : null,
        m.posts.length ? postList(doc, m.posts, m) : null,
        footer(doc, m),
      ),
    ),
  );
}

/** A full-page state: loading skeleton, or a sentence with an optional action. */
export function renderState(doc, root, s) {
  if (s.kind === "loading") {
    replace(
      root,
      h(
        doc,
        "main",
        { class: "page", "aria-busy": "true", "aria-label": t("Loading") },
        h(
          doc,
          "div",
          { class: "column skeleton" },
          h(doc, "div", { class: "sk sk-avatar" }),
          h(doc, "div", { class: "sk sk-line sk-name" }),
          h(doc, "div", { class: "sk sk-line sk-short" }),
          h(doc, "div", { class: "sk sk-bar" }),
          h(doc, "div", { class: "sk sk-bar" }),
          h(doc, "div", { class: "sk sk-bar" }),
        ),
      ),
    );
    return;
  }
  replace(
    root,
    h(
      doc,
      "main",
      { class: "page" },
      h(
        doc,
        "div",
        { class: "column state" },
        h(doc, "div", { class: "state-icon" }, icon(doc, s.icon ?? "alert")),
        h(doc, "h1", { class: "state-title" }, s.title),
        s.body ? h(doc, "p", { class: "state-body" }, s.body) : null,
        s.action ? h(doc, "button", { class: "btn btn-secondary", type: "button", on: { click: s.action.run } }, s.action.label) : null,
        s.footer ?? null,
      ),
    ),
  );
}
