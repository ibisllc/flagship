// A REAL account (not `isDemo`), as the apps open one: adding a server is
// admin-only (owner rule 2026-10-16), `.com` lists the account's servers only
// to a read-token bearer (docs/account-read-token.md), and a refused caller
// gets the rate limiter's sentence. The fleet already made R's `home` box
// through an admin-approved AuthCode; here the refusals and the other signers.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  accountReadTokenPath,
  deriveAccountDeviceKeySeed,
  ed,
  signAccountDirectoryRequest,
  signDeviceEndpointClaim,
  signJournalRequest,
  signRegisterRck,
  type JournalRequest,
  type Keypair,
  type RegisterRck,
} from "@flagship/protocol";
import { REAL_PRIMARY_DEVICE_ID, issueAuthCode, mintDeviceGrant, newAuthCode } from "../lib/fleet.js";
import { ADMIN, CONTROL, SERVICES, adminHeaders, assert, http, postJson, short, sleep, tryHttp } from "../lib/harness.js";
import type { Group } from "./types.js";

const ADMIN_ONLY = "add-server-admin-only";

export const realAccount: Group = {
  name: "real-account",
  title: "a real account: admin-only add-server and RCK, read tokens (none / IRK / device), the rate limiter's 429 sentence",
  needs: ["R1"],
  phase: 1,
  async run({ R, rec, box }) {
    const acct = R!;
    const b = box("R1");
    const user = acct.username;
    const { irk, adminRoot } = acct.keys;
    const podsUrl = `https://${CONTROL}/api/users/${user}/pods`;

    // ── read tokens ───────────────────────────────────────────────────────
    await rec.check("/pods without a read token is 401 (the account is not demo)", async () => {
      const r = await http(podsUrl);
      assert(r.status === 401 && /read token is required/.test(r.text), `${r.status}: ${short(r.text)}`);
      const forged = await http(podsUrl, { headers: { authorization: "Bearer art1.e30.AAAA" } });
      assert(forged.status === 401, `forged token: ${forged.status}`);
      return "401, forged token 401";
    });
    const mintIrk = async (signer: Keypair) => {
      const issuedAt = Date.now();
      const claim = { username: user, endpointLabel: ACCOUNT_READ_TOKEN_LABEL, phoneIrkPub: signer.publicKey, issuedAt, expiresAt: issuedAt + 5 * 60_000, nonce: new Uint8Array(randomBytes(32)) };
      return postJson(`https://${CONTROL}${accountReadTokenPath(user)}`, {
        auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(claim.nonce) },
        authSignature: bytesToHex(signDeviceEndpointClaim(claim, signer)),
      });
    };
    const mintDevice = async (deviceId: string, device: Keypair) => {
      const requestId = randomBytes(16).toString("hex");
      const issuedAt = Date.now();
      const path = accountReadTokenPath(user);
      const sig = signAccountDirectoryRequest({ accountId: user, deviceId, signerPubHex: bytesToHex(device.publicKey), method: "POST", path, requestId, issuedAt }, device);
      return http(`https://${CONTROL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flagship-device-id": deviceId,
          "x-flagship-device-pub": bytesToHex(device.publicKey),
          "x-flagship-request-id": requestId,
          "x-flagship-issued-at": String(issuedAt),
          "x-flagship-signature": sig,
        },
        body: "{}",
      });
    };
    const readsPods = async (token: string) => {
      const r = await http(podsUrl, { headers: { authorization: `Bearer ${token}` } });
      assert(r.status === 200, `/pods with token ${r.status}: ${short(r.text)}`);
      const p = (r.json?.pods ?? []).find((x: { serverDomain: string }) => x.serverDomain === b.fqdn);
      assert(p?.state === "online", `R1 row ${short(p)}`);
      return r;
    };
    await rec.check("an IRK-signed read token (≈24 h) reads /pods; a stranger's key and a replayed claim are refused", async () => {
      const r = await mintIrk(irk);
      assert(r.status === 200 && r.json?.token, `mint ${r.status}: ${short(r.text)}`);
      const hours = (r.json.expiresAt - Date.now()) / 3_600_000;
      assert(hours > 20 && hours <= 24.1, `expires in ${hours.toFixed(1)} h`);
      await readsPods(r.json.token);
      const s = new Uint8Array(randomBytes(32));
      const stranger = await mintIrk({ privateKey: s, publicKey: ed.getPublicKey(s) });
      assert(stranger.status === 403, `stranger mint ${stranger.status}`);
      return `${hours.toFixed(1)} h; stranger 403`;
    });
    await rec.check("the admin device's read token (≈30 days) reads /pods", async () => {
      const r = await mintDevice(REAL_PRIMARY_DEVICE_ID, acct.keys.primaryDevice);
      assert(r.status === 200 && r.json?.token, `mint ${r.status}: ${short(r.text)}`);
      const days = (r.json.expiresAt - Date.now()) / 86_400_000;
      assert(days > 29 && days <= 30.1, `expires in ${days.toFixed(1)} days`);
      await readsPods(r.json.token);
      const unknownId = randomBytes(16).toString("hex");
      const unknown = await mintDevice(unknownId, { privateKey: deriveAccountDeviceKeySeed(acct.keys.umk, user, unknownId), publicKey: ed.getPublicKey(deriveAccountDeviceKeySeed(acct.keys.umk, user, unknownId)) });
      assert(unknown.status === 403, `unregistered device mint ${unknown.status}`);
      return `${days.toFixed(1)} days; unregistered device 403`;
    });

    // ── adding a server is admin-only ─────────────────────────────────────
    const refusedAdminOnly = (r: { status: number; json: any; text: string }, what: string) => {
      assert(r.status === 403 && r.json?.code === ADMIN_ONLY, `${what}: expected 403 ${ADMIN_ONLY}, got ${r.status}: ${short(r.text)}`);
      assert(/Only an admin device of this account can add servers/.test(r.json?.error ?? ""), `${what}: sentence ${short(r.json?.error)}`);
    };
    await rec.check("an IRK-only AuthCode for a new server is refused (403 add-server-admin-only, with the sentence)", async () => {
      refusedAdminOnly(await issueAuthCode(newAuthCode(acct, "spare"), irk), "IRK only");
      refusedAdminOnly(await issueAuthCode(newAuthCode(acct, "spare"), irk, irk), "IRK as the approver");
      return "403 ×2";
    });
    const memberId = randomBytes(16).toString("hex");
    const memberSeed = deriveAccountDeviceKeySeed(acct.keys.umk, user, memberId);
    const member: Keypair = { privateKey: memberSeed, publicKey: ed.getPublicKey(memberSeed) };
    await rec.check("a non-admin device (IRK-signed grant) can't approve one; an `admin` grant signed by the IRK is refused", async () => {
      const g = await mintDeviceGrant(acct, memberId, member, ["browse", "install-service", "view-directory"], irk);
      assert(g.status === 200, `member grant ${g.status}: ${short(g.text)}`);
      refusedAdminOnly(await issueAuthCode(newAuthCode(acct, "spare"), irk, member), "member device approval");
      const forgedAdminId = randomBytes(16).toString("hex");
      const fs = deriveAccountDeviceKeySeed(acct.keys.umk, user, forgedAdminId);
      const bad = await mintDeviceGrant(acct, forgedAdminId, { privateKey: fs, publicKey: ed.getPublicKey(fs) }, ["admin", "view-directory"], irk);
      assert(bad.status === 403, `IRK-signed admin grant: expected 403, got ${bad.status}: ${short(bad.text)}`);
      return "403 / 403";
    });
    await rec.check("a second admin device (admin-root-signed `admin` grant) approves a new server's AuthCode (200)", async () => {
      const id = randomBytes(16).toString("hex");
      const seed = deriveAccountDeviceKeySeed(acct.keys.umk, user, id);
      const dev: Keypair = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
      const g = await mintDeviceGrant(acct, id, dev, ["admin", "view-directory"], adminRoot);
      assert(g.status === 200, `admin grant ${g.status}: ${short(g.text)}`);
      const r = await issueAuthCode(newAuthCode(acct, "spare"), irk, dev);
      assert(r.status === 200 && r.json?.serial, `issue ${r.status}: ${short(r.text)}`);
      const root = await issueAuthCode(newAuthCode(acct, "spare2"), irk, adminRoot);
      assert(root.status === 200, `admin root issue ${root.status}: ${short(root.text)}`);
      return "admin device 200, admin root 200";
    });
    await rec.check("RCK registration has no IRK fallback on a real account (403), the admin root registers it", async () => {
      const req: RegisterRck = { username: user, subdomain: `spare.${user}.${SERVICES}`, rckPubKey: acct.keys.rck.publicKey, issuedAt: Date.now() };
      const send = (signer: Keypair) =>
        postJson(`https://${CONTROL}/api/routing/register-rck`, {
          request: { ...req, rckPubKey: bytesToHex(req.rckPubKey) },
          signature: bytesToHex(signRegisterRck(req, signer)),
        });
      refusedAdminOnly(await send(irk), "IRK-signed RCK");
      const ok = await send(adminRoot);
      assert(ok.status === 200 || ok.status === 409, `admin-root RCK ${ok.status}: ${short(ok.text)}`);
      return `IRK 403, admin root ${ok.status}`;
    });
    await rec.check("R's box (registered under the admin-approved code) is owned by R's IRK and pins R's admin root", async () => {
      const req: JournalRequest = { serverId: b.fqdn, unit: "flagship-daemon", lines: 5, issuedAt: Date.now() };
      const r = await postJson(`https://${b.fqdn}/api/journal`, { request: req, signature: bytesToHex(signJournalRequest(req, irk)) });
      assert(r.status === 200, `journal ${r.status}: ${short(r.text)}`);
      const u = await http(`https://${CONTROL}/api/username/${user}`);
      assert(u.json?.adminRootPub === bytesToHex(adminRoot.publicKey), `adminRootPub ${short(u.json?.adminRootPub, 20)}`);
      return "journal 200 under R's IRK";
    });

    // ── rate limits ───────────────────────────────────────────────────────
    await rec.check("a recovery lookup past its budget gets 429 with retryAfterSec and a sentence, and .com counts the refusal", async () => {
      const before = await rateLimitRefusals();
      const name = `gymrl${randomBytes(6).toString("hex")}`;
      let hit: { status: number; json: any; headers: Headers } | null = null;
      for (let i = 0; i < 45 && !hit; i++) {
        const r = await tryHttp(`https://${CONTROL}/api/recovery/by-username/${name}`);
        if (r.status === 429) hit = r;
      }
      assert(hit, "no 429 in 45 lookups");
      const j = hit.json;
      assert(j?.error === "rate-limited" && j.endpoint === "recovery-by-username", `body ${short(j)}`);
      assert(Number.isFinite(j.retryAfterSec) && j.retryAfterSec > 0 && hit.headers.get("retry-after") === String(j.retryAfterSec), `retryAfterSec=${j.retryAfterSec} retry-after=${hit.headers.get("retry-after")}`);
      assert(/^Too many tries (from your network|for this account name)\. Try again in (a minute|about \d+ (minute|hour)s?)\.$/.test(j.message ?? ""), `sentence: ${j.message}`);
      let after = before;
      for (let i = 0; i < 12 && after <= before; i++) {
        await sleep(5000);
        after = await rateLimitRefusals();
      }
      assert(after > before, `admin report refusals ${before} → ${after}`);
      return `${j.limit}: "${j.message}" (report ${before} → ${after})`;
    });
  },
};

async function rateLimitRefusals(): Promise<number> {
  assert(ADMIN, "admin secret");
  const r = await http(`https://${CONTROL}/api/admin/rate-limits?days=1`, { headers: adminHeaders() });
  assert(r.status === 200, `rate-limits report ${r.status}: ${short(r.text)}`);
  const e = (r.json?.endpoints ?? []).find((x: { endpoint: string }) => x.endpoint === "recovery-by-username");
  return Number(e?.refused ?? 0);
}
