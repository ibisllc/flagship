import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY_ENV, keyRedactor, loadKey, redactSecrets } from "../src/key.js";
import { BudgetGuard } from "../src/budget.js";
import { ShimHost } from "../src/shimHost.js";
import { callContext } from "../src/context.js";
import type { CallRecord } from "../src/accounting.js";

const KEY = "di-test-key-0123456789abcdef";

describe("loadKey", () => {
  it("prefers the environment, then the key file", () => {
    expect(loadKey({ [KEY_ENV]: ` ${KEY} ` }, () => "file-key-zzzzzzzz")).toEqual({ key: KEY, from: "env" });
    expect(loadKey({}, () => `${KEY}\n`)).toEqual({ key: KEY, from: "file" });
  });

  it("says where to put a key when there is none, without naming one", () => {
    const missing = loadKey({}, () => {
      throw new Error("ENOENT");
    }, "/home/x/.config/flagship/deepinfra-eval.key");
    expect(missing.key).toBeNull();
    expect("reason" in missing && missing.reason).toMatch(/DEEPINFRA_API_KEY.*deepinfra-eval\.key/);
    expect(loadKey({}, () => "  \n").key).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("masks the key, URL-encoded and base64 forms included", () => {
    const k = "sk/with+chars=0123456789";
    const text = `Bearer ${k} ${encodeURIComponent(k)} ${Buffer.from(k).toString("base64")}`;
    const out = redactSecrets(text, [k]);
    expect(out).not.toContain(k);
    expect(out).not.toContain(encodeURIComponent(k));
    expect(out).not.toContain(Buffer.from(k).toString("base64"));
    expect(out.match(/\[redacted\]/g)).toHaveLength(3);
  });

  it("leaves text alone for no key or a short one", () => {
    expect(keyRedactor(null)("abc")).toBe("abc");
    expect(redactSecrets("a short word", ["short"])).toBe("a short word");
  });
});

describe("the key on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is sent only to DeepInfra's API as a Bearer header, never into the shim, and is masked in errors", async () => {
    const seen: Array<{ url: string; auth?: string; body: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") ?? undefined, body: String(init?.body ?? "") });
      // A provider that echoes the key back in its error.
      return new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 });
    });
    const records: CallRecord[] = [];
    const host = new ShimHost({ upstream: "deepinfra", apiKey: KEY, guard: new BudgetGuard(1), redact: keyRedactor(KEY) });
    try {
      expect(JSON.stringify(host.env)).not.toContain(KEY);
      const cred = await host.credential();
      expect(cred.apiKey).not.toContain(KEY);
      const res = await callContext.run({ runId: "r1", step: "build", phase: "chat", record: (c) => records.push(c) }, () =>
        host.fetchLike("https://inference.build-eval.test/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cred.apiKey}` },
          body: JSON.stringify({ model: "low", messages: [{ role: "user", content: "hi" }] }),
        }),
      );
      // The shim answers in its own words, never the provider's.
      expect(await res.text()).not.toContain(KEY);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
      expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
      expect(seen[0]!.body).not.toContain(KEY);
      expect(JSON.parse(seen[0]!.body).model).toBe("Qwen/Qwen3.6-35B-A3B");
      expect(records).toHaveLength(1);
      expect(records[0]!.status).toBe(401);
      expect(records[0]!.error).toContain("[redacted]");
      expect(JSON.stringify(records)).not.toContain(KEY);
    } finally {
      host.close();
    }
  });
});
