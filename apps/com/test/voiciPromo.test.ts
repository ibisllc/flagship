/** GET /api/voici/promo (src/voiciPromo.ts): the optional promo line under the apps' one-time voi.ci intro. */
import { describe, expect, it } from "vitest";
import { route, type RouteEnv } from "../src/route.js";
import { voiciPromoFor } from "../src/voiciPromo.js";

const TEXTS = JSON.stringify({ en: "Set it up this week for a free month.", fr: "Un mois offert cette semaine.", "pt-BR": "Um mês grátis.", "zh-Hans": "本周免费一个月。" });

describe("voiciPromoFor", () => {
  it("is null when nothing is configured (the shipped default)", () => {
    expect(voiciPromoFor({}, null, "fr")).toBeNull();
    expect(voiciPromoFor({ VOICI_PROMO: "" }, null, "fr")).toBeNull();
    expect(voiciPromoFor({ VOICI_PROMO: "not json" }, null, "fr")).toBeNull();
    expect(voiciPromoFor({ VOICI_PROMO: "{}" }, null, null)).toBeNull();
  });

  it("picks ?lang= first, then Accept-Language, then English", () => {
    const env = { VOICI_PROMO: TEXTS };
    expect(voiciPromoFor(env, "fr", "de")?.text).toBe("Un mois offert cette semaine.");
    expect(voiciPromoFor(env, null, "fr-CA,fr;q=0.9")?.text).toBe("Un mois offert cette semaine.");
    expect(voiciPromoFor(env, "pt-BR", null)?.text).toBe("Um mês grátis.");
    expect(voiciPromoFor(env, null, "pt-PT")?.text).toBe("Um mês grátis.");
    expect(voiciPromoFor(env, null, "zh-CN")?.text).toBe("本周免费一个月。");
    expect(voiciPromoFor(env, null, "zh-TW")?.text).toBe("Set it up this week for a free month.");
    expect(voiciPromoFor(env, null, "de")?.text).toBe("Set it up this week for a free month.");
    expect(voiciPromoFor({ VOICI_PROMO: JSON.stringify({ fr: "x" }) }, null, "de")).toBeNull();
  });

  it("ends at VOICI_PROMO_UNTIL", () => {
    const env = { VOICI_PROMO: TEXTS, VOICI_PROMO_UNTIL: "2026-12-01T00:00:00Z" };
    expect(voiciPromoFor(env, null, null, Date.parse("2026-11-20T00:00:00Z"))).toEqual({ text: "Set it up this week for a free month.", until: "2026-12-01T00:00:00.000Z" });
    expect(voiciPromoFor(env, null, null, Date.parse("2026-12-02T00:00:00Z"))).toBeNull();
    expect(voiciPromoFor({ VOICI_PROMO: TEXTS }, null, null)?.until).toBeNull();
  });
});

describe("GET /api/voici/promo", () => {
  const call = (env: Record<string, string>, url: string, headers: Record<string, string> = {}) =>
    route(new Request(url, { headers }), { SERVICES_BASE_URL: "https://services.invalid", ...env } as unknown as RouteEnv, { waitUntil: () => {} });

  it("answers {promo: null} by default and the text when configured", async () => {
    const off = await call({ VOICI_ENABLED: "on" }, "https://flagshipserver.com/api/voici/promo");
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ promo: null });
    const on = await call({ VOICI_ENABLED: "on", VOICI_PROMO: TEXTS }, "https://flagshipserver.com/api/voici/promo?lang=fr");
    expect(await on.json()).toEqual({ promo: { text: "Un mois offert cette semaine.", until: null } });
    const header = await call({ VOICI_ENABLED: "on", VOICI_PROMO: TEXTS }, "https://flagshipserver.com/api/voici/promo", { "accept-language": "pt-BR" });
    expect(((await header.json()) as { promo: { text: string } }).promo.text).toBe("Um mês grátis.");
  });

  it("is 404 while voi.ci is off", async () => {
    const r = await call({ VOICI_ENABLED: "off", VOICI_PROMO: TEXTS }, "https://flagshipserver.com/api/voici/promo");
    expect(r.status).toBe(404);
  });
});
