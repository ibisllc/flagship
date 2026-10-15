import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { buildInvitePage, inviteAppLinkFragment } from "../src/invitePage.js";

const BOX = "home.alice.flagship.services";
const SECRET = "ab".repeat(32);
const AID = "cd".repeat(32);
const IID = "ef".repeat(32);

function req(path: string, host = BOX, method = "GET") {
  return { method, path, headers: { host }, body: Buffer.alloc(0) };
}

/** Run the page's inline script against a stub DOM; return the element state. */
function runPage(html: string, hash: string) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const els: Record<string, { href: string; textContent: string; className: string; style: { display: string } }> = {};
  for (const id of ["lede", "open", "web", "web-link"]) {
    els[id] = { href: "", textContent: "", className: "", style: { display: "" } };
  }
  runInNewContext(script, {
    location: { hash, hostname: BOX },
    document: { getElementById: (id: string) => els[id] },
    URLSearchParams,
    RegExp,
    decodeURIComponent,
  });
  return els;
}

describe("box invite page", () => {
  const handle = buildInvitePage({ serverId: BOX });

  it("answers /invite on the box's own host only", async () => {
    const r = await handle(req("/invite"));
    expect(r!.status).toBe(200);
    expect(String(r!.body)).toContain("Open in the Flagship app");
    expect(r!.headers!["referrer-policy"]).toBe("no-referrer");
    expect(await handle(req("/invite/"))).not.toBeNull();
    expect(await handle(req("/invite", `notes.${BOX}`))).toBeNull();
    expect(await handle(req("/invite", BOX, "POST"))).toBeNull();
    expect(await handle(req("/other"))).toBeNull();
  });

  it("builds the app link and the web app link from the fragment", async () => {
    const html = String((await handle(req("/invite")))!.body);
    const els = runPage(html, `#${SECRET}&a=${AID}&i=${IID}&s=alice-notes`);
    const frag = `server=${BOX}&k=${SECRET}&a=${AID}&i=${IID}&s=alice-notes`;
    expect(els["open"]!.href).toBe(`https://flagshipserver.com/invite#${frag}`);
    expect(els["web-link"]!.href).toBe(`https://webapp.flagshipserver.com/invite#${frag}`);
  });

  it("says the link is incomplete when there is no secret", async () => {
    const html = String((await handle(req("/invite")))!.body);
    const els = runPage(html, "#nothing");
    expect(els["lede"]!.textContent).toContain("incomplete");
    expect(els["open"]!.style.display).toBe("none");
  });

  it("follows the configured control apex", async () => {
    const gym = buildInvitePage({ serverId: BOX, controlBaseUrl: "https://gym.flagshipserver.com" });
    const html = String((await gym(req("/invite")))!.body);
    expect(runPage(html, `#${SECRET}`)["open"]!.href).toBe(
      `https://gym.flagshipserver.com/invite#server=${BOX}&k=${SECRET}`,
    );
  });
});

describe("inviteAppLinkFragment", () => {
  it("accepts the bare leading secret and the older k= form", () => {
    expect(inviteAppLinkFragment(`#${SECRET}`, BOX)).toBe(`server=${BOX}&k=${SECRET}`);
    expect(inviteAppLinkFragment(`#k=${SECRET.toUpperCase()}&a=${AID}`, BOX)).toBe(`server=${BOX}&k=${SECRET}&a=${AID}`);
    expect(inviteAppLinkFragment("#short", BOX)).toBeNull();
    expect(inviteAppLinkFragment("", BOX)).toBeNull();
  });
});
