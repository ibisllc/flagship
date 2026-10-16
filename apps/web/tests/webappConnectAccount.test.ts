// The cover's "Connect to an existing account" page: one page holding both ways
// back in, the account name (sign in) and a pairing code or link (join), as
// iOS ConnectAccountScreen and Android ConnectAccountScreen.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (p: string) => readFileSync(resolve(WEBAPP, p), "utf8");
const load = (p: string) => import(pathToFileURL(resolve(WEBAPP, p)).href);

const PK = "A".repeat(43);
const HTTPS_LINK = `https://flagshipserver.com/join?sid=abc123&pk=${PK}`;
const LEGACY_LINK = `flagship://join?sid=abc123&pk=${PK}`;
const BARE_CODE = `sid=abc123&pk=${PK}`;

describe("connect to an existing account", () => {
  it("reads every pairing form the join parser reads", async () => {
    const c = await load("lib/connectAccount.js");
    for (const link of [HTTPS_LINK, LEGACY_LINK, BARE_CODE]) {
      expect(c.classifyConnectInput(`  ${link}\n`)).toEqual({ kind: "pairing", link });
      expect(c.readPairingField(link)).toEqual({ action: "join", link });
    }
  });

  it("a pairing link typed as the account name goes to join with a note", async () => {
    const c = await load("lib/connectAccount.js");
    expect(c.readNameField(HTTPS_LINK)).toEqual({ action: "join", link: HTTPS_LINK, note: c.CONNECT_ROUTED_TO_JOIN });
    expect(c.readNameField(LEGACY_LINK).action).toBe("join");
  });

  it("an account name signs in, lowercased, with or without an @", async () => {
    const c = await load("lib/connectAccount.js");
    expect(c.readNameField("  Bright-Maple ")).toEqual({ action: "sign-in", name: "bright-maple" });
    expect(c.readNameField("@demo")).toEqual({ action: "sign-in", name: "demo" });
    expect(c.readNameField("   ")).toEqual({ action: "none" });
  });

  it("refuses a link that isn't a pairing link, in a sentence, on both fields", async () => {
    const c = await load("lib/connectAccount.js");
    const other = "https://flagshipserver.com/share#s=1";
    expect(c.readNameField(other)).toEqual({ action: "error", error: c.CONNECT_BAD_LINK });
    expect(c.readPairingField(other)).toEqual({ action: "error", error: c.CONNECT_BAD_LINK });
    expect(c.readPairingField("https://flagshipserver.com/join?sid=abc")).toEqual({ action: "error", error: c.CONNECT_BAD_LINK });
  });

  it("an account name in the code field points at the sign-in field", async () => {
    const c = await load("lib/connectAccount.js");
    expect(c.readPairingField("bright-maple")).toEqual({ action: "error", error: c.CONNECT_NAME_IN_CODE });
    expect(c.readPairingField("not a code!")).toEqual({ action: "error", error: c.CONNECT_NOT_A_CODE });
    for (const msg of [c.CONNECT_BAD_LINK, c.CONNECT_NAME_IN_CODE, c.CONNECT_NOT_A_CODE, c.CONNECT_ROUTED_TO_JOIN]) {
      expect(msg).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("the cover has two choices and the connect page holds both halves", () => {
    const html = read("index.html");
    const cover = html.slice(html.indexOf('<section id="view-bootstrap"'), html.indexOf("</section>", html.indexOf('<section id="view-bootstrap"')));
    expect(cover).toContain('id="bootstrap-create" class="full-width" data-testid="welcome-create">Create your account<');
    expect(cover).toContain('data-testid="welcome-connect">Connect to an existing account<');
    expect(cover).not.toMatch(/I already have an account|Join with a pairing code<\/button>/);
    const panel = cover.slice(cover.indexOf('id="bootstrap-connect-panel"'));
    const name = panel.indexOf("Sign in with your account name");
    const or = panel.indexOf('class="connect-or"');
    const pair = panel.indexOf("Join with a pairing code");
    expect(name).toBeGreaterThan(0);
    expect(or).toBeGreaterThan(name);
    expect(pair).toBeGreaterThan(or);
    for (const id of ["connect-name-field", "connect-name-continue", "connect-scan", "connect-pair-field", "connect-pair-continue", "connect-back"]) {
      expect(panel).toContain(`data-testid="${id}"`);
    }
  });

  it("bootstrap routes a pasted link from either field into the join flow", () => {
    const js = read("views/bootstrap.js");
    expect(js).toContain("readNameField(");
    expect(js).toContain("readPairingField(");
    expect(js.match(/enterJoin\((field|r)\.link\)/g)?.length).toBe(2);
    // A /join deep link still opens the join flow at boot (unchanged).
    expect(read("app.js")).toContain("joinLinkFromLocation");
  });
});
