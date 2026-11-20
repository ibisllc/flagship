// The page renderer (docs/voici-and-messages.md §2.1): contact card, links, Message and Call, posts, footer, and the
// compact bar pinned at the top once the header scrolls away.
// Only ever given content that verify.js already checked against the signed index; it still treats every string as
// text and every URL as one more thing to check. The apps' editor preview reuses this module (§11.2): pass
// `pendingIds` for posts that are not published yet, and they render grayed with "Not published yet".

import { h, replace } from "./dom.js";
import { icon, siteMark } from "./icons.js";
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

/** "Message" and "Call", side by side on one row (they wrap only when the row can't hold both), and one line under
 *  them. A button the page doesn't offer is left out. */
export function messageButton(doc, onMessage, onCall) {
  return h(
    doc,
    "div",
    { class: "message-cta" },
    h(
      doc,
      "div",
      { class: "cta-row" },
      onMessage ? h(doc, "button", { class: "btn btn-primary cta-btn", type: "button", on: { click: onMessage } }, icon(doc, "message"), h(doc, "span", {}, t("Message"))) : null,
      onCall ? h(doc, "button", { class: onMessage ? "btn btn-secondary cta-btn call-btn" : "btn btn-primary cta-btn call-btn", type: "button", on: { click: onCall } }, icon(doc, "call"), h(doc, "span", {}, t("Call"))) : null,
    ),
    h(doc, "p", { class: "cta-note" }, t("Quantum-safe encrypted communication.")),
  );
}

/** The bar pinned to the top once the visitor scrolls past the full header: photo, name, and the same two actions as
 *  icon buttons. Hidden (and inert) until watchHeader shows it. */
export function compactBar(doc, m, onMessage, onCall) {
  const bar = h(
    doc,
    "div",
    { class: "compact-bar", "aria-hidden": "true" },
    h(
      doc,
      "div",
      { class: "compact-inner" },
      avatarEl(doc, m.profile, m.avatarUrl, "sm"),
      h(doc, "p", { class: "compact-name" }, m.profile.displayName),
      h(
        doc,
        "div",
        { class: "compact-actions" },
        onMessage ? h(doc, "button", { class: "bar-btn", type: "button", "aria-label": t("Message"), title: t("Message"), on: { click: onMessage } }, icon(doc, "message")) : null,
        onCall ? h(doc, "button", { class: "bar-btn", type: "button", "aria-label": t("Call"), title: t("Call"), on: { click: onCall } }, icon(doc, "call")) : null,
      ),
    ),
  );
  bar.inert = true;
  return bar;
}

function setBarShown(bar, shown) {
  bar.inert = !shown;
  bar.setAttribute("aria-hidden", shown ? "false" : "true");
  bar.setAttribute("class", shown ? "compact-bar is-shown" : "compact-bar");
}

let headWatch = null;

/** Shows `bar` while `last` (the header's last element) sits wholly above the viewport, through an
 *  IntersectionObserver (no scroll handler). Without one, the bar never shows. A page too short to scroll past its
 *  header never fires "above", so its bar stays hidden. */
export function watchHeader(win, last, bar) {
  headWatch?.disconnect();
  headWatch = null;
  const IO = win?.IntersectionObserver;
  if (!IO || !last || !bar) return null;
  headWatch = new IO((entries) => {
    for (const e of entries) setBarShown(bar, !e.isIntersecting && e.boundingClientRect.bottom <= 0);
  });
  headWatch.observe(last);
  return headWatch;
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

/** Newest first by creation time; posts made at the same moment keep the order they came in. */
export function newestFirst(posts) {
  return posts
    .map((p, i) => [p, i])
    .sort(([a, i], [b, j]) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || i - j)
    .map(([p]) => p);
}

export function postList(doc, posts, o) {
  return h(
    doc,
    "section",
    { class: "posts", "aria-label": t("Posts") },
    h(doc, "h2", { class: "eyebrow" }, t("Posts")),
    h(doc, "div", { class: "post-stream" }, newestFirst(posts).map((p) => postEl(doc, p, o))),
    o.hasOlder
      ? h(doc, "button", { class: "btn btn-secondary btn-wide older", type: "button", on: { click: o.onOlder } }, t("Show older posts"))
      : null,
  );
}

/** One callout ("Make your page"), then the rest in one quiet style. Report this page leads to the report sheet,
 *  which also links to the abuse page. */
export function footer(doc, o) {
  return h(
    doc,
    "footer",
    { class: "site-footer" },
    // voi.ci's front door (docs/voici-front-door.md): how a visitor makes a page of their own.
    o.host ? h(doc, "a", { class: "make-own", href: `https://${o.host}/` }, t("Make your page"), icon(doc, "arrowUpRight", "icon icon-sm")) : null,
    h(
      doc,
      "nav",
      { class: "footer-links", "aria-label": t("Rules and reports") },
      o.onReport ? h(doc, "button", { class: "footer-item", type: "button", on: { click: o.onReport } }, t("Report this page")) : null,
      h(doc, "a", { class: "footer-item", href: `https://${o.apex}/terms` }, t("Terms")),
    ),
  );
}

/**
 * The whole page into `root`. m = {username, host, apex, index, profile, avatarUrl, posts, hasOlder,
 * cardImageUrl(sha) → blob URL|null, pendingIds?, lib (the protocol module), onMessage, onCall, onReport, onOlder,
 * win? (for the compact bar's IntersectionObserver; defaults to doc.defaultView)}.
 */
export function renderPage(doc, root, m) {
  const onMessage = m.index.acceptsMessages === 1 && m.onMessage ? m.onMessage : null;
  const onCall = m.index.acceptsCalls === 1 && m.onCall ? m.onCall : null;
  const head = profileHeader(doc, m);
  const cta = onMessage || onCall ? messageButton(doc, onMessage, onCall) : null;
  const bar = compactBar(doc, m, onMessage, onCall);
  replace(
    root,
    bar,
    h(
      doc,
      "main",
      { class: "page", "data-theme": m.profile.theme },
      h(
        doc,
        "div",
        { class: "column" },
        h(
          doc,
          "div",
          { class: "page-body" },
          head,
          linkList(doc, m.profile.links, m.lib),
          cta,
          m.posts.length ? postList(doc, m.posts, m) : null,
        ),
        footer(doc, m),
      ),
    ),
  );
  watchHeader(m.win ?? doc.defaultView, cta ?? head, bar);
}

/** A full-page state: loading skeleton, or a sentence with an optional action. */
export function renderState(doc, root, s) {
  headWatch?.disconnect();
  headWatch = null;
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
