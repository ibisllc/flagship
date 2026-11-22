/**
 * `.com` calling Flagship Inference for its own work (the adapter review and
 * the weekly adapter insight). No provider key: `.com` mints a short service
 * pass with FLAGSHIP_INFERENCE_TOKEN_SECRET and posts an OpenAI-shaped chat
 * request to the shim at FLAGSHIP_INFERENCE_ENDPOINT, which picks the
 * upstream and reports the usage back to `.com`, counted on the service's own
 * budget (control-plane inferenceService.ts). Unconfigured (either setting
 * missing) ⇒ null, and the callers skip the AI step as they did with no key.
 *
 * What a caller sends is the whole prompt: nothing about an account, a
 * server or a person is added here, and the shim strips anything else.
 */
import {
  SERVICE_MODELS,
  mintServiceInferenceToken,
  parseBlessedInferenceEndpoint,
  type InferenceService,
} from "@flagship/control-plane";

export interface ServiceInferenceEnv {
  FLAGSHIP_INFERENCE_ENDPOINT?: string;
  FLAGSHIP_INFERENCE_TOKEN_SECRET?: string;
}

export interface ServiceInference {
  chatUrl: string;
  secret: string;
}

export function serviceInferenceFrom(env: ServiceInferenceEnv): ServiceInference | null {
  const ep = parseBlessedInferenceEndpoint(env.FLAGSHIP_INFERENCE_ENDPOINT);
  if (!ep || !env.FLAGSHIP_INFERENCE_TOKEN_SECRET) return null;
  return { chatUrl: `${ep.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, secret: env.FLAGSHIP_INFERENCE_TOKEN_SECRET };
}

export type ServiceChatResult =
  | { ok: true; text: string; model: string | null; finished: boolean }
  | { ok: false; reason: string };

/** One JSON-answer chat call; any failure is `{ ok: false }`, never a throw. */
export async function serviceChat(
  si: ServiceInference,
  service: InferenceService,
  req: { system: string; user: string; maxTokens: number },
): Promise<ServiceChatResult> {
  try {
    const token = await mintServiceInferenceToken(service, si.secret);
    const res = await fetch(si.chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: SERVICE_MODELS[service],
        max_tokens: req.maxTokens,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `inference ${res.status}` };
    }
    const msg = (await res.json()) as {
      model?: unknown;
      choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
    };
    const choice = msg.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    return {
      ok: true,
      text,
      model: typeof msg.model === "string" ? msg.model : null,
      finished: choice?.finish_reason === "stop",
    };
  } catch {
    return { ok: false, reason: "inference unavailable" };
  }
}

/** The first JSON object in a model's answer, or null. */
export function jsonObjectIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
