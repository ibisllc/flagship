/**
 * Providers disagree on request parameters, and change their minds model by
 * model: OpenAI's reasoning models refuse `max_tokens` (they want
 * `max_completion_tokens`) and any non-default `temperature`, older or
 * third-party OpenAI-compatible servers don't know `max_completion_tokens`,
 * and every model caps its output tokens differently. Rather than keeping a
 * table of models that is always out of date, an adapter sends its usual
 * shape, reads the 400 a server answers with, fixes the parameter it names
 * and tries again. What a server taught us is remembered per endpoint and
 * model, so later calls go right the first time.
 */

const TOKEN_FIELDS = ["max_tokens", "max_completion_tokens"] as const;
/** Never dropped: without them the request means something else. */
const ESSENTIAL = new Set(["model", "messages", "tools", "stream", "system", "contents"]);
const MAX_ADJUSTMENTS = 4;

type Body = Record<string, unknown>;

type Lesson =
  | { kind: "rename"; from: string; to: string }
  | { kind: "drop"; key: string }
  | { kind: "cap"; key: string; max: number };

const lessons = new Map<string, Lesson[]>();

/** For tests. */
export function forgetRequestShapeLessons(): void {
  lessons.clear();
}

function applyLesson(body: Body, l: Lesson): Body {
  const out = { ...body };
  if (l.kind === "rename") {
    if (out[l.from] !== undefined) {
      out[l.to] = out[l.from];
      delete out[l.from];
    }
  } else if (l.kind === "drop") {
    delete out[l.key];
  } else if (typeof out[l.key] === "number" && (out[l.key] as number) > l.max) {
    out[l.key] = l.max;
  }
  return out;
}

interface ProviderErrorBody {
  message: string;
  param?: string;
}

function readError(text: string): ProviderErrorBody {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown; param?: unknown } | string; message?: unknown };
    const e = typeof j.error === "object" && j.error ? j.error : undefined;
    const message =
      (typeof e?.message === "string" && e.message) ||
      (typeof j.error === "string" && j.error) ||
      (typeof j.message === "string" && j.message) ||
      text;
    return { message, ...(typeof e?.param === "string" && e.param ? { param: e.param } : {}) };
  } catch {
    return { message: text };
  }
}

/** The body parameter a rejection is about, if it names one we sent. */
function rejectedParam(body: Body, err: ProviderErrorBody): string | null {
  if (err.param && err.param in body) return err.param;
  // Servers name either token field whichever one was sent.
  const sentTokenField = TOKEN_FIELDS.find((k) => body[k] !== undefined);
  if (sentTokenField && (TOKEN_FIELDS as readonly string[]).includes(err.param ?? "")) return sentTokenField;
  const keys = Object.keys(body).filter((k) => body[k] !== undefined).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (new RegExp(`(^|[^a-z_])${k}([^a-z_]|$)`, "i").test(err.message)) return k;
  }
  return null;
}

/**
 * How to change `body` so the server accepts it, judged from its rejection;
 * null when the rejection isn't about a parameter we can change.
 */
export function lessonFromRejection(body: Body, status: number, errorText: string): Lesson | null {
  if (status !== 400 && status !== 422) return null;
  const err = readError(errorText);
  const key = rejectedParam(body, err);
  if (!key || ESSENTIAL.has(key)) return null;
  const value = body[key];
  if ((TOKEN_FIELDS as readonly string[]).includes(key) && typeof value === "number") {
    const limit = tokenLimit(err.message, value);
    if (limit != null) return { kind: "cap", key, max: limit };
    const other = key === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    if (/unsupported|not supported|unrecognized|unknown|not allowed|extra|instead/i.test(err.message)) {
      return { kind: "rename", from: key, to: other };
    }
    return null;
  }
  if (/unsupported|not supported|unrecognized|unknown|not allowed|extra|only the default|does not support|cannot both|invalid/i.test(err.message)) {
    return { kind: "drop", key };
  }
  return null;
}

/** The output cap a "too many tokens" rejection states, below what we asked. */
function tokenLimit(message: string, asked: number): number | null {
  if (!/at most|maximum|max(imum)? allowed|too large|exceed|greater than|less than or equal|<=/i.test(message)) return null;
  const nums = [...message.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 256 && n < asked);
  return nums.length > 0 ? Math.max(...nums) : null;
}

/** The token field an OpenAI-compatible endpoint is sent first. */
export function openAiTokenField(baseUrl: string): (typeof TOKEN_FIELDS)[number] {
  try {
    return new URL(baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
  } catch {
    return "max_tokens";
  }
}

/**
 * Send `body`, adjusting and resending while the server rejects a parameter
 * it names. `send` posts one body and returns the response; the last
 * response (accepted or not) is returned.
 */
export async function sendAdapting<R extends { ok: boolean; status: number; text(): Promise<string> }>(
  endpointKey: string,
  body: Body,
  send: (body: Body) => Promise<R>,
): Promise<{ res: R; errorText?: string }> {
  const known = lessons.get(endpointKey) ?? [];
  let current = known.reduce(applyLesson, body);
  for (let i = 0; ; i++) {
    const res = await send(current);
    if (res.ok) return { res };
    const errorText = await res.text().catch(() => "");
    const lesson = i < MAX_ADJUSTMENTS ? lessonFromRejection(current, res.status, errorText) : null;
    if (!lesson) return { res, errorText };
    const next = applyLesson(current, lesson);
    if (JSON.stringify(next) === JSON.stringify(current)) return { res, errorText };
    lessons.set(endpointKey, [...(lessons.get(endpointKey) ?? []), lesson]);
    current = next;
  }
}
