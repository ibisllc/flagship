/**
 * Production `StreamingFetchLike` built on Node's global fetch. Splits the
 * response body into UTF-8 lines and yields them via async iteration —
 * the SSE-friendly shape every streaming adapter consumes.
 *
 * Adapters carry their own private copy of this for ergonomics, but the
 * harness wants ONE shared default it can hand to providers that don't
 * ship their own (openai/google emit a `no streaming fetch wired` error
 * when called without an impl). Exporting it here lets the daemon wire
 * every streaming provider uniformly in production.
 */

import type { StreamingFetchLike } from "./types.js";

export const defaultStreamingFetch: StreamingFetchLike = async (input, init) => {
  const f = globalThis.fetch as typeof globalThis.fetch;
  const r = await f(input, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  return {
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    lines: () => readLines(r.body),
  };
};

async function* readLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buf.length > 0) yield buf;
      return;
    }
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
}
