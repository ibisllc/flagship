// Apps as API servers (docs/app-apis.md §3, §6): Flagship-issued API keys
// (admin-root-signed `flagship/app-api-key/v1`) reach a members-only app as
// `X-Flagship-Visitor: api` with their scope, a read key can't write, a
// revoked key is refused; and the owner's signed database write
// (`flagship/app-db-write/v1`) lands once, under the admin root only.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  appDbSqlSha256,
  deriveAccountDeviceKeySeed,
  ed,
  signAppApiKeyGrant,
  signAppDbWriteGrant,
  type AppApiKeyGrant,
  type AppDbWriteGrant,
  type Keypair,
} from "@flagship/protocol";
import { mintDeviceGrant, pair } from "../lib/fleet.js";
import { assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import { echoedFlagshipHeaders, installWhoami, setMode, waitServing } from "./gating.js";
import { PY_APP } from "./runtimes.js";
import type { Group } from "./types.js";

export const apiKeys: Group = {
  name: "api-keys",
  title: "app API keys (create, use at their scope, revoke) and signed database writes (admin root only, once)",
  needs: ["A1"],
  phase: 2,
  async run({ A, rec, box }) {
    const b = box("A1");
    const slug = "apikeys";
    const serviceId = `${A.username}--${slug}`;
    const app = `https://${slug}.${b.fqdn}`;
    const session = await pair(A, b);
    const s = { "x-flagship-session": session };
    const keysUrl = `https://${b.fqdn}/api/screens/services/${encodeURIComponent(serviceId)}/api-keys`;

    const up = await rec.check("install a members-only probe app (no public routes)", async () => {
      await installWhoami(A, b, slug, { enabled: true });
      await waitServing(`${app}/`).catch(() => undefined);
      await setMode(A, b, serviceId, "restricted");
      const anon = await tryHttp(`${app}/`, { headers: { accept: "application/json" } });
      assert(anon.status !== 200 || !/X-Flagship-Visitor/i.test(anon.text), `anonymous reached the app: ${anon.status}`);
      return `anonymous: ${anon.status}`;
    });
    const create = (scope: "read" | "write", signer: Keypair) => {
      const grant: AppApiKeyGrant = { serverDomain: b.fqdn, serviceId, keyId: randomBytes(8).toString("hex"), scope, expiresAt: 0, issuedAt: Date.now() };
      return postJson(keysUrl, { grant, signature: bytesToHex(signAppApiKeyGrant(grant, signer)), label: `gym ${scope}` }, s).then((r) => ({ r, keyId: grant.keyId }));
    };
    let readKey = "";
    let writeKey = "";
    let writeKeyId = "";
    if (up) {
      await rec.check("an API key grant signed by the owner IRK is refused (403)", async () => {
        const { r } = await create("write", A.keys.irk);
        assert(r.status === 403, `expected 403, got ${r.status}: ${short(r.text)}`);
        return "403";
      });
      await rec.check("create a read and a write key (admin-root signed); the list shows both, without secrets", async () => {
        const rd = await create("read", A.keys.adminRoot);
        const wr = await create("write", A.keys.adminRoot);
        assert(rd.r.status === 200 && /^fsk_/.test(rd.r.json?.key), `read ${rd.r.status}: ${short(rd.r.text)}`);
        assert(wr.r.status === 200 && /^fsk_/.test(wr.r.json?.key), `write ${wr.r.status}: ${short(wr.r.text)}`);
        readKey = rd.r.json.key;
        writeKey = wr.r.json.key;
        writeKeyId = wr.keyId;
        const list = await http(keysUrl, { headers: s });
        const ids = (list.json?.keys ?? []).map((k: { keyId: string }) => k.keyId);
        assert(ids.includes(rd.keyId) && ids.includes(wr.keyId), `list ${short(list.text)}`);
        assert(!list.text.includes(readKey) && !list.text.includes(writeKey), "the list leaks a key");
        return `${ids.length} keys`;
      });
      await rec.check("a key reaches the members-only app as X-Flagship-Visitor: api with its scope; client X-Flagship headers are stripped", async () => {
        const r = await http(`${app}/`, { headers: { authorization: `Bearer ${readKey}`, "x-flagship-role": "master" } });
        assert(r.status === 200, `${r.status}: ${short(r.text)}`);
        const h = echoedFlagshipHeaders(r.text);
        assert(h["x-flagship-visitor"] === "api" && h["x-flagship-api-scope"] === "read" && h["x-flagship-role"] === "api", `headers ${short(h, 240)}`);
        assert(/^apikey:[0-9a-f]{16}$/.test(h["x-flagship-user"] ?? ""), `user ${h["x-flagship-user"]}`);
        assert(!/^Authorization:/im.test(r.text), "the key reached the app");
        const w = await http(`${app}/`, { headers: { authorization: `Bearer ${writeKey}` } });
        assert(echoedFlagshipHeaders(w.text)["x-flagship-api-scope"] === "write", "write scope");
        return "visitor=api scope=read / write";
      });
      await rec.check("the read key can't POST (403); the write key can", async () => {
        const r = await http(`${app}/`, { method: "POST", headers: { authorization: `Bearer ${readKey}`, "content-type": "text/plain" }, body: "x" });
        assert(r.status === 403 && /read-only/.test(r.text), `read POST ${r.status}: ${short(r.text)}`);
        const w = await http(`${app}/`, { method: "POST", headers: { authorization: `Bearer ${writeKey}`, "content-type": "text/plain" }, body: "x" });
        assert(w.status === 200, `write POST ${w.status}: ${short(w.text)}`);
        return "403 / 200";
      });
      await rec.check("a wrong key is 401; a revoked key is 401", async () => {
        const wrong = await http(`${app}/`, { headers: { authorization: `Bearer ${writeKey.slice(0, -4)}AAAA` } });
        assert(wrong.status === 401, `wrong key ${wrong.status}`);
        const d = await http(`${keysUrl}/${writeKeyId}`, { method: "DELETE", headers: s });
        assert(d.status === 200, `revoke ${d.status}: ${short(d.text)}`);
        const after = await http(`${app}/`, { headers: { authorization: `Bearer ${writeKey}` } });
        assert(after.status === 401, `revoked key ${after.status}`);
        return "401 / 401";
      });
    }

    // ── signed database writes on the python app ──────────────────────────
    const py = `${A.username}--${PY_APP}`;
    const qUrl = `https://${b.fqdn}/api/screens/services/${encodeURIComponent(py)}/db/default/query`;
    const pyUp = await rec.check("the python app is live (from the runtimes group)", async () => {
      const r = await http(`https://${PY_APP}.${b.fqdn}/`);
      assert(r.status === 200, `${r.status}`);
      return "up";
    });
    if (!pyUp) return;
    const marker = `gym-db-${randomBytes(4).toString("hex")}`;
    const sql = `INSERT INTO notes (body) VALUES ('${marker}')`;
    const grantFor = (q: string): AppDbWriteGrant => ({ serverDomain: b.fqdn, serviceId: py, store: "default", sqlSha256: appDbSqlSha256(q), issuedAt: Date.now() });
    await rec.check("the Database section reads (read-only); an unsigned write is refused with needsGrant", async () => {
      const r = await postJson(qUrl, { sql: "SELECT count(*) AS n FROM notes" }, s);
      assert(r.status === 200 && Array.isArray(r.json?.rows), `read ${r.status}: ${short(r.text)}`);
      const w = await postJson(qUrl, { sql }, s);
      assert(w.status === 400 && w.json?.needsGrant === true, `unsigned write ${w.status}: ${short(w.text)}`);
      return `rows=${short(r.json.rows)}; unsigned 400 needsGrant`;
    });
    await rec.check("a write signed by the IRK or by a non-admin device is refused (403)", async () => {
      const g = grantFor(sql);
      const byIrk = await postJson(qUrl, { sql, grant: g, signature: bytesToHex(signAppDbWriteGrant(g, A.keys.irk)) }, s);
      assert(byIrk.status === 403, `IRK ${byIrk.status}: ${short(byIrk.text)}`);
      const id = randomBytes(16).toString("hex");
      const seed = deriveAccountDeviceKeySeed(A.keys.umk, A.username, id);
      const dev: Keypair = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
      const mint = await mintDeviceGrant(A, id, dev, ["browse", "install-service", "view-directory"], A.keys.irk);
      assert(mint.status === 200, `device grant ${mint.status}`);
      const byDev = await postJson(qUrl, { sql, grant: g, signature: bytesToHex(signAppDbWriteGrant(g, dev)) }, s);
      assert(byDev.status === 403, `non-admin device ${byDev.status}: ${short(byDev.text)}`);
      return "403 / 403";
    });
    await rec.check("the admin-root-signed write lands once: replay 409, another statement under the same grant 403", async () => {
      const g = grantFor(sql);
      const sig = bytesToHex(signAppDbWriteGrant(g, A.keys.adminRoot));
      const ok = await postJson(qUrl, { sql, grant: g, signature: sig }, s);
      assert(ok.status === 200, `write ${ok.status}: ${short(ok.text)}`);
      const replay = await postJson(qUrl, { sql, grant: g, signature: sig }, s);
      assert(replay.status === 409, `replay ${replay.status}: ${short(replay.text)}`);
      const swapped = await postJson(qUrl, { sql: "DELETE FROM notes", grant: g, signature: sig }, s);
      assert(swapped.status === 403, `swapped statement ${swapped.status}: ${short(swapped.text)}`);
      for (let i = 0; i < 6; i++) {
        const rd = await http(`https://${PY_APP}.${b.fqdn}/read`);
        if ((rd.json?.rows ?? []).includes(marker)) return `the app reads ${marker}`;
        await sleep(2000);
      }
      throw new Error("the written row isn't visible to the app");
    });
  },
};
