// theme.js's mirror-domain pass, run in a VM with a stub location and DOM
// (jsdom isn't in the repo). The pass covers the static pages the Worker never
// sees; apps/com/test/mirrorDomains.test.ts covers the Worker's side.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const THEME = readFileSync(join(__dirname, "../public/theme.js"), "utf8");

interface FakeNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  parentNode?: FakeNode;
  attributes: { name: string; value: string }[];
  setAttribute(name: string, value: string): void;
}

function el(nodeName: string, attrs: Record<string, string> = {}): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    nodeName,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    setAttribute(name, value) {
      const a = node.attributes.find((x) => x.name === name);
      if (a) a.value = value;
    },
  };
  return node;
}

function text(parent: FakeNode, value: string): FakeNode {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, parentNode: parent, attributes: [], setAttribute() {} };
}

function run(hostname: string, nodes: FakeNode[] = []) {
  let replaced: string | null = null;
  const document = {
    readyState: "complete",
    documentElement: { setAttribute() {}, getAttribute() { return "light"; } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return { setAttribute() {}, style: {} }; },
    body: { appendChild() {} },
    createTreeWalker() {
      let i = 0;
      return { nextNode: () => nodes[i++] ?? null };
    },
  };
  const location = {
    hostname,
    pathname: "/faq",
    search: "?a=1",
    hash: "#x",
    replace(url: string) { replaced = url; },
  };
  runInNewContext(THEME, { document, location, localStorage: { getItem() { return null; } } });
  return replaced;
}

describe("theme.js mirror-domain pass", () => {
  it("does nothing on the direct domain (fshp.app is not a mirror)", () => {
    const p = el("P");
    const t = text(p, "Open flagshipserver.com");
    expect(run("fshp.app", [p, t])).toBeNull();
    expect(run("game--alice.fshp.app", [p, t])).toBeNull();
    expect(t.nodeValue).toBe("Open flagshipserver.com");
  });

  it("does nothing on the real apex", () => {
    const p = el("P");
    const t = text(p, "Open flagshipserver.com");
    expect(run("flagshipserver.com", [p, t])).toBeNull();
    expect(t.nodeValue).toBe("Open flagshipserver.com");
  });

  it("rewrites visible text and attributes, not scripts or emails", () => {
    const a = el("A", { href: "https://webapp.flagshipserver.com/x" });
    const mail = el("A", { href: "mailto:support@flagshipserver.com" });
    const p = el("P");
    const t = text(p, "Your box at home.alice.flagship.services; mail support@flagshipserver.com");
    const s = el("SCRIPT");
    const code = text(s, 'fetch("https://flagshipserver.com/api")');
    expect(run("fshp.tech", [a, mail, p, t, s, code])).toBeNull();
    expect(a.attributes[0]!.value).toBe("https://webapp.fshp.tech/x");
    expect(mail.attributes[0]!.value).toBe("mailto:support@flagshipserver.com");
    expect(t.nodeValue).toBe("Your box at home.alice.fshp.tech; mail support@flagshipserver.com");
    expect(code.nodeValue).toBe('fetch("https://flagshipserver.com/api")');
  });

  it("redirects www, Cloudflare subhosts and every other name", () => {
    expect(run("www.fshp.tech")).toBe("https://fshp.tech/faq?a=1#x");
    expect(run("webapp.fshp.tech")).toBe("https://webapp.flagshipserver.com/faq?a=1#x");
    expect(run("home.alice.fshp.tech")).toBe("https://home.alice.flagship.services/faq?a=1#x");
  });
});
