import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetGuard } from "../src/budget.js";
import { callContext } from "../src/context.js";
import { ShimHost, withModelThinking } from "../src/shimHost.js";

const KEY = "di-test-key-0123456789abcdef";

/** One call through the in-process shim; returns the body DeepInfra received. */
async function sent(model: string, opts: { modelThinking?: boolean; ask?: Record<string, unknown> } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  const host = new ShimHost({ upstream: "deepinfra", apiKey: KEY, guard: new BudgetGuard(1), redact: (s) => s, ...opts });
  try {
    const cred = await host.credential();
    await callContext.run({ runId: "r1", step: "build", phase: "chat", record: () => {} }, () =>
      host.fetchLike("https://inference.build-eval.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cred.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...opts.ask }),
      }),
    );
  } finally {
    host.close();
    vi.unstubAllGlobals();
  }
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("thinking through the harness's shim", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reaches DeepInfra off, with each model's own switch and output cap, whatever the box asked", async () => {
    const low = await sent("low", { ask: { reasoning_effort: "high" } });
    expect(low).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, max_tokens: 32_768 });
    expect(low.reasoning_effort).toBeUndefined();
    const high = await sent("high");
    expect(high).toMatchObject({ reasoning_effort: "none", max_tokens: 24_576 });
  });

  it("--model-thinking strips the switch, leaving the model's default", async () => {
    const low = await sent("low", { modelThinking: true });
    expect(low.chat_template_kwargs).toBeUndefined();
    expect(low.reasoning_effort).toBeUndefined();
    expect(low.max_tokens).toBe(32_768);
    expect(JSON.parse(withModelThinking(JSON.stringify({ a: 1, reasoning: { effort: "none" } })))).toEqual({ a: 1 });
  });
});
