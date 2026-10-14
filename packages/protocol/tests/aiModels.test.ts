import { describe, expect, it } from "vitest";
import {
  buildCapabilityIndex,
  capabilityFromOpenRouter,
  findCapability,
  modelKey,
  modelOptions,
  type ModelCapability,
} from "../src/aiModels.js";

const OR_ROWS = [
  {
    id: "openai/gpt-5.4-mini",
    name: "OpenAI: GPT-5.4 Mini",
    context_length: 400000,
    architecture: { input_modalities: ["file", "image", "text"] },
    pricing: { prompt: "0.00000075", completion: "0.0000045" },
    top_provider: { max_completion_tokens: 128000 },
    supported_parameters: ["tools", "reasoning", "reasoning_effort"],
    reasoning: { supported_efforts: ["xhigh", "high", "medium", "low", "none"], default_effort: "medium", mandatory: false },
  },
  {
    id: "openai/gpt-3.5-turbo-instruct",
    name: "instruct",
    context_length: 4095,
    architecture: { input_modalities: ["text"] },
    pricing: { prompt: "0.0000015", completion: "0.000002" },
    supported_parameters: ["max_tokens"],
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Anthropic: Claude Opus 4.8",
    context_length: 1000000,
    architecture: { input_modalities: ["text", "image", "file"] },
    pricing: { prompt: "0.000005", completion: "0.000025" },
    supported_parameters: ["tools", "reasoning"],
    reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high", mandatory: true },
  },
  {
    id: "qwen/qwen3.6-35b-a3b",
    hugging_face_id: "Qwen/Qwen3.6-35B-A3B",
    name: "Qwen: Qwen3.6 35B A3B",
    context_length: 262144,
    architecture: { input_modalities: ["text", "image", "video"] },
    pricing: { prompt: "0.0000001", completion: "0.00000095" },
    supported_parameters: ["tools", "reasoning"],
    reasoning: { mandatory: false, default_enabled: true },
  },
  {
    id: "qwen/qwen3-coder",
    name: "Qwen3 Coder",
    context_length: 262144,
    architecture: { input_modalities: ["text"] },
    pricing: { prompt: "0.0000003", completion: "0.000001" },
    supported_parameters: ["tools"],
  },
  { id: "openai/gpt-5.4-mini:batch", name: "batch", context_length: 1, supported_parameters: [] },
  { id: "~unbiased/pareto-latest", name: "router" },
];

const rows = OR_ROWS.map(capabilityFromOpenRouter).filter((r): r is ModelCapability => r !== null);
const index = buildCapabilityIndex(rows);

describe("the capability table from OpenRouter's catalog", () => {
  it("keeps context, image input, tools, efforts in order, and prices per million", () => {
    const mini = rows.find((r) => r.id === "openai/gpt-5.4-mini")!;
    expect(mini).toEqual({
      id: "openai/gpt-5.4-mini",
      name: "OpenAI: GPT-5.4 Mini",
      contextTokens: 400000,
      maxOutputTokens: 128000,
      input: ["file", "image", "text"],
      tools: true,
      reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      priceIn: 0.75,
      priceOut: 4.5,
    });
    expect(rows.find((r) => r.id.startsWith("qwen/qwen3.6"))!.reasoning).toEqual({});
  });

  it("drops variants and routers", () => {
    expect(rows.map((r) => r.id)).not.toContain("openai/gpt-5.4-mini:batch");
    expect(rows.map((r) => r.id)).not.toContain("~unbiased/pareto-latest");
  });
});

describe("matching a provider's model id", () => {
  it("normalises dates, dots and prefixes", () => {
    expect(modelKey("claude-opus-4-8-20260101")).toBe("claude-opus-4-8");
    expect(modelKey("models/gemini-3.5-flash")).toBe("gemini-3-5-flash");
    expect(modelKey("gpt-5.4-mini-2026-03-17")).toBe("gpt-5-4-mini");
  });

  it("OpenAI, Anthropic and OpenRouter ids", () => {
    expect(findCapability(index, "openai", "gpt-5.4-mini-2026-03-17")?.id).toBe("openai/gpt-5.4-mini");
    expect(findCapability(index, "anthropic", "claude-opus-4-8")?.id).toBe("anthropic/claude-opus-4.8");
    expect(findCapability(index, "openrouter", "qwen/qwen3.6-35b-a3b")?.id).toBe("qwen/qwen3.6-35b-a3b");
    expect(findCapability(index, "openai", "claude-opus-4-8")).toBeNull();
  });

  it("another OpenAI-compatible host matches by Hugging Face id or bare name", () => {
    expect(findCapability(index, "openai-compatible", "Qwen/Qwen3.6-35B-A3B")?.id).toBe("qwen/qwen3.6-35b-a3b");
    expect(findCapability(index, "ollama", "qwen3-coder:latest")?.id).toBe("qwen/qwen3-coder");
    expect(findCapability(index, "ollama", "mystery-model")).toBeNull();
  });
});

describe("an own-key menu", () => {
  it("offers known tool-calling models with their efforts, unknown ones flagged, and drops the rest", () => {
    const opts = modelOptions(
      "openrouter",
      [
        { id: "openai/gpt-5.4-mini" },
        { id: "openai/gpt-3.5-turbo-instruct" },
        { id: "qwen/qwen3-coder" },
        { id: "someone/brand-new-model", name: "Brand New" },
        { id: "openai/text-embedding-3-small" },
      ],
      index,
    );
    expect(opts.map((o) => o.id)).toEqual(["openai/gpt-5.4-mini", "qwen/qwen3-coder", "someone/brand-new-model"]);
    expect(opts[0]).toMatchObject({ vision: true, tools: true, efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium", known: true });
    expect(opts[2]).toMatchObject({ label: "Brand New", vision: null, known: false });
    expect(opts[2]!.efforts).toBeUndefined();
  });

  it("names a vision model to switch to for a text-only one", () => {
    const opts = modelOptions("openrouter", [{ id: "qwen/qwen3-coder" }, { id: "qwen/qwen3.6-35b-a3b" }, { id: "openai/gpt-5.4-mini" }], index);
    // Qwen3 Coder costs more than Qwen3.6 on this mix, so the next vision model up is GPT-5.4 Mini.
    expect(opts.find((o) => o.id === "qwen/qwen3-coder")!.visionAlternative).toBe("openai/gpt-5.4-mini");
    expect(opts.find((o) => o.id === "openai/gpt-5.4-mini")!.visionAlternative).toBeUndefined();
  });
});
