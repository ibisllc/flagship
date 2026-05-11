/**
 * Pod simulator — a Fastify server that mimics the user's daemon
 * for the e2e test rig. Implements just the HTTP surface the
 * webapp talks to. Re-uses @flagship/protocol for signature
 * verification so any drift between the test rig and the real
 * daemon's canonical-bytes shape fails BOTH paths loudly.
 *
 * What this is NOT: a real daemon. No Docker/LUKS/ACME/tunnel.
 * No real Forgejo. The vibe-code WebSocket replays canned tokens.
 *
 * Endpoints implemented:
 *   POST /api/orders-from-user            verify PSK sig, record order
 *   GET  /api/screens/server-detail       seedable fixture
 *   GET  /api/screens/apps-list           apps-store snapshot
 *   GET  /api/screens/app-detail/:appId   apps-store lookup
 *   GET  /api/screens/marketplace-browse  empty array fixture
 *   GET  /api/screens/unlock-approvals/pending  pending-store snapshot
 *   POST /api/apps                        IRK-verified install (record only)
 *   GET  /api/screens/paired-sessions/list  recorded paired-session orders
 *   GET  /api/screens/tier-status         static fixture
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  ed,
  verifyInstallApp,
  verifyPhoneOrder,
  type Bytes,
} from "@flagship/protocol";
import { OrdersStore, type RecordedOrder } from "./orders-store.js";
import { AppsStore } from "./apps-store.js";
import { PendingStore } from "./pending-store.js";

export interface PodSimOptions {
  /** Username component of the simulated server FQDN. */
  username: string;
  /** Full FQDN the pod-sim claims. */
  serverFqdn: string;
  /** PSK pubkey the daemon would have registered (the user's IRK pubkey hex). */
  pskPubHex: string;
  /** Host IRK pubkey hex — used to verify install-app envelopes (P1.X1). */
  hostIrkPubHex: string;
  /** Optional pre-issued paired-session token tests can present without going through pairing. */
  preIssuedSessionToken?: string;
}

export interface PodSim {
  app: FastifyInstance;
  baseUrl: string;
  port: number;
  orders: OrdersStore;
  apps: AppsStore;
  pending: PendingStore;
  /** Remember which session tokens are valid (added by add-paired-session order). */
  validSessionTokens: Set<string>;
  /** Tear down the Fastify server. */
  close(): Promise<void>;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function extractSessionToken(req: {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}): string | null {
  // Mirror the daemon's extractPairedSessionToken: Authorization → x-flagship-session → ?sessionToken=
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Flagship-Session\s+(.+)$/.exec(auth);
    if (m) return m[1]!;
  }
  const xfs = req.headers["x-flagship-session"];
  if (typeof xfs === "string") return xfs;
  const q = req.query.sessionToken;
  if (typeof q === "string") return q;
  return null;
}

export async function startPodSim(opts: PodSimOptions): Promise<PodSim> {
  const orders = new OrdersStore();
  const apps = new AppsStore();
  const pending = new PendingStore();
  const validSessionTokens = new Set<string>();
  if (opts.preIssuedSessionToken) {
    validSessionTokens.add(opts.preIssuedSessionToken);
  }

  const pskPub: Bytes = hexToBytes(opts.pskPubHex);
  const hostIrkPub: Bytes = hexToBytes(opts.hostIrkPubHex);

  const app = Fastify({ logger: false });

  // CORS — the webapp on web.flagshipserver.com calls cross-origin.
  app.addHook("onSend", (req, reply, payload, done) => {
    const origin = req.headers["origin"];
    if (typeof origin === "string") {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
    }
    done(null, payload);
  });
  app.options("*", async (_req, reply) => {
    reply.header("access-control-allow-methods", "GET, HEAD, POST, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "content-type, x-flagship-session, authorization");
    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /api/orders-from-user — verify PSK signature + record.
  // ──────────────────────────────────────────────────────────────────
  app.post<{ Body: { request?: Record<string, unknown>; signature?: string } }>(
    "/api/orders-from-user",
    async (req, reply) => {
      const b = req.body;
      const r = (b?.request ?? {}) as Record<string, unknown>;
      if (typeof r.type !== "string" || typeof b?.signature !== "string") {
        return reply.status(400).send({ error: "malformed body" });
      }
      let sig: Uint8Array;
      try {
        sig = hexToBytes(b.signature);
      } catch {
        return reply.status(400).send({ error: "invalid signature hex" });
      }
      // verifyPhoneOrder takes the typed order shape; we pass r as-is
      // and let it validate the canonical-bytes layer.
      const ok = verifyPhoneOrder(r as never, sig, pskPub);
      if (!ok) return reply.status(403).send({ error: "invalid signature" });

      // Side effects: add-paired-session inserts the token into the
      // valid set so subsequent /api/screens/* calls are accepted.
      if (r.type === "add-paired-session" && typeof r.token === "string") {
        validSessionTokens.add(r.token);
      } else if (r.type === "remove-paired-session" && typeof r.token === "string") {
        validSessionTokens.delete(r.token);
      }

      const recorded: RecordedOrder = {
        type: r.type,
        raw: r,
        receivedAt: Date.now(),
      };
      orders.push(recorded);
      return reply.send({ ok: true });
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // /api/screens/* — paired-session-gated reads.
  // ──────────────────────────────────────────────────────────────────
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/screens/")) return;
    const tok = extractSessionToken(req as never);
    if (!tok || !validSessionTokens.has(tok)) {
      return reply.status(401).send({ error: "no valid paired session" });
    }
  });

  app.get("/api/screens/server-detail", async () => ({
    serverFqdn: opts.serverFqdn,
    username: opts.username,
    daemonVersion: "podsim-0.0.1",
    uptimeMs: 60_000,
    certNotAfter: Date.now() + 89 * 86400_000,
    certSans: [opts.serverFqdn, `*.${opts.serverFqdn}`],
    appCount: apps.list().length,
    pairedSessionCount: validSessionTokens.size,
    recentInstallEvents: [],
  }));

  app.get("/api/screens/apps-list", async () => ({
    apps: apps.list().map((a) => ({
      appId: a.appId,
      creator: a.creator,
      slug: a.slug,
      installedAt: a.installedAt,
      containerStatus: a.containerStatus ?? "running",
    })),
  }));

  app.get<{ Params: { appId: string } }>(
    "/api/screens/app-detail/:appId",
    async (req, reply) => {
      const a = apps.get(req.params.appId);
      if (!a) return reply.status(404).send({ error: "not found" });
      return reply.send({
        ...a,
        containerStatus: a.containerStatus ?? "running",
      });
    },
  );

  app.get("/api/screens/marketplace-browse", async () => ({
    listings: [],
  }));

  app.get("/api/screens/unlock-approvals/pending", async () => ({
    pending: pending.list(),
  }));

  app.get("/api/screens/paired-sessions/list", async () => ({
    sessions: orders
      .filterByType("add-paired-session")
      .map((o) => ({
        token: (o.raw as { token: string }).token,
        label: (o.raw as { label?: string }).label ?? "(unnamed)",
        addedAt: o.receivedAt,
      })),
  }));

  app.get("/api/screens/tier-status", async () => ({
    tier: "free",
    quotas: { storageBytes: 50 * 1024 ** 3, used: 1024 ** 3 },
  }));

  // ──────────────────────────────────────────────────────────────────
  // POST /api/apps — webapp marketplace install path. Verifies the
  // host IRK signature on the install envelope.
  // ──────────────────────────────────────────────────────────────────
  app.post<{ Body: { request?: Record<string, unknown>; signature?: string } }>(
    "/api/apps",
    async (req, reply) => {
      const b = req.body;
      const r = (b?.request ?? {}) as Record<string, unknown>;
      if (typeof b?.signature !== "string") {
        return reply.status(400).send({ error: "missing signature" });
      }
      let sig: Uint8Array;
      try {
        sig = hexToBytes(b.signature);
      } catch {
        return reply.status(400).send({ error: "invalid signature hex" });
      }
      if (!verifyInstallApp(r as never, sig, hostIrkPub)) {
        return reply.status(403).send({ error: "invalid install signature" });
      }
      const creator = r.creator as string;
      const slug = r.slug as string;
      const appId = `${creator}--${slug}`;
      apps.add({ appId, creator, slug, installedAt: Date.now() });
      orders.push({
        type: "install-app",
        raw: r,
        receivedAt: Date.now(),
      });
      return reply.send({ ok: true, appId });
    },
  );

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("pod-sim failed to bind a port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    app,
    baseUrl,
    port: addr.port,
    orders,
    apps,
    pending,
    validSessionTokens,
    close: () => app.close(),
  };
}

// CLI mode: `npm run pod-sim` from apps/web/e2e.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  // Standalone mode is for ad-hoc debugging — generate a throwaway IRK,
  // print the registration details, then run forever.
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  const pub = ed.getPublicKey(priv);
  startPodSim({
    username: "alice",
    serverFqdn: "home.alice.flagship.services",
    pskPubHex: bytesToHex(pub),
    hostIrkPubHex: bytesToHex(pub),
    preIssuedSessionToken: "podsim-debug-token",
  }).then((sim) => {
    console.log(`[pod-sim] listening on ${sim.baseUrl}`);
    console.log(`[pod-sim] PSK pubkey hex: ${bytesToHex(pub)}`);
    console.log(`[pod-sim] preIssuedSessionToken: podsim-debug-token`);
  });
}
