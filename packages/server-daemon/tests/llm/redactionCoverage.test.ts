/**
 * AI01 redaction coverage: every box-written text that reaches a model is free of the owner's
 * identity and location, and no model-facing path can be added without saying how it is redacted.
 *
 * 1. The static check: every daemon source file with a shape that puts text in front of a model
 *    (`MODEL_SINK_PATTERNS`) is listed in `MODEL_BOUNDARY`, and a file listed as `redacted` calls a
 *    redactor. A new path that skips the redactor fails here.
 * 2. Every build tool declares its output kind in the broker; a new tool without one fails.
 * 3. The corpus: the owner's name, server, host name, address, mail, time zone, locale, clock and
 *    git identity, planted in every channel the box writes (tool results, errors, logs, build
 *    output, file listings, git metadata, env names), never reaches the model.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILD_TOOL_NAMES, BuildToolHost } from "../../src/buildmodes/buildToolHost.js";
import { BuildWorkspace } from "../../src/buildmodes/buildWorkspace.js";
import { InMemoryBuildJournal } from "../../src/buildmodes/buildJournal.js";
import { TOOL_POLICIES } from "../../src/buildmodes/toolBroker.js";
import { McpBuildServer } from "../../src/buildmodes/mcpServer.js";
import { compactIfNeeded } from "../../src/llm/contextCompaction.js";
import { MODEL_BOUNDARY, MODEL_SINK_PATTERNS } from "../../src/llm/modelBoundary.js";
import { buildModelRedactor } from "../../src/llm/modelPrivacy.js";
import { buildUserContext } from "../../src/llm/systemPrompt.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".generated.ts")) out.push(p);
  }
  return out;
}

/** Who the owner is, as the box might know it. None of it may reach a model. */
const OWNER = {
  username: "plucky-avocet",
  serverFqdn: "home3.plucky-avocet.flagship.services",
  hostname: "mara-nuc",
  person: "Mara Lindqvist",
  email: "mara.lindqvist@gmail.com",
  serviceId: "plucky-avocet--ledger",
};
const LEAKS: RegExp[] = [
  /plucky/i, /avocet/i, /home3/i, /mara/i, /lindqvist/i, /gmail/i, /81\.12\.3\.4/, /2a02:8109/i, /3c:22:fb/i,
  /Europe\/Stockholm/, /sv_SE/, /\+02:?00/, /07:13:22/, /Sat, 24 Oct 2026/, /Oct 24 07:13/, /UTC\+2/,
];

/** One planted line per kind of fact. */
const PLANT = [
  `live at https://ledger.${OWNER.serverFqdn}/ and https://ledger.${OWNER.username}.flagship.services`,
  `container flagship-${OWNER.serviceId} on host ${OWNER.hostname}`,
  `client 81.12.3.4 / 2a02:8109:1:2::5 / mac 3c:22:fb:01:02:03`,
  `TZ=Europe/Stockholm LANG=sv_SE.UTF-8 started 2026-10-24T07:13:22+02:00 (UTC+2)`,
  `date: Sat, 24 Oct 2026 07:13:22 GMT`,
  `npm ERR! at /home/mara/.npm/_cacache and /Users/mara/project`,
  `commit 9f2c1d\nAuthor: ${OWNER.person} <${OWNER.email}>\nDate:   Sat Oct 24 07:13:22 2026 +0200`,
  `env PLUCKY_AVOCET_STRIPE_KEY is set`,
].join("\n");

const redact = buildModelRedactor(() => ({
  username: OWNER.username,
  serverFqdn: OWNER.serverFqdn,
  extra: [OWNER.serviceId],
  hostname: OWNER.hostname,
  people: [OWNER.person],
  emails: [OWNER.email],
}));

function clean(text: string, where: string): void {
  for (const re of LEAKS) expect(text, `${where} leaks ${re}`).not.toMatch(re);
}

describe("the model boundary is complete (static)", () => {
  const files = sources(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

  it("every file that hands text to a model is listed with how it is redacted", () => {
    const listed = new Set(MODEL_BOUNDARY.map((e) => e.file));
    const sinks = files.filter((f) => f.rel !== "llm/modelBoundary.ts" && MODEL_SINK_PATTERNS.some((re) => re.test(f.text)));
    const missing = sinks.map((f) => f.rel).filter((r) => !listed.has(r));
    expect(missing, "model-facing files missing from MODEL_BOUNDARY (llm/modelBoundary.ts)").toEqual([]);
    expect(sinks.length).toBeGreaterThan(8);
  });

  it("a file listed as redacted calls a redactor, and every listed file exists", () => {
    for (const e of MODEL_BOUNDARY) {
      const f = files.find((x) => x.rel === e.file);
      expect(f, `${e.file} is listed but gone`).toBeTruthy();
      if (e.coverage === "redacted") expect(f!.text, `${e.file} is listed as redacted`).toMatch(/\bredact\b|\bredact\(|\.scrub\(|buildModelRedactor/);
    }
  });

  it("every build tool declares whether its output is box-written (redacted) or the repo's own", () => {
    expect(Object.keys(TOOL_POLICIES).sort()).toEqual([...BUILD_TOOL_NAMES].sort());
    const repo = Object.entries(TOOL_POLICIES).filter(([, p]) => p.output === "repo-content").map(([n]) => n);
    expect(repo.sort()).toEqual(["list_files", "read_file"]);
  });
});

describe("the redaction corpus: nothing that names or places the owner reaches a model", () => {
  it("the redactor itself removes every planted fact and keeps the text useful", () => {
    const out = redact(PLANT);
    clean(out, "redactor");
    expect(out).toContain("app.example");
    expect(out).toContain("npm ERR!");
    expect(out).toContain("owner@example.com");
    // Neutral data stays: sample addresses, private container addresses.
    expect(redact("row: jo@example.com 172.18.0.5")).toBe("row: jo@example.com 172.18.0.5");
  });

  const withHooks = (ws: BuildWorkspace) =>
    new BuildToolHost({
      buildId: "b1",
      workspace: ws,
      journal: new InMemoryBuildJournal(),
      serverFqdn: OWNER.serverFqdn,
      envNames: async () => ["PLUCKY_AVOCET_STRIPE_KEY"],
      redact,
      mode: "git",
      recordEnvRequest: async () => {},
      deploy: async () => ({ ok: false, reason: `build output:\n${PLANT}` }),
      checkApp: async () => ({ ok: true, status: 500, contentType: "text/html", body: `<p>${PLANT}</p>` }),
      logs: async () => `[log] ${PLANT}`,
      data: {
        queryDb: async () => ({ ok: true, text: JSON.stringify({ rows: [{ note: PLANT }] }) }),
        listTables: async () => ({ ok: true, text: JSON.stringify({ tables: [{ name: "audit", comment: PLANT }] }) }),
        listDataFiles: async () => ({ ok: true, text: JSON.stringify({ files: [{ path: "/data/uploads/mara-lindqvist-cv.pdf", note: PLANT }] }) }),
        readDataFile: async () => ({ ok: true, text: PLANT }),
      },
      finish: async () => ({ ok: false, reason: PLANT }),
    });

  it("every box-written tool result: build output, errors, logs, file listings, data, git metadata, env names", async () => {
    const ws = new BuildWorkspace({ "flagship.app.json": JSON.stringify({ name: "ledger" }) });
    const tools = withHooks(ws);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["deploy", {}],
      ["check_app", { path: "/" }],
      ["get_logs", {}],
      ["query_db", { sql: "select * from audit" }],
      ["list_tables", {}],
      ["list_data_files", {}],
      ["read_data_file", { path: "uploads/x.txt" }],
      ["finish", {}],
      ["request_env_var", { name: "PLUCKY_AVOCET_STRIPE_KEY" }],
      ["read_file", { path: "no/such/home3.plucky-avocet.flagship.services" }],
      ["get_contract", {}],
      ["validate", {}],
    ];
    for (const [name, args] of calls) clean((await tools.call(name, args)).text, name);
    const journal = await tools.call("get_journal", {});
    clean(journal.text, "get_journal");
  });

  it("a tool hook that throws: its error reaches the model redacted", async () => {
    const ws = new BuildWorkspace({ "flagship.app.json": "{}" });
    const tools = new BuildToolHost({
      buildId: "b2",
      workspace: ws,
      journal: new InMemoryBuildJournal(),
      serverFqdn: OWNER.serverFqdn,
      envNames: async () => [],
      redact,
      mode: "git",
      logs: async () => {
        throw new Error(`ENOENT /home/mara/x on ${OWNER.serverFqdn} at 2026-10-24T07:13:22+02:00`);
      },
    });
    const r = await tools.call("get_logs", {});
    expect(r.isError).toBe(true);
    clean(r.text, "thrown error");
  });

  it("MCP: tool results, the journal resource and internal errors an IDE's model reads", async () => {
    const ws = new BuildWorkspace({ "flagship.app.json": "{}" });
    const journal = new InMemoryBuildJournal();
    await journal.append("b3", { mode: "mcp", kind: "build-phase", actor: "system", summary: `deployed for ${OWNER.person} at ${OWNER.serverFqdn}` });
    const mcp = new McpBuildServer({
      buildId: "b3",
      workspace: ws,
      journal,
      serverFqdn: OWNER.serverFqdn,
      envNames: async () => [],
      redact,
      logs: async () => PLANT,
    });
    const r = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_logs", arguments: {} } })) as { result: { content: { text: string }[] } };
    clean(r.result.content[0]!.text, "mcp get_logs");
    const res = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "flagship://journal" } })) as { result: { contents: { text: string }[] } };
    clean(res.result.contents[0]!.text, "mcp journal resource");
  });

  it("the summariser reads a redacted transcript and its summary is redacted again", async () => {
    let read = "";
    const big = "x".repeat(4000);
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "build it" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "assistant" | "user", content: `${PLANT}\n${big}` })),
    ];
    const out = await compactIfNeeded({
      messages,
      tools: [],
      contextTokens: 8_000,
      model: "m",
      redact,
      summarise: async (req) => {
        read = req.messages.map((m) => m.content).join("\n");
        return `summary mentions ${OWNER.person} in Europe/Stockholm`;
      },
    });
    expect(out.replaced).toBeGreaterThan(0);
    clean(read, "summariser input");
    // The summary that replaces the older turns (the recent ones are kept as they were sent: box
    // text in them came from tools, redacted on its way in).
    const summary = out.messages.find((m) => m.content.includes("summary mentions"));
    expect(summary).toBeTruthy();
    clean(summary!.content.split("\n").slice(0, 4).join("\n"), "summary");
  });

  it("env NAMES in the chat's system prompt pass the redactor", () => {
    const prompt = buildUserContext({ appEnvNames: ["PLUCKY_AVOCET_STRIPE_KEY", "STRIPE_KEY"].map(redact) } as never);
    clean(prompt, "system prompt env names");
    expect(prompt).toContain("STRIPE_KEY");
  });
});
