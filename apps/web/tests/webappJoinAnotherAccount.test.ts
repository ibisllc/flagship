// Settings → "Scan a pairing code": a signed-in browser joins another
// account from the code (or link) that account's device shows, as iOS
// (SettingsScreen "settings-scan-pairing-code") and Android do.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (p: string) => readFileSync(resolve(WEBAPP, p), "utf8");
const load = (p: string) => import(pathToFileURL(resolve(WEBAPP, p)).href);

describe("joining another account from Settings", () => {
  it("takes a pasted or scanned /join link and refuses anything else in words", async () => {
    const join = await load("views/join.js");
    const link = "https://flagshipserver.com/join?sid=abc123&pk=AAAA";
    expect(join.readJoinInput(`  ${link}  `)).toEqual({ link, error: "" });
    expect(join.readJoinInput("https://flagshipserver.com/share#s=1")).toEqual({ link: null, error: join.JOIN_LINK_INVALID });
    expect(join.readJoinInput("")).toEqual({ link: null, error: join.JOIN_LINK_INVALID });
  });

  it("enterJoin reads a pasted link string as well as the boot's parsed link", () => {
    const view = read("views/join.js");
    expect(view).toContain('pendingLink = typeof link === "string" ? parseJoinLink(link) : link ?? null;');
  });

  it("Settings has the row, wired to the dialog, and a companion browser doesn't", () => {
    expect(read("index.html")).toMatch(/id="settings-tab-join-account"[^]*?Scan a pairing code/);
    expect(read("app.js")).toContain('wire("settings-tab-join-account"');
    expect(read("lib/companionGuard.js")).toContain('"settings-tab-join-account"');
  });
});
