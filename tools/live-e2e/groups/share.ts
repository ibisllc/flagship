// Share a server (docs/share-a-server.md): A shares home2 with account B at
// the manage level (admin-root-signed grant + B's acceptance), B opens a share
// session with its per-share member key, sees the server but is refused every
// owner-only action, then A revokes and B's session ends.
import { bytesToHex } from "@noble/hashes/utils";
import {
  deriveShareMemberKey,
  randomShareId,
  signServerShareAccept,
  signServerShareGrant,
  signServerShareRevoke,
  signServerShareSession,
  type ServerShareAccept,
  type ServerShareGrant,
  type ServerShareRevoke,
  type ServerShareSession,
} from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep } from "../lib/harness.js";
import type { Group } from "./types.js";

export const share: Group = {
  name: "share",
  title: "share home2 with account B (manage), B's limits, revoke",
  needs: ["A2", "B1"],
  phase: 2,
  async run({ A, B, rec, box }) {
    const b = box("A2");
    const ownerSession = await pair(A, b);
    const shareId = randomShareId();
    const member = deriveShareMemberKey({ seed: B!.keys.umk }, shareId);
    const memberPubHex = bytesToHex(member.publicKey);
    const grant: ServerShareGrant = {
      serverDomain: b.fqdn,
      shareId,
      memberPubHex,
      level: "manage",
      unlockAtBoot: false,
      seeAppData: false,
      label: "gym co-manager",
      issuedAt: Date.now(),
    };
    const accept: ServerShareAccept = { serverDomain: b.fqdn, shareId, memberPubHex, acceptedAt: Date.now() };
    const acceptSignature = bytesToHex(signServerShareAccept(accept, member));

    await rec.check("a share grant signed by A's owner IRK is refused", async () => {
      const r = await postJson(`https://${b.fqdn}/api/screens/shares`, { grant, signature: bytesToHex(signServerShareGrant(grant, A.keys.irk)), accept, acceptSignature }, { "x-flagship-session": ownerSession });
      assert(r.status === 403 || r.status === 400, `expected refusal, got ${r.status}: ${short(r.text)}`);
      return `${r.status}`;
    });
    const shared = await rec.check("A shares home2 with B (admin-root grant + B's acceptance)", async () => {
      const r = await postJson(`https://${b.fqdn}/api/screens/shares`, { grant, signature: bytesToHex(signServerShareGrant(grant, A.keys.adminRoot)), accept, acceptSignature }, { "x-flagship-session": ownerSession });
      assert(r.status === 200 && r.json?.ok, `${r.status}: ${short(r.text)}`);
      return `share ${shareId.slice(0, 8)}… level=manage`;
    });
    if (!shared) return;

    let token = "";
    const opened = await rec.check("B opens a share session (nonce + member-key signature)", async () => {
      const n = await http(`https://${b.fqdn}/api/shares/nonce`);
      assert(n.status === 200 && n.json?.nonce, `nonce ${n.status}: ${short(n.text)}`);
      const session: ServerShareSession = { serverDomain: b.fqdn, shareId, memberPubHex, nonceHex: n.json.nonce, issuedAt: Date.now() };
      const r = await postJson(`https://${b.fqdn}/api/shares/session`, { session, signature: bytesToHex(signServerShareSession(session, member)) });
      assert(r.status === 200 && r.json?.token, `${r.status}: ${short(r.text)}`);
      token = r.json.token;
      assert(r.json.level === "manage", `level=${r.json.level}`);
      return `level=${r.json.level}`;
    });
    if (!opened) return;
    const bs = { "x-flagship-session": token };
    await rec.check("B sees the server (shares/me, server-detail, apps-list)", async () => {
      const me = await http(`https://${b.fqdn}/api/shares/me`, { headers: bs });
      assert(me.status === 200 && me.json?.shareId === shareId, `me ${me.status}: ${short(me.text)}`);
      for (const p of ["/api/screens/server-detail", "/api/screens/apps-list"]) {
        const r = await http(`https://${b.fqdn}${p}`, { headers: bs });
        assert(r.status === 200, `${p} ${r.status}: ${short(r.text)}`);
      }
      return `canUpdate=${me.json.canUpdate}`;
    });
    await rec.check("B is refused owner-only actions (builds, MCP, copies, server order, share admin)", async () => {
      const probes: Array<[string, string, unknown]> = [
        ["POST", "/api/build/mcp", { label: "x" }],
        ["POST", "/api/screens/services/copy", {}],
        ["POST", "/api/screens/server-order", {}],
        ["POST", "/api/screens/shares", {}],
      ];
      const got: string[] = [];
      for (const [method, path, body] of probes) {
        const r = await http(`https://${b.fqdn}${path}`, { method, headers: { "content-type": "application/json", ...bs }, body: JSON.stringify(body) });
        got.push(`${path}=${r.status}`);
        assert(r.status === 403 || r.status === 401, `${path} answered ${r.status}: ${short(r.text)}`);
      }
      return got.join(" ");
    });
    await rec.check("A revokes (admin-root signed) → B's session ends", async () => {
      const revoke: ServerShareRevoke = { serverDomain: b.fqdn, shareId, issuedAt: Date.now() };
      const r = await postJson(`https://${b.fqdn}/api/screens/shares/revoke`, { revoke, signature: bytesToHex(signServerShareRevoke(revoke, A.keys.adminRoot)) }, { "x-flagship-session": ownerSession });
      assert(r.status === 200, `revoke ${r.status}: ${short(r.text)}`);
      await sleep(1000);
      const me = await http(`https://${b.fqdn}/api/shares/me`, { headers: bs });
      assert(me.status === 403 || me.status === 401, `after revoke: ${me.status} ${short(me.text)}`);
      return `${me.status} ${short(me.json?.error ?? me.text, 40)}`;
    });
  },
};
