// Settings → "Scan a code or enter a link" (was "Scan a pairing code" and
// "Process URL"): one dialog takes a scanned or pasted Flagship code or link
// and opens the screen a tapped link opens, as iOS and Android
// (ScanOrLinkScreen, row "settings-scan-pairing-code") do.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (p: string) => readFileSync(resolve(WEBAPP, p), "utf8");
const load = (p: string) => import(pathToFileURL(resolve(WEBAPP, p)).href);

describe("Scan a code or enter a link", () => {
  it("still reads a pasted or scanned /join link and refuses anything else in words", async () => {
    const join = await load("views/join.js");
    const link = "https://flagshipserver.com/join?sid=abc123&pk=AAAA";
    expect(join.readJoinInput(`  ${link}  `)).toEqual({ link, error: "" });
    expect(join.readJoinInput("https://flagshipserver.com/share#s=1")).toEqual({ link: null, error: join.JOIN_LINK_INVALID });
    expect(join.readJoinInput("")).toEqual({ link: null, error: join.JOIN_LINK_INVALID });
  });

  it("knows a join code, a sign-in link, a share link; nothing else", async () => {
    const { classifyFlagshipLink } = await load("lib/flagshipLinkInput.js");
    expect(classifyFlagshipLink("https://flagshipserver.com/join?sid=abc123&pk=AAAA")?.kind).toBe("join");
    expect(classifyFlagshipLink("  sid=abc123&pk=AAAA ")?.kind).toBe("join");
    expect(
      classifyFlagshipLink(
        "https://flagshipserver.com/access#server=home.alice.flagship.services&svc=notes&ref=alice--notes&page=abc123",
      )?.kind,
    ).toBe("access");
    const share = classifyFlagshipLink(`https://flagshipserver.com/share#s=${"b".repeat(32)}&k=${"a".repeat(64)}`);
    expect(share?.kind).toBe("share");
    expect(classifyFlagshipLink("")).toBeNull();
    expect(classifyFlagshipLink("not a link")).toBeNull();
    expect(classifyFlagshipLink("https://example.com/somewhere")).toBeNull();
  });

  it("opens each kind on the screen a tapped link opens; a join still compares the match code", () => {
    const view = read("views/join.js");
    const open = view.slice(view.indexOf("export async function openFlagshipLink"), view.indexOf("export async function openScanOrLink"));
    expect(open).toContain("enterJoin(found.value)");
    expect(open).toContain("enterAccessAuthorize(found.value)");
    expect(open).toMatch(/canAddServers\(\)[\s\S]*enterShareAccept\(found\.value\)/);
    expect(open).toContain("enterTransferClaim(found.value)");
    // The join screen is unchanged: the 6-digit code on both screens is the check.
    expect(view).toContain("This must match the 6-digit code on the admin's screen.");
    expect(view).toContain('pendingLink = typeof link === "string" ? parseJoinLink(link) : link ?? null;');
  });

  it("the dialog has the camera, a field with Paste, and words for a bad link", () => {
    const view = read("views/join.js");
    expect(view).toContain('export const JOIN_ANOTHER_TITLE = tr("Scan a code or enter a link");');
    expect(view).toContain("data-join-scan");
    expect(view).toContain("data-join-paste");
    expect(view).toContain("navigator.clipboard.readText()");
    expect(view).toContain("classifyFlagshipLink(text)");
    expect(view).toContain("showError(LINK_INVALID)");
  });

  it("Settings has the one row, wired to the dialog; Process URL is gone; a companion browser can't use it", () => {
    const html = read("index.html");
    expect(html).toMatch(/id="settings-tab-join-account"[^]*?Scan a code or enter a link/);
    expect(html).not.toContain("settings-tab-process-url");
    expect(html).not.toContain(">Process URL<");
    expect(read("app.js")).toContain('wire("settings-tab-join-account"');
    expect(read("app.js")).toContain("openScanOrLink()");
    expect(read("lib/companionGuard.js")).toContain('"settings-tab-join-account"');
  });
});
