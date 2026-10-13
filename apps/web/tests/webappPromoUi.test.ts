import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const webapp = (...p: string[]) => resolve(__dirname, "..", "public", "webapp", ...p);
const load = (...p: string[]) => import(pathToFileURL(webapp(...p)).href);

describe("webapp free AI credits", () => {
  it("formats token counts the way all three apps do", async () => {
    const { formatTokens, creditsLine } = await load("lib", "freeAi.js");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(820_000)).toBe("820k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(creditsLine({ remainingTokens: 820_000, allowanceTokens: 1_000_000 })).toBe(
      "820k of 1M free AI tokens left",
    );
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

  it("the settings card shows what's left, or the way to your own key", async () => {
    const { freeAiCardHtml } = await load("views", "settings.js");
    expect(freeAiCardHtml(null)).toBeNull();
    const left = freeAiCardHtml({ available: true, credits: { remainingTokens: 820_000, allowanceTokens: 1_000_000 } });
    expect(left).toContain("820k of 1M free AI tokens left");
    expect(left).toMatch(/Used automatically when you build with AI and haven.{1,6}t added your own key\./);
    expect(left).not.toContain("free-ai-add-key");
    const spent = freeAiCardHtml({ available: true, credits: { remainingTokens: 0, allowanceTokens: 1_000_000 } });
    expect(spent).toMatch(/used your free AI credits\. Add your own AI key to keep building\./);
    expect(spent).toContain('id="free-ai-add-key"');
    const off = freeAiCardHtml({ available: false, credits: { remainingTokens: 0, allowanceTokens: 0 } });
    expect(off).toMatch(/available right now/);
    expect(off).toContain('id="free-ai-add-key"');
    for (const html of [left, spent, off]) expect(html).not.toMatch(/\b(buy|purchase|upgrade|subscribe)\b/i);
  });

  it("the key step offers free AI first and skips itself for an owner with no saved key", async () => {
    const { freeAiRowState, shouldAutoUseFreeAi } = await load("views", "build-key.js");
    const some = { available: true, credits: { remainingTokens: 5000, allowanceTokens: 10_000 } };
    const none = { available: true, credits: { remainingTokens: 0, allowanceTokens: 10_000 } };
    expect(freeAiRowState(some)).toEqual({ kind: "use", text: "5k left" });
    expect(freeAiRowState(none)?.kind).toBe("spent");
    expect(freeAiRowState({ available: false, credits: some.credits })?.kind).toBe("unavailable");
    expect(freeAiRowState(null)).toBeNull();
    expect(shouldAutoUseFreeAi([], some)).toBe(true);
    expect(shouldAutoUseFreeAi([{ id: "a" }], some)).toBe(false);
    expect(shouldAutoUseFreeAi([], none)).toBe(false);
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
