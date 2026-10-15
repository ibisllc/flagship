// Drives the box's MCP build server the way an IDE agent would — no model:
// write the files, validate, deploy the private test copy, check it, finish.
import { assert, http, postJson, short, sleep, tryHttp } from "./harness.js";
import type { Box } from "./fleet.js";

export interface McpConn {
  buildId: string;
  url: string;
  key: string;
}

export async function mcpOpen(box: Box, session: string, label: string): Promise<McpConn> {
  const r = await postJson(`https://${box.fqdn}/api/build/mcp`, { label }, { "x-flagship-session": session });
  assert(r.status === 200, `mcp mint ${r.status}: ${short(r.text)}`);
  const conn = r.json?.connection ?? r.json;
  assert(conn?.url && conn?.key, `no url/key: ${short(r.json)}`);
  const buildId = r.json?.buildId ?? /\/mcp\/build\/([^/?]+)/.exec(conn.url)?.[1];
  assert(buildId, `no buildId: ${short(r.json)}`);
  const c = { buildId, url: conn.url as string, key: conn.key as string };
  await rpc(c, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flagship-gym", version: "1" } });
  return c;
}

let rpcId = 1;
export async function rpc(c: McpConn, method: string, params: unknown = {}, timeoutMs = 60_000): Promise<any> {
  const r = await http(c.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${c.key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  }, timeoutMs);
  assert(r.status === 200, `${method} ${r.status}: ${short(r.text)}`);
  const msg = r.json ?? JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
  assert(!msg.error, `${method}: ${short(msg.error)}`);
  return msg.result;
}

/** Calls one build tool; returns its text content. Throws on a tool error. */
export async function tool(c: McpConn, name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<string> {
  const res = await rpc(c, "tools/call", { name, arguments: args }, timeoutMs);
  const text = (res?.content ?? []).map((x: { text?: string }) => x.text ?? "").join("\n");
  assert(!res?.isError, `${name}: ${short(text, 400)}`);
  return text;
}

/** Writes the files, validates, deploys the test copy (retrying while it builds), returns deploy's text. */
export async function buildAndDeploy(c: McpConn, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) await tool(c, "write_file", { path, content });
  const v = await tool(c, "validate");
  assert(!/problem|invalid|error/i.test(v) || /\bok\b/i.test(v), `validate: ${short(v, 300)}`);
  return tool(c, "deploy", {}, 900_000);
}

/** Says the app works and waits until the box lists it as an installed service. */
export async function finishAndWaitLive(c: McpConn, box: Box, serviceId: string, minutes = 15): Promise<void> {
  await tool(c, "finish", {}, 120_000);
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await tryHttp(`https://${box.fqdn}/api/services`);
    const list: unknown[] = Array.isArray(r.json) ? r.json : (r.json?.apps ?? r.json?.services ?? []);
    const row = list.find((a) => JSON.stringify(a).includes(serviceId)) as Record<string, unknown> | undefined;
    last = short(row ?? r.text, 160);
    if (row && !/building|deploying|installing/i.test(String(row.state ?? row.status ?? ""))) return;
    await sleep(10_000);
  }
  throw new Error(`${serviceId} not live in ${minutes} min (last: ${last})`);
}
