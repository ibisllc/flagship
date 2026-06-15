import { describe, expect, it } from "vitest";
import { McpBuildServer, type McpBuildContext } from "../src/buildmodes/mcpServer.js";
import { BuildWorkspace } from "../src/buildmodes/buildWorkspace.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";

const VALID_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { image: "flagship/notes:0.1.0", port: 8080 },
  data: { stores: { postgres: true } },
  network: { subdomain: "notes" },
  access: { enabled: true, default_role: "member", public_routes: [] },
  migration: { verification: "standard" },
});

function makeServer(over: Partial<McpBuildContext> = {}) {
  const workspace = new BuildWorkspace();
  const journal = new InMemoryBuildJournal();
  const ctx: McpBuildContext = {
    buildId: "b1",
    workspace,
    journal,
    serverFqdn: "home.harry.flagship.services",
    envNames: async () => [],
    ...over,
  };
  return { server: new McpBuildServer(ctx), workspace, journal, ctx };
}

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0" as const, id, method, ...(params != null ? { params } : {}) };
}

async function callTool(server: McpBuildServer, name: string, args: Record<string, unknown> = {}) {
  const resp = await server.handle(rpc(1, "tools/call", { name, arguments: args }));
  const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
  return { result, text: result.content[0]!.text, isError: result.isError === true };
}

describe("McpBuildServer — JSON-RPC envelope", () => {
  it("initialize returns serverInfo + capabilities, echoes protocol version", async () => {
    const { server } = makeServer();
    const resp = await server.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18" }));
    const r = resp!.result as any;
    expect(r.serverInfo.name).toBe("flagship-build");
    expect(r.capabilities.tools).toBeDefined();
    expect(r.protocolVersion).toBe("2025-06-18");
  });

  it("notifications get no response", async () => {
    const { server } = makeServer();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("ping returns empty result", async () => {
    const { server } = makeServer();
    const resp = await server.handle(rpc(2, "ping"));
    expect(resp!.result).toEqual({});
  });

  it("rejects a malformed message", async () => {
    const { server } = makeServer();
    const resp = await server.handle({ foo: "bar" });
    expect(resp!.error!.code).toBe(-32600);
  });

  it("unknown method → method not found", async () => {
    const { server } = makeServer();
    const resp = await server.handle(rpc(3, "bogus/method"));
    expect(resp!.error!.code).toBe(-32601);
  });

  it("tools/list advertises the build tools", async () => {
    const { server } = makeServer();
    const resp = await server.handle(rpc(4, "tools/list"));
    const names = (resp!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain("write_file");
    expect(names).toContain("deploy");
    expect(names).toContain("request_env_var");
    expect(names).toContain("get_contract");
  });
});

describe("McpBuildServer — resources", () => {
  it("reads the contract resource", async () => {
    const { server } = makeServer();
    const resp = await server.handle(rpc(1, "resources/read", { uri: "flagship://contract" }));
    const text = (resp!.result as any).contents[0].text as string;
    expect(text).toContain("Flagship app contract");
    expect(text).toContain("FLAGSHIP_PG_URL");
  });

  it("reads the journal resource", async () => {
    const { server, journal } = makeServer();
    await journal.append("b1", { mode: "mcp", kind: "mcp-connected", actor: "ide", summary: "cursor" });
    const resp = await server.handle(rpc(1, "resources/read", { uri: "flagship://journal" }));
    const text = (resp!.result as any).contents[0].text as string;
    expect(text).toContain("mcp-connected");
  });
});

describe("McpBuildServer — file tools + journaling", () => {
  it("write_file then read_file roundtrips and journals", async () => {
    const { server, journal } = makeServer();
    const w = await callTool(server, "write_file", { path: "src/index.js", content: "hi" });
    expect(w.isError).toBe(false);
    const r = await callTool(server, "read_file", { path: "src/index.js" });
    expect(r.text).toBe("hi");
    const entries = await journal.read("b1");
    expect(entries.some((e) => e.kind === "mcp-call" && e.summary.includes("wrote src/index.js"))).toBe(true);
  });

  it("write_file rejects an unsafe path with isError", async () => {
    const { server } = makeServer();
    const w = await callTool(server, "write_file", { path: "../escape", content: "x" });
    expect(w.isError).toBe(true);
  });

  it("read_file miss is a tool error, not a crash", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "read_file", { path: "nope.js" });
    expect(r.isError).toBe(true);
  });
});

describe("McpBuildServer — validate", () => {
  it("flags a missing manifest", async () => {
    const { server } = makeServer();
    const v = await callTool(server, "validate");
    expect(v.isError).toBe(true);
  });

  it("reports schema problems", async () => {
    const { server } = makeServer();
    await callTool(server, "write_file", { path: "flagship.app.json", content: JSON.stringify({ schema_version: 1 }) });
    const v = await callTool(server, "validate");
    expect(JSON.parse(v.text).ok).toBe(false);
  });

  it("passes a valid manifest but flags missing Dockerfile", async () => {
    const { server } = makeServer();
    await callTool(server, "write_file", { path: "flagship.app.json", content: VALID_MANIFEST });
    const v = await callTool(server, "validate");
    expect(JSON.parse(v.text).problems).toContain("missing Dockerfile");
    await callTool(server, "write_file", { path: "Dockerfile", content: "FROM node:20-alpine" });
    const v2 = await callTool(server, "validate");
    expect(JSON.parse(v2.text).ok).toBe(true);
  });
});

describe("McpBuildServer — request_env_var is value-free", () => {
  it("reports pending then set, records the request, never carries a value", async () => {
    let names: string[] = [];
    const recorded: Array<{ name: string }> = [];
    const { server } = makeServer({
      envNames: async () => names,
      recordEnvRequest: async (r) => void recorded.push(r),
    });
    const r1 = await callTool(server, "request_env_var", { name: "STRIPE_KEY", why: "billing", secret: true });
    expect(JSON.parse(r1.text).status).toBe("pending-owner");
    expect(JSON.parse(r1.text).currentlySet).toBe(false);
    expect(recorded[0]!.name).toBe("STRIPE_KEY");
    names = ["STRIPE_KEY"];
    const r2 = await callTool(server, "request_env_var", { name: "STRIPE_KEY" });
    expect(JSON.parse(r2.text).status).toBe("set");
    // No value FIELD anywhere in the response (the explanatory note may
    // mention the word "value", but the payload must carry none).
    expect(Object.keys(JSON.parse(r1.text))).not.toContain("value");
    expect(Object.keys(JSON.parse(r2.text))).not.toContain("value");
  });

  it("rejects a FLAGSHIP_ reserved name", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "request_env_var", { name: "FLAGSHIP_PG_URL" });
    expect(r.isError).toBe(true);
  });
});

describe("McpBuildServer — deploy", () => {
  it("503s when deploy is unavailable", async () => {
    const { server } = makeServer();
    await callTool(server, "write_file", { path: "flagship.app.json", content: VALID_MANIFEST });
    const d = await callTool(server, "deploy");
    expect(d.isError).toBe(true);
  });

  it("refuses to deploy with no manifest", async () => {
    const { server } = makeServer({ deploy: async () => ({ ok: true, url: "u", serviceId: "s" }) });
    const d = await callTool(server, "deploy");
    expect(d.isError).toBe(true);
  });

  it("deploys and journals the serviceId", async () => {
    const { server, journal } = makeServer({
      deploy: async () => ({ ok: true, url: "https://notes.home.harry.flagship.services", serviceId: "harry-notes" }),
    });
    await callTool(server, "write_file", { path: "flagship.app.json", content: VALID_MANIFEST });
    const d = await callTool(server, "deploy");
    expect(JSON.parse(d.text).url).toContain("notes");
    const entries = await journal.read("b1");
    expect(entries.some((e) => e.serviceId === "harry-notes")).toBe(true);
  });
});
