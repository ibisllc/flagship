// The build chat's model menu grouped by provider, switching provider in a
// chat, the context notice, and the composer of a chat that can continue
// (docs/build-modes.md "Continuing a chat").

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const webapp = (...p: string[]) => resolve(__dirname, "..", "public", "webapp", ...p);
const load = (...p: string[]) => import(pathToFileURL(webapp(...p)).href);
const src = (...p: string[]) => readFileSync(webapp(...p), "utf8");

const CATALOG = {
  models: [
    { id: "low", tier: "Low", model: "Qwen", multiplier: 1, label: "Low 1× (Qwen)", descriptor: "Quick.", contextTokens: 262144, modalities: ["text"], reasoning: true, default: true },
    { id: "small", tier: "Small", model: "Tiny", multiplier: 1, label: "Small 1× (Tiny)", descriptor: "", contextTokens: 32000, modalities: ["text"], reasoning: false },
  ],
  defaultModel: "low",
  creditTokens: 1000,
  inputWeight: 1,
  outputWeight: 4,
};
const FLAGSHIP_MENU = { kind: "flagship", catalog: CATALOG };
const OPENAI = { id: "k1", provider: "openai", label: "Work", apiKey: "sk-work", relay: true };
const ANTHROPIC = { id: "k2", provider: "anthropic", label: "Home", apiKey: "sk-ant", relay: false, baseUrl: "https://proxy.example" };
const OWN_MENU = {
  kind: "own",
  listed: true,
  models: [
    { id: "gpt-5.4", label: "GPT-5.4", contextTokens: 400000, vision: true, tools: true, efforts: ["low", "high"], defaultEffort: "low", known: true },
    { id: "gpt-tiny", label: "GPT Tiny", contextTokens: 16000, vision: false, tools: true, known: true },
  ],
};

describe("grouped model menu", () => {
  let mg: any;
  beforeEach(async () => {
    mg = await load("lib", "modelGroups.js");
  });

  it("lists Flagship Inference first when usable or in use, then every saved key", () => {
    const usable = mg.buildGroups({ entries: [OPENAI, ANTHROPIC], flagshipUsable: true, flagshipMenu: FLAGSHIP_MENU });
    expect(usable.map((g: any) => [g.id, g.title, g.kind])).toEqual([
      ["flagship", "Flagship Inference", "flagship"],
      ["k1", "openai · Work", "own"],
      ["k2", "anthropic · Home", "own"],
    ]);
    expect(mg.buildGroups({ entries: [OPENAI], flagshipUsable: false }).map((g: any) => g.id)).toEqual(["k1"]);
    // A chat on Flagship Inference keeps its group even when it can't be used now.
    expect(mg.buildGroups({ entries: [OPENAI], flagshipUsable: false, currentProvider: "flagship" }).map((g: any) => g.id)).toEqual(["flagship", "k1"]);
    // A key typed for this build but not saved still gets a group.
    const typed = mg.buildGroups({ entries: [OPENAI], unsaved: { provider: "google", apiKey: "g-1", relay: true } });
    expect(typed.map((g: any) => g.title)).toEqual(["openai · Work", "google · this key"]);
    expect(mg.buildGroups({ entries: [OPENAI], unsaved: { provider: "openai", apiKey: "sk-work" } })).toHaveLength(1);
  });

  it("finds a chat's group from the key it was given, or from the provider the box reports", () => {
    const groups = mg.buildGroups({ entries: [OPENAI, ANTHROPIC], flagshipUsable: true, flagshipMenu: FLAGSHIP_MENU });
    expect(mg.groupForCredential(groups, { provider: "anthropic", apiKey: "sk-ant", baseUrl: "https://proxy.example" })?.id).toBe("k2");
    expect(mg.groupForCredential(groups, { provider: "anthropic", apiKey: "other" })).toBeNull();
    expect(mg.groupForCredential(groups, { provider: "flagship", apiKey: "pass" })?.id).toBe("flagship");
    expect(mg.groupForProvider(groups, "openai")?.id).toBe("k1");
    expect(mg.groupForProvider(groups, "flagship")?.id).toBe("flagship");
    expect(mg.groupForProvider(groups, "google")).toBeNull();
  });

  it("offers effort only for a model that lists levels, Flagship Inference included", () => {
    expect(mg.effortOptions(OWN_MENU, "gpt-5.4")).toEqual(["low", "high"]);
    expect(mg.effortOptions(OWN_MENU, "gpt-tiny")).toEqual([]);
    expect(mg.effortOptions(FLAGSHIP_MENU, "low")).toEqual([]);
    const own = { id: "k1", kind: "own", entry: OPENAI, menu: OWN_MENU };
    expect(mg.groupedEffortHtml(own, { group: "k1", model: "gpt-5.4", effort: "high" })).toMatch(/value="high" selected/);
    expect(mg.groupedEffortHtml({ id: "flagship", kind: "flagship", menu: FLAGSHIP_MENU }, { model: "low" })).toBe("");
    // Picking a model takes its default effort.
    expect(mg.pickIn(own, "gpt-5.4")).toEqual({ group: "k1", model: "gpt-5.4", effort: "low" });
    expect(mg.pickIn(own, "gpt-tiny")).toEqual({ group: "k1", model: "gpt-tiny", effort: null });
  });

  it("names the choice with the key it uses", () => {
    const own = { id: "k1", kind: "own", entry: OPENAI, menu: OWN_MENU };
    expect(mg.groupedTriggerText(own, { model: "gpt-5.4" })).toBe("GPT-5.4 · Work");
    expect(mg.groupedTriggerText({ id: "flagship", kind: "flagship", menu: FLAGSHIP_MENU }, { model: "low" })).toBe("Low 1×");
    expect(mg.groupedTriggerText(null, {})).toBe("Choose a model");
  });

  it("shows each group's title and models in the panel, with a way to type a model for a key with no list", () => {
    const groups = [
      { id: "flagship", title: "Flagship Inference", kind: "flagship", menu: FLAGSHIP_MENU },
      { id: "k1", title: "openai · Work", kind: "own", entry: OPENAI, menu: OWN_MENU },
      { id: "k2", title: "anthropic · Home", kind: "own", entry: ANTHROPIC, menu: { kind: "own", listed: false, models: [], reason: "rejected" } },
      { id: "k3", title: "google · Lab", kind: "own", entry: OPENAI, menu: null },
    ];
    const html = mg.groupedPanelHtml(groups, { group: "k1", model: "gpt-5.4" });
    expect(html.indexOf("Flagship Inference")).toBeLessThan(html.indexOf("openai · Work"));
    expect(html).toMatch(/is-selected"[^>]*data-mm-model="gpt-5.4" data-mm-group="k1"/);
    // The same model id in another group isn't selected.
    expect(html).not.toMatch(/is-selected"[^>]*data-mm-group="flagship"/);
    expect(html).toContain('data-mm-free data-mm-group="k2"');
    expect(html).toContain("The key was refused");
    expect(html).toContain("Loading models…");
    expect(mg.groupedPanelHtml([], {})).toContain("Add an AI key");
  });

  it("says when a switch may drop older context, at the box's compaction threshold", () => {
    expect(mg.mayDropContext(10_000, 32_000)).toBe(false);
    // 32k context: (32000 - 8000) × 0.75 = 18,000.
    expect(mg.mayDropContext(18_001, 32_000)).toBe(true);
    expect(mg.mayDropContext(18_000, 32_000)).toBe(false);
    // 400k context: (400000 - 16000) × 0.75 = 288,000.
    expect(mg.mayDropContext(200_000, 400_000)).toBe(false);
    expect(mg.mayDropContext(undefined, 32_000)).toBe(false);
    expect(mg.mayDropContext(50_000, undefined)).toBe(false);
    const base = { menu: OWN_MENU, sessionModel: "gpt-5.4", conversationTokens: 20_000 };
    expect(mg.contextNotice({ ...base, choice: { model: "gpt-tiny" } })).toBe("Older messages will be summarised to fit this model.");
    expect(mg.contextNotice({ ...base, choice: { model: "gpt-5.4" } })).toBeNull();
    expect(mg.contextNotice({ ...base, conversationTokens: 1_000, choice: { model: "gpt-tiny" } })).toBeNull();
  });

  it("sends a key only when it changes or the box has none; a Flagship pass every time", async () => {
    const own = { id: "k1", kind: "own", entry: OPENAI, menu: OWN_MENU };
    expect(await mg.credentialForMessage(own, {})).toBeNull();
    expect(await mg.credentialForMessage(own, { picked: true })).toEqual({ provider: "openai", apiKey: "sk-work", relay: true });
    expect(await mg.credentialForMessage(own, { needsCredential: true })).not.toBeNull();
    expect(await mg.credentialForMessage(own, { starting: true })).not.toBeNull();
    const k2 = { id: "k2", kind: "own", entry: ANTHROPIC, menu: null };
    expect(await mg.credentialForMessage(k2, { picked: true })).toEqual({
      provider: "anthropic", apiKey: "sk-ant", baseUrl: "https://proxy.example", relay: false,
    });
    let minted = 0;
    const flagship = { id: "flagship", kind: "flagship", menu: FLAGSHIP_MENU };
    const mintFlagship = async () => ({ provider: "flagship", apiKey: `pass-${++minted}`, source: "promo" });
    expect((await mg.credentialForMessage(flagship, { mintFlagship }))?.apiKey).toBe("pass-1");
    expect((await mg.credentialForMessage(flagship, { mintFlagship }))?.apiKey).toBe("pass-2");
    expect(await mg.credentialForMessage(null, { picked: true })).toBeNull();
  });
});

describe("build chat composer and wiring", () => {
  it("takes a message when the AI asks, or when the chat is ready to deploy or failed", async () => {
    const { composerMode } = await load("views", "vibe-code.js");
    expect(composerMode({ status: "awaiting-tool-response", pendingRequest: { kind: "talkToUser" } })).toEqual({ enabled: true, placeholder: "Reply to the AI…" });
    expect(composerMode({ status: "ready-to-deploy", canContinue: true })).toEqual({ enabled: true, placeholder: "Ask for a change…" });
    expect(composerMode({ status: "failed", canContinue: true })).toEqual({ enabled: true, placeholder: "Tell the AI what to try next…" });
    // An older box doesn't say it can continue: only answers go through.
    expect(composerMode({ status: "ready-to-deploy" }).enabled).toBe(false);
    for (const status of ["streaming", "deploying", "deployed", "cancelled"]) {
      expect(composerMode({ status, canContinue: false }).enabled).toBe(false);
    }
  });

  it("the chat uses the grouped menu, and the shell precaches it", () => {
    const vibe = src("views", "vibe-code.js");
    expect(vibe).toContain("mountGroupedModelMenu(bar,");
    expect(vibe).toContain("picked: group.id !== boxGroupId");
    expect(vibe).not.toContain("thinkHarder");
    expect(src("service-worker.js")).toContain('"/lib/modelGroups.js"');
    expect(src("style.css")).toContain(".mm-context");
  });
});
