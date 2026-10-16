// The original live backend e2e (run.ts), on the shared fleet: real TLS, the
// directory, the box's unauthenticated + owner-signed API, a paired session,
// git import, MCP, the vibe-code gate, server management under the admin-root
// model, and a full image-app lifecycle.
import { bytesToHex } from "@noble/hashes/utils";
import {
  signInstallService,
  signJournalRequest,
  signPhoneOrder,
  signSetDeadManPolicy,
  signServiceEnvChange,
  serviceEnvValueSha256,
  signUninstallService,
  type InstallServiceRequest,
  type JournalRequest,
  type PhoneOrder,
  type SetDeadManPolicy,
  type ServiceEnvChange,
  type UninstallServiceRequest,
} from "@flagship/protocol";
import { pair } from "../lib/fleet.js";
import { CONTROL, assert, certInfo, http, postJson, rawTlsGet, short, sleep, tryHttp } from "../lib/harness.js";
import type { Group } from "./types.js";

export function whoamiManifest(slug: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    name: slug,
    version: "0.1.0",
    description: "gym whoami probe",
    runtime: { image: "traefik/whoami", port: 80 },
    data: {},
    network: { subdomain: slug },
    access: { enabled: true, public_routes: ["/"] },
    migration: { verification: "standard" },
    ...extra,
  });
}

export const core: Group = {
  name: "core",
  title: "live backend e2e (TLS, directory, owner API, paired session, image app lifecycle)",
  needs: ["A1"],
  phase: 1,
  async run({ A, rec, box }) {
    const b = box("A1");
    const fqdn = b.fqdn;
    const user = A.username;
    const { irk, adminRoot } = A.keys;

    await rec.check("control plane health 200", async () => {
      const r = await http(`https://${CONTROL}/api/health`);
      assert(r.status === 200, `got ${r.status}`);
      return `surface=${r.json?.surface}`;
    });
    await rec.check("box serves HTTP 200 (the daemon apex page)", async () => {
      const r = await http(`https://${fqdn}/`);
      assert(r.status === 200 && /Flagship/i.test(r.text), `got ${r.status}`);
      return `${r.text.length}B html`;
    });
    await rec.check("box presents a Let's Encrypt cert for its FQDN + per-box wildcard", () => {
      const c = certInfo(fqdn);
      assert(/Let's Encrypt/i.test(c.issuer), `issuer=${c.issuer || "<none>"}`);
      assert(c.sans.includes(fqdn) && c.sans.includes(`*.${fqdn}`), `sans=${c.sans.join(",")}`);
      return c.sans.join(", ");
    });
    await rec.check("GET /api/front-page returns the apex assignment", async () => {
      const r = await http(`https://${fqdn}/api/front-page`);
      assert(r.status === 200, `got ${r.status}`);
      return short(r.json, 70);
    });
    await rec.check("/pods shows the box online with a verified cert", async () => {
      const r = await http(`https://${CONTROL}/api/users/${user}/pods`);
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      const p = r.json?.pods?.find((x: { serverDomain: string }) => x.serverDomain === fqdn);
      assert(p, `box not in /pods`);
      assert(p.state === "online", `state=${p.state}`);
      return `state=${p.state} cert=${p.currentCert ? "set" : "-"}`;
    });
    await rec.check("the account is admin-pinned (sensitive orders need the admin root)", async () => {
      const r = await http(`https://${CONTROL}/api/username/${user}`);
      assert(r.status === 200, `username lookup ${r.status}`);
      assert(r.json?.adminRootPub === bytesToHex(adminRoot.publicKey), `adminRootPub=${short(r.json?.adminRootPub, 20)}`);
      return "adminRootPub = the demo admin root";
    });

    await rec.check("POST /api/journal (owner-IRK signed) returns daemon log lines", async () => {
      const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 25, issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/journal`, { request: req, signature: bytesToHex(signJournalRequest(req, irk)) });
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      const lines = r.json?.lines ?? r.json?.log ?? [];
      assert(Array.isArray(lines) && lines.length > 0, "no lines");
      return `${lines.length} lines`;
    });
    await rec.check("POST /api/journal rejects a forged signature", async () => {
      const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 5, issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/journal`, { request: req, signature: "00".repeat(64) });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
      return `rejected ${r.status}`;
    });

    const svc = await tryHttp(`https://${fqdn}/api/services`);
    await rec.check("ServicePlatform constructed (GET /api/services 200)", () => {
      assert(svc.status === 200, `got ${svc.status}: ${short(svc.text)}`);
      const list = Array.isArray(svc.json) ? svc.json : (svc.json?.apps ?? svc.json?.services);
      return `${list?.length ?? 0} services`;
    });

    let token = "";
    await rec.check("mint a paired session (add-paired-session, delegated-key signed)", async () => {
      token = await pair(A, b);
      return "token accepted";
    });
    const session = { "x-flagship-session": token };
    if (token) {
      await rec.check("git-import returns a fitness verdict (real clone)", async () => {
        const r = await postJson(`https://${fqdn}/api/build/git`, { gitUrl: "https://github.com/octocat/Hello-World", ref: "master" }, session, 90_000);
        assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
        return r.json?.fit !== undefined ? `fit=${r.json.fit}` : short(r.json, 80);
      });
      await rec.check("MCP connect mints a key, lists tools and runs get_contract", async () => {
        const mint = await postJson(`https://${fqdn}/api/build/mcp`, { label: "gym-ide" }, session);
        assert(mint.status === 200, `mint ${mint.status}: ${short(mint.text)}`);
        const conn = mint.json?.connection ?? mint.json;
        assert(conn?.url && conn?.key, `no url/key: ${short(mint.json)}`);
        const rpc = async (body: unknown) => {
          const r = await http(conn.url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${conn.key}` },
            body: JSON.stringify(body),
          }, 30_000);
          assert(r.status === 200, `rpc ${r.status}: ${short(r.text)}`);
          return r.json ?? JSON.parse((r.text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
        };
        const tools = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.result?.tools ?? [];
        assert(tools.length > 0, "no tools");
        const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_contract", arguments: {} } });
        assert(!call?.error && JSON.stringify(call?.result ?? "").length > 20, `get_contract: ${short(call)}`);
        return `${tools.length} tools; get_contract ran`;
      });
      await rec.check("vibe-code start with no key and no free AI → needsCredential", async () => {
        const r = await postJson(`https://${fqdn}/api/screens/vibe-code/start`, { prompt: "build a hello world note app" }, session);
        assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
        assert(r.json?.needsCredential === true, `expected needsCredential: ${short(r.json)}`);
        return "needsCredential";
      });
    }

    await rec.check("front-page set (admin-root signed) accepted", async () => {
      const order: PhoneOrder = { type: "set-front-page", serverId: fqdn, label: "", issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/front-page`, { request: order, signature: bytesToHex(signPhoneOrder(order, adminRoot)) });
      assert(r.status === 200, `got ${r.status}: ${short(r.text)}`);
      return "set ok";
    });
    await rec.check("front-page set signed by the owner IRK is REJECTED (admin-pinned box)", async () => {
      const order: PhoneOrder = { type: "set-front-page", serverId: fqdn, label: "", issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/front-page`, { request: order, signature: bytesToHex(signPhoneOrder(order, irk)) });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
      return `rejected ${r.status}`;
    });
    await rec.check("POST /api/power rejects a forged signature", async () => {
      const req = { type: "power-off", serverId: fqdn, mode: "restart", issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/power`, { request: req, signature: "00".repeat(64) });
      assert(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
      return `rejected ${r.status}`;
    });
    const deadman = (): SetDeadManPolicy => ({
      serverId: fqdn,
      enabled: false,
      windowMs: 24 * 3_600_000,
      graceMs: 3_600_000,
      lockoutMode: "off",
      issuedAt: Date.now(),
    });
    await rec.check("dead-man policy rejects a forged signature", async () => {
      const r = await postJson(`https://${fqdn}/api/deadman/policy`, { request: deadman(), signature: "00".repeat(64) });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
      return `rejected ${r.status}`;
    });
    await rec.check("dead-man policy rejects the owner IRK (admin-pinned box)", async () => {
      const req = deadman();
      const r = await postJson(`https://${fqdn}/api/deadman/policy`, { request: req, signature: bytesToHex(signSetDeadManPolicy(req, irk)) });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
      return `rejected ${r.status}`;
    });
    await rec.check("dead-man policy set (admin-root signed, disabled — never arms) → 200", async () => {
      const req = deadman();
      const r = await postJson(`https://${fqdn}/api/deadman/policy`, { request: req, signature: bytesToHex(signSetDeadManPolicy(req, adminRoot)) });
      assert(r.status === 200 && r.json?.enabled === false, `got ${r.status}: ${short(r.text)}`);
      return "accepted (disarmed)";
    });

    const slug = "corewho";
    const serviceId = `${user}--${slug}`;
    let installed = false;
    await rec.check("install an image app (owner-IRK signed) → listed", async () => {
      const req: InstallServiceRequest = { serverId: fqdn, creator: user, slug, manifestJson: whoamiManifest(slug), addOwnerToMembership: true, issuedAt: Date.now() };
      const r = await postJson(`https://${fqdn}/api/services`, { request: req, signature: bytesToHex(signInstallService(req, irk)) }, {}, 120_000);
      assert(r.status === 200, `install ${r.status}: ${short(r.text, 240)}`);
      installed = true;
      const list = await http(`https://${fqdn}/api/services`);
      assert(list.text.includes(slug), "not listed");
      return "installed + listed";
    });
    if (!installed) return;
    const envChange = (op: "set" | "unset", name: string, value?: string): ServiceEnvChange => ({
      serverId: fqdn,
      serviceId,
      op,
      name,
      valueSha256: value === undefined ? "" : serviceEnvValueSha256(value),
      issuedAt: Date.now(),
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    });
    const envUrl = `https://${fqdn}/api/services/${encodeURIComponent(serviceId)}/env`;
    await rec.check("set two env vars and unset one (owner-IRK signed) → each 200, and a replay is refused", async () => {
      const a = envChange("set", "GYM_PROBE", "ok");
      const sigA = bytesToHex(signServiceEnvChange(a, irk));
      const r1 = await postJson(envUrl, { change: a, value: "ok", signature: sigA }, {}, 60_000);
      assert(r1.status === 200, `set GYM_PROBE ${r1.status}: ${short(r1.text)}`);
      const b = envChange("set", "GYM_OTHER", "x");
      const r2 = await postJson(envUrl, { change: b, value: "x", signature: bytesToHex(signServiceEnvChange(b, irk)) }, {}, 60_000);
      assert(r2.status === 200, `set GYM_OTHER ${r2.status}: ${short(r2.text)}`);
      const u = envChange("unset", "GYM_OTHER");
      const r3 = await postJson(envUrl, { change: u, signature: bytesToHex(signServiceEnvChange(u, irk)) }, {}, 60_000);
      assert(r3.status === 200, `unset GYM_OTHER ${r3.status}: ${short(r3.text)}`);
      const again = await postJson(envUrl, { change: a, value: "ok", signature: sigA });
      assert(again.status >= 400 && again.status < 500, `a replayed change got ${again.status}`);
      return "set, set, unset applied; replay refused";
    });
    await rec.check("app env change rejects a forged signature", async () => {
      const c = envChange("set", "X", "y");
      const r = await postJson(envUrl, { change: c, value: "y", signature: "00".repeat(64) });
      assert(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
      return `rejected ${r.status}`;
    });
    await rec.check("the app SERVES 200 at its subdomain (hub → wildcard cert → proxy → container)", async () => {
      const url = `https://${slug}.${fqdn}/`;
      let last = "";
      for (let i = 0; i < 36; i++) {
        const c = await tryHttp(url, {}, 12_000);
        if (c.status === 200) return `200${/Hostname/i.test(c.text) ? " (whoami body)" : ""}`;
        last = `${c.status} ${short(c.text, 100)}`;
        await sleep(5000);
      }
      const raw = rawTlsGet(`${slug}.${fqdn}`, `${slug}.${fqdn}`, "/");
      throw new Error(`not 200 in 180s: ${last} | raw ${raw.status} ${short(raw.text, 120)}`);
    });
    await rec.check("uninstall the app (admin-root signed) → 200", async () => {
      const req: UninstallServiceRequest = { serverId: fqdn, creator: user, slug, issuedAt: Date.now() };
      const r = await http(`https://${fqdn}/api/services/${encodeURIComponent(serviceId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: bytesToHex(signUninstallService(req, A.keys.adminRoot)) }),
      }, 90_000);
      assert(r.status === 200, `uninstall ${r.status}: ${short(r.text)}`);
      return "uninstalled";
    });
    await rec.check("maintainer-trust chain served and authorized now (gym CA enforced)", async () => {
      const r = await http(`https://${CONTROL}/api/maintainer-blessing`);
      assert(r.status === 200 && r.json?.caPubkeyAuthorizedNow === true, `got ${r.status} authorized=${r.json?.caPubkeyAuthorizedNow}`);
      return `pin=${String(r.json?.pinnedMandateHash).slice(0, 12)}…`;
    });
  },
};
