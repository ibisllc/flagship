import { readFile } from "node:fs/promises";
import type { Bytes } from "@flagship/protocol";

export interface ServerConfig {
  serverId: string;
  userId: string;
  bakPublicKey: Bytes;
  irkPublicKey: Bytes;
  /**
   * Service-access gating v2 — the owner's STABLE AID pubkey (`ownerAidPubHex`).
   * Pinned at provision so the box verifies AID-signed service-invite create/
   * revoke + the box-as-authority redeem against it. OPTIONAL: absent ⇒ the box
   * falls back to owner-IRK verification (a malformed value is ignored, never
   * blocking config load).
   */
  ownerAidPub?: Bytes;
}

export async function loadConfig(path: string): Promise<ServerConfig> {
  const raw = await readFile(path, "utf8");
  return parseConfig(JSON.parse(raw));
}

export function parseConfig(data: unknown): ServerConfig {
  if (typeof data !== "object" || data === null) throw new Error("config must be an object");
  const d = data as Record<string, unknown>;
  if (typeof d.serverId !== "string") throw new Error("config.serverId must be a string");
  if (typeof d.userId !== "string") throw new Error("config.userId must be a string");
  if (typeof d.bakPublicKey !== "string" || !/^[0-9a-f]{64}$/.test(d.bakPublicKey)) {
    throw new Error("config.bakPublicKey must be 32-byte hex");
  }
  if (typeof d.irkPublicKey !== "string" || !/^[0-9a-f]{64}$/.test(d.irkPublicKey)) {
    throw new Error("config.irkPublicKey must be 32-byte hex");
  }
  // gating v2 — ownerAidPub is OPTIONAL + non-blocking: a malformed value is
  // simply dropped (the box falls back to owner-IRK verification) rather than
  // failing the whole config load + bricking the owner API.
  const ownerAidPub =
    typeof d.ownerAidPubHex === "string" && /^[0-9a-f]{64}$/.test(d.ownerAidPubHex)
      ? hexToBytes(d.ownerAidPubHex)
      : undefined;
  return {
    serverId: d.serverId,
    userId: d.userId,
    bakPublicKey: hexToBytes(d.bakPublicKey),
    irkPublicKey: hexToBytes(d.irkPublicKey),
    ...(ownerAidPub ? { ownerAidPub } : {}),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
