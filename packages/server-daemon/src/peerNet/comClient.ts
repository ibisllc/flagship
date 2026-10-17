/**
 * This server's peer-backup calls to `.com`, each signed by its STK.
 * Every call is bounded so an unreachable `.com` costs one timeout.
 */
import { createHash } from "node:crypto";
import {
  canonicalPbCheckin,
  canonicalPbDirectory,
  canonicalPbFillerFetch,
  canonicalPbFillerProof,
  canonicalPbRedeem,
  canonicalPbRootDeposit,
  canonicalPbTokens,
  parsePbNetwork,
  pbBlindedDigest,
  pbSpendsDigest,
  rsaPublicKeyFromJwk,
  type PbSpend,
  type SealedPbRoot,
} from "@flagship/protocol";
import { hex } from "./mailOps.js";
import { PbComError, PbUnreachable, type PbCheckinReply, type PbComClient, type PbDirectory, type PbNetworkInfo } from "./types.js";

export interface HttpPbComOptions {
  baseUrl: string;
  serverDomain: string;
  sign: (msg: Uint8Array) => Uint8Array;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function buildHttpPbCom(o: HttpPbComOptions): PbComClient {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const timeout = o.timeoutMs ?? 60_000;
  const sig = (m: Uint8Array) => hex(o.sign(m));

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await f(`${o.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new PbComError(`flagshipserver.com is unreachable (${(e as Error).message})`, 0);
    }
    if (!res.ok) {
      let msg = `status ${res.status}`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j.error === "string") msg = j.error;
      } catch {
        /* not JSON */
      }
      throw new PbComError(msg, res.status);
    }
    return res;
  }
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => (await (await call(method, path, body)).json()) as T;

  return {
    async network(): Promise<PbNetworkInfo> {
      const j = await json<{ network: unknown; tokenKey: Record<string, unknown>; relayBase: string }>("GET", "/api/peer-backup/network");
      const net = parsePbNetwork(j.network);
      if (typeof net === "string") throw new PbComError(net, 502);
      return { network: net, tokenKey: rsaPublicKeyFromJwk(j.tokenKey), relayBase: j.relayBase };
    },
    async checkin(a): Promise<PbCheckinReply> {
      const issuedAt = now();
      const c = { serverDomain: o.serverDomain, ...a, issuedAt };
      const reply = await json<PbCheckinReply & { network: unknown }>("POST", "/api/peer-backup/holder/checkin", {
        ...c,
        signatureHex: sig(canonicalPbCheckin(c)),
      });
      const net = parsePbNetwork(reply.network);
      if (typeof net === "string") throw new PbComError(net, 502);
      return { ...reply, network: net };
    },
    async fetchFiller(index: number): Promise<Uint8Array> {
      const issuedAt = now();
      const res = await call("POST", "/api/peer-backup/filler", {
        serverDomain: o.serverDomain,
        index,
        issuedAt,
        signatureHex: sig(canonicalPbFillerFetch(o.serverDomain, index, issuedAt)),
      });
      return new Uint8Array(await res.arrayBuffer());
    },
    async proof(challengeId: string, answerHex: string) {
      const issuedAt = now();
      return json<{ passed: boolean }>("POST", "/api/peer-backup/holder/proof", {
        serverDomain: o.serverDomain,
        challengeId,
        answerHex,
        issuedAt,
        signatureHex: sig(canonicalPbFillerProof(o.serverDomain, challengeId, answerHex, issuedAt)),
      });
    },
    async directory(): Promise<PbDirectory> {
      const issuedAt = now();
      const d = await json<PbDirectory & { network: unknown }>("POST", "/api/peer-backup/directory", {
        serverDomain: o.serverDomain,
        issuedAt,
        signatureHex: sig(canonicalPbDirectory(o.serverDomain, issuedAt)),
      });
      const net = parsePbNetwork(d.network);
      if (typeof net === "string") throw new PbComError(net, 502);
      return { ...d, network: net };
    },
    async tokens(blindedHex: string[]): Promise<string[]> {
      const issuedAt = now();
      const j = await json<{ signatures: string[] }>("POST", "/api/peer-backup/tokens", {
        serverDomain: o.serverDomain,
        blindedHex,
        issuedAt,
        signatureHex: sig(canonicalPbTokens(o.serverDomain, blindedHex.length, pbBlindedDigest(blindedHex), issuedAt)),
      });
      if (!Array.isArray(j.signatures) || j.signatures.length !== blindedHex.length) throw new PbComError("bad token reply", 502);
      return j.signatures;
    },
    async redeem(pikPubHex: string, spends: PbSpend[]) {
      const issuedAt = now();
      const j = await json<{ results: Array<{ serialHex: string; ok: boolean; reason?: string }> }>("POST", "/api/peer-backup/holder/redeem", {
        serverDomain: o.serverDomain,
        pikPubHex,
        spends,
        issuedAt,
        signatureHex: sig(canonicalPbRedeem(o.serverDomain, pikPubHex, pbSpendsDigest(spends), issuedAt)),
      });
      return j.results;
    },
    async putRoot(serverId: string, generation: number, revision: number, sealed: SealedPbRoot) {
      const issuedAt = now();
      const ctSha = createHash("sha256").update(Buffer.from(sealed.ciphertextHex, "hex")).digest("hex");
      await json("PUT", `/api/peer-backup/root/${encodeURIComponent(serverId)}`, {
        generation,
        revision,
        nonceHex: sealed.nonceHex,
        ciphertextHex: sealed.ciphertextHex,
        issuedAt,
        signatureHex: sig(canonicalPbRootDeposit(serverId, generation, revision, ctSha, issuedAt)),
      });
    },
    async getRoot(serverId: string): Promise<SealedPbRoot | null> {
      try {
        const j = await json<{ nonceHex: string; ciphertextHex: string }>("GET", `/api/peer-backup/root/${encodeURIComponent(serverId)}`);
        return { nonceHex: j.nonceHex, ciphertextHex: j.ciphertextHex };
      } catch (e) {
        if (e instanceof PbComError && e.status === 404) return null;
        throw e;
      }
    },
  };
}

/** The relay: POST the sealed envelope to `<relayBase>/pb/m/<mailboxId>`. */
export function buildHttpPbTransport(o: { relayBase: () => string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const f = o.fetchImpl ?? fetch;
  return {
    async send(mailboxId: string, envelope: Uint8Array): Promise<Uint8Array> {
      let res: Response;
      try {
        res = await f(`${o.relayBase()}/pb/m/${mailboxId}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: envelope,
          signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
        });
      } catch (e) {
        throw new PbUnreachable((e as Error).message);
      }
      if (!res.ok) throw new PbUnreachable(`relay answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
