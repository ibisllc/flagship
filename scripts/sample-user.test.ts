import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript CLI intentionally has no declaration file.
import { parseArgs, pollUntilReady, runCreate, runCleanup, USAGE } from "./sample-user.mjs";

function response(status: number, body: unknown) {
  return { status, async text() { return JSON.stringify(body); } };
}

function stream() {
  let value = "";
  return { write(chunk: string) { value += chunk; }, value: () => value };
}

describe("sample-user CLI", () => {
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
      region: "fsn1",
      size: "cpx11",
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
});
