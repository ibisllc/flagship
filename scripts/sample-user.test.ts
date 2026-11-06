import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript CLI intentionally has no declaration file.
import { parseArgs, pollUntilReady, runCreate, runCleanup, runExamplePage, USAGE } from "./sample-user.mjs";

function response(status: number, body: unknown) {
  return { status, async text() { return JSON.stringify(body); } };
}

function stream() {
  let value = "";
  return { write(chunk: string) { value += chunk; }, value: () => value };
}

describe("sample-user CLI", () => {
  it("example-page publishes or removes the sample account's example page and sends nothing else", async () => {
    expect(parseArgs(["example-page", "playstore-test-0725"])).toEqual({ command: "example-page", username: "playstore-test-0725", flags: {} });
    expect(parseArgs(["example-page", "playstore-test-0725", "--remove"])).toMatchObject({ flags: { remove: true } });
    expect(() => parseArgs(["example-page"])).toThrow("requires a <username>");
    expect(() => parseArgs(["example-page", "u", "--bio", "x"])).toThrow("unknown argument");
    expect(USAGE).toContain("example-page <username> [--remove]");
    for (const remove of [false, true]) {
      const fetchFn = vi.fn(async () => response(200, { ok: true, seq: 2 }));
      const stdout = stream();
      const code = await runExamplePage(
        { fetchFn, env: { baseUrl: "https://example.test", adminSecret: "secret" }, stderr: stream(), stdout },
        "playstore-test-0725",
        remove ? { remove: true } : {},
      );
      expect(code).toBe(0);
      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { method: string; body: string; headers: Record<string, string> }];
      expect(url).toBe("https://example.test/api/dev/sample-user/playstore-test-0725/voici-example-page");
      expect(init.method).toBe("POST");
      expect(init.headers["x-admin-secret"]).toBe("secret");
      expect(JSON.parse(init.body)).toEqual(remove ? { remove: true } : {});
      expect(stdout.value()).toContain('"seq":2');
    }
    const refused = await runExamplePage(
      { fetchFn: vi.fn(async () => response(403, { error: "forbidden" })), env: { baseUrl: "https://example.test", adminSecret: "x" }, stderr: stream(), stdout: stream() },
      "u",
      {},
    );
    expect(refused).toBe(2);
  });

  it("requires the standard encrypted account name option and rejects --display", () => {
    expect(parseArgs(["create", "openai-build", "--account-name", "OpenAI Build Week"]))
      .toMatchObject({ command: "create", username: "openai-build", flags: { accountName: "OpenAI Build Week" } });
    expect(() => parseArgs(["create", "openai-build", "--display", "OpenAI Build Week"]))
      .toThrow("unknown flag: --display");
    expect(USAGE).toContain("--account-name");
    expect(USAGE).not.toContain("--display");
  });

  it("calls one idempotent creation endpoint and then polls", async () => {
    const stderr = stream();
    const stdout = stream();
    const fetchFn = vi.fn(async () => response(202, { state: "provisioning", activeServerId: "server-1" }));
    const poll = vi.fn(async () => ({ ready: true, activeServerId: "server-1" }));
    const result = await runCreate({
      fetchFn,
      env: { baseUrl: "https://example.test", adminSecret: "secret" },
      stderr,
      stdout,
      now: () => 1_900_000_000_000,
      pollUntilReady: poll,
    }, "openai-build", { accountName: "OpenAI Build Week" });
    expect(result).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({
      username: "openai-build",
      accountName: "OpenAI Build Week",
      idempotencyKey: "sample-user-create:openai-build",
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("polls honest ready and failed states", async () => {
    const stderr = stream();
    const ready = await pollUntilReady({
      fetchFn: async () => response(200, { state: "ready", activeServerId: "server-1" }),
      env: { baseUrl: "https://example.test", adminSecret: "secret" },
      stderr,
      username: "openai-build",
      timeoutMs: 1_000,
      intervalMs: 0,
      now: () => 100,
    });
    expect(ready).toEqual({ ready: true, activeServerId: "server-1" });
  });

  it("cleanup supplies the exact creation idempotency key", async () => {
    const stderr = stream();
    const stdout = stream();
    const fetchFn = vi.fn(async () => response(200, { deleted: true }));
    expect(await runCleanup({
      fetchFn,
      env: { baseUrl: "https://example.test", adminSecret: "secret" },
      stderr,
      stdout,
    }, "openai-build")).toBe(0);
    const init = fetchFn.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({
      username: "openai-build",
      idempotencyKey: "sample-user-create:openai-build",
    });
  });

  it("sends region/size only when given, so the Worker's provider defaults apply", async () => {
    const fetchFn = vi.fn(async () => response(202, { state: "provisioning" }));
    await runCreate({
      fetchFn,
      env: { baseUrl: "https://example.test", adminSecret: "secret" },
      stderr: stream(),
      stdout: stream(),
      now: () => 1_900_000_000_000,
      pollUntilReady: async () => ({ ready: true }),
    }, "openai-build", { accountName: "OpenAI Build Week", region: "de-fra1", size: "PLAN-X" });
    const init = fetchFn.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ region: "de-fra1", size: "PLAN-X" });
  });

  it("cleanup --force forwards force:true", async () => {
    expect(parseArgs(["cleanup", "openai-build", "--force"]))
      .toMatchObject({ command: "cleanup", username: "openai-build", flags: { force: true } });
    const fetchFn = vi.fn(async () => response(200, { deleted: true, providerDestroy: "failed" }));
    expect(await runCleanup({
      fetchFn,
      env: { baseUrl: "https://example.test", adminSecret: "secret" },
      stderr: stream(),
      stdout: stream(),
    }, "openai-build", { force: true })).toBe(0);
    const init = fetchFn.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({
      username: "openai-build",
      idempotencyKey: "sample-user-create:openai-build",
      force: true,
    });
  });
});
