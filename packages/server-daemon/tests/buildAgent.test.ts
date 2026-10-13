/**
 * The agentic build loop in isolation — `runBuildAgent` driving a real
 * `BuildToolHost` over a real `BuildWorkspace`, with a scripted fake model.
 * Proves the loop: dispatches tool calls, feeds results back (multi-turn),
 * stops on finish / no-tool-calls / turn-cap, and records value-free journal
 * entries.
 */

import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, ToolUseBlock } from "@flagship/llm-providers";
import { runBuildAgent, BUILD_AGENT_SYSTEM_PROMPT } from "../src/buildmodes/buildAgent.js";
import { BuildToolHost } from "../src/buildmodes/buildToolHost.js";
import { BuildWorkspace } from "../src/buildmodes/buildWorkspace.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";

const VALID_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { base: "static", image: "flagship/notes:0.1.0", port: 8080 },
  data: { stores: {} },
  network: { subdomain: "notes" },
  access: { enabled: true, default_role: "member", public_routes: ["/"] },
  migration: { verification: "standard" },
});

function tu(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { id, name, input };
}

function scripted(script: Array<{ text?: string; toolUses?: ToolUseBlock[] }>) {
  let i = 0;
  const seen: ChatRequest[] = [];
  const runner = async (req: ChatRequest): Promise<ChatResponse> => {
    seen.push(req);
    const step = script[i++];
    return {
      content: step?.text ?? "",
      model: "fake",
      ...(step?.toolUses ? { toolUses: step.toolUses } : {}),
    };
  };
  return { runner, seen: () => seen };
}

function makeHost(buildId: string, workspace: BuildWorkspace, journal: InMemoryBuildJournal, deployed: () => void) {
  let staged = false;
  let sealed = false;
  return new BuildToolHost({
    buildId,
    workspace,
    journal,
    serverFqdn: "home.harry.flagship.services",
    mode: "git",
    envNames: async () => [],
    deploy: async () => {
      deployed();
      staged = true;
      return { ok: true };
    },
    finish: async () => {
      if (!staged) return { ok: false, reason: "deploy first" };
      sealed = true;
      return { ok: true };
    },
    sealed: () => sealed,
  });
}

describe("runBuildAgent", () => {
  it("passes the tool specs + agent system prompt and drives deploy → finish", async () => {
    const ws = new BuildWorkspace({ "package.json": "{}", "index.js": "x" });
    const journal = new InMemoryBuildJournal();
    let deployCount = 0;
    const host = makeHost("b1", ws, journal, () => deployCount++);
    const model = scripted([
      { toolUses: [tu("a1", "get_contract")] },
      { toolUses: [tu("b1", "write_file", { path: "flagship.app.json", content: VALID_MANIFEST }), tu("b2", "write_file", { path: "index.html", content: "<h1>notes</h1>" })] },
      { toolUses: [tu("c1", "validate")] },
      { toolUses: [tu("e0", "finish")] },
      { toolUses: [tu("d1", "deploy")] },
      { toolUses: [tu("e1", "check_app", { path: "/" }), tu("e2", "get_logs")] },
      { toolUses: [tu("f1", "finish"), tu("f2", "write_file", { path: "late.txt", content: "x" })] },
      { text: "never asked" },
    ]);

    const r = await runBuildAgent({
      buildId: "b1",
      runner: model.runner,
      tools: host,
      journal,
      repoFiles: ws.list(),
    });

    // A deploy alone no longer ends the loop: finish does, and only once
    // the copy is staged (the early finish was refused and fed back).
    expect(r.finished).toBe(true);
    expect(r.staged).toBe(true);
    expect(r.stopReason).toBe("finished");
    expect(r.validated).toBe(true);
    expect(r.turns).toBe(7);
    expect(deployCount).toBe(1);
    expect(model.seen()).toHaveLength(7);
    // Nothing after finish in the same turn ran.
    expect(ws.read("late.txt")).toBeNull();

    // The request carried the agent system prompt + the tool specs.
    const first = model.seen()[0]!;
    expect(first.messages[0]!.content).toBe(BUILD_AGENT_SYSTEM_PROMPT);
    expect((first.tools ?? []).map((t) => t.name)).toEqual(
      expect.arrayContaining(["get_contract", "read_file", "write_file", "validate", "deploy", "check_app", "get_logs", "finish", "request_env_var"]),
    );
    expect(first.messages[0]!.content).toMatch(/check_app[\s\S]*finish/);
    const refusedEarly = model.seen()[4]!.messages.find((m) => m.role === "tool" && m.toolResults?.[0]?.toolUseId === "e0");
    expect(refusedEarly!.toolResults![0]!.isError).toBe(true);
    // get_journal is intentionally NOT exposed to the model.
    expect((first.tools ?? []).map((t) => t.name)).not.toContain("get_journal");
  });

  it("feeds tool results back as a tool turn the next request carries", async () => {
    const ws = new BuildWorkspace({ "main.go": "package main" });
    const journal = new InMemoryBuildJournal();
    const host = makeHost("b2", ws, journal, () => {});
    const model = scripted([
      { toolUses: [tu("r1", "read_file", { path: "main.go" })] },
      { text: "stopping" },
    ]);
    await runBuildAgent({ buildId: "b2", runner: model.runner, tools: host, journal, repoFiles: ws.list() });

    // The SECOND request carries the assistant tool-call turn + the tool
    // result turn from the first — a real multi-turn conversation.
    const second = model.seen()[1]!;
    expect(second.messages.some((m) => m.role === "assistant" && (m.toolUses?.length ?? 0) > 0)).toBe(true);
    const toolTurn = second.messages.find((m) => m.role === "tool");
    expect(toolTurn).toBeTruthy();
    expect(toolTurn!.toolResults![0]!.toolUseId).toBe("r1");
    expect(toolTurn!.toolResults![0]!.content).toContain("package main");
  });

  it("stops without throwing when the model errors mid-loop", async () => {
    const ws = new BuildWorkspace();
    const journal = new InMemoryBuildJournal();
    const host = makeHost("b3", ws, journal, () => {});
    const runner = async (): Promise<ChatResponse> => {
      throw new Error("provider 401");
    };
    const r = await runBuildAgent({ buildId: "b3", runner, tools: host, journal, repoFiles: [] });
    expect(r.stopReason).toBe("error");
    expect(r.finished).toBe(false);
    const entries = await journal.read("b3");
    expect(entries.some((e) => e.kind === "error" && /provider 401/.test(e.summary))).toBe(true);
  });

  it("truncates a giant tool result fed back to the model", async () => {
    const big = "x".repeat(50_000);
    const ws = new BuildWorkspace({ "big.txt": big });
    const journal = new InMemoryBuildJournal();
    const host = makeHost("b4", ws, journal, () => {});
    const model = scripted([{ toolUses: [tu("r1", "read_file", { path: "big.txt" })] }, { text: "ok" }]);
    await runBuildAgent({
      buildId: "b4",
      runner: model.runner,
      tools: host,
      journal,
      repoFiles: ws.list(),
      options: { maxToolResultChars: 1000 },
    });
    const toolTurn = model.seen()[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.toolResults![0]!.content.length).toBeLessThan(1100);
    expect(toolTurn.toolResults![0]!.content).toContain("truncated");
  });
});
