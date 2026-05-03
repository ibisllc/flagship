import { anthropic } from "./providers/anthropic.js";
import { openai } from "./providers/openai.js";
import { google } from "./providers/google.js";
import { openrouter } from "./providers/openrouter.js";
import { ollama } from "./providers/ollama.js";
import type { LLMProvider } from "./types.js";

const builtins: LLMProvider[] = [anthropic, openai, google, openrouter, ollama];

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
