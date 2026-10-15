import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const webapp = (...p: string[]) => resolve(__dirname, "..", "public", "webapp", ...p);
const load = (...p: string[]) => import(pathToFileURL(webapp(...p)).href);
const src = (...p: string[]) => readFileSync(webapp(...p), "utf8");

const CATALOG = {
  models: [
    { id: "low", tier: "Low", model: "Qwen3.6-35B-A3B", multiplier: 1, label: "Low 1× (Qwen3.6-35B-A3B)",
      descriptor: "Quick and thrifty. Handles most apps and reads screenshots.", contextTokens: 262144,
      modalities: ["text", "image"], reasoning: true, default: true },
    { id: "medium", tier: "Medium", model: "DeepSeek-V4-Flash", multiplier: 1, label: "Medium 1× (DeepSeek-V4-Flash)",
      descriptor: "A larger model with a 1M-token memory, for big apps. Text only.", contextTokens: 1048576,
      modalities: ["text"], reasoning: true, visionAlternative: "medium-vision" },
    { id: "medium-vision", tier: "Medium multimodal", model: "GLM-5.3-Flash", multiplier: 2,
      label: "Medium multimodal 2× (GLM-5.3-Flash)", descriptor: "Sees screenshots and sketches well.",
      contextTokens: 1048576, modalities: ["text", "image"], reasoning: true },
    { id: "plain", tier: "Plain", model: "Plain-1", multiplier: 3.5, label: "Plain 3.5× (Plain-1)", descriptor: "",
      contextTokens: 1000, modalities: ["text"], reasoning: false },
  ],
  defaultModel: "low",
  creditTokens: 1000,
  inputWeight: 1,
  outputWeight: 4,
};
const FLAGSHIP = { kind: "flagship", catalog: CATALOG };
const OWN = {
  kind: "own",
  listed: true,
  defaultModel: "gpt-5.4-mini",
  models: [
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", contextTokens: 400000, vision: true, tools: true,
      efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium", known: true },
    { id: "brand-new", label: "brand-new", vision: null, tools: null, known: false },
    { id: "qwen3-coder", label: "Qwen3 Coder", vision: false, tools: true, known: true, visionAlternative: "gpt-5.4-mini" },
    { id: "blind", label: "Blind", vision: false, tools: true, known: true },
  ],
};
const IMAGE = [{ kind: "image", mediaType: "image/png", dataBase64: "", name: "a.png" }];

describe("webapp model menu", () => {
  let mm: any;
  beforeEach(async () => {
    mm = await load("lib", "modelMenu.js");
    mm.clearModelMenuCache();
  });

  it("names models the way the contract says", () => {
    expect(mm.shortName(FLAGSHIP, "low")).toBe("Low 1×");
    expect(mm.shortName(FLAGSHIP, "medium-vision")).toBe("Medium multimodal 2×");
    expect(mm.shortName(OWN, "gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(mm.triggerText({ kind: "flagship", catalog: null }, {})).toBe("Flagship Inference");
    expect(["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(mm.effortLabel)).toEqual([
      "None", "Minimal", "Low", "Medium", "High", "Extra high", "Max",
    ]);
    expect(mm.multiplierText(2)).toBe("2×");
    expect(mm.multiplierText(3.5)).toBe("3.5×");
  });

  it("words the credits line with one decimal at most", () => {
    expect(mm.creditsUsedText(2.8)).toBe("used 2.8 credits");
    expect(mm.creditsUsedText(2.84)).toBe("used 2.8 credits");
    expect(mm.creditsUsedText(3)).toBe("used 3 credits");
    expect(mm.creditsUsedText(3.04)).toBe("used 3 credits");
    expect(mm.creditsUsedText(1)).toBe("used 1 credit");
    expect(mm.creditsUsedText(0.96)).toBe("used 1 credit");
  });

  it("starts on the saved default when the menu has it, else the menu's own", () => {
    expect(mm.initialChoice(FLAGSHIP, {})).toEqual({ model: "low", effort: null });
    expect(mm.initialChoice(FLAGSHIP, { model: "medium" }).model).toBe("medium");
    expect(mm.initialChoice(FLAGSHIP, { model: "gone" }).model).toBe("low");
    // A reasoning Flagship model offers no effort unless its catalog lists levels.
    expect(mm.initialChoice(FLAGSHIP, { model: "medium", effort: "high" }).effort).toBeNull();
    const withEfforts = { kind: "flagship", catalog: { ...CATALOG, models: [{ ...CATALOG.models[0], efforts: ["low", "high"], defaultEffort: "low" }] } };
    expect(mm.initialChoice(withEfforts, { model: "low", effort: "high" }).effort).toBe("high");
    expect(mm.initialChoice(withEfforts, { model: "low" }).effort).toBe("low");
    expect(mm.initialChoice({ kind: "flagship", catalog: null }, { model: "medium" }).model).toBeNull();
    expect(mm.initialChoice(OWN, {})).toEqual({ model: "gpt-5.4-mini", effort: "medium" });
    expect(mm.initialChoice(OWN, { model: "gpt-5.4-mini", effort: "xhigh" }).effort).toBe("xhigh");
    expect(mm.initialChoice(OWN, { model: "brand-new" })).toEqual({ model: "brand-new", effort: null });
    const unlisted = { kind: "own", listed: false, models: [], reason: "rejected", defaultModel: "gpt-5" };
    expect(mm.initialChoice(unlisted, {}).model).toBe("gpt-5");
    expect(mm.initialChoice(unlisted, { model: "o9" }).model).toBe("o9");
  });

  it("sends model and effort on start, and always says the effort on a reply", () => {
    const low = { model: "low", effort: null };
    expect(mm.wireChoice(FLAGSHIP, low)).toEqual({ model: "low" });
    expect(mm.wireChoice(FLAGSHIP, low, { reply: true })).toEqual({ model: "low", effort: null });
    expect(mm.wireChoice(FLAGSHIP, { ...low, effort: "high" }, { reply: true })).toEqual({ model: "low", effort: "high" });
    // Catalog unreadable ⇒ nothing sent; the box uses its default.
    expect(mm.wireChoice({ kind: "flagship", catalog: null }, low, { reply: true })).toEqual({});
    expect(mm.wireChoice(OWN, { model: "gpt-5.4-mini", effort: "high" })).toEqual({ model: "gpt-5.4-mini", effort: "high" });
    expect(mm.wireChoice(OWN, { model: "brand-new", effort: null }, { reply: true })).toEqual({ model: "brand-new", effort: null });
    expect(mm.wireChoice(null, low)).toEqual({});
  });

  it("picking another model resets the effort to that model's default", () => {
    expect(mm.withModel(OWN, { model: "brand-new", effort: null }, "gpt-5.4-mini")).toEqual({
      model: "gpt-5.4-mini", effort: "medium",
    });
    expect(mm.withModel(OWN, { model: "gpt-5.4-mini", effort: "high" }, "brand-new").effort).toBeNull();
    expect(mm.withModel(FLAGSHIP, { model: "low", effort: "high" }, "medium")).toEqual({ model: "medium", effort: null });
  });

  it("asks to switch before sending images to a model that can't see them, in the contract's words", () => {
    expect(mm.visionCheck(FLAGSHIP, { model: "low" }, IMAGE)).toEqual({ kind: "ok" });
    expect(mm.visionCheck(FLAGSHIP, { model: "medium" }, [])).toEqual({ kind: "ok" });
    expect(mm.visionCheck(FLAGSHIP, { model: "medium" }, IMAGE)).toEqual({
      kind: "switch", to: "medium-vision", message: "I'll have to switch to GLM-5.3-Flash (2×) for this.",
    });
    expect(mm.visionCheck(FLAGSHIP, { model: "plain" }, IMAGE)).toEqual({
      kind: "blocked", message: "Plain-1 can't see images. Remove them or pick another model.",
    });
    expect(mm.visionCheck(OWN, { model: "qwen3-coder" }, IMAGE)).toEqual({
      kind: "switch", to: "gpt-5.4-mini", message: "I'll have to switch to GPT-5.4 Mini for this.",
    });
    expect(mm.visionCheck(OWN, { model: "blind" }, IMAGE)).toEqual({
      kind: "blocked", message: "Blind can't see images. Remove them or pick another model.",
    });
    // Unknown vision ⇒ send as is.
    expect(mm.visionCheck(OWN, { model: "brand-new" }, IMAGE)).toEqual({ kind: "ok" });
  });

  it("classifies attachments by kind and refuses one over its limit, naming the limit", () => {
    const MB = 1024 * 1024;
    expect(mm.classifyFile({ name: "a.png", type: "image/png", size: 10 })).toEqual({ kind: "image", mediaType: "image/png" });
    expect(mm.classifyFile({ name: "a.JPG", type: "", size: 10 })).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(mm.classifyFile({ name: "a.pdf", type: "application/pdf", size: 10 })).toEqual({ kind: "document", mediaType: "application/pdf" });
    expect(mm.classifyFile({ name: "rows.csv", type: "text/csv", size: 10 })).toEqual({ kind: "data", mediaType: "text/csv" });
    expect(mm.classifyFile({ name: "rows.json", type: "", size: 10 })).toEqual({ kind: "data", mediaType: "application/json" });
    expect(mm.classifyFile({ name: "app.py", type: "", size: 10 })).toEqual({ kind: "text" });
    expect(mm.classifyFile({ name: "notes.md", type: "text/markdown", size: 10 })).toEqual({ kind: "text" });
    expect(mm.classifyFile({ name: "big.png", type: "image/png", size: 4 * MB + 1 }).error).toBe(
      '"big.png" is too big: images can be up to 4 MB.',
    );
    expect(mm.classifyFile({ name: "big.txt", type: "text/plain", size: 256 * 1024 + 1 }).error).toContain("256 KB");
    expect(mm.classifyFile({ name: "big.csv", type: "text/csv", size: 2 * MB + 1 }).error).toContain("2 MB");
    expect(mm.classifyFile({ name: "big.pdf", type: "application/pdf", size: 10 * MB + 1 }).error).toBe(
      '"big.pdf" is too big: PDFs can be up to 10 MB.',
    );
    expect(mm.classifyFile({ name: "ok.pdf", type: "application/pdf", size: 10 * MB }).kind).toBe("document");
    expect(mm.classifyFile({ name: "x.heic", type: "image/heic", size: 1 }).error).toMatch(/can't be attached/);
    expect(mm.classifyFile({ name: "app.zip", type: "application/zip", size: 1 }).error).toMatch(/can't be attached/);
  });

  it("tells the owner the AI sees attachments, and where sample data goes", () => {
    expect(mm.attachNotice([])).toEqual(["The AI will see what you attach."]);
    expect(mm.attachNotice([{ kind: "data" }])).toEqual([
      "The AI will see what you attach.",
      "Sample data goes only to the private test copy.",
    ]);
    expect(mm.dataTextError("a.json", "application/json", "{nope")).toBe('"a.json" isn\'t valid JSON.');
    expect(mm.dataTextError("a.json", "application/json", '{"ok":1}')).toBeNull();
    expect(mm.dataTextError("a.csv", "text/csv", "{nope")).toBeNull();
    expect(mm.attachmentIcon("data")).not.toBe(mm.attachmentIcon("document"));
  });

  it("lists labels with descriptors, marks unknown models, and falls back to a free-text field", () => {
    const flagship = mm.menuPanelHtml(FLAGSHIP, { model: "low" });
    expect(flagship).toContain("Low 1× (Qwen3.6-35B-A3B)");
    expect(flagship).toContain("Quick and thrifty.");
    expect(flagship).toMatch(/is-selected"[^>]*data-mm-model="low"/);
    const own = mm.menuPanelHtml(OWN, { model: "gpt-5.4-mini" });
    expect(own).toContain("GPT-5.4 Mini");
    expect(own).toContain("capabilities unknown");
    const refused = mm.menuPanelHtml({ kind: "own", listed: false, models: [], reason: "rejected", defaultModel: "gpt-5" }, {});
    expect(refused).toContain("data-mm-free");
    expect(refused).toContain('value="gpt-5"');
    expect(refused).toContain("The key was refused");
    expect(mm.menuPanelHtml({ kind: "own", listed: false, models: [], reason: "no-list" }, {})).not.toContain("refused");
    expect(mm.unknownNoteHtml(OWN, { model: "brand-new" })).toContain("capabilities unknown");
    expect(mm.unknownNoteHtml(OWN, { model: "gpt-5.4-mini" })).toBe("");
  });

  it("offers an effort picker only for a model that lists effort levels, Flagship Inference included", () => {
    const picker = mm.effortPickerHtml(OWN, { model: "gpt-5.4-mini", effort: "medium" });
    expect(picker).toContain(">Extra high<");
    expect(picker).toMatch(/value="medium" selected/);
    expect(mm.effortPickerHtml(OWN, { model: "brand-new" })).toBe("");
    // Reasoning alone offers nothing: no level is assumed for Flagship Inference.
    expect(mm.effortPickerHtml(FLAGSHIP, { model: "low" })).toBe("");
    const listed = { kind: "flagship", catalog: { ...CATALOG, models: [{ ...CATALOG.models[0], efforts: ["low", "high"] }] } };
    expect(mm.effortPickerHtml(listed, { model: "low", effort: "high" })).toMatch(/value="high" selected/);
    expect(mm.thinkHarderHtml).toBeUndefined();
    expect(src("lib", "modelMenu.js")).not.toContain("Think harder");
  });

  it("reads Flagship Inference's catalog from .com and an own key's list from the box once per key", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => CATALOG };
    };
    const menu = await mm.loadModelMenu({ provider: "flagship", apiKey: "pass", source: "promo" }, null, { fetchImpl });
    expect(menu.kind).toBe("flagship");
    expect(menu.catalog.defaultModel).toBe("low");
    expect(urls).toEqual(["https://flagshipserver.com/api/inference/models"]);
    await mm.loadModelMenu({ provider: "flagship", apiKey: "pass2" }, null, { fetchImpl });
    expect(urls).toHaveLength(1);

    const calls: Array<{ path: string; body: any }> = [];
    const boxFetch = async (path: string, init: any) => {
      calls.push({ path, body: JSON.parse(init.body) });
      return { provider: "openai", ...OWN };
    };
    const cred = { provider: "openai", apiKey: "sk-1", relay: true };
    const own = await mm.loadModelMenu(cred, boxFetch);
    expect(own.listed).toBe(true);
    expect(own.models).toHaveLength(4);
    await mm.loadModelMenu({ ...cred }, boxFetch);
    expect(calls).toEqual([{ path: "/api/screens/ai/models", body: { credential: cred } }]);
    // An older box without the endpoint: a free-text field.
    const failed = await mm.loadModelMenu({ provider: "anthropic", apiKey: "k" }, async () => {
      throw new Error("404");
    });
    expect(failed).toEqual({ kind: "own", listed: false, models: [], reason: "failed" });
    expect(await mm.loadModelMenu(null, boxFetch)).toBeNull();
  });

  it("the catalog being unreadable leaves just 'Flagship Inference'", async () => {
    const menu = await mm.loadModelMenu({ provider: "flagship" }, null, {
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    });
    expect(menu).toEqual({ kind: "flagship", catalog: null });
    expect(mm.menuPanelHtml(menu, {})).not.toContain("data-mm-model");
  });

  it("the attach input's accept list is the one the lib classifies", () => {
    const html = src("index.html");
    expect(html).toContain(`accept="${mm.ACCEPT}"`);
    expect(html).toContain('id="vc-attach-notice"');
    expect(html).toContain("The AI will see what you attach.");
    expect(html).toMatch(/PDF ≤ 10 MB/);
  });
});

describe("webapp build chat sends the choice", () => {
  it("rides start and every reply, checks vision first and shows credits", async () => {
    const vibe = src("views", "vibe-code.js");
    expect(vibe).toContain("Object.assign(startBody, wireChoice(currentMenu(), modelChoice))");
    expect(vibe).toContain("Object.assign(replyBody, wireChoice(currentMenu(), modelChoice, { reply: true }))");
    expect(vibe.match(/await checkVision\(attachments\)/g)).toHaveLength(2);
    expect(vibe).toContain('okLabel: "Switch", cancelLabel: "Cancel"');
    expect(vibe).not.toContain("flagship-free");
    expect(src("index.html")).toContain('id="vc-model-bar"');
    const { creditsMarkup } = await load("views", "vibe-code.js");
    expect(creditsMarkup({ role: "assistant", text: "hi", credits: 2.8 })).toContain("used 2.8 credits");
    expect(creditsMarkup({ role: "assistant", text: "hi" })).toBe("");
    expect(creditsMarkup({ role: "user", text: "hi", credits: 1 })).toBe("");
  });

  it("an edit starts on the saved default, not the pass's model", () => {
    const edit = src("views", "edit-service.js");
    expect(edit).toContain("Object.assign(body, await savedDefaultModel(credential))");
    expect(edit).not.toMatch(/credential\.model/);
  });
});

describe("webapp default model per provider", () => {
  it("keeps a saved key's default model and effort, and Flagship Inference's on the list", async () => {
    const { _testing, defaultModelFor } = await load("providers.js");
    const entry = { id: "e1", provider: "openai", label: "Work", apiKey: "sk-1", relay: true, defaultModel: "gpt-5.4-mini", defaultEffort: "high" };
    expect(_testing.isValidEntry(entry)).toBe(true);
    expect(_testing.isValidEntry({ ...entry, defaultEffort: 3 })).toBe(false);
    const list = { entries: [entry], activeId: "e1", flagshipDefaultModel: "medium" };
    expect(defaultModelFor(list, { provider: "openai", apiKey: "sk-1", relay: true })).toEqual({ model: "gpt-5.4-mini", effort: "high" });
    expect(defaultModelFor(list, { provider: "flagship", apiKey: "pass", source: "promo" })).toEqual({ model: "medium" });
    expect(defaultModelFor(list, { provider: "openai", apiKey: "other" })).toEqual({});
    expect(defaultModelFor(list, null)).toEqual({});
  });

  it("Settings shows a Default model menu for Flagship Inference and each saved key", async () => {
    const settings = src("views", "settings.js");
    expect(settings).toContain("mountFlagshipDefaultModel");
    expect(settings).toContain("mountEntryDefaultModel");
    expect(settings).toContain("setDefaultModel(session.umk, id");
    const { freeAiCardHtml, defaultModelSlot } = await load("views", "settings.js");
    expect(defaultModelSlot('id="x"')).toContain("Default model");
    const usable = { available: true, ended: false, reason: null, credits: { remainingTokens: 5000, remainingCredits: 5 } };
    expect(freeAiCardHtml(usable)).toContain('id="free-ai-default-model"');
    expect(freeAiCardHtml(null)).not.toContain('id="free-ai-default-model"');
  });
});
