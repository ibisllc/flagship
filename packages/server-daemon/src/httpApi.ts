import Fastify, { type FastifyInstance } from "fastify";
import {
  type Bytes,
  type InviteAcceptance,
  type InviteToken,
  type MembershipMutation,
} from "@flagship/protocol";
import { BootCoordinator } from "./bootCoordinator.js";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";

/**
 * The HTTP API surface that the Flagship server-daemon exposes for the phone
 * and for other Flagship servers (during migration). Keep this small and
 * keep all sensitive ops behind IRK/BAK signatures verified by the underlying
 * stores — the HTTP layer is plumbing, not policy.
 */

export interface DaemonContext {
  serverId: string;
  userId: string;
  bootCoordinator: BootCoordinator;
  apps: Map<string, AppMembership>;
  /** Resolves an authenticated paired-session token to the requester's IRK pubkey. */
  resolveSession: (token: string | undefined) => Bytes | null;
  /** Per-app identity injectors. Built lazily based on per-app manifest. */
  injectors: Map<string, IdentityInjector>;
}

interface HexBytesField {
  hex: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function buildDaemonHttp(ctx: DaemonContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    ok: true,
    serverId: ctx.serverId,
    userId: ctx.userId,
    apps: Array.from(ctx.apps.keys()),
    pendingBootChallenges: ctx.bootCoordinator.pendingCount(),
  }));

  // ---- Boot challenge ----------------------------------------------------

  app.post("/boot/challenge", async () => {
    const { challenge, nonceId } = ctx.bootCoordinator.createChallenge();
    return {
      nonceId,
      challenge: {
        serverId: challenge.serverId,
        nonce: bytesToHex(challenge.nonce),
        issuedAt: challenge.issuedAt,
      },
    };
  });

  app.post<{ Body: { nonceId?: string; signature?: string } }>(
    "/boot/approve",
    async (req, reply) => {
      const body = req.body ?? {};
      if (typeof body.nonceId !== "string" || typeof body.signature !== "string") {
        return reply.status(400).send({ error: "nonceId and signature required" });
      }
      let sig: Uint8Array;
      try {
        sig = hexToBytes(body.signature);
      } catch {
        return reply.status(400).send({ error: "signature not hex" });
      }
      const result = ctx.bootCoordinator.submitApproval(body.nonceId, sig);
      if (!result.ok) return reply.status(403).send(result);
      return { ok: true };
    },
  );

  // ---- Per-app invite redemption ----------------------------------------

  app.post<{
    Params: { appId: string };
    Body: {
      token?: {
        appId?: string;
        role?: string;
        nonce?: string;
        issuedAt?: number;
        expiresAt?: number;
      };
      inviteSignature?: string;
      acceptance?: {
        inviteNonce?: string;
        accepterIrkPub?: string;
        acceptedAt?: number;
      };
      acceptanceSignature?: string;
    };
  }>("/apps/:appId/invites/redeem", async (req, reply) => {
    const app = ctx.apps.get(req.params.appId);
    if (!app) return reply.status(404).send({ error: "app not found" });

    const body = req.body ?? {};
    if (
      !body.token ||
      typeof body.token.role !== "string" ||
      typeof body.token.nonce !== "string" ||
      typeof body.token.issuedAt !== "number" ||
      typeof body.token.expiresAt !== "number" ||
      typeof body.inviteSignature !== "string" ||
      !body.acceptance ||
      typeof body.acceptance.inviteNonce !== "string" ||
      typeof body.acceptance.accepterIrkPub !== "string" ||
      typeof body.acceptance.acceptedAt !== "number" ||
      typeof body.acceptanceSignature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed redemption body" });
    }

    let token: InviteToken;
    let acceptance: InviteAcceptance;
    let inviteSig: Uint8Array;
    let accSig: Uint8Array;
    try {
      token = {
        appId: req.params.appId,
        role: body.token.role,
        nonce: hexToBytes(body.token.nonce),
        issuedAt: body.token.issuedAt,
        expiresAt: body.token.expiresAt,
      };
      acceptance = {
        inviteNonce: hexToBytes(body.acceptance.inviteNonce),
        accepterIrkPub: hexToBytes(body.acceptance.accepterIrkPub),
        acceptedAt: body.acceptance.acceptedAt,
      };
      inviteSig = hexToBytes(body.inviteSignature);
      accSig = hexToBytes(body.acceptanceSignature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }

    const r = app.redeemInvite(token, inviteSig, acceptance, accSig);
    if (!r.ok) return reply.status(403).send(r);
    return {
      ok: true,
      role: r.role,
      stableId: r.stableId,
    };
  });

  // ---- Per-app membership mutations (remove, role change) ---------------

  app.post<{
    Params: { appId: string };
    Body: {
      mutation?: {
        appId?: string;
        targetIrkPub?: string;
        role?: string | null;
        issuedAt?: number;
      };
      signature?: string;
    };
  }>("/apps/:appId/membership/mutation", async (req, reply) => {
    const app = ctx.apps.get(req.params.appId);
    if (!app) return reply.status(404).send({ error: "app not found" });

    const body = req.body ?? {};
    const m = body.mutation;
    if (
      !m ||
      typeof m.targetIrkPub !== "string" ||
      typeof m.issuedAt !== "number" ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed mutation body" });
    }

    let mutation: MembershipMutation;
    let sig: Uint8Array;
    try {
      mutation = {
        appId: req.params.appId,
        targetIrkPub: hexToBytes(m.targetIrkPub),
        role: m.role ?? null,
        issuedAt: m.issuedAt,
      };
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }

    const r = app.applyMutation(mutation, sig);
    if (!r.ok) return reply.status(403).send(r);
    return { ok: true, effect: r.effect };
  });

  // ---- Identity-injector decision (used by the in-server Caddy) ---------

  app.post<{
    Params: { appId: string };
    Body: { path?: string; sessionToken?: string };
  }>("/apps/:appId/identity/decide", async (req, reply) => {
    const injector = ctx.injectors.get(req.params.appId);
    if (!injector) return reply.status(404).send({ error: "no injector for app" });
    const body = req.body ?? {};
    if (typeof body.path !== "string") {
      return reply.status(400).send({ error: "path required" });
    }
    const decision = injector.evaluate({
      path: body.path,
      sessionToken: body.sessionToken,
    });
    return decision;
  });

  return app;
}
