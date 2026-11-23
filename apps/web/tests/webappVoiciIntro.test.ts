/**
 * The one-time "Turn on safe messages, calls and posts" intro (lib/voiciIntro.js): pending only after creating an
 * account, shown once per account on a browser that can publish, the promo line only when `.com` sends one, Turn on
 * opens the Social Profile and makes the page public through the usual steps.
 * Also the Social options renames and the removed "Anyone signed in with Flagship" choice (owner, 2026-11-20).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchVoiciPromo, markVoiciIntroPending, maybeShowVoiciIntro, takeVoiciIntro, voiciIntroKey } from "../public/webapp/lib/voiciIntro.js";

const WEBAPP = join(import.meta.dirname, "../public/webapp");
const read = (rel: string) => readFileSync(join(WEBAPP, rel), "utf8");

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

describe("the voi.ci intro shows once, after creating an account", () => {
  it("is pending only once marked, and taken exactly once", () => {
    const s = memoryStorage();
    expect(takeVoiciIntro("bright-maple", s)).toBe(false);
    markVoiciIntroPending("bright-maple", s);
    expect(s.map.get(voiciIntroKey("bright-maple"))).toBe("pending");
    expect(takeVoiciIntro("bright-maple", s)).toBe(true);
    expect(takeVoiciIntro("bright-maple", s)).toBe(false);
    markVoiciIntroPending("bright-maple", s);
    expect(takeVoiciIntro("bright-maple", s)).toBe(false);
    expect(takeVoiciIntro("other-name", s)).toBe(false);
  });

  it("Turn on opens the Social Profile and makes the page public; No thanks only closes", async () => {
    const s = memoryStorage();
    markVoiciIntroPending("bright-maple", s);
    const did: string[] = [];
    let shownWith: { username: string; promo: unknown } | null = null;
    const base = { storage: s, canPublish: async () => true, fetchPromo: async () => null, enterYourPage: async () => void did.push("profile"), goPublic: async () => void did.push("public") };
    const pick = await maybeShowVoiciIntro("bright-maple", { ...base, open: async (o: { username: string; promo: unknown }) => ((shownWith = o), "on") });
    expect(pick).toBe("on");
    expect(did).toEqual(["profile", "public"]);
    expect(shownWith!.username).toBe("bright-maple");
    expect(await maybeShowVoiciIntro("bright-maple", { ...base, open: async () => "on" })).toBeNull();
    expect(did).toEqual(["profile", "public"]);

    markVoiciIntroPending("calm-river", s);
    expect(await maybeShowVoiciIntro("calm-river", { ...base, open: async () => "no" })).toBe("no");
    expect(did).toEqual(["profile", "public"]);
  });

  it("is never offered on a device that can't publish the page (it stays pending)", async () => {
    const s = memoryStorage();
    markVoiciIntroPending("bright-maple", s);
    let opened = 0;
    const r = await maybeShowVoiciIntro("bright-maple", { storage: s, canPublish: async () => false, open: async () => (opened++, "on") });
    expect(r).toBeNull();
    expect(opened).toBe(0);
    expect(s.map.get(voiciIntroKey("bright-maple"))).toBe("pending");
  });

  it("only account creation marks it: not joining, signing in again or restoring", () => {
    const boot = read("views/bootstrap.js");
    const marks = [...boot.matchAll(/markVoiciIntroPending\(/g)];
    expect(marks.length).toBe(1);
    const create = boot.slice(boot.indexOf("async function createAccount()"), boot.indexOf("function showAccessOptions("));
    expect(create).toContain("markVoiciIntroPending(finalName)");
    for (const f of ["views/join.js", "views/recovery.js", "views/restore-merge.js", "views/post-recovery.js", "lib/accountAccess.js"]) {
      expect(read(f)).not.toContain("markVoiciIntroPending");
    }
    expect(read("views/home.js")).toContain("maybeShowVoiciIntro(getSession()?.username)");
    expect(read("service-worker.js")).toContain('"/lib/voiciIntro.js"');
  });

  it("draws the sheet through tr(), with the promo line hidden until `.com` sends one", () => {
    const src = read("lib/voiciIntro.js");
    expect(src).toContain('tr("Turn on safe messages, calls and posts")');
    expect(src).toContain(
      'tr("Let people message and call you, and share your updates. Everything is protected against quantum computers. Your page will be at voi.ci/{0}.", username)',
    );
    expect(src).toContain('tr("Turn on")');
    expect(src).toContain('tr("No thanks")');
    expect(src).toContain("setPagePublic(true)");
    expect(src).toMatch(/data-testid="voici-intro-promo" hidden/);
    expect(src).toMatch(/if \(!done && line && p\?\.text\)/);
    expect(src).not.toMatch(/anonymous/i);
  });
});

describe("fetchVoiciPromo", () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  it("returns the text, or null for none, an error or a bad answer", async () => {
    let asked = "";
    const promo = await fetchVoiciPromo({
      baseUrl: "https://c.example",
      lang: "pt-BR",
      fetchImpl: async (url: string) => ((asked = url), new Response(JSON.stringify({ promo: { text: " Um mês grátis. ", until: "2026-12-01T00:00:00.000Z" } }))),
    });
    expect(asked).toBe("https://c.example/api/voici/promo?lang=pt-BR");
    expect(promo).toEqual({ text: "Um mês grátis.", until: "2026-12-01T00:00:00.000Z" });
    expect(await fetchVoiciPromo({ baseUrl: "x", lang: "en", fetchImpl: answer(200, { promo: null }) })).toBeNull();
    expect(await fetchVoiciPromo({ baseUrl: "x", lang: "en", fetchImpl: answer(404, { error: "not-found" }) })).toBeNull();
    expect(await fetchVoiciPromo({ baseUrl: "x", lang: "en", fetchImpl: answer(200, { promo: { text: "" } }) })).toBeNull();
    expect(await fetchVoiciPromo({ baseUrl: "x", lang: "en", fetchImpl: async () => { throw new Error("offline"); } })).toBeNull();
  });
});

describe("Social options (owner, 2026-11-20)", () => {
  const editor = read("views/page-editor.js");
  const messages = read("views/messages.js");
  it("is called Social options, and Remove page is Turn off social features", () => {
    expect(editor).toContain('title: tr("Social options")');
    expect(messages).toContain('aria-label="${escapeHtml(tr("Social options"))}"');
    expect(messages).toContain('tr("No messages yet. Turn on Accept messages in Social options to get them.")');
    expect(editor).toContain('tr("Turn off social features")');
    expect(editor).toContain("removePage({ socialOff: true })");
    expect(`${editor}\n${messages}`).not.toMatch(/tr\("Page options"\)|tr\("Remove page"\)/);
    const control = read("lib/voiciPageControl.js");
    expect(control).toContain("socialOff ? VOICI_SOCIAL_OFF_TITLE() : VOICI_REMOVE_TITLE()");
    const copy = read("lib/voiciCopy.js");
    expect(copy).toContain('tr("Turn off social features?")');
    expect(copy).toContain(
      'tr("Your voi.ci page is removed, and messages and calls to it stop. Your posts and profile stay on your devices, so you can turn it on again.")',
    );
  });

  it("offers Anyone on the internet and People who let you call them back only, and calls the hours Set business hours", () => {
    expect(editor).not.toContain("Anyone signed in with Flagship");
    expect(editor).not.toMatch(/\["signed-in",/);
    // The same two modes as iOS and Android; an old accepted or signed-in index shows as callback.
    expect(editor).toContain('["anyone", tr("Anyone on the internet")]');
    expect(editor).toContain('["callback", tr("People who let you call them back")]');
    expect(editor).not.toMatch(/\["accepted",/);
    expect(editor).toContain('from: idx.callsFrom === "anyone" ? "anyone" : "callback"');
    expect(editor).toContain('tr("Set business hours")');
    expect(editor).not.toContain("Only at certain hours");
    expect(editor).not.toMatch(/Do Not Disturb/);
  });
});
