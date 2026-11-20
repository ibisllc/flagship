/**
 * The one-time "Get your own voi.ci page" intro (lib/voiciIntro.js): pending only after creating an account, shown
 * once per account on this browser, the promo line only when `.com` sends one, Set it up opens the Social Profile.
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

  it("Set it up opens the Social tab's Profile; Not now only closes", async () => {
    const s = memoryStorage();
    markVoiciIntroPending("bright-maple", s);
    let entered = 0;
    let shownWith: { username: string; promo: unknown } | null = null;
    const pick = await maybeShowVoiciIntro("bright-maple", {
      storage: s,
      fetchPromo: async () => null,
      open: async (o: { username: string; promo: unknown }) => ((shownWith = o), "setup"),
      enterYourPage: async () => void entered++,
    });
    expect(pick).toBe("setup");
    expect(entered).toBe(1);
    expect(shownWith!.username).toBe("bright-maple");
    expect(await maybeShowVoiciIntro("bright-maple", { storage: s, open: async () => "setup", enterYourPage: async () => void entered++ })).toBeNull();
    expect(entered).toBe(1);

    markVoiciIntroPending("calm-river", s);
    const later = await maybeShowVoiciIntro("calm-river", { storage: s, fetchPromo: async () => null, open: async () => "later", enterYourPage: async () => void entered++ });
    expect(later).toBe("later");
    expect(entered).toBe(1);
  });

  it("only account creation marks it: not joining, signing in again or restoring", () => {
    const boot = read("views/bootstrap.js");
    const marks = [...boot.matchAll(/markVoiciIntroPending\(/g)];
    expect(marks.length).toBe(1);
    const create = boot.slice(boot.indexOf("async function createAccount()"), boot.indexOf("function showAccessOptions("));
    expect(create).toContain("markVoiciIntroPending(chosen)");
    for (const f of ["views/join.js", "views/recovery.js", "views/restore-merge.js", "views/post-recovery.js", "lib/accountAccess.js"]) {
      expect(read(f)).not.toContain("markVoiciIntroPending");
    }
    expect(read("views/home.js")).toContain("maybeShowVoiciIntro(getSession()?.username)");
    expect(read("service-worker.js")).toContain('"/lib/voiciIntro.js"');
  });

  it("draws the sheet through tr(), with the promo line hidden until `.com` sends one", () => {
    const src = read("lib/voiciIntro.js");
    expect(src).toContain('tr("Get your own voi.ci page")');
    expect(src).toContain(
      `tr("Set up voi.ci/{0} to send and receive private messages and calls, and to post updates. No phone number or email needed, and it's protected against quantum computers.", username)`,
    );
    expect(src).toContain('tr("Set it up")');
    expect(src).toContain('tr("Not now")');
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

  it("offers no \"Anyone signed in with Flagship\" and calls the hours Set business hours", () => {
    expect(editor).not.toContain("Anyone signed in with Flagship");
    expect(editor).not.toMatch(/\["signed-in",/);
    expect(editor).toContain("from: callsFromChoice(idx.callsFrom)");
    expect(editor).toContain('tr("Set business hours")');
    expect(editor).not.toContain("Only at certain hours");
    expect(editor).not.toMatch(/Do Not Disturb/);
  });
});
