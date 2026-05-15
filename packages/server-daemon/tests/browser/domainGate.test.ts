import { describe, expect, it } from "vitest";
import { DomainGate } from "../../src/browser/domainGate.js";

describe("DomainGate", () => {
  it("denies when no grant is set for the app", () => {
    const g = new DomainGate();
    expect(g.check("alice-game1", "https://example.com/")).toBe("deny");
  });

  it("denies when the grant exists but is empty", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", []);
    expect(g.check("alice-game1", "https://example.com/")).toBe("deny");
  });

  it("allows literal-host matches", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    expect(g.check("alice-game1", "https://example.com/path?x=1")).toBe("allow");
    // sibling host that just shares a suffix is denied
    expect(g.check("alice-game1", "https://www.example.com/")).toBe("deny");
  });

  it("allows wildcard subdomains but NOT the apex", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["*.example.com"]);
    expect(g.check("alice-game1", "https://www.example.com/")).toBe("allow");
    expect(g.check("alice-game1", "https://deep.www.example.com/")).toBe("allow");
    expect(g.check("alice-game1", "https://example.com/")).toBe("deny");
  });

  it("denies non-http(s) schemes (data:, javascript:, file:, blob:)", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    expect(g.check("alice-game1", "data:text/html,<h1>x</h1>")).toBe("deny");
    expect(g.check("alice-game1", "javascript:alert(1)")).toBe("deny");
    expect(g.check("alice-game1", "file:///etc/passwd")).toBe("deny");
    expect(g.check("alice-game1", "blob:https://example.com/abc")).toBe("deny");
  });

  it("denies hosts that look-alike ('evilexample.com' against 'example.com')", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    expect(g.check("alice-game1", "https://evilexample.com/")).toBe("deny");
    expect(g.check("alice-game1", "https://example.com.evil.com/")).toBe("deny");
  });

  it("denies malformed URLs", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    expect(g.check("alice-game1", "not a url")).toBe("deny");
    expect(g.check("alice-game1", "")).toBe("deny");
    expect(g.check("alice-game1", "/relative/path")).toBe("deny");
  });

  it("checks against ALL entries; first match wins", () => {
    const g = new DomainGate();
    g.setGrant("alice-shopper", [
      "amazon.com",
      "*.amazon.com",
      "accounts.google.com",
      "*.walmart.com",
    ]);
    expect(g.check("alice-shopper", "https://amazon.com/")).toBe("allow");
    expect(g.check("alice-shopper", "https://www.amazon.com/dp/X")).toBe("allow");
    expect(g.check("alice-shopper", "https://accounts.google.com/o/oauth2/auth")).toBe("allow");
    expect(g.check("alice-shopper", "https://www.walmart.com/")).toBe("allow");
    expect(g.check("alice-shopper", "https://google.com/")).toBe("deny");
    expect(g.check("alice-shopper", "https://walmart.com/")).toBe("deny"); // wildcard doesn't cover apex
  });

  it("revoke drops the grant entirely; subsequent check denies", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    expect(g.check("alice-game1", "https://example.com/")).toBe("allow");
    g.revoke("alice-game1");
    expect(g.check("alice-game1", "https://example.com/")).toBe("deny");
    expect(g.hasGrant("alice-game1")).toBe(false);
  });

  it("setGrant replaces (not merges) — manifest version bump cleanly resets", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    g.setGrant("alice-game1", ["amazon.com"]);
    expect(g.check("alice-game1", "https://example.com/")).toBe("deny");
    expect(g.check("alice-game1", "https://amazon.com/")).toBe("allow");
  });

  it("grantsFor returns a defensive copy (mutating it doesn't leak into the gate)", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    const snap = g.grantsFor("alice-game1");
    snap.push("evil.com");
    expect(g.grantsFor("alice-game1")).toEqual(["example.com"]);
  });

  it("two apps' grants don't bleed across each other", () => {
    const g = new DomainGate();
    g.setGrant("alice-shopper", ["amazon.com"]);
    g.setGrant("alice-mailer", ["gmail.com"]);
    expect(g.check("alice-shopper", "https://gmail.com/")).toBe("deny");
    expect(g.check("alice-mailer", "https://amazon.com/")).toBe("deny");
  });

  it("host casing is normalized to lowercase before matching", () => {
    const g = new DomainGate();
    g.setGrant("alice-game1", ["example.com"]);
    expect(g.check("alice-game1", "https://EXAMPLE.com/")).toBe("allow");
    expect(g.check("alice-game1", "https://Example.Com/path")).toBe("allow");
  });
});
