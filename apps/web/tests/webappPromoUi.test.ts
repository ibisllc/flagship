import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const webapp = (...p: string[]) => resolve(__dirname, "..", "public", "webapp", ...p);
const load = (...p: string[]) => import(pathToFileURL(webapp(...p)).href);

const CREDITS = {
  week: { used: 160_000, allowance: 500_000, remaining: 340_000, resetsAt: 0 },
  starter: { used: 800_000, allowance: 2_000_000, remaining: 1_200_000 },
  usedTokens: 960_000,
  allowanceTokens: 2_500_000,
  remainingTokens: 1_540_000,
};
const SPENT = {
  week: { used: 500_000, allowance: 500_000, remaining: 0, resetsAt: 0 },
  starter: { used: 2_000_000, allowance: 2_000_000, remaining: 0 },
  usedTokens: 2_500_000,
  allowanceTokens: 2_500_000,
  remainingTokens: 0,
};
const ok = (credits = CREDITS) => ({ available: true, ended: false, reason: null, credits });

describe("webapp free AI credits", () => {
  it("formats token counts and the weekly / starter line the way all three apps do", async () => {
    const { formatTokens, creditsLine } = await load("lib", "freeAi.js");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(820_000)).toBe("820k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(creditsLine(CREDITS)).toBe("This week: 340k of 500k left · Starter reserve: 1.2M");
  });

  it("signs the same canonical bytes as the protocol vectors", async () => {
    const { canonicalFor } = await load("lib", "freeAi.js");
    const v = JSON.parse(
      readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/llm-promo-issue/vectors.json"), "utf8"),
    ) as { cases: Array<Record<string, unknown> & { canonical: string }> };
    for (const c of v.cases) expect(canonicalFor(c)).toBe(c.canonical);
  });

  it("tells a free AI pass from your own key, and leaves your own key alone", async () => {
    const freeAi = await load("lib", "freeAi.js");
    expect(freeAi.isFreeAiCredential({ provider: "flagship", source: "promo" })).toBe(true);
    expect(freeAi.isFreeAiCredential({ provider: "openai", apiKey: "k" })).toBe(false);
    const byok = { provider: "openai", apiKey: "k" };
    expect(await freeAi.freshCredential(byok, "box")).toBe(byok);
  });

  it("names free AI as the built-in Flagship Inference provider, word for word", async () => {
    const f = await load("lib", "freeAi.js");
    expect(f.PROVIDER_TITLE).toBe("Flagship Inference");
    expect(f.PROVIDER_SUBTITLE).toBe("We use third-party providers and anonymize your requests.");
    expect(f.BUILT_IN_LABEL).toMatch(/built-in provider\. It can.t be removed\./);
    expect(f.TOO_LONG_MESSAGE).toBe(
      "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.",
    );
  });

  it("maps the shim's too-long refusal to its own message, not 'unavailable'", () => {
    const lib = readFileSync(webapp("lib", "freeAi.js"), "utf8");
    expect(lib).toMatch(/"free-ai-too-long": TOO_LONG_MESSAGE/);
  });

  it("the settings entry is always listed, first, never removable, and says why it can't be used", async () => {
    const { freeAiCardHtml } = await load("views", "settings.js");
    const all = [
      freeAiCardHtml(null),
      freeAiCardHtml({ ...ok(), available: false, ended: true }),
      freeAiCardHtml(ok()),
      freeAiCardHtml(ok(), { isActive: true }),
      freeAiCardHtml(ok(SPENT)),
      freeAiCardHtml({ ...ok(), reason: "busy-today" }),
      freeAiCardHtml({ ...ok(), reason: "no-server" }),
      freeAiCardHtml({ ...ok(), available: false }),
    ];
    for (const html of all) {
      expect(html).toContain("Flagship Inference");
      expect(html).toContain("We use third-party providers and anonymize your requests.");
      expect(html).toMatch(/aria-label="Flagship Inference, built-in provider\. It can.{1,6}t be removed\."/);
      expect(html).not.toMatch(/data-action="remove"|>remove</);
      expect(html).not.toMatch(/\b(buy|purchase|upgrade|subscribe)\b/i);
    }
    const [unread, ended, left, active, spent, busy, noServer, off] = all as string[];
    expect(unread).toMatch(/available right now/);
    expect(unread).not.toContain('id="free-ai-use"');
    expect(ended).toContain("The free building period has ended");
    expect(ended).not.toContain('id="free-ai-use"');
    expect(left).toContain("This week: 340k of 500k left · Starter reserve: 1.2M");
    expect(left).toContain('id="free-ai-use"');
    expect(left).toContain(">use<");
    expect(left).not.toContain("free-ai-add-key");
    expect(active).toContain(">active<");
    expect(active).toMatch(/Used automatically when you build with AI and haven.{1,6}t added your own key\./);
    expect(spent).toContain("More arrive on Monday, or add your own AI key to keep building.");
    expect(spent).toContain('id="free-ai-add-key"');
    expect(spent).not.toContain('id="free-ai-use"');
    expect(busy).toContain("Free building is busy today. Try again tomorrow, or use your own AI key.");
    expect(noServer).toContain("start once one of your servers is running");
    expect(noServer).not.toContain("free-ai-add-key");
    expect(off).toMatch(/available right now/);
  });

  it("the key step lists Flagship Inference first, disabled with the reason, and skips itself for an owner with no saved key", async () => {
    const { freeAiRowState, freeAiRowHtml, shouldAutoUseFreeAi } = await load("views", "build-key.js");
    expect(freeAiRowState(ok())).toEqual({ kind: "use", text: "340k left this week · 1.2M reserve" });
    expect(freeAiRowState(ok(SPENT))?.kind).toBe("blocked");
    expect(freeAiRowState({ ...ok(), reason: "busy-today" })?.kind).toBe("blocked");
    expect(freeAiRowState({ ...ok(), available: false })?.kind).toBe("blocked");
    expect(freeAiRowState({ ...ok(), available: false, ended: true })).toEqual({
      kind: "blocked",
      text: "The free building period has ended — use your own AI key.",
    });
    expect(freeAiRowState(null)?.kind).toBe("blocked");
    const usable = freeAiRowHtml(freeAiRowState(ok()));
    expect(usable).toContain("<strong>Flagship Inference</strong>");
    expect(usable).toContain("We use third-party providers and anonymize your requests.");
    expect(usable).toContain('id="build-key-free-ai-use"');
    expect(usable).not.toContain("build-key-delete");
    expect(usable).not.toContain("Last used");
    expect(freeAiRowHtml(freeAiRowState(ok()), { lastUsed: true })).toContain("Last used");
    const ended = freeAiRowHtml(freeAiRowState({ ...ok(), ended: true }));
    expect(ended).toContain("The free building period has ended");
    expect(ended).not.toContain("build-key-free-ai-use");
    expect(ended).toMatch(/aria-label="Flagship Inference, built-in provider\. It can.{1,6}t be removed\."/);
    expect(shouldAutoUseFreeAi([], ok())).toBe(true);
    expect(shouldAutoUseFreeAi([{ id: "a" }], ok())).toBe(false);
    expect(shouldAutoUseFreeAi([], ok(SPENT))).toBe(false);
    expect(shouldAutoUseFreeAi([], { ...ok(), reason: "no-server" })).toBe(false);
    expect(shouldAutoUseFreeAi([], { ...ok(), ended: true })).toBe(false);
    expect(shouldAutoUseFreeAi([], null)).toBe(false);
  });

  it("builds refresh a free AI pass on every send and pass its model on start", async () => {
    const app = buildServer();
    const vibe = (await app.inject({ method: "GET", url: "/webapp/views/vibe-code.js" })).body;
    expect(vibe).toContain("buildCredential = await freshCredential(buildCredential, client().fqdn)");
    expect(vibe).toMatch(/isFreeAiCredential\(buildCredential\) && buildCredential\.model\) startBody\.model/);
    const { errorText } = await load("views", "vibe-code.js");
    expect(errorText(Object.assign(new Error("Your free AI credits are used up."), { code: "free-ai-used-up" }))).toBe(
      "Your free AI credits are used up.",
    );
  });

  it("the old phone-number claim is gone and nothing posts to the retired promo routes", async () => {
    const app = buildServer();
    const html = (await app.inject({ method: "GET", url: "/webapp/" })).body;
    expect(html).not.toContain('id="promo-issuance-form"');
    expect(html).toContain('id="free-ai-card"');
    for (const path of ["/webapp/views/settings.js", "/webapp/lib/freeAi.js", "/webapp/views/build-key.js"]) {
      const body = (await app.inject({ method: "GET", url: path })).body;
      expect(body).not.toContain("/api/llm-promo/issue");
      expect(body).not.toContain("/api/llm-promo/quota");
    }
    const lib = (await app.inject({ method: "GET", url: "/webapp/lib/freeAi.js" })).body;
    expect(lib).toContain("/api/free-ai/token");
    expect(lib).toContain("/api/free-ai/status");
    expect(lib).toContain("controlApex()");
  });
});
