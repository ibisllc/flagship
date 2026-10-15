// AI build with no real model: a scripted OpenAI-compatible stub runs as an
// app on account B's box, and account A's box drives a chat build against it
// (the stub answers with the files; the box builds, tests and installs them). The stub records every request the box sent, so the
// run proves the model never learned who or where the owner is (AGENTS.md:
// "An AI never learns who or where the owner is").
import { bytesToHex } from "@noble/hashes/utils";
import { signUninstallService, type UninstallServiceRequest } from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen, tool } from "../lib/mcpBuild.js";
import type { Group } from "./types.js";

const STUB = "aistub";
const BUILT = `ai${Date.now().toString(36).slice(-5)}`;

const roles = {
  default_role: "member",
  role_descriptions: { member: "Uses the app.", manager: "Same as member.", master: "Same as member." },
};

const stubFiles: Record<string, string> = {
  "flagship.app.json": JSON.stringify({
    schema_version: 1,
    name: STUB,
    version: "0.1.0",
    description: "gym scripted model",
    runtime: { base: "python-3.13", port: 8080, start: ["python", "stub.py"] },
    data: { stores: { files: true } },
    network: { subdomain: STUB },
    access: { enabled: true, public_routes: ["/*"], ...roles },
    migration: { verification: "standard" },
  }, null, 2),
  "requirements.txt": "\n",
  "stub.py": `import json, os, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.path.join(os.environ.get("FLAGSHIP_FILES_DIR", "/data"), "requests.jsonl")
def app_for(name):
    return {"schema_version": 1, "name": name, "version": "0.1.0", "description": "gym ai page",
       "runtime": {"base": "static", "port": 8080}, "network": {"subdomain": name},
       "access": {"enabled": True, "public_routes": ["/*"], "default_role": "member",
                  "role_descriptions": {"member": "Reads the page.", "manager": "Same.", "master": "Same."}},
       "migration": {"verification": "standard"}}
APP = app_for("aiapp")
SCRIPT = [
    [("write_file", {"path": "flagship.app.json", "content": json.dumps(APP)}),
     ("write_file", {"path": "index.html", "content": "<!doctype html><p>gym-ai-ok</p>"})],
    [("deploy", {})],
    [("finish", {})],
]

def chunk(obj):
    return ("data: " + json.dumps(obj) + "\\n\\n").encode()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/log"):
            try:
                body = open(LOG, "rb").read()
            except FileNotFoundError:
                body = b""
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/v1/models"):
            out = json.dumps({"object": "list", "data": [{"id": "stub", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(out)
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"stub ok")

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(n)
        with open(LOG, "ab") as f:
            f.write(raw.replace(b"\\n", b" ") + b"\\n")
        req = json.loads(raw or b"{}")
        turn = sum(1 for m in req.get("messages", []) if m.get("role") == "assistant")
        tools = [t.get("function", {}).get("name") for t in req.get("tools", [])]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        if "deploy" not in tools:
            asked = re.search(r"Name it ([a-z0-9]+)", json.dumps(req.get("messages", [])))
            text = "=== flagship.app.json ===\\n" + json.dumps(app_for(asked.group(1) if asked else "aiapp"), indent=2) + "\\n=== index.html ===\\n<!doctype html><p>gym-ai-ok</p>\\n=== END ===\\n"
            self.wfile.write(chunk({"choices": [{"index": 0, "delta": {"content": text}}]}))
            self.wfile.write(chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}))
        elif turn < len(SCRIPT):
            for i, (name, args) in enumerate(SCRIPT[turn]):
                self.wfile.write(chunk({"choices": [{"index": 0, "delta": {"tool_calls": [{"index": i, "id": "call_%d_%d" % (turn, i), "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}]}))
            self.wfile.write(chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}))
        else:
            self.wfile.write(chunk({"choices": [{"index": 0, "delta": {"content": "The page is live."}}]}))
            self.wfile.write(chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}))
        self.wfile.write(b"data: [DONE]\\n\\n")

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
};

export const aiStaging: Group = {
  name: "ai-staging",
  title: "AI build on the staging copy against a scripted model; no owner identity reaches the model",
  needs: ["A1", "B1"],
  phase: 2,
  async run({ A, B, rec, box }) {
    const a1 = box("A1");
    const b1 = box("B1");
    const stubUrl = `https://${STUB}.${b1.fqdn}`;
    const bSession = await pair(B!, b1);
    const stubUp = await rec.check("the scripted model is live on account B's box", async () => {
      const listed = await http(`https://${b1.fqdn}/api/services`);
      if (listed.text.includes(`${B!.username}--${STUB}`)) {
        const req: UninstallServiceRequest = { serverId: b1.fqdn, creator: B!.username, slug: STUB, issuedAt: Date.now() };
        await http(`https://${b1.fqdn}/api/services/${encodeURIComponent(`${B!.username}--${STUB}`)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, B!.keys.adminRoot)) }),
        }, 120_000);
      }
      const c = await mcpOpen(b1, bSession, "gym-aistub");
      await buildAndDeploy(c, stubFiles);
      await tool(c, "check_app", { path: "/" });
      await finishAndWaitLive(c, b1, `${B!.username}--${STUB}`);
      for (let i = 0; i < 24; i++) {
        const r = await tryHttp(`${stubUrl}/`);
        if (r.status === 200) return stubUrl;
        await sleep(5000);
      }
      throw new Error("stub not serving");
    });
    if (!stubUp) return;

    const session = await pair(A, a1);
    const s = { "x-flagship-session": session };
    let sessionId = "";
    const started = await rec.check("A starts an AI build with the stub as its OpenAI-compatible provider", async () => {
      const r = await postJson(`https://${a1.fqdn}/api/screens/vibe-code/start`, {
        prompt: `Make a one-page site that says gym-ai-ok. Name it ${BUILT}.`,
        name: BUILT,
        model: "stub",
        credential: { provider: "openai", apiKey: "gym-stub-key", baseUrl: stubUrl },
      }, s, 60_000);
      assert(r.status === 200 && r.json?.sessionId && !r.json?.needsCredential, `${r.status}: ${short(r.text)}`);
      sessionId = r.json.sessionId;
      return sessionId;
    });
    if (!started) return;
    await rec.check("the box builds the scripted files, tests them on a staging copy and installs them live", async () => {
      const snap = () => tryHttp(`https://${a1.fqdn}/api/screens/vibe-code/${encodeURIComponent(sessionId)}`, { headers: s });
      const waitFor = async (want: RegExp, minutes: number): Promise<string> => {
        const deadline = Date.now() + minutes * 60_000;
        let last = "";
        while (Date.now() < deadline) {
          const r = await snap();
          last = `${r.json?.status} ${r.json?.deployPhase ?? ""} ${short(r.json?.errorReason ?? "", 160)}`;
          if (want.test(String(r.json?.status))) return last;
          if (/failed|cancelled/.test(String(r.json?.status))) throw new Error(last);
          await sleep(10_000);
        }
        throw new Error(`timed out (${last})`);
      };
      await waitFor(/^ready-to-deploy$/, 5);
      const d = await postJson(`https://${a1.fqdn}/api/llm/sessions/${encodeURIComponent(sessionId)}/deploy`, { background: true }, s, 120_000);
      assert(d.status === 200 || d.status === 202, `deploy ${d.status}: ${short(d.text)}`);
      const last = await waitFor(/^deployed$/, 20);
      const list = await http(`https://${a1.fqdn}/api/services`);
      assert(list.text.includes(`${A.username}--${BUILT}`), `not installed (${last})`);
      for (let i = 0; i < 24; i++) {
        const g = await tryHttp(`https://${BUILT}.${a1.fqdn}/`);
        if (g.status === 200 && /gym-ai-ok/.test(g.text)) return `live (${last})`;
        await sleep(5000);
      }
      throw new Error(`app not serving gym-ai-ok (${last})`);
    });
    await rec.check("nothing the model received names the owner's account or server", async () => {
      const log = await http(`${stubUrl}/log`);
      const bodies = log.text.split("\n").filter(Boolean);
      assert(bodies.length >= 1, "no model request recorded");
      const leaks = [A.username, a1.fqdn, `${A.username}.`].filter((needle) => log.text.toLowerCase().includes(needle.toLowerCase()));
      assert(leaks.length === 0, `model saw: ${leaks.join(", ")}`);
      return `${bodies.length} request(s), no account or server name`;
    });
  },
};
