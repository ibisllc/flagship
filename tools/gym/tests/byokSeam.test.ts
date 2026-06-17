/**
 * BYOK seam tests (§2.1 Layer 2) — the short-AI judge/navigator adapter.
 *
 * Everything here runs with a MOCKED fetch (the `GymFetch` constructor seam) and
 * a temp screenshot file — NO real network, NO real API key. The tests pin the
 * two things that matter: (1) a well-formed provider reply maps to advisory
 * findings, and (2) the IRON RULE — every failure shape (a thrown fetch, a 500,
 * a garbage body, a wrong-typed reply) degrades to `[]` / `{findings:[]}` and
 * NEVER throws into the gate. Plus the env/switch contract.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ByokJudge,
  ByokNavigator,
  byokConfigFromEnv,
  resolveAiHooks,
  type ByokConfig,
  type GymFetch,
} from "../src/ai/byokSeam.js";
import type { JudgeContext, NavigateContext } from "../src/ai/hooks.js";

const CONFIG: ByokConfig = { provider: "anthropic", apiKey: "sk-test-NOT-REAL", model: "claude-sonnet-4-6" };

/** A mock fetch that returns a 200 Anthropic Messages body wrapping `text`. */
function okFetchWithText(text: string): GymFetch {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content: [{ type: "text", text }] }),
  });
}

/** A mock fetch returning a 200 OpenAI Chat Completions body wrapping `text`. */
function okOpenAiFetch(text: string): GymFetch {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
  });
}

/** A mock fetch that returns a non-2xx (e.g. 500). */
function statusFetch(status: number): GymFetch {
  return async () => ({ ok: false, status, text: async () => "boom" });
}

/** A mock fetch that THROWS (network down / DNS / abort). */
const throwingFetch: GymFetch = async () => {
  throw new Error("network down");
};

/** A mock fetch returning a 200 with an unparseable (non-JSON) body. */
const garbageBodyFetch: GymFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => "<html>not json</html>",
});

/** Make a tiny temp PNG file so the judge's screenshot read succeeds. */
function makeScreenshot(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gym-byok-"));
  const path = join(dir, "shot.png");
  // A 1x1 PNG (header + minimal IDAT) — content is irrelevant; only that it reads.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000a49444154789c6360000002000154a24f9b0000000049454e44ae426082",
    "hex",
  );
  writeFileSync(path, png);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const judgeCtx = (screenshotPath: string): JudgeContext => ({
  scenarioId: "web-x",
  point: "home-empty",
  screenshotPath,
  goal: "home renders the empty state",
});

const navCtx: NavigateContext = {
  scenarioId: "web-x",
  goal: "open settings",
  missingHandle: "#settings-old",
  currentTree: "<button id='settings-new'>Settings</button>",
};

describe("ByokJudge — happy path maps a well-formed reply to findings", () => {
  it("maps a JSON findings array (incl. a fenced block) to advisory judge findings", async () => {
    const shot = makeScreenshot();
    try {
      const reply =
        "Here is my review:\n```json\n" +
        JSON.stringify([
          { severity: "warn", message: "Primary button contrast is low on the teal." },
          { severity: "info", message: "Spacing between the cards is a touch tight." },
        ]) +
        "\n```";
      const judge = new ByokJudge(CONFIG, okFetchWithText(reply));
      const findings = await judge.judge(judgeCtx(shot.path));
      expect(findings).toHaveLength(2);
      expect(findings[0]).toMatchObject({
        role: "judge",
        severity: "warn",
        scenarioId: "web-x",
        point: "home-empty",
      });
      expect(findings[0]!.message).toContain("contrast");
      expect(findings[1]!.severity).toBe("info");
    } finally {
      shot.cleanup();
    }
  });

  it("an empty findings array (the screen looks good) yields no findings", async () => {
    const shot = makeScreenshot();
    try {
      const judge = new ByokJudge(CONFIG, okFetchWithText("[]"));
      const findings = await judge.judge(judgeCtx(shot.path));
      expect(findings).toEqual([]);
    } finally {
      shot.cleanup();
    }
  });

  it("sends the API key in the x-api-key header to <base>/v1/messages, never logged", async () => {
    const shot = makeScreenshot();
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const spyFetch: GymFetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "[]" }] }) };
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const judge = new ByokJudge({ ...CONFIG, baseUrl: "https://proxy.example.com/" }, spyFetch);
      await judge.judge(judgeCtx(shot.path));
      expect(seen).toHaveLength(1);
      // baseUrl honored + trailing slash trimmed.
      expect(seen[0]!.url).toBe("https://proxy.example.com/v1/messages");
      expect(seen[0]!.headers["x-api-key"]).toBe(CONFIG.apiKey);
      expect(seen[0]!.headers["anthropic-version"]).toBeTruthy();
      // The key must never have been logged.
      const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(" ");
      expect(logged).not.toContain(CONFIG.apiKey);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      shot.cleanup();
    }
  });
});

describe("ByokJudge — OpenAI provider (Chat Completions shape)", () => {
  const OPENAI: ByokConfig = { provider: "openai", apiKey: "sk-openai-NOT-REAL" };

  it("maps an OpenAI choices[].message.content reply to findings", async () => {
    const shot = makeScreenshot();
    try {
      const reply = JSON.stringify([{ severity: "warn", message: "The teal accent looks washed out here." }]);
      const judge = new ByokJudge(OPENAI, okOpenAiFetch(reply));
      const findings = await judge.judge(judgeCtx(shot.path));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ role: "judge", severity: "warn" });
      expect(findings[0]!.message).toContain("teal");
    } finally {
      shot.cleanup();
    }
  });

  it("posts to <base>/v1/chat/completions with Authorization: Bearer (not x-api-key), vision as image_url", async () => {
    const shot = makeScreenshot();
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const spyFetch: GymFetch = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "[]" } }] }) };
    };
    try {
      const judge = new ByokJudge({ ...OPENAI, baseUrl: "https://oai.example.com/" }, spyFetch);
      await judge.judge(judgeCtx(shot.path));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("https://oai.example.com/v1/chat/completions");
      expect(seen[0]!.headers["authorization"]).toBe(`Bearer ${OPENAI.apiKey}`);
      expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
      expect(seen[0]!.body).toContain("image_url");
      expect(seen[0]!.body).toContain("data:image/png;base64,");
    } finally {
      shot.cleanup();
    }
  });

  it("an OpenAI 401 (wrong/expired key) still degrades to [] (IRON RULE)", async () => {
    const shot = makeScreenshot();
    try {
      const judge = new ByokJudge(OPENAI, statusFetch(401));
      await expect(judge.judge(judgeCtx(shot.path))).resolves.toEqual([]);
    } finally {
      shot.cleanup();
    }
  });
});

describe("ByokJudge — IRON RULE: every failure degrades to [] and never throws", () => {
  it("a thrown fetch (network down) → []", async () => {
    const shot = makeScreenshot();
    try {
      const judge = new ByokJudge(CONFIG, throwingFetch);
      await expect(judge.judge(judgeCtx(shot.path))).resolves.toEqual([]);
    } finally {
      shot.cleanup();
    }
  });

  it("a 500 response → []", async () => {
    const shot = makeScreenshot();
    try {
      const judge = new ByokJudge(CONFIG, statusFetch(500));
      await expect(judge.judge(judgeCtx(shot.path))).resolves.toEqual([]);
    } finally {
      shot.cleanup();
    }
  });

  it("a 200 with a non-JSON body → []", async () => {
    const shot = makeScreenshot();
    try {
      const judge = new ByokJudge(CONFIG, garbageBodyFetch);
      await expect(judge.judge(judgeCtx(shot.path))).resolves.toEqual([]);
    } finally {
      shot.cleanup();
    }
  });

  it("a reply that is JSON but NOT a findings array (an object) → []", async () => {
    const shot = makeScreenshot();
    try {
      const judge = new ByokJudge(CONFIG, okFetchWithText(JSON.stringify({ not: "an array" })));
      await expect(judge.judge(judgeCtx(shot.path))).resolves.toEqual([]);
    } finally {
      shot.cleanup();
    }
  });

  it("a missing/unreadable screenshot → [] (never throws)", async () => {
    const judge = new ByokJudge(CONFIG, okFetchWithText("[]"));
    await expect(judge.judge(judgeCtx("/no/such/file.png"))).resolves.toEqual([]);
  });

  it("a non-image screenshot path → [] without even calling the provider", async () => {
    const fetchSpy = vi.fn(okFetchWithText("[]"));
    const judge = new ByokJudge(CONFIG, fetchSpy as unknown as GymFetch);
    await expect(judge.judge(judgeCtx("/tmp/capture.txt"))).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ByokNavigator — maps a suggestion + never throws", () => {
  it("a well-formed suggestion object yields a warn finding + the suggested handle", async () => {
    const nav = new ByokNavigator(
      CONFIG,
      okFetchWithText(JSON.stringify({ suggestedHandle: "#settings-new", message: "renamed in this build" })),
    );
    const out = await nav.navigate(navCtx);
    expect(out.suggestedHandle).toBe("#settings-new");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ role: "navigate", severity: "warn", scenarioId: "web-x" });
    expect(out.findings[0]!.message).toContain("#settings-new");
  });

  it("a null suggestion yields a warn finding with NO suggestedHandle", async () => {
    const nav = new ByokNavigator(CONFIG, okFetchWithText(JSON.stringify({ suggestedHandle: null, message: "unsure" })));
    const out = await nav.navigate(navCtx);
    expect(out.suggestedHandle).toBeUndefined();
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.role).toBe("navigate");
  });

  it("a thrown fetch → {findings:[]} (never throws)", async () => {
    const nav = new ByokNavigator(CONFIG, throwingFetch);
    await expect(nav.navigate(navCtx)).resolves.toEqual({ findings: [] });
  });

  it("a 500 → {findings:[]}", async () => {
    const nav = new ByokNavigator(CONFIG, statusFetch(500));
    await expect(nav.navigate(navCtx)).resolves.toEqual({ findings: [] });
  });

  it("a garbage (non-JSON) body → {findings:[]}", async () => {
    const nav = new ByokNavigator(CONFIG, garbageBodyFetch);
    await expect(nav.navigate(navCtx)).resolves.toEqual({ findings: [] });
  });

  it("a JSON array (wrong shape for the navigator) → {findings:[]}", async () => {
    const nav = new ByokNavigator(CONFIG, okFetchWithText("[1,2,3]"));
    await expect(nav.navigate(navCtx)).resolves.toEqual({ findings: [] });
  });
});

describe("byokConfigFromEnv — null without a key, a config with one", () => {
  it("returns null when GYM_AI_API_KEY is absent", () => {
    expect(byokConfigFromEnv({})).toBeNull();
  });

  it("returns a config (provider defaults to anthropic) when the key is present", () => {
    const cfg = byokConfigFromEnv({ GYM_AI_API_KEY: "k" });
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("k");
    expect(cfg!.provider).toBe("anthropic");
    expect(cfg!.baseUrl).toBeUndefined();
    expect(cfg!.model).toBeUndefined();
  });

  it("threads provider / baseUrl / model overrides through", () => {
    const cfg = byokConfigFromEnv({
      GYM_AI_API_KEY: "k",
      GYM_AI_PROVIDER: "anthropic",
      GYM_AI_BASE_URL: "https://proxy.example.com",
      GYM_AI_MODEL: "claude-opus-4-1",
    });
    expect(cfg).toMatchObject({
      apiKey: "k",
      provider: "anthropic",
      baseUrl: "https://proxy.example.com",
      model: "claude-opus-4-1",
    });
  });

  it("threads GYM_AI_PROVIDER=openai through", () => {
    const cfg = byokConfigFromEnv({ GYM_AI_API_KEY: "sk-o", GYM_AI_PROVIDER: "openai" });
    expect(cfg).toMatchObject({ provider: "openai", apiKey: "sk-o" });
  });
});

describe("resolveAiHooks — switches on key presence", () => {
  it("no key → the deterministic no-op hooks", () => {
    const hooks = resolveAiHooks({});
    expect(hooks.judge.name).toBe("noop-judge");
    expect(hooks.navigator.name).toBe("noop-navigator");
  });

  it("a key → the BYOK adapters", () => {
    const hooks = resolveAiHooks({ GYM_AI_API_KEY: "k" });
    expect(hooks.judge.name).toContain("byok-judge");
    expect(hooks.navigator.name).toContain("byok-navigator");
  });

  it("a key + an injected mock fetch → BYOK adapters that use the mock (no network)", async () => {
    const shot = makeScreenshot();
    try {
      const hooks = resolveAiHooks(
        { GYM_AI_API_KEY: "k" },
        okFetchWithText(JSON.stringify([{ severity: "info", message: "looks fine" }])),
      );
      const findings = await hooks.judge.judge(judgeCtx(shot.path));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.message).toContain("looks fine");
    } finally {
      shot.cleanup();
    }
  });
});
