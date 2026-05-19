import type { ChatRequest, ChatResponse, FetchLike, LLMProvider, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";

const DEFAULT_BASE = "https://openrouter.ai/api";

export const openrouter: LLMProvider = {
  name: "openrouter",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }
    const res = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
        "x-title": "Flagship",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError("openrouter", res.status, await res.text());
    const data = (await res.json()) as {
      choices: {
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }[];
      model: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices[0];
    if (!choice) throw new ProviderError("openrouter", 200, "no choices in response");
    const toolUses = (choice.message.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c) => {
        let input: Record<string, unknown> = {};
        const s = c.function?.arguments ?? "";
        if (s) {
          try {
            const obj = JSON.parse(s);
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              input = obj as Record<string, unknown>;
            }
          } catch {
            // ignored; orchestrator can reject
          }
        }
        return { id: c.id, name: c.function!.name!, input };
      });
    return {
      content: choice.message.content ?? "",
      model: data.model,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      stopReason: choice.finish_reason,
      raw: data,
      toolUses: toolUses.length > 0 ? toolUses : undefined,
    };
  },
};
