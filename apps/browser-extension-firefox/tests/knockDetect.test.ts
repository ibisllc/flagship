import { describe, expect, it } from "vitest";

import "../src/lib/knockDetect.js";

const { detectKnock, parseAccessLink } = (globalThis as unknown as {
  FlagshipKnock: {
    detectKnock: (host: string, hrefs: string[]) => null | { kind: string; site: string; bound?: boolean; link: { server: string } };
    parseAccessLink: (href: string) => null | { server: string; svc: string; trusted: boolean };
  };
}).FlagshipKnock;

const PAGE = "0123456789abcdef0123456789abcdef";
const link = (server: string, svc = "", host = "flagshipserver.com") =>
  `https://${host}/access#server=${server}&svc=${svc}&ref=chess-1&page=${PAGE}`;

describe("parseAccessLink", () => {
  it("reads the fragment of a control-apex link", () => {
    expect(parseAccessLink(link("home.alice.flagship.services", "chess"))).toMatchObject({
      server: "home.alice.flagship.services", svc: "chess", trusted: true,
    });
  });

  it("marks a look-alike host or a malformed server untrusted", () => {
    expect(parseAccessLink(link("home.alice.flagship.services", "chess", "flagshipserver.com.evil.example"))?.trusted).toBe(false);
    expect(parseAccessLink(link("evil.example", "chess"))?.trusted).toBe(false);
  });

  it("ignores other links", () => {
    expect(parseAccessLink("https://flagshipserver.com/")).toBeNull();
    expect(parseAccessLink("not a url")).toBeNull();
  });
});

describe("detectKnock", () => {
  it("finds the sign-in page for this very site", () => {
    const r = detectKnock("chess.home.alice.flagship.services", [link("home.alice.flagship.services", "chess")]);
    expect(r).toMatchObject({ kind: "knock", site: "chess.home.alice.flagship.services", bound: true });
  });

  it("warns about a sign-in code for another site (the QR relay trick)", () => {
    const r = detectKnock("notes.home.mallory.flagship.services", [link("home.alice.flagship.services", "chess")]);
    expect(r).toMatchObject({ kind: "foreign", site: "chess.home.alice.flagship.services" });
  });

  it("warns about a look-alike link", () => {
    const r = detectKnock("chess.home.alice.flagship.services", [link("home.alice.flagship.services", "chess", "flagshipserver.co")]);
    expect(r?.kind).toBe("foreign");
  });

  it("warns when one page shows two different sign-ins", () => {
    const other = link("home.alice.flagship.services", "chess").replace(PAGE, "f".repeat(32));
    const r = detectKnock("chess.home.alice.flagship.services", [link("home.alice.flagship.services", "chess"), other]);
    expect(r?.kind).toBe("foreign");
  });

  it("on a direct name, takes a server-level sign-in as unbound", () => {
    const r = detectKnock("chess.fshp.app", [link("home.alice.flagship.services")]);
    expect(r).toMatchObject({ kind: "knock", bound: false, link: { server: "home.alice.flagship.services" } });
    expect(detectKnock("chess.fshp.app", [link("home.alice.flagship.services", "chess")])?.kind).toBe("foreign");
  });

  it("says nothing on a page without a sign-in link", () => {
    expect(detectKnock("chess.home.alice.flagship.services", ["https://example.com/"])).toBeNull();
  });
});
