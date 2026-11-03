// voi.ci pages and Messages on the live gym (docs/voici-and-messages.md §14 G). Two throwaway REAL accounts (no box):
// the owner O publishes a page and the visitor V writes to it. O's admin phone is simulated (lib/phoneSim.ts with the
// voi.ci operations of lib/voiciPhone.ts) and holds O's bare name through the real gym relay; a second, non-admin
// device of O writes posts as draft ops. V's "browser" is packages/flagship-web itself, run in Node with WebCrypto
// (a non-extractable P-256 browser key, the real loadVoiciPage / buildVoiciMessage / deliverEnvelope / fetchThread /
// verifyThreadItem / buildVoiciAlertsOrder), behind a fetch that enforces CORS the way a browser does (preflight for
// non-simple requests, Access-Control-Allow-Origin required) with Origin https://gym.voi.ci. V's "app" side (pseudonym,
// attestation, delegation, thread statement) is done here with the protocol package, as the apps do; the /qr-pipe
// sign-in itself is not driven.
//
// Covered: publish with the admin phone online (draft delivered direct + acked, then published and consumed) and
// offline (draft lane, grayed = in the lane and not in the published index, published when the admin returns); a
// headless Chromium load of https://gym.voi.ci/<owner> (renders, no CSP violation, no console error); a message round
// trip browser → mailbox → owner → reply → browser; the same with the phone live (direct + ack + forward, deduped at
// .com); reply alerts on/off (push itself is not checked, only that .com takes the subscription); the first-contact
// limit; block (dropped, no oracle, on .com and on the phone); report → open-tag with the gym abuse key → ban →
// attestation refused; the revoke rule (a stranger pseudonym gets 404 unknown-delegate); CORS from a fake origin;
// takedown (410, pieces gone, publish refused).
//
// Gym prerequisites, each a SKIP with its reason when missing:
//   - VOICI_ENABLED=on in the gym Worker and gym.voi.ci routed to it (wrangler.gym.toml).
//   - A gym abuse key in the gym branch's .maintainers/abuse-keys/list.json (lib/gymAbuseKey.ts prints the signed
//     entry): without it every attestation is 503 no-abuse-key and nothing a visitor sends can be tested.
//   - A visitor attestation needs device-integrity evidence (App Attest / Play Integrity), which a harness cannot make,
//     or an account at least 7 days old (the unattested tier). The group backdates its own throwaway visitor account's
//     claimed_at in the GYM D1 with `wrangler d1 execute` (GYM_VOICI_BACKDATE=0 turns that off).
//   - The relay's /phone-tunnel for the bare name (the phone checks skip without it).
//
// Leaves behind: two throwaway real accounts (O's page taken down, V banned), O's non-admin device grant revoked.
import { execFile } from "node:child_process";
import { randomBytes, type webcrypto } from "node:crypto";
import { lookup } from "node:dns/promises";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  b64Decode,
  b64Encode,
  canonicalJsonBytes,
  deriveAccountDeviceKeySeed,
  deriveMessagesPseudonymKey,
  deriveMessagesSecret,
  deriveMessagesThreadKey,
  deriveVoiciDraftsKey,
  deriveVoiciInboxKey,
  deriveVoiciOwnerSignKey,
  ed,
  mergeVoiciPage,
  openVoiciAbuseTag,
  openVoiciBody,
  openVoiciDraft,
  PHONE_ENVELOPE_CONTENT_TYPE,
  PHONE_WEB_ORIGINS_GYM,
  sealVoiciBody,
  sealVoiciDraft,
  sha256Hex,
  signAccountDirectoryRequest,
  signDeviceCapabilityGrant,
  signMessagesKeyAttestationRequest,
  signRevokeDeviceCapabilityGrant,
  signVoiciBlock,
  signVoiciDraftsConsume,
  signVoiciMessageReport,
  signVoiciPageIndex,
  signVoiciPieceUpload,
  signVoiciThreadStatement,
  signWebDelegation,
  signWebDelegationRevoke,
  signWebEnvelopeEd25519,
  verifyDeviceCapabilityGrant,
  verifyVoiciAck,
  voiciConv,
  type DeviceCapabilityGrant,
  type Keypair,
  type MessagesKeyAttestation,
  type VoiciDraftOp,
  type VoiciPageIndex,
  type VoiciPageState,
  type VoiciPieceRef,
  type VoiciPost,
  type VoiciProfile,
  type WebDelegation,
  type WebEnvelope,
} from "@flagship/protocol";
import { createRealAccount, REAL_PRIMARY_DEVICE_ID, type Account } from "../../lib/fleet.js";
import { accountReadHeaders } from "../../readToken.js";
import { ADMIN, CONTROL, SERVICES, SkipError, adminHeaders, assert, http, postJson, short, sleep, tryHttp, writeJson, type Resp } from "../../lib/harness.js";
import { SimPhone, phoneRequest, selfSignedPhoneCert, type PhoneHttpAnswer } from "../../lib/phoneSim.js";
import { VoiciPhoneWeb } from "../../lib/voiciPhone.js";
import { GYM_ABUSE_SEED, GYM_K_PUB, gymAbuseKeyEntry } from "../../lib/gymAbuseKey.js";
import type { Group } from "../types.js";

const run = promisify(execFile);
const REPO = resolvePath(import.meta.dirname, "../../../..");
/** voi.ci in the gym: the control apex with `flagshipserver.com` swapped for `voi.ci` (gym.flagshipserver.com → gym.voi.ci). */
export const VOICI_HOST = process.env.GYM_VOICI_HOST || CONTROL.replace(/flagshipserver\.com$/, "voi.ci");
export const VOICI_ORIGIN = `https://${VOICI_HOST}`;
export const FILES_ORIGIN = `https://files.${VOICI_HOST}`;
const API = `https://${CONTROL}`;
const FAKE_ORIGIN = "https://evil.example";
const DAY = 86_400_000;

// ── pure helpers (unit-tested in tools/live-e2e/tests/voici.test.ts) ─────────────────────────────────────────────

export interface BuiltIndex {
  index: VoiciPageIndex;
  pieces: Map<string, Uint8Array>;
}

/** The pieces and the signed index of a page state (no avatar, no images). */
export function buildIndex(o: {
  username: string;
  pageId: string;
  seq: number;
  issuedAt: number;
  state: VoiciPageState;
  inboxPub: string;
  ownerSignPub: string;
  signerSeed: Uint8Array;
}): BuiltIndex {
  const pieces = new Map<string, Uint8Array>();
  const refs: VoiciPieceRef[] = [];
  const add = (role: string, bytes: Uint8Array) => {
    const sha = sha256Hex(bytes);
    pieces.set(sha, bytes);
    refs.push({ role, sha256: sha, size: bytes.length });
  };
  add("profile", canonicalJsonBytes(o.state.profile));
  o.state.chunks.forEach((posts, n) => add(`chunk-${n}`, canonicalJsonBytes({ v: 1, chunk: n, posts })));
  const index = signVoiciPageIndex(
    {
      username: o.username,
      pageId: o.pageId,
      seq: o.seq,
      issuedAt: o.issuedAt,
      acceptsMessages: o.state.acceptsMessages,
      inboxEpoch: 1,
      inboxPub: o.inboxPub,
      ownerSignPub: o.ownerSignPub,
      pieces: refs,
      signerKind: "admin-root",
    },
    o.signerSeed,
  );
  return { index, pieces };
}

export function newPost(text: string, at = Date.now()): VoiciPost {
  return { id: randomBytes(16).toString("hex"), createdAt: at, editedAt: null, text, links: [] };
}

/** A non-admin device's draft op as a signed voici-draft envelope (§5.2). */
export function draftEnvelope(o: {
  username: string;
  umk: Uint8Array;
  device: Keypair;
  deviceId: string;
  grant: Record<string, unknown>;
  grantSignature: string;
  op: VoiciDraftOp;
  seq: number;
}): WebEnvelope {
  const body = sealVoiciDraft(deriveVoiciDraftsKey({ seed: o.umk }), o.username, o.op);
  return signWebEnvelopeEd25519(
    {
      v: 1,
      kind: "voici-draft",
      audience: o.username,
      conv: "",
      from: bytesToHex(o.device.publicKey),
      msgId: o.op.opId,
      seq: o.seq,
      sentAt: o.op.at,
      bodyB64: b64Encode(body),
      cred: { grant: o.grant, grantSignature: o.grantSignature },
    },
    o.device.privateKey,
  );
}

/** The owner's reply to a conversation (§7.4): sealed to the visitor's T and the owner's own inbox key. */
export function ownerReply(o: {
  pageId: string;
  conv: string;
  threadPub: string;
  inboxPub: Uint8Array;
  ownerSign: { seed: Uint8Array; publicKey: Uint8Array };
  pageSeq: number;
  seq: number;
  text: string;
  replyTo: string | null;
  sentAt?: number;
}): WebEnvelope {
  const msgId = randomBytes(16).toString("hex");
  const sentAt = o.sentAt ?? Date.now();
  const from = bytesToHex(o.ownerSign.publicKey);
  const body = sealVoiciBody({ conv: o.conv, msgId, sentAt, fromPub: from, recipients: [hexToBytes(o.threadPub), o.inboxPub], plaintext: { v: 1, text: o.text, replyTo: o.replyTo } });
  return signWebEnvelopeEd25519(
    { v: 1, kind: "voici-reply", audience: o.pageId, conv: o.conv, from, msgId, seq: o.seq, sentAt, bodyB64: b64Encode(body), cred: { pageSeq: o.pageSeq } },
    o.ownerSign.seed,
  );
}

/** Device headers (as /profile) for `path`. */
export function deviceHeaders(account: string, deviceId: string, device: Keypair, method: string, path: string): Record<string, string> {
  const requestId = randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  const sig = signAccountDirectoryRequest({ accountId: account, deviceId, signerPubHex: bytesToHex(device.publicKey), method, path, requestId, issuedAt }, device);
  return {
    "x-flagship-device-id": deviceId,
    "x-flagship-device-pub": bytesToHex(device.publicKey),
    "x-flagship-request-id": requestId,
    "x-flagship-issued-at": String(issuedAt),
    "x-flagship-signature": sig,
  };
}

/** Lower-case response headers as a record (for a Response built from a raw phone answer). */
const isSimple = (method: string, headers: Record<string, string>) => {
  const ct = (headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  return (method === "GET" || method === "HEAD" || method === "POST") && Object.keys(headers).every((k) => k === "content-type" || k === "accept") &&
    (ct === "" || ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(ct));
};

/** What a browser at `origin` lets a page read: the request runs only after a granted preflight, the answer only with ACAO. */
export function corsFetch(
  origin: string,
  send: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>,
  /** Hosts whose answers are not CORS-checked (a known gap reported by its own check). */
  exempt: (url: string) => boolean = () => false,
): typeof fetch {
  return (async (input: string | URL | { url: string }, init: RequestInit = {}) => {
    const url = typeof input === "object" && "url" in input ? input.url : String(input);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    if (new URL(url).origin !== origin) {
      if (!isSimple(method, headers)) {
        const pre = await send(url, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": method, "access-control-request-headers": Object.keys(headers).sort().join(",") },
        });
        if (pre.headers.get("access-control-allow-origin") !== origin) throw new TypeError(`CORS preflight refused for ${method} ${url} (${pre.status})`);
      }
      headers.origin = origin;
    }
    const res = await send(url, { method, headers, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    if (new URL(url).origin !== origin && !exempt(url)) {
      if (res.headers.get("access-control-allow-origin") !== origin) throw new TypeError(`CORS: no Access-Control-Allow-Origin on ${method} ${url} (${res.status})`);
      if (res.headers.get("access-control-allow-credentials")) throw new TypeError(`CORS: Allow-Credentials on ${url}`);
    }
    return res;
  }) as typeof fetch;
}

function responseOf(a: PhoneHttpAnswer): Response {
  const h = new Headers();
  for (const [k, v] of Object.entries(a.headers)) for (const x of v.split("\n")) h.append(k, x);
  return new Response(a.status === 204 ? null : a.body, { status: a.status, headers: h });
}

// ── the group ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Visitor {
  pageId: string;
  pseud: { seed: Uint8Array; publicKey: Uint8Array };
  pPub: string;
  threadSeed: Uint8Array;
  attestation: MessagesKeyAttestation;
  /** flagship-web's session (privateKey a non-extractable CryptoKey). */
  session: Record<string, unknown> & { privateKey: webcrypto.CryptoKey; delegatePub?: string };
  delegation: WebDelegation;
  conv: string;
}

export const voici: Group = {
  name: "voici",
  title:
    "voi.ci pages + Messages: one namespace (canonical 301s, /@ for people only, codes, one 404, /-/), publish with the admin phone online (direct draft + ack) and offline (draft lane), the real site in headless Chromium, a mailbox and a direct-to-phone round trip with flagship-web as the browser, reply alerts, first-contact limit, block, report → open-tag → ban, the revoke rule, CORS, takedown",
  needs: [],
  phase: 10.7,
  parallel: false,
  async run({ rec, dir }) {
    const W: any = await import(new URL("../../../../packages/flagship-web/src/index.js", import.meta.url).href);

    // ── preconditions ───────────────────────────────────────────────────────────────────────────────────────────
    const on = await rec.check("the gym .com has voi.ci on (VOICI_ENABLED) and gym.voi.ci resolves", async () => {
      // .com answers voi.ci CORS only while VOICI_ENABLED is on (voiciCorsHeaders).
      const r = await tryHttp(`${API}/api/username/${"x".repeat(12)}`, { headers: { origin: VOICI_ORIGIN } });
      if (r.headers.get("access-control-allow-origin") !== VOICI_ORIGIN) throw new SkipError(`no voi.ci CORS on ${CONTROL}: VOICI_ENABLED is off there (or VOICI_WEB_ORIGIN isn't ${VOICI_ORIGIN})`);
      const a = await lookup(VOICI_HOST).catch(() => null);
      if (!a) throw new SkipError(`${VOICI_HOST} doesn't resolve (its route comes with the gym Worker deploy)`);
      return `voi.ci CORS on; ${VOICI_HOST} → ${a.address}`;
    });
    if (!on) return;

    let O: Account;
    let V: Account;
    const made = await rec.check("setup: two throwaway real accounts, the owner O and the visitor V", async () => {
      O = await createRealAccount();
      V = await createRealAccount();
      return `O ${O.username}, V ${V.username}`;
    });
    if (!made) return;
    const owner = O!;
    const visitorAcct = V!;
    const user = owner.username;
    const readO = () => accountReadHeaders(CONTROL, user, owner.keys.irk);

    // O's page keys.
    const pageId = randomBytes(16).toString("hex");
    const umk = { seed: owner.keys.umk };
    const inbox = deriveVoiciInboxKey(umk, pageId, 1);
    const ownerSign = deriveVoiciOwnerSignKey(umk, pageId, 1);
    const ownerSignPub = bytesToHex(ownerSign.publicKey);
    const profile: VoiciProfile = { v: 1, displayName: "Gym Owner", bio: "A throwaway page of the live gym.", avatar: null, theme: "sea", links: [] };
    let state: VoiciPageState = { profile, acceptsMessages: 1, chunks: [[newPost("First post from the admin device.")]], issuedAt: 0 };
    let published: VoiciPageIndex | null = null;
    let seq = 0;

    const publish = async (next: VoiciPageState): Promise<VoiciPageIndex> => {
      const issuedAt = Date.now();
      const b = buildIndex({ username: user, pageId, seq: seq + 1, issuedAt, state: next, inboxPub: bytesToHex(inbox.publicKey), ownerSignPub, signerSeed: owner.keys.adminRoot.privateKey });
      for (const [sha, bytes] of b.pieces) {
        const signature = signVoiciPieceUpload({ username: user, pageId, sha256: sha, size: bytes.length, issuedAt }, owner.keys.adminRoot.privateKey);
        const r = await http(`${API}/api/voici/pages/${user}/pieces`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-flagship-page-id": pageId,
            "x-flagship-issued-at": String(issuedAt),
            "x-flagship-signature": signature,
            "x-flagship-sha256": sha,
            "x-flagship-size": String(bytes.length),
          },
          body: bytes,
          idempotent: true,
        });
        assert(r.status === 200 && r.json?.sha256 === sha, `piece ${sha.slice(0, 8)} ${r.status}: ${short(r.text)}`);
      }
      const p = await postJson(`${API}/api/voici/pages/${user}/publish`, { index: b.index });
      assert(p.status === 200 && p.json?.seq === seq + 1, `publish seq ${seq + 1}: ${p.status} ${short(p.text)}`);
      seq += 1;
      state = { ...next, issuedAt };
      published = b.index;
      if (phoneWeb) phoneWeb.page = { pageId, acceptsMessages: next.acceptsMessages === 1, ownerSignPub, ownerSignSeed: ownerSign.seed };
      return b.index;
    };
    const storedIndex = async (): Promise<VoiciPageIndex> => {
      const r = await http(`${API}/api/voici/pages/${user}`);
      assert(r.status === 200 && r.json?.index, `GET page ${r.status}: ${short(r.text)}`);
      return r.json.index as VoiciPageIndex;
    };
    const postsOf = async (index: VoiciPageIndex): Promise<string[]> => {
      const texts: string[] = [];
      for (const p of index.pieces.filter((x) => x.role.startsWith("chunk-"))) {
        const r = await http(`${API}/api/voici/pages/${user}/pieces/${p.sha256}`);
        assert(r.status === 200, `piece ${p.role} ${r.status}`);
        for (const post of (r.json?.posts ?? []) as VoiciPost[]) texts.push(post.text);
      }
      return texts;
    };

    // O's admin phone (the primary device: admin grant under the admin root) and a non-admin device N.
    const bare = `${user}.${SERVICES}`;
    const cert = selfSignedPhoneCert(bare);
    let phone: SimPhone | null = null;
    let phoneWeb: VoiciPhoneWeb | null = null;
    let relayIp = "";
    const nId = randomBytes(16).toString("hex");
    const nSeed = deriveAccountDeviceKeySeed(owner.keys.umk, user, nId);
    const nKey: Keypair = { privateKey: nSeed, publicKey: ed.getPublicKey(nSeed) };
    let nGrant: Record<string, unknown> | null = null;
    let nGrantSig = "";
    let nSeq = 0;
    const visitorBrowsers: Visitor[] = [];

    const phoneAnswer = async (method: string, path: string, headers: Record<string, string>, body?: string): Promise<PhoneHttpAnswer | null> => {
      for (let i = 0; i < 3; i++) {
        const a = await phoneRequest({ ip: relayIp, sni: bare, ca: [cert.cert], method, path, headers: { host: bare, ...headers }, ...(body !== undefined ? { body } : {}) });
        if (a) return a;
        await sleep(500);
      }
      return null;
    };
    /** flagship-web's fetch: the phone's name through the relay (TLS ends on the sim phone), everything else the network. */
    let filesCors = true;
    const browserFetch = corsFetch(VOICI_ORIGIN, async (url, init) => {
      const u = new URL(url);
      if (u.hostname === bare) {
        if (!relayIp) throw new TypeError("no relay");
        const a = await phoneAnswer(init.method, u.pathname, init.headers, init.body);
        if (!a) throw new TypeError(`no answer from ${bare}`);
        return responseOf(a);
      }
      return fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "manual" });
    }, (url) => !filesCors && url.startsWith(`${FILES_ORIGIN}/`));

    const connectPhone = async (): Promise<string> => {
      const ep = await http(`${API}/api/services/endpoints`);
      const hub = typeof ep.json?.tunnelHub === "string" ? (ep.json.tunnelHub as string) : "";
      const url = hub.replace(/\/tunnel$/, "/phone-tunnel");
      if (!url) throw new SkipError("the gym .com lists no tunnelHub, so there's no /phone-tunnel to hold the bare name");
      relayIp = (await lookup(bare, { family: 4 })).address;
      phoneWeb ??= new VoiciPhoneWeb({
        account: user,
        origins: PHONE_WEB_ORIGINS_GYM,
        webOrigin: VOICI_ORIGIN,
        deviceSeed: owner.keys.primaryDevice.privateKey,
        caKeys: (process.env.GYM_VOICI_CA_KEYS ?? GYM_K_PUB).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        grantOk: (grant, sig, devicePub) => {
          const g = grant as Record<string, unknown>;
          if (g.username !== user || g.devicePubKey !== devicePub) return false;
          const parsed: DeviceCapabilityGrant = { ...(g as unknown as DeviceCapabilityGrant), devicePubKey: hexToBytes(devicePub) };
          return [owner.keys.adminRoot, owner.keys.irk].some((k) => {
            try {
              return verifyDeviceCapabilityGrant(parsed, hexToBytes(sig), k.publicKey);
            } catch {
              return false;
            }
          });
        },
        forward: async (env) => {
          const r = await postJson(`${API}/api/voici/web/send`, { envelope: env, direct: true });
          if (r.status !== 200) throw new Error(`forward ${r.status} ${short(r.text)}`);
        },
      });
      if (published) phoneWeb.page = { pageId, acceptsMessages: state.acceptsMessages === 1, ownerSignPub, ownerSignSeed: ownerSign.seed };
      try {
        phone = await SimPhone.connect(url, {
          account: user,
          seed: owner.keys.primaryDevice.privateKey,
          label: "O",
          tls: cert,
          com: { control: CONTROL, readHeaders: readO },
        });
      } catch (e) {
        throw new SkipError(`no phone tunnel at ${url}: ${String(e)} (the relay needs the serving authority on)`);
      }
      phone.endpoint.web = phoneWeb;
      const c = await phone.acquire();
      if (c.type !== "granted") throw new Error(`the relay refused the phone's claim: ${JSON.stringify(c)}`);
      for (let i = 0; i < 10; i++) {
        const live = await phoneAnswer("GET", "/api/phone/live", { origin: VOICI_ORIGIN });
        if (live?.status === 200) return `generation ${String(c.generation)}; the bare name answers through ${relayIp}`;
        await sleep(1_000);
      }
      throw new Error("the phone holds the name but /api/phone/live doesn't answer through the relay");
    };
    const dropPhone = async () => {
      if (!phone) return;
      await phone.release().catch(() => undefined);
      phone.terminate();
      phone = null;
    };

    try {
      // ── publish ───────────────────────────────────────────────────────────────────────────────────────────────
      const pub1 = await rec.check("publish: the admin device uploads the pieces and an admin-root-signed index (seq 1); .com serves it, files.voi.ci holds it, voi.ci/<u> serves the site shell with the strict CSP", async () => {
        await publish(state);
        const idx = await storedIndex();
        assert(idx.seq === 1 && idx.pageId === pageId && idx.signature === published!.signature, `stored index ${short(idx)}`);
        const shell = await http(`${VOICI_ORIGIN}/${user}`);
        assert(shell.status === 200 && /<html/i.test(shell.text), `voi.ci/${user} ${shell.status}`);
        const csp = shell.headers.get("content-security-policy") ?? "";
        for (const d of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "img-src 'self' blob:"]) assert(csp.includes(d), `CSP lacks ${d}: ${csp}`);
        assert(shell.headers.get("x-frame-options") === "DENY", "no X-Frame-Options: DENY");
        const at = await http(`${VOICI_ORIGIN}/@${user}`);
        assert(at.status === 301 && new URL(at.headers.get("location") ?? "", VOICI_ORIGIN).href === new URL(`/${user}`, VOICI_ORIGIN).href, `/@${user} ${at.status} ${at.headers.get("location")}`);
        const stale = await postJson(`${API}/api/voici/pages/${user}/publish`, { index: published });
        assert(stale.status === 409 && stale.json?.code === "seq-conflict", `republishing seq 1: ${stale.status} ${short(stale.text)}`);
        const files = await tryHttp(`${FILES_ORIGIN}/v1/u/${user}.json`);
        return `seq 1, ${published!.pieces.length} pieces; shell 200 with CSP; /@u 301; a repeated seq 409 seq-conflict; files index ${files.status}`;
      });
      if (!pub1) return;

      // ── one namespace (docs/voici-namespace-spec.md) ──────────────────────────────────────────────────────────
      await rec.check("one namespace: T1 capitals and a trailing slash 301 to voi.ci/<u>; T7 /@<u> 301s to it; the removed any-URL shortener is a 404 (codes come only from apps); a reserved word, an unknown name and /@<unknown> are the same 404 shell; the site lives under /-/ (D11) and /_/ is gone", async () => {
        const upper = await http(`${VOICI_ORIGIN}/${user.toUpperCase()}/`);
        assert(upper.status === 301 && new URL(upper.headers.get("location") ?? "", VOICI_ORIGIN).href === new URL(`/${user}`, VOICI_ORIGIN).href, `/${user.toUpperCase()}/ ${upper.status} ${upper.headers.get("location")}`);
        const at = await http(`${VOICI_ORIGIN}/@${user}`);
        assert(at.status === 301 && new URL(at.headers.get("location") ?? "", VOICI_ORIGIN).href === new URL(`/${user}`, VOICI_ORIGIN).href, `/@${user} ${at.status} ${at.headers.get("location")}`);
        const shorten = await postJson(`${API}/api/voici/shorten`, { request: { username: user, targetUrl: `${API}/`, issuedAt: Date.now() }, signature: "00" });
        assert(shorten.status === 404, `POST /api/voici/shorten ${shorten.status} ${short(shorten.text)}`);
        const nobody = `nobody-${randomBytes(4).toString("hex")}`;
        for (const p of ["/admin", `/${nobody}`, `/@${nobody}`]) {
          const r = await http(`${VOICI_ORIGIN}${p}`);
          assert(r.status === 404 && /name="voici-status" content="404"/.test(r.text), `${p} ${r.status}`);
        }
        const about = await http(`${VOICI_ORIGIN}/-/about`);
        assert(about.status === 200 && /<html/i.test(about.text), `/-/about ${about.status}`);
        const old = await http(`${VOICI_ORIGIN}/_/about`);
        assert(old.status === 404, `/_/about ${old.status}`);
        return `301 to /${user} for capitals, a trailing slash and /@; /api/voici/shorten 404; reserved and unknown 404 with the site's 404 shell; /-/about 200, /_/about 404`;
      });

      filesCors = await rec.check("files.voi.ci answers the site's origin with CORS (the R2 rule; without it the site can't read a page)", async () => {
        const r = await tryHttp(`${FILES_ORIGIN}/v1/u/${user}.json`, { headers: { origin: VOICI_ORIGIN } });
        assert(r.status === 200, `GET ${FILES_ORIGIN}/v1/u/${user}.json ${r.status}: ${short(r.text)}`);
        const acao = r.headers.get("access-control-allow-origin");
        assert(acao === VOICI_ORIGIN || acao === "*", `no Access-Control-Allow-Origin for ${VOICI_ORIGIN} (got ${acao}): add the R2 CORS rule (docs/voici-and-messages.md §4.2 "Owner/B1")`);
        const evil = await tryHttp(`${FILES_ORIGIN}/v1/u/${user}.json`, { headers: { origin: FAKE_ORIGIN } });
        return `ACAO ${acao}; from ${FAKE_ORIGIN}: ${evil.headers.get("access-control-allow-origin") ?? "none"}`;
      });

      await rec.check("CORS from a fake origin: the page read, the send preflight and the report preflight grant exactly gym.voi.ci; another origin, an extra request header or an owner route get no CORS; never Allow-Credentials", async () => {
        const acao = (r: Resp) => r.headers.get("access-control-allow-origin");
        const get = (origin: string, path: string) => http(`${API}${path}`, { headers: { origin } });
        const pre = (origin: string, path: string, hdrs = "content-type") =>
          http(`${API}${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": hdrs } });
        const out: string[] = [];
        const good = await get(VOICI_ORIGIN, `/api/voici/pages/${user}`);
        assert(acao(good) === VOICI_ORIGIN && !good.headers.get("access-control-allow-credentials"), `page read from ${VOICI_ORIGIN}: ACAO ${acao(good)}`);
        const acc = await get(VOICI_ORIGIN, `/api/username/${user}`);
        assert(acao(acc) === VOICI_ORIGIN, `account lookup: ACAO ${acao(acc)}`);
        for (const path of ["/api/voici/web/send", "/api/voici/web/thread", "/api/voici/reports"]) {
          const p = await pre(VOICI_ORIGIN, path);
          assert(p.status === 204 && acao(p) === VOICI_ORIGIN && !p.headers.get("access-control-allow-credentials"), `preflight ${path}: ${p.status} ACAO ${acao(p)}`);
          const evil = await pre(FAKE_ORIGIN, path);
          assert(!acao(evil), `preflight ${path} from ${FAKE_ORIGIN} granted ${acao(evil)}`);
          const extra = await pre(VOICI_ORIGIN, path, "content-type,authorization");
          assert(!acao(extra), `preflight ${path} asking for authorization granted ${acao(extra)}`);
          out.push(path);
        }
        const evilRead = await get(FAKE_ORIGIN, `/api/voici/pages/${user}`);
        assert(!acao(evilRead), `page read from ${FAKE_ORIGIN}: ACAO ${acao(evilRead)}`);
        const nullOrigin = await get("null", `/api/voici/pages/${user}`);
        assert(!acao(nullOrigin), `page read from Origin: null: ACAO ${acao(nullOrigin)}`);
        for (const path of [`/api/voici/pages/${user}/inbox`, `/api/accounts/${user}/voici-drafts`, `/api/accounts/${user}/messages-state`]) {
          const r = await get(VOICI_ORIGIN, path);
          assert(!acao(r), `owner route ${path} answered ${VOICI_ORIGIN} with ACAO ${acao(r)}`);
        }
        return `granted to ${VOICI_ORIGIN} on the page/account reads and ${out.length} POST routes; refused for ${FAKE_ORIGIN}, Origin null, extra headers and owner routes`;
      });

      await rec.check("setup: a second, non-admin device N of O (IRK-signed grant without admin)", async () => {
        const issuedAt = Date.now();
        const g: DeviceCapabilityGrant = {
          grantId: randomBytes(16).toString("hex"),
          username: user,
          deviceId: nId,
          devicePubKey: nKey.publicKey,
          scopes: ["browse", "view-directory"] as DeviceCapabilityGrant["scopes"],
          issuedAt,
          expiresAt: issuedAt + 7 * DAY,
        };
        nGrantSig = bytesToHex(signDeviceCapabilityGrant(g, owner.keys.irk));
        nGrant = { ...g, devicePubKey: bytesToHex(nKey.publicKey) };
        const r = await postJson(`${API}/api/users/${user}/device-grants`, { grant: nGrant, signature: nGrantSig });
        assert(r.status === 200, `grant ${r.status}: ${short(r.text)}`);
        return `device ${nId.slice(0, 8)}`;
      });
      const nDraft = (op: VoiciDraftOp) => draftEnvelope({ username: user, umk: owner.keys.umk, device: nKey, deviceId: nId, grant: nGrant!, grantSignature: nGrantSig, op, seq: ++nSeq });
      const depositDraft = (env: WebEnvelope) => {
        const path = `/api/accounts/${user}/voici-drafts`;
        return http(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", ...deviceHeaders(user, nId, nKey, "POST", path) }, body: JSON.stringify({ envelope: env }) });
      };
      const listDrafts = async (): Promise<WebEnvelope[]> => {
        const r = await http(`${API}/api/accounts/${user}/voici-drafts`, { headers: await readO() });
        assert(r.status === 200 && Array.isArray(r.json?.drafts), `drafts list ${r.status}: ${short(r.text)}`);
        return (r.json.drafts as unknown[]).map((d) => ((d as { envelope?: WebEnvelope }).envelope ?? d) as WebEnvelope);
      };
      /** The admin device's side: open every op (lane + direct), merge, publish, consume. */
      const adminPublishes = async (envs: WebEnvelope[]): Promise<{ ops: VoiciDraftOp[]; consumed: number }> => {
        const key = deriveVoiciDraftsKey(umk);
        const ops = envs.map((e) => openVoiciDraft(key, user, e.msgId, b64Decode(e.bodyB64)!)).filter((x): x is VoiciDraftOp => !!x);
        assert(ops.length === envs.length, `opened ${ops.length} of ${envs.length} drafts`);
        await publish(mergeVoiciPage(state, ops));
        const consume = { username: user, opIds: ops.map((o) => o.opId), issuedAt: Date.now() };
        const c = await postJson(`${API}/api/accounts/${user}/voici-drafts/consume`, { consume, signature: signVoiciDraftsConsume(consume, owner.keys.adminRoot.privateKey) });
        assert(c.status === 200 && c.json?.ok === true, `consume ${c.status}: ${short(c.text)}`);
        return { ops, consumed: Number(c.json.removed ?? 0) };
      };

      // ── the admin phone, online ─────────────────────────────────────────────────────────────────────────────────
      const phoneUp = await rec.check("setup: O's admin phone (simulated) holds the bare name through the gym relay and answers the voi.ci operations", connectPhone);

      if (phoneUp) {
        await rec.check("the phone endpoint: live answers the page's ownerSignPub with CORS for gym.voi.ci; the deliver preflight is 204 for exactly content-type; a fake origin, an extra header, a wrong content type and a wrong Host are refused without CORS", async () => {
          const acao = (a: PhoneHttpAnswer | null) => a?.headers["access-control-allow-origin"];
          const live = await phoneAnswer("GET", "/api/phone/live", { origin: VOICI_ORIGIN });
          assert(live?.status === 200 && acao(live) === VOICI_ORIGIN, `live ${live?.status} ACAO ${acao(live)}`);
          const lj = JSON.parse(live.body) as { live: boolean; account: string; ownerSignPub: string };
          assert(lj.live && lj.account === user && lj.ownerSignPub === ownerSignPub, `live body ${short(live.body)}`);
          const pre = await phoneAnswer("OPTIONS", "/api/phone/deliver", { origin: VOICI_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" });
          assert(pre?.status === 204 && acao(pre) === VOICI_ORIGIN && !pre.headers["access-control-allow-credentials"], `preflight ${pre?.status} ${short(pre?.headers)}`);
          const refusals: Array<[string, PhoneHttpAnswer | null, number]> = [
            ["fake origin live", await phoneAnswer("GET", "/api/phone/live", { origin: FAKE_ORIGIN }), 403],
            ["fake origin preflight", await phoneAnswer("OPTIONS", "/api/phone/deliver", { origin: FAKE_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }), 403],
            ["extra header preflight", await phoneAnswer("OPTIONS", "/api/phone/deliver", { origin: VOICI_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" }), 403],
            ["text/plain deliver", await phoneAnswer("POST", "/api/phone/deliver", { origin: VOICI_ORIGIN, "content-type": "text/plain" }, "{}"), 415],
            ["GET deliver", await phoneAnswer("GET", "/api/phone/deliver", { origin: VOICI_ORIGIN }), 405],
            ["other path from gym.voi.ci", await phoneAnswer("GET", "/.well-known/flagship-phone", { origin: VOICI_ORIGIN }), 403],
          ];
          for (const [what, a, status] of refusals) {
            assert(a?.status === status, `${what}: ${a?.status} ${short(a?.body)} (expected ${status})`);
            if (status !== 415 && status !== 405) assert(!acao(a), `${what} carried CORS`);
          }
          return `live + preflight granted; ${refusals.length} refused (${refusals.map((r) => r[2]).join(", ")})`;
        });

        await rec.check("publish, phone online: N's post goes straight to the admin phone, which acks it with the admin device key; it also waits in the lane; the admin publishes seq 2 with it and consumes it, so the lane is empty", async () => {
          const op: VoiciDraftOp = { v: 1, opId: randomBytes(16).toString("hex"), op: "post-add", at: Date.now(), deviceId: nId, post: newPost("Written on a non-admin device, delivered to the phone.") };
          const env = nDraft(op);
          const a = await phoneAnswer("POST", "/api/phone/deliver", { "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, JSON.stringify(env));
          assert(a?.status === 200, `deliver ${a?.status} ${short(a?.body)}`);
          const ack = verifyVoiciAck(JSON.parse(a.body).ack, phoneWeb!.phoneRoutePub, { msgId: op.opId, conv: "" });
          assert(ack && ack.phoneRoutePub === phoneWeb!.phoneRoutePub, `the ack doesn't verify under the admin device key: ${short(a.body)}`);
          const again = await phoneAnswer("POST", "/api/phone/deliver", { "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, JSON.stringify(env));
          assert(again?.status === 409, `a repeated draft: ${again?.status}`);
          const d = await depositDraft(env);
          assert(d.status === 200, `lane deposit ${d.status}: ${short(d.text)}`);
          const lane = await listDrafts();
          assert(lane.some((e) => e.msgId === op.opId), "the lane doesn't list the draft (every device shows it grayed from there)");
          const r = await adminPublishes(phoneWeb!.drafts.splice(0));
          const texts = await postsOf(await storedIndex());
          assert(texts.includes(op.post!.text), `seq ${seq} lacks the post: ${short(texts)}`);
          assert(!(await listDrafts()).some((e) => e.msgId === op.opId), "still in the lane after consume");
          return `direct ack by ${ack.phoneRoutePub.slice(0, 8)}; repeat 409; published seq ${seq}; consumed ${r.consumed}`;
        });

        await rec.check("a forged draft (N's grant re-signed by a stranger, or a draft signed by another key) is refused by the phone and by the lane", async () => {
          const stranger = new Uint8Array(randomBytes(32));
          const op: VoiciDraftOp = { v: 1, opId: randomBytes(16).toString("hex"), op: "post-add", at: Date.now(), deviceId: nId, post: newPost("forged") };
          const forged = draftEnvelope({ username: user, umk: owner.keys.umk, device: nKey, deviceId: nId, grant: nGrant!, grantSignature: bytesToHex(ed.sign(new Uint8Array(1), stranger)), op, seq: ++nSeq });
          const a = await phoneAnswer("POST", "/api/phone/deliver", { "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, JSON.stringify(forged));
          assert(a?.status === 403 && a.body.includes("bad-grant"), `phone: ${a?.status} ${short(a?.body)}`);
          const d = await depositDraft(forged);
          assert(d.status === 403, `lane: ${d.status} ${short(d.text)}`);
          return `phone 403 bad-grant; lane ${d.status} ${d.json?.code}`;
        });
      }

      // ── the admin phone, offline ────────────────────────────────────────────────────────────────────────────────
      await rec.check("publish, phone offline: the live ping gets no phone; N's post goes to the drafts lane, shows there (grayed) and not in the published index; when the admin device returns it publishes it and consumes the lane", async () => {
        await dropPhone();
        const live = relayIp ? await phoneRequest({ ip: relayIp, sni: bare, ca: [cert.cert], method: "GET", path: "/api/phone/live", headers: { host: bare, origin: VOICI_ORIGIN } }) : null;
        assert(!live || live.status !== 200, `the live ping still answered 200 after the phone left: ${short(live?.body)}`);
        const op: VoiciDraftOp = { v: 1, opId: randomBytes(16).toString("hex"), op: "post-add", at: Date.now(), deviceId: nId, post: newPost("Written while the admin phone was away.") };
        const d = await depositDraft(nDraft(op));
        assert(d.status === 200 && d.json?.opId === op.opId, `deposit ${d.status}: ${short(d.text)}`);
        const lane = await listDrafts();
        assert(lane.some((e) => e.msgId === op.opId), "the lane doesn't list the draft");
        const before = await postsOf(await storedIndex());
        assert(!before.includes(op.post!.text), "the draft is already on the published page");
        const r = await adminPublishes(lane);
        const after = await postsOf(await storedIndex());
        assert(after.includes(op.post!.text), `seq ${seq} lacks the post`);
        assert((await listDrafts()).length === 0, "the lane isn't empty after consume");
        return `lane held it (unpublished), the returning admin published seq ${seq}, consumed ${r.consumed}`;
      });

      // ── the real site in a headless browser ─────────────────────────────────────────────────────────────────────
      let footerHrefs: string[] | null = null;
      await rec.check(`headless Chromium renders ${VOICI_ORIGIN}/${user}: the page checks out (display name, posts) with no CSP violation and no console error`, async () => {
        let chromium: any;
        try {
          ({ chromium } = await import("playwright"));
        } catch (e) {
          throw new SkipError(`playwright isn't installed: ${String(e)}`);
        }
        const browser = await chromium.launch().catch((e: unknown) => {
          throw new SkipError(`no Chromium for Playwright (npx playwright install chromium): ${String(e)}`);
        });
        try {
          const page = await browser.newPage();
          const problems: string[] = [];
          page.on("console", (m: any) => {
            if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(`console: ${m.text()}`);
          });
          page.on("pageerror", (e: Error) => problems.push(`pageerror: ${e.message}`));
          await page.exposeFunction("__cspViolation", (s: string) => problems.push(`CSP: ${s}`));
          await page.addInitScript({
            content: 'document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(e.violatedDirective + " " + e.blockedURI));',
          });
          const res = await page.goto(`${VOICI_ORIGIN}/${user}`, { waitUntil: "load" });
          assert(res?.status() === 200, `HTTP ${res?.status()}`);
          await page.waitForSelector(".page:not([aria-busy])", { timeout: 30_000 }).catch(async () => {
            throw new Error(`the page never finished rendering: ${short(await page.textContent("body"), 300)}`);
          });
          const body = (await page.textContent("body")) ?? "";
          assert(body.includes("Gym Owner"), `no display name on the page: ${short(body, 300)}`);
          assert(body.includes("delivered to the phone") || body.includes("admin phone was away"), `the posts aren't shown: ${short(body, 300)}`);
          assert(!/couldn.t be checked/i.test(body), "the site says the page couldn't be checked");
          footerHrefs = await page.$$eval(".site-footer a", (as: Array<{ href: string }>) => as.map((a) => a.href));
          await page.waitForTimeout(500);
          assert(problems.length === 0, problems.join(" | "));
          return `rendered and checked, no CSP violation or console error`;
        } finally {
          await browser.close();
        }
      });

      await rec.check("the site's footer links to the terms and to the abuse/report page (§9.7: published contact info)", async () => {
        if (!footerHrefs) throw new SkipError("the page didn't render (see the headless check)");
        assert(footerHrefs.includes(`https://${CONTROL}/terms`) && footerHrefs.includes(`https://${CONTROL}/abuse#voici`), `footer links: ${footerHrefs.join(", ")} (a site build from before the footer links: rebuild and deploy apps/voici-site)`);
        return footerHrefs.join(", ");
      });

      // ── a visitor ───────────────────────────────────────────────────────────────────────────────────────────────
      const vSecret = deriveMessagesSecret({ seed: visitorAcct.keys.umk });
          let backdated = false;
      const backdate = async (): Promise<string> => {
        if (process.env.GYM_VOICI_BACKDATE === "0") throw new SkipError("GYM_VOICI_BACKDATE=0");
        const at = Date.now() - 8 * DAY;
        assert(/^[a-z0-9-]+$/.test(visitorAcct.username), "bad username");
        await run("npx", ["wrangler", "d1", "execute", "flagship-state-gym", "--config", "wrangler.gym.toml", "--remote", "--command", `UPDATE usernames SET claimed_at = ${at} WHERE username = '${visitorAcct.username}'`], {
          cwd: resolvePath(REPO, "apps/com"),
          timeout: 120_000,
        });
        backdated = true;
        return new Date(at).toISOString();
      };
      /** POST messages-attestation for a pseudonym key: the raw answer. */
      const attest = (pPub: string, acct: Account = visitorAcct): Promise<Resp> => {
        const path = `/api/accounts/${acct.username}/messages-attestation`;
        const request = { username: acct.username, pseudonymPub: pPub, renewOfHash: "", deviceCheckRef: "none" as const, issuedAt: Date.now() };
        return http(`${API}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...deviceHeaders(acct.username, REAL_PRIMARY_DEVICE_ID, acct.keys.primaryDevice, "POST", path) },
          body: JSON.stringify({ request, signature: signMessagesKeyAttestationRequest(request, acct.keys.primaryDevice.privateKey) }),
        });
      };
      /** The visitor's app approves a sign-in for a fresh browser key: P, T, attestation, delegation, thread statement. */
      const signIn = async (att?: MessagesKeyAttestation): Promise<Visitor> => {
        const pseud = deriveMessagesPseudonymKey(vSecret, pageId);
        const thread = deriveMessagesThreadKey(vSecret, pageId);
        const pPub = bytesToHex(pseud.publicKey);
        let attestation = att;
        if (!attestation) {
          const r = await attest(pPub);
          assert(r.status === 200 && r.json?.attestation, `attestation ${r.status}: ${short(r.text)}`);
          attestation = r.json.attestation as MessagesKeyAttestation;
        }
        const b = await W.createBrowserKey();
        const now = Date.now();
        const delegation: WebDelegation = {
          scope: "voici-messages",
          origin: VOICI_ORIGIN,
          audience: pageId,
          principalPub: pPub,
          delegateAlg: "p256",
          delegatePub: b.delegatePub,
          issuedAt: now - 5 * 60_000,
          expiresAt: Math.min(attestation.expiresAt, now + 29 * DAY),
          nonce: randomBytes(16).toString("hex"),
        };
        const threadStmt = { pageId, pseudonymPub: pPub, threadPub: bytesToHex(thread.publicKey), issuedAt: now - 5 * 60_000 };
        const session = {
          v: 1,
          pageId,
          username: user,
          origin: VOICI_ORIGIN,
          privateKey: b.privateKey,
          delegatePub: b.delegatePub,
          pseudonymPub: pPub,
          attestation,
          delegation,
          delegationSig: signWebDelegation(delegation, pseud.seed),
          threadStmt,
          threadSig: signVoiciThreadStatement(threadStmt, pseud.seed),
          threadSeed: bytesToHex(thread.seed),
          savedAt: now,
        };
        const v: Visitor = { pageId, pseud, pPub, threadSeed: thread.seed, attestation, session, delegation, conv: voiciConv(pageId, pPub) };
        visitorBrowsers.push(v);
        return v;
      };

      let vis: Visitor | null = null;
      const enrolled = await rec.check("the visitor's app gets a Messages key attestation for its pseudonym on O's page from the gym CA (unattested tier: the throwaway account is backdated 8 days in the gym D1), and the abuse tag opens with the gym abuse key", async () => {
        const pPub = bytesToHex(deriveMessagesPseudonymKey(vSecret, pageId).publicKey);
        let r = await attest(pPub);
        if (r.status === 503 && r.json?.code === "no-abuse-key") {
          writeJson(dir, "voici-gym-abuse-key-entry.json", { version: 1, entries: [gymAbuseKeyEntry()] });
          throw new SkipError(
            `the gym .com has no abuse key (503 no-abuse-key): .com takes abuse keys only from the bundled, ca-track-signed .maintainers/abuse-keys/list.json (no runtime seam). ` +
              `Commit the gym entry (${dir}/voici-gym-abuse-key-entry.json, or \`npx tsx tools/live-e2e/lib/gymAbuseKey.ts\`) to the gym branch's list.json and run gym-refresh.sh`,
          );
        }
        let how = "attested at once";
        if (r.status === 403 && r.json?.code === "unattested-too-new") {
          try {
            how = `backdated to ${await backdate()}`;
          } catch (e) {
            if (e instanceof SkipError) throw e;
            throw new SkipError(`a visitor needs device-integrity evidence or an account ≥ 7 days old, and backdating the throwaway account in the gym D1 failed: ${short(String(e), 200)}`);
          }
          r = await attest(pPub);
        }
        if (r.status === 429 && r.json?.code === "rate-limited") throw new SkipError(`the unattested enrollment budget for this address is spent for today (429 rate-limited, retry in ${r.json.retryAfterSec} s)`);
        assert(r.status === 200 && r.json?.attestation, `attestation ${r.status}: ${short(r.text)}`);
        const att = r.json.attestation as MessagesKeyAttestation;
        assert(att.pseudonymPub === pPub && att.expiresAt - att.issuedAt <= 30 * DAY + 1, `attestation ${short(att)}`);
        assert(!JSON.stringify(att).includes(visitorAcct.username), "the attestation names the account");
        let tag = "the tag doesn't open with the gym abuse key (another key is in the gym list)";
        try {
          const t = openVoiciAbuseTag(GYM_ABUSE_SEED, pPub, b64Decode(att.abuseTag)!);
          assert(t.username === visitorAcct.username, `the tag names ${t.username}`);
          tag = "the tag opens to V with the gym abuse key";
        } catch {
          /* reported in the report check */
        }
        vis = await signIn(att);
        return `${how}; epoch ${att.abuseEpoch}, signed by ${String((att as unknown as { signedBy?: string }).signedBy ?? "?").slice(0, 8)}; ${tag}`;
      });
      const needVisitor = (): Visitor => {
        if (!vis) throw new SkipError(enrolled ? "no visitor session" : "needs a visitor attestation (see the attestation check)");
        return vis;
      };
      const loadPage = async () => {
        const r = await W.loadVoiciPage({ username: user, filesBase: FILES_ORIGIN, apiBase: API, fetch: browserFetch, seqStore: memSeqStore() });
        assert(r.ok, `flagship-web loadVoiciPage: ${r.code}`);
        return r.index as VoiciPageIndex;
      };
      const inboxSince = async (since: string) => {
        const r = await http(`${API}/api/voici/pages/${user}/inbox?since=${encodeURIComponent(since)}`, { headers: await readO() });
        assert(r.status === 200, `inbox ${r.status}: ${short(r.text)}`);
        return r.json as { items: Array<{ id: string; envelope: WebEnvelope; storedAt: number; fetchedAt: number | null; direct: boolean }>; cursor: string; blocks: string[]; revoked: string[] };
      };
      let cursor = "";
      let visitorSeq = 0;
      let firstMessage: WebEnvelope | null = null;
      let ownerSeq = 0;
      const ownerOpens = (env: WebEnvelope) => openVoiciBody(b64Decode(env.bodyB64)!, { conv: env.conv, msgId: env.msgId }, inbox.seed);

      await rec.check("round trip by the mailbox: flagship-web (CORS-checked, gym.voi.ci origin) loads and verifies the page, seals and signs a message with its non-extractable key, the phone is away so it goes to the mailbox; the owner reads and opens it, replies; the browser's thread fetch shows both, the reply verified and opened with T, its own message marked delivered", async () => {
        const v = needVisitor();
        const index = await loadPage();
        assert(index.seq === seq && index.ownerSignPub === ownerSignPub, `verified index seq ${index.seq}`);
        assert(!(await W.pingPhone({ username: user, servicesApex: SERVICES, ownerSignPub, fetch: browserFetch })), "the phone answered live while away");
        const text = "Hello from the gym visitor.";
        const env = (await W.buildVoiciMessage({ session: v.session, index, text, seq: ++visitorSeq })) as WebEnvelope;
        const sent = await W.deliverEnvelope(env, { username: user, servicesApex: SERVICES, ownerSignPub, apiBase: API, live: false, fetch: browserFetch });
        assert(sent.ok && sent.via === "mailbox", `deliver ${JSON.stringify(sent)}`);
        const ib = await inboxSince(cursor);
        cursor = ib.cursor;
        const got = ib.items.find((i) => i.envelope.msgId === env.msgId);
        assert(got && !got.direct, `the inbox doesn't hold the message: ${short(ib.items.map((i) => i.envelope.msgId))}`);
        const opened = ownerOpens(got.envelope);
        assert(opened.ok && opened.plaintext.text === text, `the owner can't open it: ${JSON.stringify(opened)}`);
        firstMessage = got.envelope;
        const threadPub = (got.envelope.cred as { threadStmt: { threadPub: string } }).threadStmt.threadPub;
        const reply = ownerReply({ pageId, conv: v.conv, threadPub, inboxPub: inbox.publicKey, ownerSign, pageSeq: seq, seq: ++ownerSeq, text: "Hi! Got it.", replyTo: env.msgId });
        const rs = await postJson(`${API}/api/voici/web/send`, { envelope: reply });
        assert(rs.status === 200 && rs.json?.storedAt, `reply ${rs.status}: ${short(rs.text)}`);
        const t = await W.fetchThread(v.session, { apiBase: API, fetch: browserFetch });
        assert(t.ok, `thread ${t.code}`);
        const ctx = { pageId, ownerSignPub, pseudonymPub: v.pPub, threadSeed: v.threadSeed, origin: VOICI_ORIGIN };
        const items = (t.items as Array<{ envelope: WebEnvelope; fetchedAt: number | null }>).map((i) => ({ i, r: W.verifyThreadItem(i.envelope, ctx) }));
        const mine = items.find((x) => x.r.ok && x.r.mine && x.r.envelope.msgId === env.msgId);
        const theirs = items.find((x) => x.r.ok && !x.r.mine && x.r.envelope.msgId === reply.msgId);
        assert(mine && mine.r.plaintext.text === text, `own message not in the thread: ${short(items.map((x) => x.r.code ?? "ok"))}`);
        assert(mine.i.fetchedAt !== null, "the own message isn't marked delivered (fetchedAt) after the owner's inbox read");
        assert(theirs && theirs.r.plaintext.text === "Hi! Got it." && theirs.r.plaintext.replyTo === env.msgId, "the reply doesn't verify and open in the browser");
        return `message ${env.msgId.slice(0, 8)} via mailbox, opened by the owner; reply verified and opened in the browser; delivered`;
      });

      await rec.check("round trip with the phone live: flagship-web pings live, delivers straight to the phone (preflight, then the envelope), gets an ack signed by the page's key; the phone forwarded it, so the inbox holds it marked direct; the same envelope again is deduped by .com", async () => {
        const v = needVisitor();
        if (!phoneUp) throw new SkipError("the phone couldn't hold the bare name (see its setup check)");
        await connectPhone();
        const index = await loadPage();
        const live = await W.pingPhone({ username: user, servicesApex: SERVICES, ownerSignPub, fetch: browserFetch });
        assert(live, "flagship-web's live ping says no");
        const env = (await W.buildVoiciMessage({ session: v.session, index, text: "Straight to your phone.", seq: ++visitorSeq })) as WebEnvelope;
        const sent = await W.deliverEnvelope(env, { username: user, servicesApex: SERVICES, ownerSignPub, apiBase: API, live: true, fetch: browserFetch });
        assert(sent.ok && sent.via === "phone" && sent.ack?.msgId === env.msgId, `deliver ${JSON.stringify(sent)}`);
        assert(phoneWeb!.forwardErrors.length === 0, `the phone's forward failed: ${phoneWeb!.forwardErrors.join("; ")}`);
        const ib = await inboxSince(cursor);
        cursor = ib.cursor;
        const got = ib.items.find((i) => i.envelope.msgId === env.msgId);
        assert(got?.direct === true, `the inbox lacks the forwarded message or it isn't marked direct: ${short(got)}`);
        const again = await postJson(`${API}/api/voici/web/send`, { envelope: env, direct: true });
        assert(again.status === 200 && !again.json?.storedAt, `a repeated forward: ${again.status} ${short(again.text)}`);
        const dup = await phoneAnswer("POST", "/api/phone/deliver", { origin: VOICI_ORIGIN, "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, JSON.stringify(env));
        assert(dup?.status === 409, `the phone took a repeated msgId: ${dup?.status}`);
        return `ack by ${String(sent.ack.phoneRoutePub).slice(0, 8)} under ownerSignPub; inbox direct:true; .com dedupe (no storedAt); phone 409 on a repeat`;
      });

      await rec.check("reply alerts: .com serves its VAPID key; the visitor's browser key subscribes its own conversation (on) and turns it off; another browser key with this cred, or the visitor's key with a stranger's cred, is refused", async () => {
        const v = needVisitor();
        const k = await http(`${API}/api/voici/web/alert-key`, { headers: { origin: VOICI_ORIGIN } });
        if (k.status === 503) throw new SkipError("the gym .com has no Web Push VAPID keys (alert-key 503 unavailable)");
        if (k.status === 404) throw new SkipError("GET /api/voici/web/alert-key is 404: the gym Worker predates the reply alerts (migration 0125)");
        assert(k.status === 200 && typeof k.json?.key === "string" && k.headers.get("access-control-allow-origin") === VOICI_ORIGIN, `alert-key ${k.status} ${short(k.text)}`);
        const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", ua.publicKey)).toString("base64url");
        const endpoint = `https://fcm.googleapis.com/fcm/send/gym-voici-${randomBytes(8).toString("hex")}`;
        const subscription = { endpoint, keys: { p256dh, auth: randomBytes(16).toString("base64url") } };
        const post = (body: unknown) => browserFetch(`${API}/api/voici/web/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const onBody = await W.buildVoiciAlertsOrder(v.session, { op: "on", subscription });
        const on = await post(onBody);
        const onJ = (await on.json()) as { ok?: boolean; alerts?: string; code?: string };
        assert(on.status === 200 && onJ.ok && onJ.alerts === "on", `on ${on.status} ${JSON.stringify(onJ)}`);
        const other = await W.createBrowserKey();
        const forged = await W.buildVoiciAlertsOrder({ ...v.session, privateKey: other.privateKey }, { op: "off", endpoint });
        const f = await post(forged);
        assert(f.status === 403, `another browser key turned the alert off: ${f.status} ${await f.text()}`);
        const off = await post(await W.buildVoiciAlertsOrder(v.session, { op: "off", endpoint }));
        const offJ = (await off.json()) as { ok?: boolean; alerts?: string };
        assert(off.status === 200 && offJ.alerts === "off", `off ${off.status} ${JSON.stringify(offJ)}`);
        return `on → off for ${endpoint.slice(-16)}; a foreign browser key refused (${f.status})`;
      });

      await rec.check("first-contact limit: the visitor's account asks for a second new pseudonym the same day and is refused 429 first-contact-limit with its limit and retryAfterSec", async () => {
        needVisitor();
        const p2 = bytesToHex(deriveMessagesPseudonymKey(vSecret, randomBytes(16).toString("hex")).publicKey);
        const r = await attest(p2);
        assert(r.status === 429 && r.json?.code === "first-contact-limit", `second new recipient: ${r.status} ${short(r.text)}`);
        assert(Number.isSafeInteger(r.json.limit) && r.json.retryAfterSec > 0 && r.json.retryAfterSec <= 86_400, `limit/retry ${short(r.json)}`);
        return `limit ${r.json.limit}/day (${backdated ? "unattested tier, backdated" : "tier"}); retry in ${r.json.retryAfterSec} s`;
      });

      await rec.check("block: the owner's signed block makes .com answer the visitor's next message 'accepted' with nothing stored (no oracle) and the phone 200 with no ack; the inbox lists the block; unblock restores delivery", async () => {
        const v = needVisitor();
        const block = (op: "block" | "unblock") => {
          const b = { pageId, pseudonymPub: v.pPub, op, issuedAt: Date.now() };
          return postJson(`${API}/api/voici/pages/${user}/block`, { block: b, signature: signVoiciBlock(b, ownerSign.seed) });
        };
        const b = await block("block");
        assert(b.status === 200, `block ${b.status}: ${short(b.text)}`);
        const forgedB = { pageId, pseudonymPub: v.pPub, op: "unblock" as const, issuedAt: Date.now() };
        const forged = await postJson(`${API}/api/voici/pages/${user}/block`, { block: forgedB, signature: signVoiciBlock(forgedB, v.pseud.seed) });
        assert(forged.status === 403, `an unblock signed by the visitor: ${forged.status}`);
        const index = await loadPage();
        const env = (await W.buildVoiciMessage({ session: v.session, index, text: "Can you still hear me?", seq: ++visitorSeq })) as WebEnvelope;
        const s = await W.sendToMailbox(env, { apiBase: API, fetch: browserFetch });
        assert(s.ok, `the browser saw a refusal (an oracle): ${JSON.stringify(s)}`);
        const raw = await postJson(`${API}/api/voici/web/send`, env);
        assert(raw.status === 200 && raw.json?.status === "accepted" && !raw.json?.storedAt, `blocked send: ${raw.status} ${short(raw.text)}`);
        let phoneNote = "phone not live";
        if (phone && phoneWeb) {
          phoneWeb.blocked.add(v.pPub);
          const env2 = (await W.buildVoiciMessage({ session: v.session, index, text: "And on your phone?", seq: ++visitorSeq })) as WebEnvelope;
          const a = await phoneAnswer("POST", "/api/phone/deliver", { origin: VOICI_ORIGIN, "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, JSON.stringify(env2));
          assert(a?.status === 200 && !a.body.includes('"ack"'), `phone, blocked: ${a?.status} ${short(a?.body)}`);
          phoneWeb.blocked.delete(v.pPub);
          phoneNote = "phone 200 without ack";
        }
        const ib = await inboxSince(cursor);
        assert(!ib.items.some((i) => i.envelope.msgId === env.msgId), "the blocked message reached the inbox");
        assert(ib.blocks.includes(v.pPub), `the inbox doesn't list the block: ${short(ib.blocks)}`);
        const u = await block("unblock");
        assert(u.status === 200, `unblock ${u.status}`);
        const env3 = (await W.buildVoiciMessage({ session: v.session, index, text: "Back again.", seq: ++visitorSeq })) as WebEnvelope;
        const ok = await postJson(`${API}/api/voici/web/send`, env3);
        assert(ok.status === 200 && ok.json?.storedAt, `after unblock: ${ok.status} ${short(ok.text)}`);
        return `dropped silently (.com accepted, nothing stored; ${phoneNote}); a visitor-signed unblock 403; unblock delivers again`;
      });

      await rec.check("report → open-tag → ban: the owner reports the first message; the admin reads it and opens its abuse tag with the gym abuse key (voici-abuse's openReport), which names V; the ban refuses V's next attestation (banned) and drops the reported pseudonym's sends with no oracle", async () => {
        const v = needVisitor();
        assert(firstMessage, "no stored message to report (the mailbox round trip failed)");
        const r = { kind: "message" as const, pageId, envelope: firstMessage, reason: "spam" as const, attached: null, issuedAt: Date.now() };
        const rep = await postJson(`${API}/api/voici/reports`, { ...r, signature: signVoiciMessageReport(r, ownerSign.seed) });
        assert(rep.status === 200 && typeof rep.json?.reportId === "string", `report ${rep.status}: ${short(rep.text)}`);
        const reportId = rep.json.reportId as string;
        const forgedR = { ...r, issuedAt: Date.now() };
        const forged = await postJson(`${API}/api/voici/reports`, { ...forgedR, signature: signVoiciMessageReport(forgedR, v.pseud.seed) });
        assert(forged.status === 403, `a report not signed by the page's key: ${forged.status}`);
        const got = await http(`${API}/api/admin/voici/reports/${reportId}`, { headers: adminHeaders() });
        assert(got.status === 200 && got.json?.report?.envelope, `admin read ${got.status}: ${short(got.text)}`);
        const { openReport } = (await import(new URL("../../../../scripts/voici-abuse.mjs", import.meta.url).href)) as { openReport(r: unknown, seed: Uint8Array): string[] };
        let opened: string[];
        try {
          opened = openReport(got.json.report, GYM_ABUSE_SEED);
        } catch (e) {
          throw new SkipError(`open-tag: the tag doesn't open with the gym abuse key (${String(e)}); the gym's list.json holds another key: use lib/gymAbuseKey.ts's entry`);
        }
        assert(opened[0] === `Sender account: ${visitorAcct.username}`, `open-tag: ${opened.join(" / ")}`);
        const ban = await postJson(`${API}/api/admin/voici/ban`, { username: visitorAcct.username, reportId, reason: "spam" }, adminHeaders());
        assert(ban.status === 200 && ban.json?.pseudonymBanned === true, `ban ${ban.status}: ${short(ban.text)}`);
        const p3 = bytesToHex(deriveMessagesPseudonymKey(vSecret, randomBytes(16).toString("hex")).publicKey);
        const refused = await attest(p3);
        assert(refused.status === 403 && refused.json?.code === "banned", `attestation after the ban: ${refused.status} ${short(refused.text)}`);
        const index = await loadPage();
        const env = (await W.buildVoiciMessage({ session: v.session, index, text: "Still here.", seq: ++visitorSeq })) as WebEnvelope;
        const s = await postJson(`${API}/api/voici/web/send`, env);
        assert(s.status === 200 && !s.json?.storedAt, `a banned pseudonym's send: ${s.status} ${short(s.text)}`);
        return `report ${reportId.slice(0, 8)}; ${opened[0]}; banned; attestation 403 banned; the pseudonym's sends dropped silently`;
      });

      await rec.check("the revoke rule: a stranger pseudonym can't sign the visitor's browser out (404 unknown-delegate) and the browser keeps reading its thread; the visitor's own pseudonym can (then the thread fetch is 403 revoked)", async () => {
        const v = needVisitor();
        const delegatePub = v.delegation.delegatePub;
        const strangerSeed = new Uint8Array(randomBytes(32));
        const rv = { delegatePub, issuedAt: Date.now() };
        const s = await postJson(`${API}/api/voici/web/revoke`, { revoke: rv, principalPub: bytesToHex(ed.getPublicKey(strangerSeed)), signature: signWebDelegationRevoke(rv, strangerSeed) });
        assert(s.status === 404 && s.json?.code === "unknown-delegate", `stranger revoke: ${s.status} ${short(s.text)}`);
        const wrongSig = await postJson(`${API}/api/voici/web/revoke`, { revoke: rv, principalPub: v.pPub, signature: signWebDelegationRevoke(rv, strangerSeed) });
        assert(wrongSig.status === 403 && wrongSig.json?.code === "bad-signature", `revoke naming P, signed by a stranger: ${wrongSig.status} ${short(wrongSig.text)}`);
        const still = await W.fetchThread(v.session, { apiBase: API, fetch: browserFetch });
        assert(still.ok, `thread after the stranger's try: ${still.code}`);
        const own = { delegatePub, issuedAt: Date.now() };
        const r = await postJson(`${API}/api/voici/web/revoke`, { revoke: own, principalPub: v.pPub, signature: signWebDelegationRevoke(own, v.pseud.seed) });
        assert(r.status === 200 && r.json?.ok, `own revoke: ${r.status} ${short(r.text)}`);
        const gone = await W.fetchThread(v.session, { apiBase: API, fetch: browserFetch });
        assert(!gone.ok && gone.code === "revoked", `thread after sign-out: ${JSON.stringify(gone)}`);
        return "stranger 404 unknown-delegate, wrong signer 403; own sign-out ok, then 403 revoked";
      });

      // ── takedown ────────────────────────────────────────────────────────────────────────────────────────────────
      await rec.check("takedown: the admin tool removes O's page; voi.ci/<u> is 410, .com's page and piece reads are gone, files.voi.ci no longer serves the index or a piece, a publish is refused taken-down, a message to the page 404", async () => {
        const idx = published as VoiciPageIndex | null;
        assert(idx, "nothing published");
        const piece = idx.pieces[0]!;
        let done = false;
        for (let i = 0; i < 10 && !done; i++) {
          const t = await postJson(`${API}/api/admin/voici/takedown`, { username: user, reason: "spam" }, adminHeaders());
          assert(t.status === 200 && t.json?.ok, `takedown ${t.status}: ${short(t.text)}`);
          done = t.json.done === true;
          if (!done) await sleep(1_000);
        }
        assert(done, "the takedown never reported done");
        const site = await http(`${VOICI_ORIGIN}/${user}`);
        assert(site.status === 410, `voi.ci/${user} ${site.status}`);
        const page = await http(`${API}/api/voici/pages/${user}`);
        assert(page.status === 410 || page.status === 404, `GET page ${page.status}`);
        const p = await http(`${API}/api/voici/pages/${user}/pieces/${piece.sha256}`);
        assert(p.status === 404, `.com piece read ${p.status}`);
        // Past the CDN cache (a fresh query string): the objects themselves are gone. The plain URLs show the purge.
        const bust = `?gym=${Date.now()}`;
        const fi = await tryHttp(`${FILES_ORIGIN}/v1/u/${user}.json${bust}`);
        const fp = await tryHttp(`${FILES_ORIGIN}/v1/p/${pageId}/${piece.sha256}${bust}`);
        assert(fi.status !== 200 && fp.status !== 200, `R2 still holds the page: index ${fi.status}, piece ${fp.status}`);
        const ci = await tryHttp(`${FILES_ORIGIN}/v1/u/${user}.json`);
        const cp = await tryHttp(`${FILES_ORIGIN}/v1/p/${pageId}/${piece.sha256}`);
        const purge = ci.status === 200 || cp.status === 200 ? `NOT purged from the CDN cache (index ${ci.status}, piece ${cp.status}: CLOUDFLARE_PURGE_TOKEN / VOICI_FILES_ZONE_ID)` : "cache purged";
        const next = buildIndex({ username: user, pageId, seq: seq + 1, issuedAt: Date.now(), state, inboxPub: bytesToHex(inbox.publicKey), ownerSignPub, signerSeed: owner.keys.adminRoot.privateKey });
        const pub = await postJson(`${API}/api/voici/pages/${user}/publish`, { index: next.index });
        assert(pub.json?.code === "taken-down" && pub.status >= 400, `publish after takedown: ${pub.status} ${short(pub.text)}`);
        let msg = "no visitor";
        if (vis) {
          const env = (await W.buildVoiciMessage({ session: (vis as Visitor).session, index: idx, text: "Hello?", seq: ++visitorSeq })) as WebEnvelope;
          const s = await postJson(`${API}/api/voici/web/send`, env);
          assert(s.status === 404, `a message to a taken-down page: ${s.status}`);
          msg = "send 404";
        }
        return `voi.ci 410; .com page ${page.status}, piece 404; R2 index ${fi.status}, piece ${fp.status}; ${purge}; publish ${pub.status} taken-down; ${msg}`;
      });
    } finally {
      await dropPhone();
      const grantId = (nGrant as Record<string, unknown> | null)?.grantId;
      if (typeof grantId === "string") {
        const r = { grantId, username: user, reason: "decommissioned" as const, issuedAt: Date.now() };
        await postJson(`${API}/api/users/${user}/device-grants/revoke`, { request: r, signature: bytesToHex(signRevokeDeviceCapabilityGrant(r, owner.keys.irk)) }).catch(() => undefined);
      }
      if (ADMIN) await postJson(`${API}/api/admin/voici/takedown`, { username: user, reason: "spam" }, adminHeaders()).catch(() => undefined);
    }
  },
};

function memSeqStore() {
  const m = new Map<string, number>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: number) => void m.set(k, v) };
}
