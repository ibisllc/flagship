/**
 * Shadow-DOM overlay panel. Renders OverlayState into an isolated tree
 * appended to <body>.
 *
 * Security:
 *  - No innerHTML with untrusted data. All user-derived strings are
 *    inserted via textContent.
 *  - No remote scripts; styles are inline as a CSSStyleSheet attached
 *    to the shadow root.
 *  - The mount node is a single <div> with a closed shadow root so the
 *    host page's CSS/JS cannot reach into our tree.
 *
 * Banner colors are deliberately neutral — defer to the host page on
 * accent colors so we don't clash. Reds and yellows are reserved for
 * actual alarms.
 */
import type { OverlayState, Alarm, PersonCard, TrackView } from "./verifier-logic.js";
import { formatDuration } from "./verifier-logic.js";

const HOST_ID = "maintainers-overlay-root";

let mounted: { host: HTMLDivElement; root: ShadowRoot } | null = null;

export interface OverlayCallbacks {
  onAlarmClick(alarm: Alarm): void;
  onInvestigate(): void;
  onCollapse(collapsed: boolean): void;
}

export function mountOverlay(
  parent: Document,
  state: OverlayState,
  cb: OverlayCallbacks,
): void {
  unmountOverlay(parent);
  const host = parent.createElement("div");
  host.id = HOST_ID;
  // The host element itself is in the page DOM; keep it positionally
  // out of the way and let the shadow tree handle styling.
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.right = "0";
  host.style.zIndex = "2147483647"; // top-of-stack
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "visible";
  host.style.pointerEvents = "none";

  const root = host.attachShadow({ mode: "closed" });
  attachStyles(root);
  renderInto(root, state, cb);

  parent.body.appendChild(host);
  mounted = { host, root };
}

export function updateOverlay(state: OverlayState, cb: OverlayCallbacks): void {
  if (!mounted) return;
  // Wipe existing tree and re-render. The shadow root is small enough
  // that a full re-render is simpler than diffing.
  while (mounted.root.lastChild && (mounted.root.lastChild as Node).nodeType !== Node.TEXT_NODE) {
    const node = mounted.root.lastChild;
    // Preserve the stylesheet by not removing CSSStyleSheet objects
    // (attachStyles uses adoptedStyleSheets which is not in childNodes).
    if (node instanceof HTMLStyleElement) break;
    mounted.root.removeChild(node);
  }
  renderInto(mounted.root, state, cb);
}

export function unmountOverlay(parent: Document): void {
  if (mounted) {
    mounted.host.remove();
    mounted = null;
  }
  // Defensive cleanup in case a previous instance was orphaned.
  const stale = parent.getElementById(HOST_ID);
  if (stale) stale.remove();
}

function attachStyles(root: ShadowRoot): void {
  const sheet = `
    :host, * { box-sizing: border-box; }
    .panel {
      pointer-events: auto;
      position: fixed;
      top: 64px;
      right: 16px;
      width: 320px;
      max-height: calc(100vh - 96px);
      overflow-y: auto;
      background: #fbfbfa;
      color: #1c1c1a;
      border: 1px solid #e0ddd6;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.08);
      font: 13px/1.4 system-ui, -apple-system, sans-serif;
      transition: transform .18s ease, opacity .18s ease;
    }
    .panel.collapsed { transform: translateX(290px); }
    .panel.collapsed .body { opacity: 0; pointer-events: none; }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid #ece9e2;
      background: #fefdf9;
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
    }
    .header .title {
      font-weight: 600;
      letter-spacing: -.01em;
      font-size: 13px;
    }
    .header .repo {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: #6a6a64;
      margin-top: 2px;
    }
    .header .toggle {
      cursor: pointer;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 4px 8px;
      font: inherit;
      color: #4a4a44;
    }
    .header .toggle:hover { background: #f0ede5; }
    .body { padding: 8px 12px 14px; }
    .alarm {
      padding: 8px 10px;
      border-radius: 6px;
      margin: 6px 0;
      font-size: 12px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .alarm.red {
      background: #fdecea;
      border-color: #f3b6b1;
      color: #88231b;
    }
    .alarm.yellow {
      background: #fff4d6;
      border-color: #ead9a1;
      color: #6a4f0b;
    }
    .alarm.info {
      background: #eef3fb;
      border-color: #c8d6ee;
      color: #25457a;
    }
    .alarm .alarm-detail { display: block; opacity: .8; font-size: 11px; margin-top: 2px; }
    .track {
      padding: 10px 0;
      border-top: 1px solid #ece9e2;
    }
    .track:first-of-type { border-top: none; }
    .track h3 {
      margin: 0 0 6px;
      font-size: 11px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: #6a6a64;
    }
    .person {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
    }
    .person .avatar {
      width: 28px; height: 28px; border-radius: 14px;
      background: #ece9e2;
      flex: 0 0 28px;
      object-fit: cover;
    }
    .person .meta {
      flex: 1 1 auto;
      min-width: 0;
    }
    .person .meta .name { font-weight: 500; }
    .person .meta .email {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: #6a6a64;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .expiry {
      font-size: 11px;
      color: #6a6a64;
      margin-top: 2px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    .expiry.soon { color: #88231b; }
    .successors h4 {
      margin: 8px 0 4px;
      font-size: 10px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: #6a6a64;
    }
    .empty {
      color: #8a8a82;
      font-style: italic;
      font-size: 12px;
      padding: 8px 0;
    }
    .timeline {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #ece9e2;
    }
    .timeline h4 {
      margin: 0 0 6px;
      font-size: 10px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: #6a6a64;
    }
    .timeline ul { list-style: none; padding: 0; margin: 0; }
    .timeline li {
      font-size: 11px;
      color: #4a4a44;
      padding: 4px 0;
      border-top: 1px dashed #ece9e2;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    .timeline li:first-of-type { border-top: none; }
    .footer {
      padding: 8px 12px;
      border-top: 1px solid #ece9e2;
      text-align: right;
    }
    .footer button {
      background: #1c1c1a;
      color: #fbfbfa;
      border: none;
      border-radius: 6px;
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
    }
    .footer button:hover { background: #333330; }
  `;
  const styleEl = document.createElement("style");
  styleEl.textContent = sheet;
  root.appendChild(styleEl);
}

function renderInto(root: ShadowRoot, state: OverlayState, cb: OverlayCallbacks): void {
  const panel = el("div", { className: "panel" });
  panel.appendChild(renderHeader(state, cb, panel));
  const body = el("div", { className: "body" });

  // Alarms first — they're the load-bearing UI.
  for (const a of state.alarms) {
    body.appendChild(renderAlarm(a, cb));
  }

  if (!state.policyPresent) {
    body.appendChild(textBlock("empty", "No .maintainers/policy.json on this repo"));
  } else if (state.tracks.length === 0) {
    body.appendChild(textBlock("empty", "Policy declares zero tracks"));
  } else {
    for (const t of state.tracks) {
      body.appendChild(renderTrack(t));
    }
  }

  panel.appendChild(body);

  const footer = el("div", { className: "footer" });
  const button = el("button", { type: "button" });
  button.textContent = "Investigate";
  button.addEventListener("click", () => cb.onInvestigate());
  footer.appendChild(button);
  panel.appendChild(footer);

  root.appendChild(panel);
}

function renderHeader(state: OverlayState, cb: OverlayCallbacks, panel: HTMLElement): HTMLElement {
  const header = el("div", { className: "header" });
  const titleWrap = el("div");
  const title = el("div", { className: "title" });
  title.textContent = state.projectName;
  const repoLine = el("div", { className: "repo" });
  repoLine.textContent = "maintainers v1";
  titleWrap.appendChild(title);
  titleWrap.appendChild(repoLine);

  const toggle = el("button", { className: "toggle", type: "button" });
  toggle.textContent = "−";
  let collapsed = false;
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    panel.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "+" : "−";
    cb.onCollapse(collapsed);
  });

  header.appendChild(titleWrap);
  header.appendChild(toggle);
  return header;
}

function renderAlarm(a: Alarm, cb: OverlayCallbacks): HTMLElement {
  const div = el("div", { className: `alarm ${a.level}` });
  const msg = el("span");
  msg.textContent = a.message;
  div.appendChild(msg);
  if (a.detail) {
    const detail = el("span", { className: "alarm-detail" });
    detail.textContent = a.detail;
    div.appendChild(detail);
  }
  div.addEventListener("click", () => cb.onAlarmClick(a));
  return div;
}

function renderTrack(t: TrackView): HTMLElement {
  const wrap = el("div", { className: "track" });
  const h3 = el("h3");
  h3.textContent = t.track;
  wrap.appendChild(h3);

  if (!t.current) {
    wrap.appendChild(textBlock("empty", "No active mandate"));
    if (t.lastExpired) {
      const note = el("div", { className: "expiry soon" });
      note.textContent = `Last mandate expired ${t.lastExpired.expiresAt}`;
      wrap.appendChild(note);
    }
  } else {
    wrap.appendChild(renderPerson(t.current.holder));
    const exp = el("div", { className: "expiry" });
    const soon = t.current.expiresInMs < 7 * 24 * 60 * 60 * 1000;
    if (soon) exp.classList.add("soon");
    exp.textContent = `expires in ${formatDuration(t.current.expiresInMs)}`;
    wrap.appendChild(exp);
  }

  if (t.successors.length > 0) {
    const succWrap = el("div", { className: "successors" });
    const h4 = el("h4");
    h4.textContent = `successors (${t.successors.length})`;
    succWrap.appendChild(h4);
    for (const s of t.successors) succWrap.appendChild(renderPerson(s));
    wrap.appendChild(succWrap);
  }

  if (t.recentMandates.length > 0) {
    const tl = el("div", { className: "timeline" });
    const h4 = el("h4");
    h4.textContent = "recent activity";
    tl.appendChild(h4);
    const ul = el("ul");
    for (const m of t.recentMandates) {
      const li = el("li");
      li.textContent = `${m.issuedAt.slice(0, 10)}  ${m.mandateId.slice(0, 8)}  holder ${m.holder.slice(0, 8)}…`;
      ul.appendChild(li);
    }
    tl.appendChild(ul);
    wrap.appendChild(tl);
  }

  return wrap;
}

function renderPerson(p: PersonCard): HTMLElement {
  const wrap = el("div", { className: "person" });
  const avatar = el("img", { className: "avatar", alt: "" }) as HTMLImageElement;
  // Only allow http(s) photos. Reject anything else (data:, javascript:, etc.)
  if (p.photo && /^https?:\/\//i.test(p.photo)) {
    avatar.src = p.photo;
  } else {
    avatar.removeAttribute("src");
  }
  // referrerpolicy keeps the host page private when we load an avatar
  avatar.referrerPolicy = "no-referrer";
  wrap.appendChild(avatar);
  const meta = el("div", { className: "meta" });
  const name = el("div", { className: "name" });
  name.textContent = p.displayName;
  const email = el("div", { className: "email" });
  email.textContent = p.email;
  meta.appendChild(name);
  meta.appendChild(email);
  wrap.appendChild(meta);
  return wrap;
}

function textBlock(cls: string, content: string): HTMLElement {
  const div = el("div", { className: cls });
  div.textContent = content;
  return div;
}

interface ElAttrs {
  className?: string;
  type?: "button" | "reset" | "submit";
  alt?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.className) node.className = attrs.className;
  if (attrs.type) (node as HTMLButtonElement).type = attrs.type;
  if (attrs.alt) (node as HTMLImageElement).alt = attrs.alt;
  return node;
}
