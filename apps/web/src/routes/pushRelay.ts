import type { FastifyInstance } from "fastify";
import { hexToBytes } from "../lib/hex.js";

/**
 * The control plane stores a (irkPub → push-token, platform) mapping. Senders
 * (the user's own Flagship server, or another phone signaling) POST an
 * opaque payload addressed to an IRK pubkey; the relay looks up the matching
 * push token and forwards via APNs/FCM. The relay never reads the payload —
 * it's the phone's job to decrypt under a key only it holds.
 */

export type PushPlatform = "apns" | "fcm";

export interface PushTokenRecord {
  irkPub: Uint8Array;
  platform: PushPlatform;
  pushToken: string;
  registeredAt: number;
}

export interface PushTokenStore {
  putToken(rec: PushTokenRecord): void;
  /** Look up by IRK pubkey hex. */
  getByIrk(irkPubHex: string): PushTokenRecord | undefined;
  removeByIrk(irkPubHex: string): boolean;
}

export class InMemoryPushTokenStore implements PushTokenStore {
  private byIrk = new Map<string, PushTokenRecord>();

  putToken(rec: PushTokenRecord): void {
    this.byIrk.set(bytesToHex(rec.irkPub), { ...rec, irkPub: rec.irkPub.slice() });
  }

  getByIrk(irkPubHex: string): PushTokenRecord | undefined {
    const r = this.byIrk.get(irkPubHex.toLowerCase());
    return r ? { ...r, irkPub: r.irkPub.slice() } : undefined;
  }

  removeByIrk(irkPubHex: string): boolean {
    return this.byIrk.delete(irkPubHex.toLowerCase());
  }
}

export interface PushDispatcher {
  /** Forward an opaque ciphertext + metadata to the platform's push backend. */
  dispatch(rec: PushTokenRecord, opts: { ciphertext: Uint8Array; collapseId?: string }): Promise<{ ok: boolean; reason?: string }>;
}

export class NoopPushDispatcher implements PushDispatcher {
  /** Useful in dev / tests when there's no APNs/FCM credential available. */
  delivered: { tokenLast8: string; size: number; collapseId?: string }[] = [];
  async dispatch(rec: PushTokenRecord, opts: { ciphertext: Uint8Array; collapseId?: string }) {
    this.delivered.push({
      tokenLast8: rec.pushToken.slice(-8),
      size: opts.ciphertext.length,
      collapseId: opts.collapseId,
    });
    return { ok: true };
  }
}

/** Maximum opaque payload size we'll accept. APNs cap is 4 KiB; FCM is 4 KiB. */
const MAX_PAYLOAD_BYTES = 3 * 1024;

export interface PushRelayOptions {
  store: PushTokenStore;
  dispatcher: PushDispatcher;
  /** Rate-limit per IRK pubkey, ms between dispatches. Default 250ms. */
  minIntervalMs?: number;
  now?: () => number;
}

export function registerPushRelay(app: FastifyInstance, opts: PushRelayOptions): void {
  const minIntervalMs = opts.minIntervalMs ?? 250;
  const now = opts.now ?? (() => Date.now());
  const lastDispatch = new Map<string, number>();

  app.post<{
    Body: {
      irkPub?: string;
      platform?: PushPlatform;
      pushToken?: string;
    };
  }>("/api/push/register", async (req, reply) => {
    const body = req.body ?? {};
    if (
      typeof body.irkPub !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.irkPub) ||
      (body.platform !== "apns" && body.platform !== "fcm") ||
      typeof body.pushToken !== "string" ||
      body.pushToken.length === 0 ||
      body.pushToken.length > 512
    ) {
      return reply.status(400).send({ error: "malformed registration" });
    }
    let irk: Uint8Array;
    try {
      irk = hexToBytes(body.irkPub);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    opts.store.putToken({
      irkPub: irk,
      platform: body.platform,
      pushToken: body.pushToken,
      registeredAt: now(),
    });
    return { ok: true };
  });

  app.post<{
    Body: {
      toIrkPub?: string;
      ciphertext?: string;
      collapseId?: string;
    };
  }>("/api/push/dispatch", async (req, reply) => {
    const body = req.body ?? {};
    if (
      typeof body.toIrkPub !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.toIrkPub) ||
      typeof body.ciphertext !== "string"
    ) {
      return reply.status(400).send({ error: "malformed dispatch" });
    }
    let cipher: Uint8Array;
    try {
      cipher = hexToBytes(body.ciphertext);
    } catch {
      return reply.status(400).send({ error: "ciphertext must be hex" });
    }
    if (cipher.length > MAX_PAYLOAD_BYTES) {
      return reply.status(413).send({ error: "payload too large" });
    }

    const target = opts.store.getByIrk(body.toIrkPub);
    if (!target) return reply.status(404).send({ error: "no push token for that IRK" });

    const lastTs = lastDispatch.get(body.toIrkPub.toLowerCase()) ?? 0;
    if (now() - lastTs < minIntervalMs) {
      return reply.status(429).send({ error: "rate limited" });
    }
    lastDispatch.set(body.toIrkPub.toLowerCase(), now());

    const r = await opts.dispatcher.dispatch(target, {
      ciphertext: cipher,
      collapseId: typeof body.collapseId === "string" ? body.collapseId : undefined,
    });
    if (!r.ok) return reply.status(502).send({ error: "dispatch failed", reason: r.reason });
    return { ok: true };
  });
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
