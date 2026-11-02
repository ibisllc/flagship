// The page renderer on a minimal fake DOM, fed hostile content (which verify.js would only let through if the owner
// signed it, and which must still come out as text): no element is made from content, every link is https or
// mailto with noopener, pending posts are grayed, and the message button follows acceptsMessages.
import { describe, expect, it } from "vitest";
import * as lib from "../../../packages/flagship-web/src/proto/lib/voiciProtocol.js";
import { h, safeHref } from "../src/dom.js";
import { renderPage } from "../src/page.js";

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

  it("the dom helper refuses event-handler and unknown attributes and unsafe URLs", () => {
    const doc = new FakeDoc() as unknown as Document;
    expect(() => h(doc, "a", { onclick: "x" } as never)).toThrow();
    expect(() => h(doc, "div", { style: "color:red" } as never)).toThrow();
    expect((h(doc, "a", { href: "javascript:alert(1)" }) as unknown as FakeEl).getAttribute("href")).toBeNull();
    expect((h(doc, "img", { src: "https://evil.example/x.png" }) as unknown as FakeEl).getAttribute("src")).toBeNull();
    expect(safeHref("https://ok.example/a b")).toBeNull();
  });
});
