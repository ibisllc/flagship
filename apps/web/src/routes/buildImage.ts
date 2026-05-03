import type { FastifyInstance } from "fastify";
import { verifyRebuildRequest, type ImageRebuildRequest } from "@flagship/protocol";
import { hexToBytes } from "../lib/hex.js";

export interface BuildJob {
  jobId: string;
  status: "queued" | "building" | "ready" | "failed";
  estimatedSeconds: number;
}

/**
 * Pluggable backend for actually performing the image build. The default in
 * tests / dev returns a stubbed job (the existing v0 behavior). In production
 * this is wired to a worker that calls @flagship/bootkey-builder's
 * `materializePlan` + `invokeMkosi` against the validated request.
 */
export type ImageBuildEnqueuer = (req: ImageRebuildRequest) => Promise<BuildJob>;

export const stubImageBuildEnqueuer: ImageBuildEnqueuer = async (req) => ({
  jobId: `build-${req.newServerId}-${req.issuedAt}`,
  status: "queued",
  estimatedSeconds: 120,
});

interface Body {
  request: {
    userId: string;
    newServerId: string;
    wifiSsid: string;
    wifiPskHash: string;
    shareRatio: number;
    issuedAt: number;
  };
  signature: string;
  irkPublicKey: string;
}

export interface BuildImageOptions {
  enqueuer?: ImageBuildEnqueuer;
}

export function registerBuildImage(app: FastifyInstance, opts: BuildImageOptions = {}): void {
  const enqueue = opts.enqueuer ?? stubImageBuildEnqueuer;
  app.post<{ Body: Body }>("/api/build-image", async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      !body.request ||
      typeof body.signature !== "string" ||
      typeof body.irkPublicKey !== "string"
    ) {
      return reply.status(400).send({ error: "missing fields" });
    }

    const r = body.request;
    if (
      typeof r.userId !== "string" ||
      typeof r.newServerId !== "string" ||
      typeof r.wifiSsid !== "string" ||
      typeof r.wifiPskHash !== "string" ||
      typeof r.shareRatio !== "number" ||
      typeof r.issuedAt !== "number"
    ) {
      return reply.status(400).send({ error: "malformed request" });
    }

    let pskHash: Uint8Array;
    let signature: Uint8Array;
    let irkPub: Uint8Array;
    try {
      pskHash = hexToBytes(r.wifiPskHash);
      signature = hexToBytes(body.signature);
      irkPub = hexToBytes(body.irkPublicKey);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }

    if (pskHash.length !== 32 || irkPub.length !== 32 || signature.length !== 64) {
      return reply.status(400).send({ error: "invalid byte lengths" });
    }

    const rebuild: ImageRebuildRequest = {
      userId: r.userId,
      newServerId: r.newServerId,
      wifiSsid: r.wifiSsid,
      wifiPskHash: pskHash,
      shareRatio: r.shareRatio,
      issuedAt: r.issuedAt,
    };

    if (!verifyRebuildRequest(rebuild, signature, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }

    // Replay protection: reject requests older than 5 minutes.
    const ageMs = Date.now() - rebuild.issuedAt;
    if (ageMs > 5 * 60_000 || ageMs < -60_000) {
      return reply.status(403).send({ error: "stale request" });
    }

    return await enqueue(rebuild);
  });
}
