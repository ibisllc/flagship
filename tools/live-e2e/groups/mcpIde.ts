// An IDE building over MCP (docs/build-modes.md "IDE"), driven as a scripted
// JSON-RPC client with no model in the loop: the owner opens an MCP build,
// the IDE writes files, deploys the private test copy (which reaches no host),
// checks it and reads its sample data, then finishes and the app goes live
// with a valid certificate. "Change this app" opens a build on the live app:
// its test copy holds only sample data, the change goes live, and the live
// rows, files and API keys survive. Keys are scoped: refused with no key,
// after finish, after a rotate and at another build's URL, each with its own
// sentence. Nothing any response carries names the account, server or box.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { signAppApiKeyGrant, type AppApiKeyGrant } from "@flagship/protocol";
import { pair, type Box } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { pyAppFiles } from "./runtimes.js";
import type { Group } from "./types.js";

const APP = "ideapp";

interface Conn {
  buildId: string;
  url: string;
  key: string;
}

function appFiles(version: string): Record<string, string> {
  const manifest = JSON.parse(pyAppFiles["flagship.app.json"]!);
  manifest.name = APP;
  manifest.network.subdomain = APP;
  return {
    ...pyAppFiles,
    "flagship.app.json": JSON.stringify(manifest, null, 2),
    "app.py": pyAppFiles["app.py"]!.replace(`{"app": "py", "uid": os.getuid()}`, `{"app": "py", "version": "${version}", "uid": os.getuid()}`),
  };
}

export const mcpIde: Group = {
  name: "mcp-ide",
  title: "an IDE over MCP: build → test copy (no network, sample data) → live; change this app keeps live data and API keys; key scoping; no identity in any answer",
  needs: ["B1"],
  phase: 3,
  async run({ B, rec, box }) {
    const acct = B!;
    const b: Box = box("B1");
    const s = { "x-flagship-session": await pair(acct, b) };
    const serviceId = `${acct.username}--${APP}`;
    const app = `https://${APP}.${b.fqdn}`;
    const seen: string[] = [];
    let id = 1;
    const send = async (c: Conn | { url: string; key: string | null }, method: string, params: unknown = {}) => {
      const r = await http(c.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      }, 900_000);
      seen.push(r.text);
      return r;
    };
    const tool = async (c: Conn, name: string, args: Record<string, unknown> = {}) => {
      const r = await send(c, "tools/call", { name, arguments: args });
      assert(r.status === 200, `${name} ${r.status}: ${short(r.text)}`);
      const res = r.json?.result ?? JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["{}"])[0]).result;
      const text = (res?.content ?? []).map((x: { text?: string }) => x.text ?? "").join("\n");
      assert(!res?.isError, `${name}: ${short(text, 300)}`);
      return text;
    };
    const open = async (editServiceId?: string): Promise<Conn> => {
      const r = await postJson(`https://${b.fqdn}/api/build/mcp`, { label: "gym ide", ...(editServiceId ? { editServiceId } : {}) }, s);
      assert(r.status === 200, `mcp ${r.status}: ${short(r.text)}`);
      const c = r.json?.connection ?? r.json;
      return { buildId: r.json.buildId, url: c.url, key: c.key };
    };
    const writeAll = async (c: Conn, files: Record<string, string>) => {
      for (const [path, content] of Object.entries(files)) await tool(c, "write_file", { path, content });
      const v = await tool(c, "validate");
      assert(/"ok":\s*true/.test(v), `validate: ${short(v, 300)}`);
      return tool(c, "deploy", {});
    };
    const waitVersion = async (version: string) => {
      for (let i = 0; i < 60; i++) {
        const r = await tryHttp(`${app}/`);
        if (r.status === 200 && r.json?.version === version) return r;
        await sleep(10_000);
      }
      throw new Error(`${app} never served version ${version}`);
    };

    let first: Conn | null = null;
    const opened = await rec.check("the owner opens an MCP build; the IDE initializes and lists the build tools", async () => {
      first = await open();
      const init = await send(first, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gym-ide", version: "1" } });
      assert(init.status === 200 && /serverInfo|protocolVersion/.test(init.text), `initialize ${init.status}: ${short(init.text)}`);
      const list = await send(first, "tools/list");
      const names = ((list.json?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
      const want = ["write_file", "validate", "deploy", "check_app", "query_db", "list_data_files", "finish"];
      assert(want.every((n) => names.includes(n)), `tools: ${names.join(",")}`);
      return `${names.length} tools`;
    });
    if (!opened || !first) return;
    const c1 = first as Conn;

    const staged = await rec.check("the IDE writes the app and deploys the test copy; it answers, reaches no host, and its database is queryable", async () => {
      await writeAll(c1, appFiles("1"));
      const home = await tool(c1, "check_app", { path: "/" });
      assert(/200/.test(home) && /version\W+1/.test(home), `check_app /: ${short(home, 200)}`);
      const probe = await tool(c1, "check_app", { path: "/probe?host=example.com" });
      assert(/reached\W{0,6}false/.test(probe), `staging reached the internet: ${short(probe, 200)}`);
      await tool(c1, "check_app", { path: "/write?text=staging-sample" });
      const q = await tool(c1, "query_db", { sql: "SELECT body FROM notes ORDER BY id" });
      assert(/staging-sample/.test(q), `query_db: ${short(q, 200)}`);
      return "200, example.com blocked, query_db reads the copy";
    });
    if (!staged) return;

    const live = await rec.check("finish: the app goes live on the owner's server with a valid certificate", async () => {
      await tool(c1, "finish", {});
      const r = await waitVersion("1");
      return `${app} → ${r.status} (TLS verified)`;
    });
    if (!live) return;

    await rec.check("after finish the build's key opens nothing (401, with the sentence)", async () => {
      const r = await send(c1, "ping");
      assert(r.status === 401 && /doesn't open a build on this server/.test(r.text), `${r.status}: ${short(r.text)}`);
      return "401";
    });

    let apiKey = "";
    await rec.check("live data and an API key exist before the change", async () => {
      const w = await http(`${app}/write?text=LIVEDATA-${randomBytes(3).toString("hex")}`);
      assert(w.status === 200, `/write ${w.status}`);
      const grant: AppApiKeyGrant = { serverDomain: b.fqdn, serviceId, keyId: randomBytes(8).toString("hex"), scope: "read", expiresAt: 0, issuedAt: Date.now() };
      const k = await postJson(`https://${b.fqdn}/api/screens/services/${encodeURIComponent(serviceId)}/api-keys`, { grant, signature: bytesToHex(signAppApiKeyGrant(grant, acct.keys.adminRoot)), label: "gym ide" }, s);
      assert(k.status === 200 && k.json?.key, `api key ${k.status}: ${short(k.text)}`);
      apiKey = k.json.key;
      return "row + file written, read key minted";
    });

    let c2: Conn | null = null;
    const changed = await rec.check("Change this app: the edit build's test copy holds sample data only, the change goes live", async () => {
      c2 = await open(serviceId);
      await send(c2, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gym-ide", version: "1" } });
      await writeAll(c2, appFiles("2"));
      const q = await tool(c2, "query_db", { sql: "SELECT body FROM notes" });
      assert(!/LIVEDATA/.test(q), `the test copy holds live rows: ${short(q, 200)}`);
      const files = await tool(c2, "list_data_files", {});
      assert(!/LIVEDATA/.test(files), `the test copy holds live files: ${short(files, 200)}`);
      await tool(c2, "finish", {});
      await waitVersion("2");
      return "sample data only; version 2 live";
    });
    if (changed) {
      await rec.check("the live rows, file and API key survive the change", async () => {
        const r = await http(`${app}/read`);
        assert((r.json?.rows ?? []).some((x: string) => x.startsWith("LIVEDATA")) && String(r.json?.file ?? "").length > 0, `/read ${short(r.text)}`);
        const k = await http(`${app}/`, { headers: { authorization: `Bearer ${apiKey}` } });
        assert(k.status === 200, `API key after the change ${k.status}`);
        return "rows + key ok";
      });
    }

    await rec.check("key scoping: no key, a rotated key, and another build's key at this URL are refused (401, with sentences)", async () => {
      const c3 = await open();
      const c4 = await open();
      const none = await send({ url: c3.url, key: null }, "ping");
      assert(none.status === 401 && /has no key/.test(none.text), `no key ${none.status}: ${short(none.text)}`);
      const cross = await send({ url: c3.url, key: c4.key }, "ping");
      assert(cross.status === 401, `another build's key ${cross.status}: ${short(cross.text)}`);
      const rot = await postJson(`https://${b.fqdn}/api/build/sessions/${c3.buildId}/mcp/rotate`, { label: "gym ide" }, s);
      assert(rot.status === 200 && rot.json?.key && rot.json.key !== c3.key, `rotate ${rot.status}: ${short(rot.text)}`);
      const old = await send(c3, "ping");
      assert(old.status === 401 && /replaced|doesn't open/.test(old.text), `rotated-out key ${old.status}: ${short(old.text)}`);
      const fresh = await send({ url: rot.json.url ?? c3.url, key: rot.json.key }, "ping");
      assert(fresh.status === 200, `new key ${fresh.status}: ${short(fresh.text)}`);
      for (const c of [c3, c4]) await postJson(`https://${b.fqdn}/api/build/sessions/${c.buildId}/discard`, {}, s).catch(() => null);
      return "401 ×3, new key 200";
    });

    await rec.check("privacy: no MCP answer names the account, the server or the box", () => {
      const text = seen.join("\n").toLowerCase();
      const needles = [acct.username, b.fqdn, `home.${acct.username}`, `gym ${acct.username}`].map((n) => n.toLowerCase());
      const hits = needles.filter((n) => text.includes(n));
      assert(!hits.length, `answers name: ${hits.join(", ")}`);
      return `${seen.length} answers, ${text.length} chars scanned`;
    });
  },
};
