// Line icons (24-unit grid, 1.75 stroke, round caps) and the link-site marks. Built as SVG elements, never parsed.
// Known sites (packages/protocol/src/voiciLinkSites.json) get a monogram of the site's own label in a ring: the
// renderer trusts only the ids of that table, and draws no third-party brand artwork (spec §2.4, C note).

import { svg } from "./dom.js";

const PATHS = {
  link: ["M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2", "M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"],
  arrowUpRight: ["M7 17 17 7", "M9 7h8v8"],
  message: ["M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z"],
  mail: ["M4 6.5h16v11H4z", "m4.5 7 7.5 6 7.5-6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  flag: ["M6 21V4.5", "M6 4.5h10.5l-1.8 4 1.8 4H6"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  back: ["M15 5.5 8.5 12l6.5 6.5"],
  send: ["M4.5 12h11", "m11 6.5 6 5.5-6 5.5"],
  lock: ["M7 11V8.5a5 5 0 0 1 10 0V11", "M5.5 11h13v9h-13z"],
  alert: ["M12 4 21 19.5H3z", "M12 10v4.5", "M12 17.2v.3"],
  globe: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z", "M3.5 12h17", "M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5Z"],
  phone: ["M8.5 3.5h7a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19V5a1.5 1.5 0 0 1 1.5-1.5Z", "M11 17.5h2"],
};

export function icon(doc, name, cls = "icon") {
  const d = PATHS[name] ?? PATHS.link;
  return svg(
    doc,
    "svg",
    { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: cls },
    ...d.map((p) => svg(doc, "path", { d: p })),
  );
}

/** The Flagship mark (apps/web/public/logo.svg geometry), in the current colour. */
export function flagshipMark(doc, cls = "mark") {
  return svg(
    doc,
    "svg",
    { viewBox: "0 0 64 64", width: 20, height: 20, "aria-hidden": "true", focusable: "false", class: cls },
    svg(doc, "rect", { x: 7, y: 7, width: 50, height: 50, rx: 7, fill: "currentColor" }),
    svg(doc, "circle", { cx: 32, cy: 32, r: 17, class: "mark-core" }),
  );
}

/** The mark beside a profile link: mail for email, the Flagship mark for Flagship apps, a monogram for a known site,
 *  the link icon otherwise. `sites` is the shared table; only its ids and labels are used. */
export function siteMark(doc, siteId, sites) {
  if (siteId === "email") return icon(doc, "mail", "site-icon");
  if (siteId === "flagship") return flagshipMark(doc, "site-icon");
  const site = siteId ? sites.find((s) => s.id === siteId) : null;
  if (!site) return icon(doc, "link", "site-icon");
  const el = doc.createElement("span");
  el.className = "site-monogram";
  el.setAttribute("aria-hidden", "true");
  el.appendChild(doc.createTextNode([...site.label][0] ?? "?"));
  return el;
}
