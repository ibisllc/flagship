import type { FastifyInstance } from "fastify";
import { sha256 } from "@noble/hashes/sha256";
import {
  verifyDns01Delete,
  verifyDns01Publish,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
} from "@flagship/protocol";
import type { DnsChallengeService } from "@flagship/services-zone";
import { hexToBytes } from "../lib/hex.js";
import type { ServerRegistry } from "./serverRegistry.js";

/**
 * .services-side helper for the per-server ACME flow. Each Flagship server
 * runs ACME against Let's Encrypt for its own wildcard cert
 * `*.<server>.<user>.flagship.services`. ACME challenges DNS-01; the server
 * doesn't own the zone, so it asks `.services` to write the TXT record on
 * its behalf.
 *
 * Auth: STK-signed. The route looks up the server's STK pubkey via the
 * existing ServerRegistry; signature must verify. recordName must be inside
 * the signing server's namespace (no cross-server poisoning).
 */
export interface Dns01PublishOptions {
  serverRegistry: ServerRegistry;
  dnsChallenge: DnsChallengeService;
  apex?: string;
  maxAgeMs?: number;
  now?: () => number;
}

interface PublishBody {
  request?: {
    serverId?: string;
    recordName?: string;
    recordValueHash?: string;
    issuedAt?: number;
  };
  signature?: string;
  recordValue?: string;
}

interface DeleteBody {
  request?: {
    serverId?: string;
    recordId?: string;
    issuedAt?: number;
  };
  signature?: string;
}

interface PublishedRecord {
  recordId: string;
  serverId: string;
  dispose: () => Promise<void>;
}

export function registerDns01Publish(app: FastifyInstance, opts: Dns01PublishOptions): void {
  const apex = opts.apex ?? "flagship.services";
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const records = new Map<string, PublishedRecord>();
  let nextRecordId = 1;

  app.post<{ Body: PublishBody }>("/api/services-zone/dns-01-publish", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.serverId !== "string" ||
      typeof r.recordName !== "string" ||
      typeof r.recordValueHash !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      typeof body.recordValue !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }

    // The recordName must live under the signing server's namespace so a
    // compromised server STK can't poison another user's zone.
    const reg = opts.serverRegistry.get(r.serverId);
    if (!reg) return reply.status(404).send({ error: "unknown server" });
    if (reg.revokedAt) return reply.status(403).send({ error: "server is revoked" });
    const expectedSuffix = `.${r.serverId}.${reg.userId}.${apex}`;
    if (!r.recordName.endsWith(expectedSuffix)) {
      return reply
        .status(403)
        .send({ error: `recordName must end with ${expectedSuffix}` });
    }
    // ACME DNS-01 always uses `_acme-challenge.<name>` so add a structural check.
    if (!r.recordName.startsWith("_acme-challenge.")) {
      return reply.status(400).send({ error: "recordName must start with _acme-challenge." });
    }

    let valueHash: Uint8Array;
    let sig: Uint8Array;
    try {
      valueHash = hexToBytes(r.recordValueHash);
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    const expectedValueHash = sha256(new TextEncoder().encode(body.recordValue));
    if (!equalBytes(expectedValueHash, valueHash)) {
      return reply.status(400).send({ error: "recordValue does not match recordValueHash" });
    }

    const claim: Dns01PublishRequest = {
      serverId: r.serverId,
      recordName: r.recordName,
      recordValueHash: valueHash,
      issuedAt: r.issuedAt,
    };
    if (!verifyDns01Publish(claim, sig, reg.stkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return reply.status(403).send({ error: "stale request" });
    }

    try {
      const dispose = await opts.dnsChallenge.publishTxt(r.recordName, body.recordValue);
      const recordId = `dns01-${nextRecordId++}`;
      records.set(recordId, { recordId, serverId: r.serverId, dispose });
      return { recordId };
    } catch (e) {
      return reply.status(502).send({ error: "publish failed", message: errMsg(e) });
    }
  });

  app.post<{ Body: DeleteBody }>("/api/services-zone/dns-01-delete", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.serverId !== "string" ||
      typeof r.recordId !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    const reg = opts.serverRegistry.get(r.serverId);
    if (!reg) return reply.status(404).send({ error: "unknown server" });
    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    const claim: Dns01DeleteRequest = {
      serverId: r.serverId,
      recordId: r.recordId,
      issuedAt: r.issuedAt,
    };
    if (!verifyDns01Delete(claim, sig, reg.stkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return reply.status(403).send({ error: "stale request" });
    }
    const rec = records.get(r.recordId);
    if (!rec) return reply.status(404).send({ error: "unknown recordId" });
    if (rec.serverId !== r.serverId) {
      // Cross-server delete attempt — shouldn't happen given STK verification,
      // but defense in depth.
      return reply.status(403).send({ error: "recordId not owned by this server" });
    }
    await rec.dispose();
    records.delete(r.recordId);
    return { ok: true };
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
