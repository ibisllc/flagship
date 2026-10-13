import { describe, expect, it } from "vitest";
import { McpBuildServer, type McpBuildContext } from "../src/buildmodes/mcpServer.js";
import { BuildWorkspace } from "../src/buildmodes/buildWorkspace.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";

const VALID_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { base: "static", image: "flagship/notes:0.1.0", port: 8080 },
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

  it("asks for a runtime, and never lets the IDE write the build itself", async () => {
    const { server } = makeServer();
    const noBase = JSON.stringify({ ...JSON.parse(VALID_MANIFEST), runtime: { image: "x:1", port: 8080 } });
    await callTool(server, "write_file", { path: "flagship.app.json", content: noBase });
    const v = await callTool(server, "validate");
    expect(JSON.parse(v.text).problems.join()).toMatch(/set runtime.base to one of node-24, python-3.13, static/);
    for (const path of ["Dockerfile", "dockerfile", "Containerfile", ".dockerignore", "Dockerfile.prod"]) {
      const w = await callTool(server, "write_file", { path, content: "FROM evil/image" });
      expect(w.text).toMatch(/the box writes the build itself/);
    }
    // A nested Dockerfile isn't the build; it's just a file.
    expect((await callTool(server, "write_file", { path: "docs/Dockerfile", content: "x" })).text).toMatch(/"ok":true/);
    await callTool(server, "write_file", { path: "flagship.app.json", content: VALID_MANIFEST });
    expect(JSON.parse((await callTool(server, "validate")).text).ok).toBe(true);
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
    const { server } = makeServer({ deploy: async () => ({ ok: true }) });
    const d = await callTool(server, "deploy");
    expect(d.isError).toBe(true);
  });

  it("deploys to staging and says only that it worked", async () => {
    const { server, journal } = makeServer({ deploy: async () => ({ ok: true }) });
    await callTool(server, "write_file", { path: "flagship.app.json", content: VALID_MANIFEST });
    const d = await callTool(server, "deploy");
    expect(JSON.parse(d.text)).toEqual({ ok: true });
    const entries = await journal.read("b1");
    expect(entries.some((e) => e.summary === "staged a test copy")).toBe(true);
    expect(entries.every((e) => e.serviceId == null)).toBe(true);
  });
});

describe("McpBuildServer — testing the staging copy, finishing, sealed", () => {
  it("check_app and get_logs reach the staging hooks, redacted; finish then seals everything", async () => {
    let sealed = false;
    const asked: unknown[] = [];
    const { server, workspace } = makeServer({
      redact: (t) => t.replaceAll("home.harry.flagship.services", "app.example"),
      deploy: async () => ({ ok: true }),
      checkApp: async (req) => {
        asked.push(req);
        return { ok: true, status: 200, contentType: "text/html", body: "<a href=https://home.harry.flagship.services>x</a>" };
      },
      logs: async () => "listening for home.harry.flagship.services",
      finish: async () => {
        sealed = true;
        return { ok: true };
      },
      sealed: () => sealed,
    });
    const tools = (((await server.handle(rpc(1, "tools/list")))!.result) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["deploy", "check_app", "get_logs", "finish"]));
    const c = await callTool(server, "check_app", { path: "/items", method: "POST", body: "{}" });
    expect(asked).toEqual([{ path: "/items", method: "POST", body: "{}" }]);
    expect(JSON.parse(c.text)).toMatchObject({ status: 200, contentType: "text/html" });
    expect(c.text).not.toContain("harry");
    expect((await callTool(server, "get_logs")).text).toBe("listening for app.example");
    expect(JSON.parse((await callTool(server, "finish")).text).ok).toBe(true);

    workspace.write("flagship.app.json", VALID_MANIFEST);
    for (const name of ["deploy", "check_app", "get_logs", "read_file", "write_file", "get_journal", "finish"]) {
      const r = await callTool(server, name, { path: "/", content: "x" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("closed");
    }
    const res = await server.handle(rpc(2, "resources/read", { uri: "flagship://journal" }));
    expect(res!.error).toBeTruthy();
  });

  it("get_logs before any deploy says so instead of reading anything", async () => {
    const { server } = makeServer({ logs: async () => null });
    expect((await callTool(server, "get_logs")).text).toMatch(/call deploy first/);
  });
});

describe("McpBuildServer — the staging copy's data tools", () => {
  it("lists them, routes them to the data hooks, redacts what comes back, and journals no SQL", async () => {
    const seen: unknown[] = [];
    let sealed = false;
    const { server, journal } = makeServer({
      redact: (t) => t.replaceAll("home.harry.flagship.services", "app.example"),
      data: {
        queryDb: async (req) => {
          seen.push(["queryDb", req]);
          return { ok: true, text: JSON.stringify({ rows: [["visit home.harry.flagship.services"]] }) };
        },
        listTables: async (req) => {
          seen.push(["listTables", req]);
          return { ok: true, text: '{"tables":[]}' };
        },
        listDataFiles: async (req) => {
          seen.push(["listDataFiles", req]);
          return { ok: false, reason: "the app has no files folder (data.stores.files)" };
        },
        readDataFile: async (req) => {
          seen.push(["readDataFile", req]);
          return { ok: true, text: '{"content":"x"}' };
        },
      },
      sealed: () => sealed,
    });
    const tools = (((await server.handle(rpc(1, "tools/list")))!.result) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["query_db", "list_tables", "list_data_files", "read_data_file", "list_files"]));

    const q = await callTool(server, "query_db", { sql: "SELECT secret_column FROM t", store: "default" });
    expect(q.isError).toBe(false);
    expect(q.text).toBe('{"rows":[["visit app.example"]]}');
    expect((await callTool(server, "list_tables")).text).toBe('{"tables":[]}');
    const f = await callTool(server, "list_data_files", { path: "uploads" });
    expect(f.isError).toBe(true);
    expect(JSON.parse(f.text).error).toMatch(/no files folder/);
    expect((await callTool(server, "read_data_file", {})).isError).toBe(true);
    expect((await callTool(server, "query_db", {})).isError).toBe(true);
    expect(seen).toEqual([
      ["queryDb", { sql: "SELECT secret_column FROM t", store: "default" }],
      ["listTables", {}],
      ["listDataFiles", { path: "uploads" }],
    ]);
    const entries = JSON.stringify(await journal.read("b1"));
    expect(entries).not.toContain("secret_column");

    sealed = true;
    for (const name of ["query_db", "list_tables", "list_data_files", "read_data_file"]) {
      const r = await callTool(server, name, { sql: "SELECT 1", path: "a" });
      expect(r.isError, name).toBe(true);
      expect(r.text).toContain("closed");
    }
    expect(seen).toHaveLength(3);
  });

  it("without data hooks the tools refuse", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "query_db", { sql: "SELECT 1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not available/);
  });
});
