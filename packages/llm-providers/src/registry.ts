import { anthropic, anthropicStreaming } from "./providers/anthropic.js";
import { openai, openaiStreaming } from "./providers/openai.js";
import { google, googleStreaming } from "./providers/google.js";
import { openrouter, openrouterStreaming } from "./providers/openrouter.js";
import { ollama } from "./providers/ollama.js";
import { flagship, flagshipStreaming } from "./providers/flagship.js";
import type { LLMProvider, StreamingLLMProvider } from "./types.js";

const builtins: LLMProvider[] = [anthropic, openai, google, openrouter, ollama, flagship];

// Only providers with a real streaming adapter. Ollama is intentionally
// excluded for now and falls back to the non-streaming `chat()` path.
const streamingBuiltins: StreamingLLMProvider[] = [
  anthropicStreaming,
  openaiStreaming,
  googleStreaming,
  openrouterStreaming,
  flagshipStreaming,
];

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  constructor(initial: LLMProvider[] = builtins) {
    for (const p of initial) this.register(p);
  }

  register(p: LLMProvider): void {
    this.providers.set(p.name, p);
  }

  get(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`unknown provider: ${name}`);
    return p;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export const defaultRegistry = new ProviderRegistry();

/**
 * Registry of streaming-capable providers. Mirrors `ProviderRegistry`
 * but keyed on `StreamingLLMProvider`. The harness resolves a streaming
 * adapter by provider name from this; `has()` lets a caller fall back to
 * the non-streaming `chat()` path when a provider has no streaming
 * adapter (ollama).
 */
export class StreamingProviderRegistry {
  private providers = new Map<string, StreamingLLMProvider>();

  constructor(initial: StreamingLLMProvider[] = streamingBuiltins) {
    for (const p of initial) this.register(p);
  }

  register(p: StreamingLLMProvider): void {
    this.providers.set(p.name, p);
  }

  get(name: string): StreamingLLMProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`unknown streaming provider: ${name}`);
    return p;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export const defaultStreamingRegistry = new StreamingProviderRegistry();
