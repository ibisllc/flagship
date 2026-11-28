// The org read token, end to end against a `.com` (docs/account-read-token.md "Org routes"; `.com` bdea6fef1, box
// 73df9f8cd). It makes a throwaway org with fresh keys, has an org admin approve a server code, registers a stand-in
// box under its own STK, and then reads the org the way an org box does: through the daemon's own OrgReadToken
// (packages/server-daemon/src/orgReadToken.ts), which mints `box:<domain>` with the STK and sends the token on every
// org GET. The box then revokes itself (its STK, the daemon's revoke-self path) and must be refused a new token, and,
// on a `.com` that requires the token for an org read, refused that read with the token it already holds.
//
// No UpCloud: everything here is `.com` and keys, so the group needs no box. The real box leg (an org box's daemon)
// needs an org recipe flow the gym fleet does not build yet; the daemon class used here is the one that box runs.
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ORG_GENESIS_PREV,
  canonicalOrgAuthority,
  canonicalOrgServerCode,
  canonicalPqKeyBinding,
  hybridSigKeygen,
  hybridSign,
  orgAuthorityHash,
  orgBoxReadSubject,
  orgKeyIdHex,
  orgSeatReadSubject,
  orgSeatSubject,
  orgServerCodeSha256,
  signOrgApproval,
  signOrgReadTokenRequest,
  signOrgServerRegister,
  signOrgServerEnrolment,
  newOrgServerEnrolmentKey,
  signServerRevokeBySelf,
} from "@flagship/protocol";
import { OrgReadToken } from "../../../packages/server-daemon/src/orgReadToken.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const rand = (n: number): string => randomBytes(n).toString("hex");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface OrgKey {
  seatId: string;
  secret: Uint8Array;
  edSeed: Uint8Array;
  ed25519PubHex: string;
  binding: Record<string, unknown>;
  keyId: string;
}

function orgKey(orgId: string, issuedAt: number): OrgKey {
  const seatId = rand(16);
  const edSeed = new Uint8Array(randomBytes(32));
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, new Uint8Array(randomBytes(32)));
  const st = { role: "org-seat-admin" as const, subjectId: orgSeatSubject(orgId, seatId), ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt };
  const binding = { v: 1 as const, ...st, signature: hex(hybridSign(secretKey, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
  return { seatId, secret: secretKey, edSeed, ed25519PubHex: st.ed25519PubHex, binding, keyId: orgKeyIdHex(binding) };
}

export interface OrgReadFlowOptions {
  /** `https://<control apex>` */
  control: string;
  /** The services apex the org's server names live under (`gym.flagship.services`). */
  servicesApex: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Org name prefix; a random suffix keeps every run's org new (orgs are never deleted). */
  namePrefix?: string;
  log?: (s: string) => void;
}

type Json = { status: number; body: any };

/** Each step, in order; a step throws (with the `.com` answer) when `.com` did not do what the box relies on. */
export function orgReadFlow(o: OrgReadFlowOptions) {
  const f = o.fetchImpl ?? ((...a) => fetch(...a));
  const now = o.now ?? Date.now;
  const base = o.control.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown, token?: string | null): Promise<Json> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await f(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: parsed };
  };
  const expect = (r: Json, status: number, what: string) => {
    if (r.status !== status) throw new Error(`${what}: HTTP ${r.status}, expected ${status}: ${JSON.stringify(r.body).slice(0, 240)}`);
    return r;
  };

  const t0 = now();
  const orgId = rand(16);
  const name = `${o.namePrefix ?? "gymorg"}${rand(4)}`;
  const keys = [0, 1, 2, 3].map(() => orgKey(orgId, t0 - 10 * MIN));
  const [A, B, C, D] = keys as [OrgKey, OrgKey, OrgKey, OrgKey];
  const stkSeed = new Uint8Array(randomBytes(32));
  const stkPub = ed25519.getPublicKey(stkSeed);
  const serverDomain = `home.${name}.${o.servicesApex}`;
  let genesisHash = "";
  let boxToken: string | null = null;
  const sentAuth: string[] = [];
  // The daemon's own org reader, over a fetch that notes whether each org GET carried a token.
  const reader = new OrgReadToken({
    comBaseUrl: base,
    orgId,
    serverDomain,
    boxPublicKey: () => stkPub,
    signAsBox: (m) => ed25519.sign(m, stkSeed),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const auth = h.get("authorization");
      if ((init?.method ?? "GET") === "GET") sentAuth.push(auth ?? "");
      const r = await f(input as string, init);
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/read-token") && r.ok) {
        boxToken = ((await r.clone().json()) as { token?: string }).token ?? null;
      }
      return r;
    }) as typeof fetch,
    now,
    retryAfterMs: 0,
    log: o.log,
  });
  const boxGet = reader.fetchFor();
  const orgPath = (sub: string) => `/api/orgs/${orgId}/${sub}`;
  const approve = (k: OrgKey, order: Uint8Array, at: number) =>
    signOrgApproval({ orgId, oarVersion: 0, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt: at, notAfter: at + DAY }, k.secret);
  const mintSeat = async (k: OrgKey) => {
    const request = { orgId, subject: orgSeatReadSubject(k.seatId), pubHex: k.ed25519PubHex, issuedAt: now(), nonceHex: rand(16) };
    return call("POST", orgPath("read-token"), { request, signature: signOrgReadTokenRequest(request, (m) => ed25519.sign(m, k.edSeed)) });
  };
  const mintBox = async () => {
    const request = { orgId, subject: orgBoxReadSubject(serverDomain), pubHex: hex(stkPub), issuedAt: now(), nonceHex: rand(16) };
    return call("POST", orgPath("read-token"), { request, signature: signOrgReadTokenRequest(request, (m) => ed25519.sign(m, stkSeed)) });
  };

  return {
    orgId,
    name,
    serverDomain,

    /** A fresh org: genesis with four admins (one a board seat), approved by all four. */
    async createOrg(): Promise<string> {
      const at = now();
      const record = {
        orgId,
        version: 0,
        prevHash: ORG_GENESIS_PREV,
        admins: [
          { seatId: A.seatId, kind: "admin", binding: A.binding },
          { seatId: B.seatId, kind: "admin", binding: B.binding },
          { seatId: C.seatId, kind: "admin", binding: C.binding },
          { seatId: D.seatId, kind: "board", binding: D.binding },
        ],
        bylaws: { overturnSeats: [B.seatId, C.seatId, D.seatId], overturnK: 2, vetoK: 1 },
        founderSeatId: A.seatId,
        kGov: 2,
        kGrant: 1,
        kDestroy: 2,
        kSite: 3,
        issuedAt: at - 5 * MIN,
      };
      genesisHash = orgAuthorityHash(record as never);
      const order = canonicalOrgAuthority(record as never);
      const entry = { record, via: "genesis", approvals: keys.map((k) => approve(k, order, at - 4 * MIN)) };
      const r = expect(await call("POST", "/api/orgs", { name, entry }), 200, "create the org");
      if (r.body?.orgId !== orgId || r.body?.genesisHash !== genesisHash) throw new Error(`.com answered another org: ${JSON.stringify(r.body).slice(0, 200)}`);
      return `org ${name} (${orgId.slice(0, 8)})`;
    },

    /** An org admin approves a server code; the stand-in box registers with it under its STK. */
    async registerBox(): Promise<string> {
      const at = now();
      const enrolment = newOrgServerEnrolmentKey();
      const code = { orgId, genesisHash, serial: `gymorg-${rand(8)}`, serverName: "home", serverDomain, delegatedPubKeyHex: rand(32), enrolmentPubKeyHex: enrolment.pubKeyHex, issuedAt: at, expiresAt: at + 6 * 60 * MIN };
      expect(await call("POST", orgPath("servers/code"), { code, approvals: [approve(B, canonicalOrgServerCode(code as never), at)] }), 200, "issue the server code");
      const request = { orgId, serial: code.serial, serverDomain, codeSha256: orgServerCodeSha256(code as never), serverIdentityPubKeyHex: hex(stkPub), issuedAt: now(), nonceHex: rand(16) };
      expect(await call("POST", orgPath("servers/register"), { request, signature: signOrgServerRegister(request as never, stkSeed), enrolmentSignature: signOrgServerEnrolment(request as never, code as never, enrolment.seedHex) }), 200, "register the box");
      return serverDomain;
    },

    /** The box reads authority, seats and keys through the daemon's reader: each GET carries its STK-minted token. */
    async boxReads(): Promise<string> {
      const out: string[] = [];
      for (const sub of ["authority", "seats", "keys"]) {
        sentAuth.length = 0;
        const r = await boxGet(`${base}${orgPath(sub)}`, { signal: AbortSignal.timeout(30_000) });
        if (r.status !== 200) throw new Error(`GET ${sub} with the box's token: HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        if (!sentAuth.some((a) => /^Bearer ort1\./.test(a))) throw new Error(`GET ${sub} went out without the org read token (the mint failed or .com refused it)`);
        if (sub === "authority") {
          const body = (await r.json()) as { org?: { genesisHash?: string } };
          if (body.org?.genesisHash !== genesisHash) throw new Error("authority answered another genesis");
        } else await r.arrayBuffer();
        out.push(sub);
      }
      if (!boxToken) throw new Error("no box token was minted");
      return `${out.join(", ")} read with box token ${String(boxToken).slice(0, 12)}…`;
    },

    /** A box token never reads the audit log (admin scope); an org admin's seat token does. */
    async auditScope(): Promise<string> {
      expect(await call("GET", orgPath("log")), 401, "the audit log without a token");
      const byBox = expect(await call("GET", orgPath("log"), undefined, boxToken), 401, "the audit log with the box's token");
      if (byBox.body?.code !== "org-read-token-required") throw new Error(`refusal code ${byBox.body?.code}`);
      const seat = expect(await mintSeat(A), 200, "an org admin's seat token");
      const log = expect(await call("GET", orgPath("log"), undefined, seat.body.token), 200, "the audit log with the admin's token");
      const n = Array.isArray(log.body?.entries) ? log.body.entries.length : 0;
      if (n < 3) throw new Error(`the audit log has ${n} entries (expected the genesis, the server code and the registration)`);
      return `box token 401, admin token 200 (${n} log entries)`;
    },

    /** The box revokes itself with its STK; it is then refused a token, and (where `.com` requires one) its old token. */
    async revokedBoxRefused(): Promise<string> {
      const old = boxToken;
      const request = { serverId: serverDomain, reason: "gym org-read check", issuedAt: now() };
      const sig = signServerRevokeBySelf(request, { publicKey: stkPub, privateKey: stkSeed });
      expect(await call("POST", `/api/server/by-domain/${encodeURIComponent(serverDomain)}/revoke`, { request, signature: hex(sig) }), 200, "the box's revoke-self");
      const seat = expect(await mintSeat(A), 200, "an org admin's seat token");
      const listed = expect(await call("GET", orgPath("servers"), undefined, seat.body.token), 200, "the org's servers");
      const me = (listed.body?.servers ?? []).find((s: { serverDomain?: string }) => s.serverDomain === serverDomain);
      if (!me?.revoked) throw new Error(`the org's server list does not show ${serverDomain} revoked`);
      const mint = await mintBox();
      if (mint.status !== 403) throw new Error(`a revoked box minted an org read token: HTTP ${mint.status}`);
      const notes = ["new token refused (403)"];
      for (const sub of ["seats", "keys", "authority"]) {
        const open = await call("GET", orgPath(sub));
        if (open.status === 401) {
          const withOld = await call("GET", orgPath(sub), undefined, old);
          if (withOld.status !== 401) throw new Error(`GET ${sub} needs a token, and the revoked box's old token still read it: HTTP ${withOld.status}`);
          notes.push(`${sub}: old token refused (401)`);
        } else notes.push(`${sub}: open without a token on this .com`);
      }
      return notes.join("; ");
    },
  };
}
