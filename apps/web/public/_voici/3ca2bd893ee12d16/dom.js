// The only way this site puts anything on screen (docs/voici-and-messages.md §12.1, §12.3): elements are built one
// by one, every string becomes a Text node, and attributes go through an allow-list. There is no HTML parsing
// anywhere in the site; tests/site.test.ts fails the build on innerHTML, outerHTML, insertAdjacentHTML,
// document.write, eval, new Function, setAttribute("on…"), or a style attribute.

const ATTRS = new Set([
  "class",
  "id",
  "role",
  "type",
  "name",
  "value",
  "for",
  "tabindex",
  "title",
  "alt",
  "lang",
  "dir",
  "rows",
  "maxlength",
  "autocomplete",
  "inputmode",
  "placeholder",
  "target",
  "rel",
  "referrerpolicy",
  "datetime",
  "width",
  "height",
  "decoding",
  "loading",
  "spellcheck",
  "enterkeyhint",
]);
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_ATTRS = new Set(["viewBox", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "x", "y", "width", "height", "rx", "cx", "cy", "r", "shape-rendering", "aria-hidden", "focusable", "class"]);

/** An http(s) or mailto URL the protocol's own checks already accepted; anything else is refused here too. */
export function safeHref(url) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("mailto:")) && !/[\s<>"`]/.test(url) ? url : null;
}

/** blob: URLs this page minted itself (verified image bytes). */
export function safeImageSrc(url) {
  return typeof url === "string" && url.startsWith("blob:") ? url : null;
}

export function setAttr(el, k, v) {
  if (v === null || v === undefined || v === false) return;
  if (k.startsWith("aria-") || k.startsWith("data-") || ATTRS.has(k)) {
    el.setAttribute(k, v === true ? "" : String(v));
  } else if (k === "href") {
    const u = safeHref(v);
    if (u) el.setAttribute("href", u);
  } else if (k === "src") {
    const u = safeImageSrc(v);
    if (u) el.setAttribute("src", u);
  } else if (k === "disabled" || k === "hidden" || k === "required" || k === "checked" || k === "selected" || k === "open") {
    if (v) el.setAttribute(k, "");
  } else {
    throw new Error(`dom: attribute not allowed: ${k}`);
  }
}

function append(doc, el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) {
    for (const x of c) append(doc, el, x);
    return;
  }
  if (typeof c === "string" || typeof c === "number") el.appendChild(doc.createTextNode(String(c)));
  else el.appendChild(c);
}

/** h(doc, "a", {class, href, on: {click: fn}}, ...children). Strings are always text. */
export function h(doc, tag, props = {}, ...children) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "on") {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    } else {
      setAttr(el, k, v);
    }
  }
  append(doc, el, children);
  return el;
}

export function svg(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (!SVG_ATTRS.has(k)) throw new Error(`dom: svg attribute not allowed: ${k}`);
    el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el, ...children) {
  clear(el);
  append(el.ownerDocument, el, children);
}
