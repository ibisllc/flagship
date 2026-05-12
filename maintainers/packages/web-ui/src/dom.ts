/**
 * Tiny DOM-builder helpers. No framework; just terser-than-vanilla
 * `document.createElement` calls.
 *
 * `el("button.primary", { onClick: ... }, "Continue")` reads cleaner
 * than the equivalent five lines of imperative DOM mutation, and the
 * type signatures keep us honest about attribute names.
 */

type Child = Node | string | number | false | null | undefined;

type ElProps = {
  [k: string]: unknown;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onSubmit?: (e: SubmitEvent) => void;
  className?: string;
};

const SELECTOR_RE = /^([a-zA-Z][a-zA-Z0-9-]*)?(?:\.([a-zA-Z0-9._-]+))?(?:#([a-zA-Z0-9_-]+))?$/;

export function el(selector: string, props: ElProps | null, ...children: Child[]): HTMLElement {
  const m = SELECTOR_RE.exec(selector);
  if (!m) throw new Error(`invalid selector: ${selector}`);
  const tag = m[1] || "div";
  const cls = m[2] ? m[2].split(".").join(" ") : "";
  const id = m[3];
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (id) node.id = id;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        const event = k.slice(2).toLowerCase();
        node.addEventListener(event, v as EventListener);
        continue;
      }
      if (k === "className") {
        node.className = node.className ? `${node.className} ${v}` : String(v);
        continue;
      }
      if (k === "style" && v && typeof v === "object") {
        Object.assign(node.style, v as object);
        continue;
      }
      if (k === "dataset" && v && typeof v === "object") {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) {
          node.dataset[dk] = dv;
        }
        continue;
      }
      if (v === true) {
        node.setAttribute(k, "");
        continue;
      }
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) appendChild(node, c);
  return node;
}

function appendChild(parent: HTMLElement, c: Child): void {
  if (c === undefined || c === null || c === false) return;
  if (c instanceof Node) {
    parent.appendChild(c);
  } else {
    parent.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(root: HTMLElement, child: Node): void {
  clear(root);
  root.appendChild(child);
}

export function shortHex(h: string, head = 6, tail = 4): string {
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function relativeTime(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!isFinite(t)) return iso;
  const diff = t - now.getTime();
  const ad = Math.abs(diff) / 86_400_000;
  if (ad < 1) {
    const ah = Math.abs(diff) / 3_600_000;
    if (ah < 1) {
      const am = Math.abs(diff) / 60_000;
      return diff < 0 ? `${Math.round(am)}m ago` : `in ${Math.round(am)}m`;
    }
    return diff < 0 ? `${Math.round(ah)}h ago` : `in ${Math.round(ah)}h`;
  }
  if (ad < 30) {
    return diff < 0 ? `${Math.round(ad)}d ago` : `in ${Math.round(ad)}d`;
  }
  const am = ad / 30;
  if (am < 12) {
    return diff < 0 ? `${Math.round(am)}mo ago` : `in ${Math.round(am)}mo`;
  }
  const ay = am / 12;
  return diff < 0 ? `${Math.round(ay)}y ago` : `in ${Math.round(ay)}y`;
}

export function daysFromNow(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (!isFinite(t)) return NaN;
  return Math.round((t - now.getTime()) / 86_400_000);
}
