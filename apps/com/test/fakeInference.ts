/** A Flagship Inference stand-in for `.com`'s own model calls (serviceInference.ts). */
export const INFERENCE_SECRET = "test-inference-secret";
export const INFERENCE_ENV = {
  FLAGSHIP_INFERENCE_ENDPOINT: JSON.stringify({ baseUrl: "https://inference.test", model: "flagship-free" }),
  FLAGSHIP_INFERENCE_TOKEN_SECRET: INFERENCE_SECRET,
};
export const INFERENCE_URL = "https://inference.test/v1/chat/completions";

/** An OpenAI-shaped chat answer whose text is `content` (an object is sent as JSON). */
export function chatAnswer(
  content: unknown,
  opts: { model?: string; finish?: string } = {},
): Response {
  return new Response(
    JSON.stringify({
      model: opts.model ?? "deepseek-ai/DeepSeek-V4-Flash",
      choices: [
        {
          finish_reason: opts.finish ?? "stop",
          message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
