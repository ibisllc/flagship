// Cross-owner app chat between two accounts' boxes (0.3): each account runs a small chat probe app that
// listens; account B's app starts a conversation with account A's app. Nothing arrives until B's admin
// approves the outgoing contact and A's admin answers the incoming request (both signed
// `flagship/chat-approval/v1`); A's reply comes back to B; and A's Always allow covers that one sender.
// Frames go to the receiving app's canonical name, so both accounts need gossip (lib/cgk.ts).
import { bytesToHex } from "@noble/hashes/utils";
import { ed, signChatApproval, type ChatApprovalDecision, type ChatApprovalKind } from "@flagship/protocol";
import { depositCgk, waitGossiping } from "../../lib/cgk.js";
import { pair, type Account, type Box } from "../../lib/fleet.js";
import { assert, http, postJson, short, tryHttp } from "../../lib/harness.js";
import { buildAndDeploy, finishAndWaitLive, mcpOpen } from "../../lib/mcpBuild.js";
import type { Group } from "../types.js";
import { allowEgress, uninstall, until } from "./util.js";

const SLUG = "chatprobe";

/** A Python app that drives the box's chat API with its app token (urllib follows the egress proxy). */
function probeFiles(boxFqdn: string): Record<string, string> {
  return {
    "flagship.app.json": JSON.stringify({
      schema_version: 1,
      name: SLUG,
      version: "0.1.0",
      description: "gym chat probe",
      runtime: { base: "python-3.13", port: 8080, start: ["python", "app.py"], env: { GYM_BOX: boxFqdn } },
      data: {},
      network: { subdomain: SLUG, egress: [{ host: boxFqdn, why: "the box's app chat API" }] },
      access: { enabled: true, public_routes: ["/*"], default_role: "member", role_descriptions: { member: "Uses it.", manager: "Same.", master: "Same." } },
      migration: { verification: "standard" },
    }, null, 2),
    "app.py": `import json, os, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BOX = "https://" + os.environ["GYM_BOX"]
TOKEN = os.environ.get("FLAGSHIP_APP_TOKEN", "")
EVENTS = []

def call(method, path, body=None):
    req = urllib.request.Request(BOX + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)[:300]}

class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/":
            return self.send(200, {"app": "chat"})
        if u.path == "/listen":
            s, j = call("POST", "/api/chat/v1/listen", {"originScope": "all-accounts", "ownedInstanceScope": "this-server"})
            return self.send(200, {"status": s, "body": j})
        if u.path == "/send":
            s, j = call("POST", "/api/chat/v1/message", {"receiverAuthor": q["author"], "receiverApp": q["app"], "targetUser": q["user"], "body": q["body"], "requestId": q["rid"]})
            return self.send(200, {"status": s, "body": j})
        if u.path == "/reply":
            s, j = call("POST", "/api/chat/v1/message", {"conversationId": q["cid"], "body": q["body"], "requestId": q["rid"]})
            return self.send(200, {"status": s, "body": j})
        if u.path == "/poll":
            s, j = call("GET", "/api/chat/v1/poll")
            EVENTS.extend(j.get("events", []) if isinstance(j, dict) else [])
            return self.send(200, {"status": s, "events": EVENTS})
        return self.send(404, {"error": "no route"})

    def log_message(self, *a):
        pass

ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
`,
  };
}

async function answer(acct: Account, b: Box, session: string, requestId: string, kind: ChatApprovalKind, decision: ChatApprovalDecision) {
  const issuedAt = Date.now();
  const sig = signChatApproval({ serverDomain: b.fqdn, requestId, kind, decision, issuedAt }, (m) => ed.sign(m, acct.keys.adminRoot.privateKey));
  return postJson(`https://${b.fqdn}/api/screens/chat/answer`, { requestId, kind, decision, issuedAt, signature: bytesToHex(sig) }, { "x-flagship-session": session });
}

type ChatReq = { requestId: string; kind: ChatApprovalKind; claimedSender: { author: string; slug: string }; receiverApp: { author: string; slug: string } };

async function waitRequest(b: Box, session: string, kind: ChatApprovalKind, ms = 3 * 60_000): Promise<ChatReq> {
  return until(`a ${kind} chat request on ${b.serverName}`, ms, async () => {
    const r = await http(`https://${b.fqdn}/api/screens/chat/requests`, { headers: { "x-flagship-session": session } });
    return ((r.json?.requests ?? []) as ChatReq[]).find((x) => x.kind === kind);
  });
}

async function events(app: string): Promise<Array<{ type: string; envelope?: { body?: string; conversationId?: string; claimedSender?: { author: string; slug: string } } }>> {
  const r = await http(`${app}/poll`);
  return r.json?.events ?? [];
}

export const chatCrossOwner: Group = {
  name: "chat-cross-owner",
  title: "app chat across two accounts: both admins approve, the reply comes back, Always allow covers one sender",
  needs: ["A1", "B1"],
  phase: 8,
  parallel: false,
  async run({ A, B, rec, box }) {
    assert(B, "account B is required");
    const a = box("A1");
    const bb = box("B1");
    const sa = await pair(A, a);
    const sb = await pair(B, bb);

    const gossip = await rec.check("both accounts' servers gossip, so each holds its app's canonical name", async () => {
      for (const [acct, b] of [[A, a], [B, bb]] as const) {
        if (!(await waitGossiping([b], 30_000))) {
          await depositCgk(acct, [b]);
          assert(await waitGossiping([b]), `${acct.username}'s box never reported gossipActive`);
        }
      }
      return "gossipActive on both";
    });
    if (!gossip) return;

    const deploy = async (acct: Account, b: Box, session: string) => {
      const c = await mcpOpen(b, session, `gym-${SLUG}`);
      await buildAndDeploy(c, probeFiles(b.fqdn));
      await finishAndWaitLive(c, b, `${acct.username}--${SLUG}`);
      await allowEgress(acct, b, session, `${acct.username}--${SLUG}`, b.fqdn);
      const app = `https://${SLUG}.${b.fqdn}`;
      const l = await until("the app listening", 3 * 60_000, async () => {
        const r = await tryHttp(`${app}/listen`);
        return r.json?.status === 200 ? r.json : undefined;
      });
      return { app, listen: l };
    };
    let appA = "";
    let appB = "";
    const up = await rec.check("a chat probe app runs and listens on each account's server", async () => {
      appA = (await deploy(A, a, sa)).app;
      appB = (await deploy(B, bb, sb)).app;
      return `${appA} and ${appB}`;
    });
    if (!up) return;

    await rec.check("B's start waits for B's admin; nothing reaches A before that", async () => {
      const r = await http(`${appB}/send?user=${A.username}&author=${A.username}&app=${SLUG}&body=hello-from-b&rid=gym1`);
      assert(r.json?.status === 200 && r.json?.body?.accepted === true, `send: ${short(r.json)}`);
      await waitRequest(bb, sb, "outgoing");
      const onA = await http(`https://${a.fqdn}/api/screens/chat/requests`, { headers: { "x-flagship-session": sa } });
      assert(!(onA.json?.requests ?? []).some((x: ChatReq) => x.kind === "incoming"), "A already has an incoming request");
      return "held as outgoing on B";
    });
    await rec.check("B's admin allows it (signed); A's admin sees the incoming request naming B's app as a claim", async () => {
      const out = await waitRequest(bb, sb, "outgoing");
      const r = await answer(B, bb, sb, out.requestId, "outgoing", "allow");
      assert(r.status === 200, `answer ${r.status}: ${short(r.text)}`);
      const inc = await waitRequest(a, sa, "incoming");
      assert(inc.claimedSender.author === B.username && inc.claimedSender.slug === SLUG, `claimed ${short(inc.claimedSender)}`);
      assert((await events(appA)).every((e) => e.envelope?.body !== "hello-from-b"), "delivered before A answered");
      return "incoming held";
    });
    let cid = "";
    await rec.check("A's admin answers Always allow (signed); the message arrives at A's app", async () => {
      const inc = await waitRequest(a, sa, "incoming");
      const unsigned = await postJson(`https://${a.fqdn}/api/screens/chat/answer`, { requestId: inc.requestId, kind: "incoming", decision: "always", issuedAt: Date.now(), signature: "00".repeat(64) }, { "x-flagship-session": sa });
      assert(unsigned.status === 403, `an unsigned answer got ${unsigned.status}`);
      const r = await answer(A, a, sa, inc.requestId, "incoming", "always");
      assert(r.status === 200, `answer ${r.status}: ${short(r.text)}`);
      const msg = await until("the message at A", 2 * 60_000, async () => (await events(appA)).find((e) => e.envelope?.body === "hello-from-b"));
      cid = String(msg.envelope?.conversationId ?? "");
      assert(cid, "no conversation id");
      return `conversation ${cid.slice(0, 8)}…`;
    });
    if (!cid) return;
    await rec.check("A's reply comes back to B's app", async () => {
      const r = await http(`${appA}/reply?cid=${encodeURIComponent(cid)}&body=pong-from-a&rid=gym2`);
      assert(r.json?.status === 200, `reply: ${short(r.json)}`);
      await until("the reply at B", 2 * 60_000, async () => (await events(appB)).find((e) => e.envelope?.body === "pong-from-a"));
      return "pong arrived";
    });
    await rec.check("Always allow lets B's app start again without a prompt, and covers only that sender", async () => {
      const out = await http(`${appB}/send?user=${A.username}&author=${A.username}&app=${SLUG}&body=second-from-b&rid=gym3`);
      assert(out.json?.body?.accepted === true, `send: ${short(out.json)}`);
      await until("the second message at A", 2 * 60_000, async () => (await events(appA)).find((e) => e.envelope?.body === "second-from-b"));
      const r = await http(`https://${a.fqdn}/api/screens/chat/requests`, { headers: { "x-flagship-session": sa } });
      const always = (r.json?.always ?? []) as Array<{ receiverApp: { slug: string }; claimedSender: { author: string; slug: string } }>;
      assert(always.length === 1 && always[0]!.claimedSender.author === B.username && always[0]!.receiverApp.slug === SLUG, `always: ${short(always)}`);
      return "delivered without a prompt; one standing approval";
    });
    await uninstall(A, a, SLUG);
    await uninstall(B, bb, SLUG);
  },
};
