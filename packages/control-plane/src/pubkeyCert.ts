import {
  ed,
  signUserPubKeyBinding,
  type Keypair,
  type UserPubKeyBinding,
} from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";
import { hexToBytes, bytesToHex } from "./hex.js";
import {
  notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface CaIssuer {
  keypair: Keypair;
  issuer: string;
}

export interface PubkeyCertDeps {
  ca: CaIssuer;
  usernames: UsernameStorage;
  ttlMs?: number;
  cacheMaxAgeSec?: number;
  now?: () => number;
}

export async function handleUserPubKeyCert(
  deps: PubkeyCertDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const ttlMs = deps.ttlMs ?? 7 * 24 * 60 * 60_000;
  const cacheMaxAgeSec = deps.cacheMaxAgeSec ?? 60 * 60;
  const now = (deps.now ?? (() => Date.now()))();
  const u = await deps.usernames.get(username);
  if (!u) return notFound("username not registered");

  const binding: UserPubKeyBinding = {
    version: 1,
    username: u.username,
    pubKey: hexToBytes(u.irkPubHex),
    issuedAt: now,
    expiresAt: now + ttlMs,
    issuer: deps.ca.issuer,
  };
  const sig = signUserPubKeyBinding(binding, deps.ca.keypair);
  return ok(
    {
      binding: {
        version: binding.version,
        username: binding.username,
        pubKey: u.irkPubHex,
        issuedAt: binding.issuedAt,
        expiresAt: binding.expiresAt,
        issuer: binding.issuer,
      },
      signature: bytesToHex(sig),
    },
    { "cache-control": `public, max-age=${cacheMaxAgeSec}` },
  );
}

export function handleCaCert(deps: PubkeyCertDeps): HandlerResponseWithHeaders {
  const ttlMs = deps.ttlMs ?? 7 * 24 * 60 * 60_000;
  return ok({
    issuer: deps.ca.issuer,
    pubKey: bytesToHex(deps.ca.keypair.publicKey),
    ttlMs,
    retiredIssuers: [],
  });
}

export function caKeypairFromEnv(env: Record<string, string | undefined>): CaIssuer {
  const privHex = env.FLAGSHIP_CA_PRIV_HEX;
  if (privHex && /^[0-9a-f]{64}$/i.test(privHex)) {
    const sk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) sk[i] = parseInt(privHex.slice(i * 2, i * 2 + 2), 16);
    return {
      keypair: { privateKey: sk, publicKey: ed.getPublicKey(sk) },
      issuer: env.FLAGSHIP_CA_ISSUER ?? "flagship-ca-v1",
    };
  }
  const sk = new Uint8Array(32).fill(0xCA);
  return {
    keypair: { privateKey: sk, publicKey: ed.getPublicKey(sk) },
    issuer: env.FLAGSHIP_CA_ISSUER ?? "flagship-ca-dev",
  };
}
