// The webapp's screens for app chat requests (lib/chatAlerts.js) and the AI-run consent
// (lib/aiConsentUi.js): what the box's answers become, what is signed, and that a declined run sends
// nothing more.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
// @ts-expect-error — plain-JS webapp module, no types
import { ScreensError } from "../public/webapp/lib/api.js";

const load = (rel: string) => import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);

const SEED = new Uint8Array(32).fill(7);
const PUB = ed25519.getPublicKey(SEED);
const sign = async (b: Uint8Array) => ed25519.sign(b, SEED);
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const ESTIMATE = { provider: "openai", source: "byok", operation: "adapt", lowTokens: 9000, highTokens: 54000, unit: "tokens" };
const BUILD = "0123456789abcdef";

describe("AI-run consent", () => {
  it("reads the box's estimate only from an ai-consent refusal", async () => {
    const { consentEstimate } = await load("lib/aiConsentUi.js");
    expect(consentEstimate(new ScreensError("x", 428, { code: "ai-consent", estimate: ESTIMATE }))).toMatchObject({ provider: "openai", highTokens: 54000 });
    expect(consentEstimate(new ScreensError("x", 428, { code: "other", estimate: ESTIMATE }))).toBeNull();
    expect(consentEstimate(new ScreensError("x", 500, { code: "ai-consent", estimate: ESTIMATE }))).toBeNull();
    expect(consentEstimate(new ScreensError("x", 428, { code: "ai-consent", estimate: { ...ESTIMATE, source: "free" } }))).toBeNull();
  });

  it("says who pays and that the range is an estimate", async () => {
    const { consentText } = await load("lib/aiConsentUi.js");
    const byok = consentText(ESTIMATE);
    expect(byok.payer).toBe("OpenAI runs it with your own API key, so OpenAI bills you for it.");
    expect(byok.range).toContain("not a limit");
    expect(consentText({ ...ESTIMATE, provider: "flagship", source: "promo" }).payer).toContain("free Flagship Inference credits");
  });

  it("on Continue resends once with a consent signed over the estimate", async () => {
    const { withAiConsent } = await load("lib/aiConsentUi.js");
    const { canonicalAiRepairConsent } = await load("lib/aiRepairConsent.js");
    const sent: unknown[] = [];
    const send = vi.fn(async (consent?: unknown) => {
      sent.push(consent);
      if (!consent) throw new ScreensError("consent-required", 428, { code: "ai-consent", estimate: ESTIMATE });
      return { ok: true, started: true };
    });
    const ask = vi.fn(async () => true);
    const r = await withAiConsent({ send, serverDomain: "Home.Smoketest.Flagship.Services", buildId: BUILD, sign, ask, now: () => 1_700_000_000_000 });
    expect(r).toEqual({ ok: true, started: true });
    expect(ask).toHaveBeenCalledTimes(1);
    const c = sent[1] as { issuedAt: number; provider: string; source: string; highTokens: number; signature: string };
    expect(c).toMatchObject({ issuedAt: 1_700_000_000_000, provider: "openai", source: "byok", highTokens: 54000 });
    const bytes = canonicalAiRepairConsent({ serverDomain: "home.smoketest.flagship.services", buildId: BUILD, operation: "adapt", provider: "openai", source: "byok", highTokens: 54000, issuedAt: c.issuedAt });
    expect(ed25519.verify(hex(c.signature), bytes, PUB)).toBe(true);
  });

  it("on Cancel sends nothing more and says so", async () => {
    const { withAiConsent } = await load("lib/aiConsentUi.js");
    const send = vi.fn(async () => {
      throw new ScreensError("consent-required", 428, { code: "ai-consent", estimate: ESTIMATE });
    });
    expect(await withAiConsent({ send, serverDomain: "h", buildId: BUILD, sign, ask: async () => false })).toEqual({ cancelled: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks again with the box's reason when the estimate grew, and passes other errors through", async () => {
    const { withAiConsent } = await load("lib/aiConsentUi.js");
    let n = 0;
    const send = vi.fn(async () => {
      n++;
      if (n === 1) throw new ScreensError("x", 428, { code: "ai-consent", estimate: ESTIMATE });
      if (n === 2) throw new ScreensError("x", 403, { error: "the estimate grew since you agreed", code: "ai-consent", estimate: { ...ESTIMATE, highTokens: 60000 } });
      return { ok: true };
    });
    const notes: string[] = [];
    await withAiConsent({ send, serverDomain: "h", buildId: BUILD, sign, ask: async (_e: unknown, o: { note: string }) => (notes.push(o.note), true) });
    expect(notes).toEqual(["", "the estimate grew since you agreed"]);
    const boom = new ScreensError("nope", 503, { error: "no model" });
    await expect(withAiConsent({ send: async () => { throw boom; }, serverDomain: "h", buildId: BUILD, sign, ask: async () => true })).rejects.toBe(boom);
  });

  it("a declined adapt ends startAndFollowAdapt with nothing to follow", async () => {
    const { startAndFollowAdapt } = await load("lib/gitImport.js");
    const follow = vi.fn();
    expect(await startAndFollowAdapt({ start: async () => ({ cancelled: true }), follow })).toEqual({ phase: "cancelled", cancelled: true });
    expect(follow).not.toHaveBeenCalled();
  });
});

describe("app chat requests", () => {
  const BODY = {
    requests: [
      { requestId: "r1", kind: "incoming", claimedSender: { author: "alice", slug: "chess" }, receiverApp: { author: "smoketest", slug: "notes" }, phrase: "blue fox", count: 3, at: 5 },
      { requestId: "r2", kind: "outgoing", claimedSender: { author: "smoketest", slug: "notes" }, receiverApp: { author: "bob", slug: "board" }, count: 1, at: 6 },
      { requestId: "", kind: "incoming", claimedSender: { author: "x", slug: "y" }, receiverApp: { author: "a", slug: "b" } },
    ],
    always: [{ author: "smoketest", slug: "notes" }, { author: "bad|name", slug: "x" }],
  };

  it("keeps well-formed requests and Always allows", async () => {
    const { readChatRequests } = await load("lib/chatAlerts.js");
    const { requests, always } = readChatRequests(BODY);
    expect(requests.map((r: { requestId: string }) => r.requestId)).toEqual(["r1", "r2"]);
    expect(always).toEqual([{ author: "smoketest", slug: "notes" }]);
  });

  it("says the sender's name is a claim", async () => {
    const { readChatRequests, chatRequestTitle, chatRequestNotes } = await load("lib/chatAlerts.js");
    const [incoming, outgoing] = readChatRequests(BODY).requests;
    expect(chatRequestTitle(incoming)).toBe("A remote machine claiming to run alice/chess wants to start a chat with your app notes.");
    expect(chatRequestNotes(incoming)).toEqual([
      "Flagship can't confirm who runs that machine. Only allow it if you expected this app to get in touch.",
      "The sender's recognition phrase: blue fox",
      "It asked 3 times.",
    ]);
    expect(chatRequestTitle(outgoing)).toBe("Your app notes wants to start a chat with bob/board, an app on another owner's server.");
  });

  it("collects every server's requests, tagged, and skips one that fails", async () => {
    const { fetchChatOnServers } = await load("lib/chatAlerts.js");
    const r = await fetchChatOnServers([
      { fqdn: "home.x", fetchJson: async () => BODY },
      { fqdn: "office.x", fetchJson: async () => { throw new Error("down"); } },
    ]);
    expect(r.requests.map((q: { serverDomain: string }) => q.serverDomain)).toEqual(["home.x", "home.x"]);
    expect(r.always[0]).toMatchObject({ serverDomain: "home.x", slug: "notes" });
  });
});
