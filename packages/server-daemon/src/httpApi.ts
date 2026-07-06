import Fastify, { type FastifyInstance } from "fastify";
import {
  parseManifest,
  verifyBackupToggle,
  type AppManifest,
  type BackupToggle,
  type Bytes,
  type InviteAcceptance,
  type InviteToken,
  type MembershipMutation,
} from "@flagship/protocol";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";
import { LlmHarness } from "./llmHarness.js";
import { AppRunner } from "./serviceRunner.js";
import { PhoneStateStore, PHONE_STATE_MAX_BYTES } from "./phoneStateStore.js";
import { DataProvisioner, credentialsToEnv, type AppDataCredentials } from "./dataLayer/index.js";
import { buildLlmAppContext } from "./llmServiceContext.js";
import { ForgejoAppAdmin } from "./forgejoServiceAdmin.js";
import { BackupLoop } from "./backupLoop.js";
import {
  PB_FRAMES_PATH,
  type PbFramesRequestBody,
  type PbFramesResult,
} from "./peerBackup/httpPeerLink.js";

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
  /** Credentials minted by the DataProvisioner. Used on restart to re-inject env. */
  data?: AppDataCredentials;
  /** Per-app sister-app token. Issued at deploy; baked into the container env. */
  peersToken?: string;
}

export interface DaemonContext {
  serverId: string;
  userId: string;
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
  /** Optional phone-state backup store. */
  phoneState?: PhoneStateStore;
  /** Optional unified-data-layer provisioner. Required for data.stores in manifests. */
  dataProvisioner?: DataProvisioner;
  /** Optional Forgejo admin scoped to <user>-flagship/<app>. */
  forgejo?: ForgejoAppAdmin;
  /** Optional BackupLoop. When set, /backup/* routes are live. */
  backupLoop?: BackupLoop;
  /**
   * The phone's IRK pubkey, baked into this server at provisioning time.
   * Required for verifying backup-toggle commands (and any other phone-only
   * mutation that doesn't go through the existing membership flow).
   */
  irkPubKey?: Bytes;
  /**
   * Optional peer-backup frames endpoint (box↔box shard transport). When
   * set, POST /api/peer-backup/frames is live. The handler owns the STK
   * envelope verification + owner-scoping (see peerBackup/httpPeerLink.ts).
   */
  peerBackupFrames?: (body: PbFramesRequestBody) => Promise<PbFramesResult>;
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

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}

export function buildDaemonHttp(ctx: DaemonContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    ok: true,
    serverId: ctx.serverId,
    userId: ctx.userId,
    apps: Array.from(ctx.apps.keys()),
  }));

  // ---- Per-app invite redemption ----------------------------------------

  app.post<{
    Params: { serviceId: string };
    Body: {
      token?: {
        serviceId?: string;
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
  }>("/apps/:serviceId/invites/redeem", async (req, reply) => {
    const app = ctx.apps.get(req.params.serviceId);
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
        serviceId: req.params.serviceId,
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
    Params: { serviceId: string };
    Body: {
      mutation?: {
        serviceId?: string;
        targetIrkPub?: string;
        role?: string | null;
        issuedAt?: number;
      };
      signature?: string;
    };
  }>("/apps/:serviceId/membership/mutation", async (req, reply) => {
    const app = ctx.apps.get(req.params.serviceId);
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
        serviceId: req.params.serviceId,
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
    const serviceId = m.name;
    if (ctx.deployedApps.has(serviceId)) {
      return reply.status(409).send({ error: "app already deployed", serviceId });
    }

    // Provision data-layer resources before starting the container so the
    // env vars are present on the very first launch. If the manifest
    // declared stores but no provisioner is configured, refuse early.
    let creds: AppDataCredentials | undefined;
    const stores = m.data.stores ?? {};
    const wantsAnyStore = !!(stores.postgres || stores.objects || stores.kv);
    if (wantsAnyStore) {
      if (!ctx.dataProvisioner) {
        return reply.status(503).send({ error: "data provisioner not configured" });
      }
      try {
        creds = await ctx.dataProvisioner.provisionApp({
          creator: ctx.userId,
          slug: serviceId,
          stores,
        });
      } catch (e) {
        return reply.status(500).send({ error: "data provisioning failed", message: errMsg(e) });
      }
    }

    const dataEnv = creds ? credentialsToEnv(creds) : {};
    const peersToken = randomToken();
    const env = {
      ...(m.runtime.env ?? {}),
      ...dataEnv,
      FLAGSHIP_PEERS_TOKEN: peersToken,
      FLAGSHIP_APP_ID: serviceId,
    };
    try {
      await ctx.appRunner.deploy({
        serviceId,
        image: m.runtime.image,
        env,
        port: m.runtime.port,
      });
    } catch (e) {
      // Roll back the data resources so a failed deploy doesn't leak
      // a half-provisioned tenant.
      if (creds && ctx.dataProvisioner) {
        await ctx.dataProvisioner
          .deprovisionApp({ creator: ctx.userId, slug: serviceId, stores })
          .catch(() => {});
      }
      return reply.status(500).send({ error: "deploy failed", message: errMsg(e) });
    }
    ctx.deployedApps.set(serviceId, {
      manifest: m,
      deployedAt: Date.now(),
      source: typeof body.source === "string" ? body.source : undefined,
      data: creds,
      peersToken,
    });
    return { ok: true, serviceId };
  });

  app.delete<{
    Params: { serviceId: string };
    Body: { sessionToken?: string };
  }>("/apps/:serviceId", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.body?.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const serviceId = req.params.serviceId;
    const entry = ctx.deployedApps.get(serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    try {
      await ctx.appRunner.stop(serviceId);
    } catch (e) {
      return reply.status(500).send({ error: "stop failed", message: errMsg(e) });
    }
    if (entry.data && ctx.dataProvisioner) {
      await ctx.dataProvisioner
        .deprovisionApp({
          creator: ctx.userId,
          slug: serviceId,
          stores: entry.manifest.data.stores ?? {},
        })
        .catch(() => {
          // best-effort: data containers may already be gone (system stopping)
        });
    }
    ctx.deployedApps.delete(serviceId);
    return { ok: true, serviceId };
  });

  app.post<{
    Params: { serviceId: string };
    Body: { sessionToken?: string };
  }>("/apps/:serviceId/restart", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.body?.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    const dataEnv = entry.data ? credentialsToEnv(entry.data) : {};
    const restartEnv: Record<string, string> = {
      ...(entry.manifest.runtime.env ?? {}),
      ...dataEnv,
      FLAGSHIP_APP_ID: req.params.serviceId,
    };
    if (entry.peersToken) restartEnv.FLAGSHIP_PEERS_TOKEN = entry.peersToken;
    try {
      await ctx.appRunner.restart({
        serviceId: req.params.serviceId,
        image: entry.manifest.runtime.image,
        env: restartEnv,
        port: entry.manifest.runtime.port,
      });
    } catch (e) {
      return reply.status(500).send({ error: "restart failed", message: errMsg(e) });
    }
    return { ok: true };
  });

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; tail?: string };
  }>("/apps/:serviceId/logs", async (req, reply) => {
    if (!ctx.appRunner) return reply.status(503).send({ error: "appRunner not configured" });
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    if (!ctx.deployedApps.has(req.params.serviceId)) {
      return reply.status(404).send({ error: "app not found" });
    }
    const tail = Number(req.query.tail ?? 200);
    const safeTail = Number.isFinite(tail) && tail > 0 && tail <= 5000 ? Math.floor(tail) : 200;
    try {
      const out = await ctx.appRunner.logs(req.params.serviceId, safeTail);
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
        apps: [...ctx.deployedApps.entries()].map(([serviceId, e]) => ({
          serviceId,
          name: e.manifest.name,
          version: e.manifest.version,
          subdomain: e.manifest.network.subdomain,
          deployedAt: e.deployedAt,
          source: e.source,
        })),
      };
    },
  );

  // ---- Data dashboard (read-only, paged) --------------------------------

  /** Resolve `?instance=<name>` (or default to the singleton). */
  function resolveInstance<T>(map: Record<string, T> | undefined, instance?: string): T | undefined {
    if (!map) return undefined;
    return map[instance ?? "default"];
  }

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; instance?: string };
  }>("/data/postgres/:serviceId/tables", async (req, reply) => {
    if (!ctx.deployedApps || !ctx.dataProvisioner) {
      return reply.status(503).send({ error: "data subsystem missing" });
    }
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    const inst = resolveInstance(entry.data?.postgres, req.query.instance);
    if (!inst) return reply.status(404).send({ error: "app does not use this postgres instance" });
    const tables = await ctx.dataProvisioner.listPostgresTables(inst.database);
    return { database: inst.database, tables };
  });

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; sql?: string; max?: string; instance?: string };
  }>("/data/postgres/:serviceId/query", async (req, reply) => {
    if (!ctx.deployedApps || !ctx.dataProvisioner) {
      return reply.status(503).send({ error: "data subsystem missing" });
    }
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    const inst = resolveInstance(entry.data?.postgres, req.query.instance);
    if (!inst) return reply.status(404).send({ error: "app does not use this postgres instance" });
    if (typeof req.query.sql !== "string" || req.query.sql.length === 0) {
      return reply.status(400).send({ error: "sql required" });
    }
    const max = clamp(Number(req.query.max ?? 100), 1, 1000);
    try {
      const out = await ctx.dataProvisioner.queryPostgres({
        db: inst.database,
        sql: req.query.sql,
        maxRows: max,
      });
      return { database: inst.database, columns: out.columns, rows: out.rows, max };
    } catch (e) {
      return reply.status(500).send({ error: "query failed", message: errMsg(e) });
    }
  });

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; prefix?: string; max?: string; instance?: string };
  }>("/data/objects/:serviceId/list", async (req, reply) => {
    if (!ctx.deployedApps || !ctx.dataProvisioner) {
      return reply.status(503).send({ error: "data subsystem missing" });
    }
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    const inst = resolveInstance(entry.data?.objects, req.query.instance);
    if (!inst) return reply.status(404).send({ error: "app does not use this objects instance" });
    const max = clamp(Number(req.query.max ?? 200), 1, 5000);
    const objects = await ctx.dataProvisioner.listObjects(
      inst.bucket,
      typeof req.query.prefix === "string" ? req.query.prefix : "",
      max,
    );
    return { bucket: inst.bucket, objects, max };
  });

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; max?: string; instance?: string };
  }>("/data/kv/:serviceId/keys", async (req, reply) => {
    if (!ctx.deployedApps || !ctx.dataProvisioner) {
      return reply.status(503).send({ error: "data subsystem missing" });
    }
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    const inst = resolveInstance(entry.data?.kv, req.query.instance);
    if (!inst) return reply.status(404).send({ error: "app does not use this kv instance" });
    const max = clamp(Number(req.query.max ?? 200), 1, 5000);
    const keys = await ctx.dataProvisioner.listKvKeys(inst.prefix, max);
    return { prefix: inst.prefix, keys, max };
  });

  // ---- Phone-state backup (opaque SWK-encrypted blob) -------------------

  app.put<{
    Body: {
      sessionToken?: string;
      ciphertext?: string;
      nonce?: string;
      version?: number;
    };
  }>("/phone-state", async (req, reply) => {
    if (!ctx.phoneState) return reply.status(503).send({ error: "phoneState store missing" });
    const body = req.body ?? {};
    if (!ctx.resolveSession(body.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    if (
      typeof body.ciphertext !== "string" ||
      typeof body.nonce !== "string" ||
      typeof body.version !== "number"
    ) {
      return reply.status(400).send({ error: "ciphertext, nonce, and version required" });
    }
    let cipher: Uint8Array;
    let nonce: Uint8Array;
    try {
      cipher = hexToBytes(body.ciphertext);
      nonce = hexToBytes(body.nonce);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    if (cipher.length > PHONE_STATE_MAX_BYTES) {
      return reply.status(413).send({ error: "blob too large" });
    }
    const r = ctx.phoneState.put({
      ciphertext: cipher,
      nonce,
      version: body.version,
      storedAt: Date.now(),
    });
    if (!r.ok) return reply.status(409).send({ error: r.reason });
    return { ok: true, version: body.version };
  });

  app.get<{ Querystring: { sessionToken?: string } }>(
    "/phone-state",
    async (req, reply) => {
      if (!ctx.phoneState) return reply.status(503).send({ error: "phoneState store missing" });
      if (!ctx.resolveSession(req.query.sessionToken)) {
        return reply.status(401).send({ error: "session not authenticated" });
      }
      const blob = ctx.phoneState.get();
      if (!blob) return reply.status(404).send({ error: "no state stored" });
      return {
        ciphertext: bytesToHex(blob.ciphertext),
        nonce: bytesToHex(blob.nonce),
        version: blob.version,
        storedAt: blob.storedAt,
      };
    },
  );

  // ---- Per-app Forgejo (commits / PRs / merge / revert) -----------------

  function requireForgejoApp(req: { params: { serviceId: string }; query: { sessionToken?: string } }, reply: import("fastify").FastifyReply) {
    if (!ctx.forgejo) {
      reply.status(503).send({ error: "forgejo admin not configured" });
      return null;
    }
    if (!ctx.deployedApps) {
      reply.status(503).send({ error: "deployedApps store missing" });
      return null;
    }
    if (!ctx.resolveSession(req.query.sessionToken)) {
      reply.status(401).send({ error: "session not authenticated" });
      return null;
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) {
      reply.status(404).send({ error: "app not found" });
      return null;
    }
    return { entry, forgejo: ctx.forgejo };
  }

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; max?: string };
  }>("/apps/:serviceId/git/commits", async (req, reply) => {
    const r = requireForgejoApp(req, reply);
    if (!r) return reply;
    const max = Number(req.query.max ?? 50);
    const commits = await r.forgejo.listCommits(req.params.serviceId, max);
    return { commits };
  });

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; state?: "open" | "closed" | "all" };
  }>("/apps/:serviceId/git/prs", async (req, reply) => {
    const r = requireForgejoApp(req, reply);
    if (!r) return reply;
    const state = req.query.state === "closed" || req.query.state === "all" ? req.query.state : "open";
    const prs = await r.forgejo.listPullRequests(req.params.serviceId, state);
    return { prs };
  });

  app.post<{
    Params: { serviceId: string; prNumber: string };
    Querystring: { sessionToken?: string };
    Body: { message?: string };
  }>("/apps/:serviceId/git/prs/:prNumber/approve", async (req, reply) => {
    const r = requireForgejoApp(req, reply);
    if (!r) return reply;
    const num = Number(req.params.prNumber);
    if (!Number.isInteger(num) || num <= 0) return reply.status(400).send({ error: "invalid PR number" });
    try {
      const merged = await r.forgejo.mergePr(req.params.serviceId, num, req.body?.message);
      return merged;
    } catch (e) {
      return reply.status(500).send({ error: "merge failed", message: errMsg(e) });
    }
  });

  app.post<{
    Params: { serviceId: string; prNumber: string };
    Querystring: { sessionToken?: string };
  }>("/apps/:serviceId/git/prs/:prNumber/retract", async (req, reply) => {
    const r = requireForgejoApp(req, reply);
    if (!r) return reply;
    const num = Number(req.params.prNumber);
    if (!Number.isInteger(num) || num <= 0) return reply.status(400).send({ error: "invalid PR number" });
    try {
      await r.forgejo.closePr(req.params.serviceId, num);
      return { closed: true };
    } catch (e) {
      return reply.status(500).send({ error: "close failed", message: errMsg(e) });
    }
  });

  app.post<{
    Params: { serviceId: string; sha: string };
    Querystring: { sessionToken?: string };
  }>("/apps/:serviceId/git/commits/:sha/revert", async (req, reply) => {
    const r = requireForgejoApp(req, reply);
    if (!r) return reply;
    if (!/^[0-9a-f]{7,40}$/.test(req.params.sha)) return reply.status(400).send({ error: "invalid sha" });
    try {
      const pr = await r.forgejo.createRevertPr(req.params.serviceId, req.params.sha);
      return { pr };
    } catch (e) {
      return reply.status(500).send({ error: "revert failed", message: errMsg(e) });
    }
  });

  // ---- Peer-backup shard transport (box↔box, STK-signed envelope) -------
  //
  // One POST per frame burst; hex-in-JSON like every other daemon body.
  // The default Fastify bodyLimit (1 MiB) would cap shards at ~½ MiB after
  // hex doubling, so this route gets its own limit. All authentication +
  // owner-scoping lives in handlePbFramesRequest — this is a thin shim.
  app.post<{ Body: PbFramesRequestBody }>(
    PB_FRAMES_PATH,
    { bodyLimit: 64 * 1024 * 1024 },
    async (req, reply) => {
      if (!ctx.peerBackupFrames) {
        return reply.status(503).send({ error: "peer backup not configured" });
      }
      const r = await ctx.peerBackupFrames(req.body ?? {});
      return reply.status(r.status).send(r.body);
    },
  );

  // ---- Per-server backup toggle (IRK-signed; runs the BackupLoop) -------

  app.get("/backup/status", async (_req, reply) => {
    if (!ctx.backupLoop) return reply.status(503).send({ error: "backup loop not configured" });
    return ctx.backupLoop.status();
  });

  app.post<{
    Body: {
      request?: { serverId?: string; enabled?: boolean; issuedAt?: number };
      signature?: string;
    };
  }>("/backup/toggle", async (req, reply) => {
    if (!ctx.backupLoop || !ctx.irkPubKey) {
      return reply.status(503).send({ error: "backup loop not configured" });
    }
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.serverId !== "string" ||
      typeof r.enabled !== "boolean" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string"
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (r.serverId !== ctx.serverId) {
      // The signed serverId must be ours. A captured "enable" signed for
      // server-A can't be replayed against server-B.
      return reply.status(403).send({ error: "serverId mismatch" });
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }
    const claim: BackupToggle = {
      serverId: r.serverId,
      enabled: r.enabled,
      issuedAt: r.issuedAt,
    };
    if (!verifyBackupToggle(claim, sig, ctx.irkPubKey)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const now = Date.now();
    if (Math.abs(now - r.issuedAt) > 5 * 60_000) {
      return reply.status(403).send({ error: "stale request" });
    }
    ctx.backupLoop.setEnabled(r.enabled, now);
    return { ok: true, status: ctx.backupLoop.status() };
  });

  // ---- Sister-app capability (.flagship/peers/<target>/installed) -------

  app.get<{
    Params: { targetAppId: string };
    Headers: { authorization?: string };
  }>("/.flagship/peers/:targetAppId/installed", async (req, reply) => {
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });

    // Bearer token identifies the *querying* app. Format: `Bearer <token>`.
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "bearer token required" });
    }
    const token = auth.slice("Bearer ".length).trim();
    let queryingAppId: string | undefined;
    for (const [serviceId, entry] of ctx.deployedApps) {
      if (entry.peersToken && entry.peersToken === token) {
        queryingAppId = serviceId;
        break;
      }
    }
    if (!queryingAppId) return reply.status(401).send({ error: "unknown peers token" });

    const target = ctx.deployedApps.get(req.params.targetAppId);
    // Always returns "not installed" when the target hasn't allowlisted us.
    // Same response for "target doesn't exist" and "target exists but doesn't
    // know about us" — the querier cannot distinguish the two, so they cannot
    // fingerprint the box.
    if (!target) return { installed: false };
    const allowed = target.manifest.access.queryable_by ?? [];
    if (!allowed.includes(queryingAppId)) return { installed: false };

    return {
      installed: true,
      subdomain: target.manifest.network.subdomain,
    };
  });

  // ---- LLM app context (markdown blob the harness prepends to chat) -----

  app.get<{
    Params: { serviceId: string };
    Querystring: { sessionToken?: string; reveal?: string };
  }>("/apps/:serviceId/llm-context", async (req, reply) => {
    if (!ctx.deployedApps) return reply.status(503).send({ error: "deployedApps store missing" });
    if (!ctx.resolveSession(req.query.sessionToken)) {
      return reply.status(401).send({ error: "session not authenticated" });
    }
    const entry = ctx.deployedApps.get(req.params.serviceId);
    if (!entry) return reply.status(404).send({ error: "app not found" });
    const reveal = req.query.reveal === "1" || req.query.reveal === "true";
    const out = await buildLlmAppContext({
      manifest: entry.manifest,
      credentials: entry.data,
      deployedApps: ctx.deployedApps,
      dataProvisioner: ctx.dataProvisioner,
      revealCredentials: reveal,
      serverFqdn: ctx.serverId,
    });
    return out;
  });

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
    Params: { serviceId: string };
    Body: { path?: string; sessionToken?: string };
  }>("/apps/:serviceId/identity/decide", async (req, reply) => {
    const injector = ctx.injectors.get(req.params.serviceId);
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
