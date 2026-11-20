// The page renderer on a minimal fake DOM, fed hostile content (which verify.js would only let through if the owner
// signed it, and which must still come out as text): no element is made from content, every link is https or
// mailto with noopener, pending posts are grayed, and the message button follows acceptsMessages.
import { describe, expect, it } from "vitest";
import * as lib from "../../../packages/flagship-web/src/proto/lib/voiciProtocol.js";
import { h, safeHref } from "../src/dom.js";
import { renderPage } from "../src/page.js";
import { initLocale, locale } from "../src/i18n.js";

type Node = FakeEl | FakeText;
class FakeText {
  nodeType = 3;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}
class FakeEl {
  nodeType = 1;
  attrs = new Map<string, string>();
  children: Node[] = [];
  listeners: Record<string, unknown[]> = {};
  parent: FakeEl | null = null;
  constructor(public tagName: string, public ownerDocument: FakeDoc, public ns: string | null = null) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  appendChild(c: Node) {
    if (c instanceof FakeEl) c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: Node) {
    this.children = this.children.filter((x) => x !== c);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  addEventListener(t: string, f: unknown) {
    (this.listeners[t] ??= []).push(f);
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  *walk(): Generator<FakeEl> {
    yield this;
    for (const c of this.children) if (c instanceof FakeEl) yield* c.walk();
  }
}
class FakeDoc {
  createElement(t: string) {
    return new FakeEl(t, this);
  }
  createElementNS(ns: string, t: string) {
    return new FakeEl(t, this, ns);
  }
  createTextNode(s: string) {
    return new FakeText(s);
  }
}

const EVIL = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function page(over: Record<string, unknown> = {}) {
  const doc = new FakeDoc();
  const root = doc.createElement("div");
  const posts = [
    { id: "a".repeat(32), createdAt: 1_800_000_000_000, editedAt: null, text: `${EVIL}\nsee https://example.com/x?y=1 and javascript:alert(3)`, links: [{ url: "https://example.com/card", card: { title: EVIL, site: EVIL, description: EVIL, image: null } }] },
    { id: "b".repeat(32), createdAt: 1_800_000_100_000, editedAt: 1_800_000_200_000, text: "pending one", links: [{ url: "https://bare.example/x", card: null }] },
  ];
  renderPage(doc as unknown as Document, root as unknown as Element, {
    username: "alice",
    host: "voi.ci",
    apex: "flagshipserver.com",
    index: { acceptsMessages: 1 },
    profile: {
      displayName: EVIL,
      bio: EVIL,
      theme: "classic",
      links: [
        { url: "https://github.com/alice", label: EVIL, site: "github" },
        { url: "javascript:alert(1)", label: "bad", site: null },
        { url: "mailto:alice@example.com", label: "Mail", site: "email" },
        { url: "https://x.example/", label: "fake site id", site: "<svg>" },
      ],
    },
    avatarUrl: null,
    posts,
    hasOlder: true,
    cardImageUrl: () => null,
    pendingIds: new Set(["b".repeat(32)]),
    lib,
    onMessage: () => {},
    onReport: () => {},
    onOlder: () => {},
    ...over,
  });
  return root;
}

describe("voi.ci renderer", () => {
  it("puts every piece of content on screen as text, never as elements", () => {
    const root = page();
    const tags = new Set([...root.walk()].map((e) => e.tagName));
    for (const t of ["script", "img", "iframe", "object", "embed", "style", "form"]) expect(tags.has(t), t).toBe(false);
    expect(root.textContent).toContain(EVIL);
    for (const e of root.walk()) for (const k of e.attrs.keys()) expect(k.startsWith("on"), `${e.tagName}[${k}]`).toBe(false);
  });

  it("links are https or mailto, open in a new tab without opener or referrer, and show their host", () => {
    const root = page();
    const anchors = [...root.walk()].filter((e) => e.tagName === "a");
    expect(anchors.length).toBeGreaterThan(4);
    for (const a of anchors) {
      const href = a.getAttribute("href")!;
      expect(href, a.textContent).toMatch(/^(https:\/\/|mailto:)/);
      if (a.getAttribute("target") === "_blank") {
        expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
      }
    }
    expect(anchors.some((a) => a.getAttribute("href") === "https://example.com/x?y=1")).toBe(true);
    expect(anchors.some((a) => (a.getAttribute("href") ?? "").includes("javascript"))).toBe(false);
    const labels = anchors.filter((a) => a.getAttribute("class") === "link-button").map((a) => a.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain("github.com");
    expect(root.textContent).not.toContain("<svg>G");
  });

  it("grays posts that are not published yet, and shows the message button only when the page accepts messages", () => {
    const root = page();
    const pending = [...root.walk()].filter((e) => (e.getAttribute("class") ?? "").includes("is-pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.textContent).toContain("Not published yet");
    expect([...root.walk()].some((e) => (e.getAttribute("class") ?? "").includes("message-cta"))).toBe(true);
    const closed = page({ index: { acceptsMessages: 0 } });
    expect([...closed.walk()].some((e) => (e.getAttribute("class") ?? "").includes("message-cta"))).toBe(false);
  });

  it("the footer offers a visitor a page of their own, on the front door of this voi.ci (docs/voici-front-door.md)", () => {
    const own = (host: string) => [...page({ host }).walk()].filter((e) => e.getAttribute("class") === "make-own");
    expect(own("voi.ci")).toHaveLength(1);
    expect(own("voi.ci")[0]!.getAttribute("href")).toBe("https://voi.ci/");
    expect(own("voi.ci")[0]!.textContent).toBe("Make your page");
    expect(own("gym.voi.ci")[0]!.getAttribute("href")).toBe("https://gym.voi.ci/");
    expect(own("voi.ci")[0]!.getAttribute("target")).toBeNull();
  });

  it("the dom helper refuses event-handler and unknown attributes and unsafe URLs", () => {
    const doc = new FakeDoc() as unknown as Document;
    expect(() => h(doc, "a", { onclick: "x" } as never)).toThrow();
    expect(() => h(doc, "div", { style: "color:red" } as never)).toThrow();
    expect((h(doc, "a", { href: "javascript:alert(1)" }) as unknown as FakeEl).getAttribute("href")).toBeNull();
    expect((h(doc, "img", { src: "https://evil.example/x.png" }) as unknown as FakeEl).getAttribute("src")).toBeNull();
    expect(safeHref("https://ok.example/a b")).toBeNull();
  });
});

const cls = (e: FakeEl) => e.getAttribute("class") ?? "";
const byClass = (root: FakeEl, c: string) => [...root.walk()].filter((e) => cls(e).split(" ").includes(c));

/** An IntersectionObserver stand-in: the test decides when (and how) it fires. */
function fakeWin() {
  const made: Array<{ cb: (e: unknown[]) => void; targets: unknown[]; disconnected: boolean }> = [];
  class IO {
    rec: { cb: (e: unknown[]) => void; targets: unknown[]; disconnected: boolean };
    constructor(cb: (e: unknown[]) => void) {
      this.rec = { cb, targets: [], disconnected: false };
      made.push(this.rec);
    }
    observe(t: unknown) {
      this.rec.targets.push(t);
    }
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  const fire = (isIntersecting: boolean, bottom: number) => {
    const r = made[made.length - 1]!;
    r.cb(r.targets.map((target) => ({ target, isIntersecting, boundingClientRect: { bottom } })));
  };
  return { win: { IntersectionObserver: IO }, made, fire };
}

describe("the owner page's layout (owner review, 2026-11-19)", () => {
  const both = { index: { acceptsMessages: 1, acceptsCalls: 1 }, onCall: () => {} };

  it("puts Message and Call side by side in one row, with the quantum-safe line under them", () => {
    const root = page(both);
    const row = byClass(root, "cta-row");
    expect(row).toHaveLength(1);
    const buttons = row[0]!.children.filter((c): c is FakeEl => c instanceof FakeEl && c.tagName === "button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Message", "Call"]);
    for (const b of buttons) expect(cls(b)).toContain("cta-btn");
    expect(byClass(root, "cta-note").map((e) => e.textContent)).toEqual(["Quantum-safe encrypted communication."]);
  });

  it("leaves out a button the page doesn't offer", () => {
    const callsOnly = page({ index: { acceptsMessages: 0, acceptsCalls: 1 }, onCall: () => {} });
    expect(byClass(callsOnly, "cta-btn").map((b) => b.textContent)).toEqual(["Call"]);
    const messagesOnly = page();
    expect(byClass(messagesOnly, "cta-btn").map((b) => b.textContent)).toEqual(["Message"]);
    const neither = page({ index: { acceptsMessages: 0, acceptsCalls: 0 }, onCall: () => {} });
    expect(byClass(neither, "cta-btn")).toHaveLength(0);
    expect(byClass(neither, "bar-btn")).toHaveLength(0);
  });

  it("has one report link, no language picker, no 'Made with Flagship', and 'Make your page' as its one callout", () => {
    const root = page(both);
    const foot = byClass(root, "site-footer")[0]!;
    const text = foot.textContent;
    expect(text.match(/Report/g)).toHaveLength(1);
    expect(text).toContain("Report this page");
    expect(text).not.toContain("Report abuse");
    expect(text).not.toContain("Made with Flagship");
    expect(text).not.toContain("©");
    expect([...root.walk()].some((e) => e.tagName === "select")).toBe(false);
    expect(byClass(foot, "make-own")).toHaveLength(1);
    const items = byClass(foot, "footer-item");
    expect(items.map((e) => e.textContent)).toEqual(["Report this page", "Terms"]);
  });

  it("sets the footer after the content, in the column's normal flow", () => {
    const root = page(both);
    const column = byClass(root, "column")[0]!;
    const kids = column.children.filter((c): c is FakeEl => c instanceof FakeEl);
    expect(kids.map((k) => cls(k))).toEqual(["page-body", "site-footer"]);
    expect(byClass(kids[0]!, "posts")).toHaveLength(1);
  });

  it("shows the compact bar only once the observer says the header has scrolled away above", () => {
    const w = fakeWin();
    const root = page({ ...both, win: w.win });
    const bar = byClass(root, "compact-bar")[0]! as FakeEl & { inert?: boolean };
    expect(cls(bar)).toBe("compact-bar");
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.inert).toBe(true);
    expect(w.made).toHaveLength(1);
    expect(cls(w.made[0]!.targets[0] as FakeEl)).toBe("message-cta");
    const icons = byClass(bar, "bar-btn");
    expect(icons.map((b) => b.getAttribute("aria-label"))).toEqual(["Message", "Call"]);
    expect(bar.textContent).not.toContain("Quantum-safe");
    w.fire(false, 300);
    expect(cls(bar)).toBe("compact-bar");
    w.fire(false, -2);
    expect(cls(bar)).toBe("compact-bar is-shown");
    expect(bar.getAttribute("aria-hidden")).toBe("false");
    expect(bar.inert).toBe(false);
    w.fire(true, 40);
    expect(cls(bar)).toBe("compact-bar");
    page({ ...both, win: w.win });
    expect(w.made[0]!.disconnected).toBe(true);
  });

  it("never shows the compact bar without an IntersectionObserver", () => {
    const root = page(both);
    expect(cls(byClass(root, "compact-bar")[0]!)).toBe("compact-bar");
  });

  it("lists posts newest first by creation time, ties in the order they came", () => {
    const mk = (id: string, createdAt: number) => ({ id: id.repeat(32), createdAt, editedAt: null, text: `post ${id}`, links: [] });
    const root = page({ posts: [mk("a", 1000), mk("c", 3000), mk("b", 2000), mk("d", 2000)], pendingIds: new Set() });
    const order = [...root.walk()].filter((e) => e.tagName === "article").map((e) => e.getAttribute("data-post")![0]);
    expect(order).toEqual(["c", "b", "d", "a"]);
  });
});

describe("the visitor's language", () => {
  const nav = (languages: string[], language = languages[0]) => ({ languages, language }) as unknown as Navigator;
  it("is the browser's first shipped language, with base-language fallbacks, else English", () => {
    expect(initLocale(nav(["pt-PT"]))).toBe("pt-BR");
    expect(initLocale(nav(["zh"]))).toBe("zh-Hans");
    expect(initLocale(nav(["zh-CN"]))).toBe("zh-Hans");
    expect(initLocale(nav(["ko-KR", "de-AT"]))).toBe("de");
    expect(initLocale(nav(["ko-KR"]))).toBe("en");
    expect(initLocale(nav([], "ja-JP"))).toBe("ja");
    expect(initLocale(nav(["es-MX", "fr"]))).toBe("es");
    expect(locale()).toBe("es");
    initLocale(nav(["en-US"]));
  });

  it("never reads a remembered choice", () => {
    const g = globalThis as { localStorage?: unknown };
    const old = g.localStorage;
    let reads = 0;
    g.localStorage = { getItem: () => (reads++, "ja"), setItem: () => {} };
    try {
      expect(initLocale(nav(["fr-FR"]))).toBe("fr");
      expect(reads).toBe(0);
    } finally {
      g.localStorage = old;
      initLocale(nav(["en-US"]));
    }
  });
});
