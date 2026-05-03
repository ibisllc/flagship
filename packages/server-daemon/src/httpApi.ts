import Fastify, { type FastifyInstance } from "fastify";
import {
  parseManifest,
  type AppManifest,
  type Bytes,
  type InviteAcceptance,
  type InviteToken,
  type MembershipMutation,
} from "@flagship/protocol";
import { BootCoordinator } from "./bootCoordinator.js";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";
import { LlmHarness } from "./llmHarness.js";
import { AppRunner } from "./appRunner.js";

/**
 * The HTTP API surface that the Flagship server-daemon exposes for the phone
 * and for other Flagship servers (during migration). Keep this small and
 * keep all sensitive ops behind IRK/BAK signatures verified by the underlying
 * stores — the HTTP layer is plumbing, not policy.
 */

export interface DeployedApp {
  manifest: AppManifest;
  deployedAt: number;
  /** Source revision (git sha or tarball digest) — opaque, surfaced to UI. */
  source?: string;
}

export interface DaemonContext {
  serverId: string;
  userId: string;
  bootCoordinator: BootCoordinator;
  apps: Map<string, AppMembership>;
  /** Resolves an authenticated paired-session token to the requester's IRK pubkey. */
  resolveSession: (token: string | undefined) => Bytes | null;
  /** Per-app identity injectors. Built lazily based on per-app manifest. */
  injectors: Map<string, IdentityInjector>;
  /** Optional LLM harness — undefined when SWK isn't yet provisioned. */
  llm?: LlmHarness;
  /** Optional container runner. When set, /apps/* lifecycle endpoints are live. */
  appRunner?: AppRunner;
  /** Per-app deploy records. Daemon keeps this in memory; persisted by the caller. */
  deployedApps?: Map<string, DeployedApp>;
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

  // ---- App lifecycle (deploy / delete / restart / logs) -----------------

  app.post<{
    Body: {
      sessionToken?: string;
      manifest?: unknown;
      source?: string;
    };
  }>("/apps", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    const body = req.body ?? {};
    if (!ctx.resolveSession(body.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const parsed = parseManifest(body.manifest);
    if (!parsed.ok) return reply.status(400).send({ error: "invalid manifest", details: parsed.errors });
    const m = parsed.manifest;
    const appId = m.name;
    if (ctx.deployedApps.has(appId)) {
      return reply.status(409).send({ error: "app already deployed", appId });
    }
    try {
      await ctx.appRunner.deploy({
        appId,
        image: m.runtime.image,
        env: m.runtime.env,
        port: m.runtime.port,
      });
    } catch (e) {
      return reply.status(500).send({ error: "deploy failed", message: errMsg(e) });
    }
    ctx.deployedApps.set(appId, {
      manifest: m,
      deployedAt: Date.now(),
      source: typeof body.source === "string" ? body.source : undefined,
    });
    return { ok: true, appId };
  });

  app.delete<{
    Params: { appId: string };
    Body: { sessionToken?: string };
  }>("/apps/:appId", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.body?.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const appId = req.params.appId;
    const entry = ctx.deployedApps.get(appId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    try {
      await ctx.appRunner.stop(appId);
    } catch (e) {
      return reply.status(500).send({ error: "stop failed", message: errMsg(e) });
    }
    ctx.deployedApps.delete(appId);
    return { ok: true, appId };
  });

  app.post<{
    Params: { appId: string };
    Body: { sessionToken?: string };
  }>("/apps/:appId/restart", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.body?.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.appId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    try {
      await ctx.appRunner.restart({
        appId: req.params.appId,
        image: entry.manifest.runtime.image,
        env: entry.manifest.runtime.env,
        port: entry.manifest.runtime.port,
      });
    } catch (e) {
      return reply.status(500).send({ error: "restart failed", message: errMsg(e) });
    }
    return { ok: true };
  });

  app.get<{
    Params: { appId: string };
    Querystring: { sessionToken?: string; tail?: string };
  }>("/apps/:appId/logs", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    if (!ctx.deployedApps.has(req.params.appId)) {
      return reply.status(404).send({ error: "app not found" });
    }
    const tail = Number(req.query.tail ?? 200);
    const safeTail = Number.isFinite(tail) && tail > 0 && tail <= 5000 ? Math.floor(tail) : 200;
    try {
      const out = await ctx.appRunner.logs(req.params.appId, safeTail);
      return { stdout: out.stdout, stderr: out.stderr, tail: safeTail };
    } catch (e) {
      return reply.status(500).send({ error: "logs failed", message: errMsg(e) });
    }
  });

  app.get<{ Querystring: { sessionToken?: string } }>(
    "/apps",
    async (req, reply) => {
      if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
      if (!ctx.resolveSession(req.query.sessionToken)) {
        return reply.status(401).send({ error: "session not authenticated" });
      }
      return {
        apps: [...ctx.deployedApps.entries()].map(([appId, e]) => ({
          appId,
          name: e.manifest.name,
          version: e.manifest.version,
          subdomain: e.manifest.network.subdomain,
          deployedAt: e.deployedAt,
          source: e.source,
        })),
      };
    },
  );

  // ---- LLM harness (BYO provider, SWK-sealed payload) -------------------

  app.get("/llm/providers", async (_req, reply) => {
    if (!ctx.llm) return reply.status(503).send({ error: "llm harness not provisioned" });
    return { providers: ctx.llm.listProviders() };
  });

  app.post<{
    Body: {
      sessionToken?: string;
      sealed?: { ciphertext?: string; nonce?: string };
    };
  }>("/llm/chat", async (req, reply) => {
    if (!ctx.llm) return reply.status(503).send({ error: "llm harness not provisioned" });
    const body = req.body ?? {};
    if (!ctx.resolveSession(body.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    if (
      !body.sealed ||
      typeof body.sealed.ciphertext !== "string" ||
      typeof body.sealed.nonce !== "string"
    ) {
      return reply.status(400).send({ error: "sealed payload required" });
    }
    let sealed;
    try {
      sealed = {
        ciphertext: hexToBytes(body.sealed.ciphertext),
        nonce: hexToBytes(body.sealed.nonce),
      };
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    const out = await ctx.llm.chat(sealed);
    return {
      sealed: {
        ciphertext: bytesToHex(out.ciphertext),
        nonce: bytesToHex(out.nonce),
      },
    };
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
