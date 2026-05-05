import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveIRK } from "@flagship/protocol";
import { registerBuildImage } from "./routes/buildImage.js";
import { registerQrAuth } from "./routes/qrAuth.js";
import { registerSecurityReport } from "./routes/securityReport.js";
import {
  registerDesktopPair,
  type DesktopPairOptions,
  type DesktopSessionStore,
} from "./routes/desktopPair.js";
import { registerMigration, type MigrationOptions } from "./routes/migration.js";
import {
  registerServerRegistry,
  InMemoryServerRegistry,
  authLookupFromRegistry,
  type ServerRegistry,
} from "./routes/serverRegistry.js";
import { registerServerRevocation } from "./routes/serverRevocation.js";
import { registerAccountRecovery } from "./routes/accountRecovery.js";
import {
  registerUsernameRegistry,
  InMemoryUsernameRegistry,
  type UsernameRegistry,
} from "./routes/usernameRegistry.js";
import {
  registerAuthCode,
  InMemoryAuthCodeStore,
  type AuthCodeStore,
} from "./routes/authCode.js";
import {
  registerServerRegister,
  inProcessAuthCodeUseClient,
  type AuthCodeUseClient,
} from "./routes/serverRegister.js";
import {
  registerBuildTicket,
  InMemoryBuildTicketStore,
  type BuildTicketStore,
} from "./routes/buildTicket.js";
import {
  registerLlmPromo,
  InMemoryPromoLedger,
  ConsoleSmsSender,
  type PromoLedger,
  type PromoIssuer,
  type SmsSender,
} from "./routes/llmPromo.js";
import { registerServerDnsPublish } from "./routes/serverDnsPublish.js";
import { registerDns01Publish } from "./routes/dns01Publish.js";
import {
  DnsChallengeService,
  InMemoryServerDnsRegistry,
  ServerDnsPublisher,
  type ServerDnsRegistry,
  type ZoneApi,
} from "@flagship/services-zone";
import {
  registerPeerBackupMatchmaker,
  InMemoryReciprocityLedger,
  InMemoryPeerCandidatePool,
  type ReciprocityLedger,
  type PeerCandidatePool,
} from "./routes/peerBackupMatchmaker.js";
import {
  registerPushRelay,
  InMemoryPushTokenStore,
  NoopPushDispatcher,
  type PushDispatcher,
  type PushTokenStore,
} from "./routes/pushRelay.js";
import { startSniRouter, type RunningSniRouter } from "./tunnel/sniRouter.js";
import { startTunnelHub } from "./tunnel/tunnelHub.js";
import { TunnelRegistry } from "./tunnel/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  app: FastifyInstance;
  registry: TunnelRegistry;
  serverRegistry: ServerRegistry;
  router: RunningSniRouter | null;
  stopHub: () => Promise<void>;
  close(): Promise<void>;
}

/**
 * Which surface this Fastify instance is serving.
 *
 *  - "com"      — flagshipserver.com (identity surface): static pages, /webapp,
 *                 /deck, /login, account recovery, push relay, promo issuance,
 *                 desktop pairing. Sees no traffic.
 *  - "services" — flagship.services (traffic + peer mesh): tunnel hub,
 *                 peer-backup matchmaker, DNS publishing (later). Sees traffic
 *                 metadata but never decrypts user-content.
 *  - "both"     — single binary serves everything. The dev / test default and
 *                 the simplest single-machine deploy.
 */
export type Surface = "com" | "services" | "both";

export interface BuildServerOptions {
  /** Default "both" — see Surface for the modes. */
  surface?: Surface;
  migration?: MigrationOptions;
  desktopPair?: DesktopPairOptions;
  /** Pre-built server registry (tests pass a seeded one). Defaults to in-memory. */
  serverRegistry?: ServerRegistry;
  /** Resolves a userId to its IRK pubkey for registration verification. */
  resolveUserIrk?: (userId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  /** Push-relay components. Both must be present to expose the routes. */
  pushTokenStore?: PushTokenStore;
  pushDispatcher?: PushDispatcher;
  /** Peer-backup matchmaker components. Defaults are in-memory. */
  reciprocityLedger?: ReciprocityLedger;
  peerCandidatePool?: PeerCandidatePool;
  /**
   * Flagship-promo issuance — the issuer mints a per-user API key that the
   * phone uses BYOK-style. flagshipserver.com NEVER sees vibe-coding prompts.
   * Throttling is the GPU server's job.
   */
  promoLedger?: PromoLedger;
  promoIssuer?: PromoIssuer;
  promoSms?: SmsSender;
  /** Server-side pepper mixed into stored identity hashes. Required for issuance. */
  promoIdentityPepper?: Uint8Array;
  /**
   * .services-side DNS publishing for `<server>.<user>.flagship.services`.
   * Both the zone API + tunnel ingress IP are required to expose the route.
   */
  zone?: ZoneApi;
  serverDnsRegistry?: ServerDnsRegistry;
  tunnelIngressIp?: string;
  /**
   * .com username registry — username → IRK pubkey.
   * Defaults to in-memory on .com surface.
   */
  usernameRegistry?: UsernameRegistry;
  /** Auth-code store for the install-flow issue/use/revoke endpoints. */
  authCodeStore?: AuthCodeStore;
  /** Build-ticket store backing the /api/build-tickets/* endpoints. */
  buildTicketStore?: BuildTicketStore;
  /**
   * AuthCodeUseClient bridges .services → .com when those run in different
   * processes. When unset and `surface = "both"`, defaults to an in-process
   * adapter against `authCodeStore`. When `surface = "services"` alone, this
   * MUST be provided (or there's no way to validate auth codes).
   */
  authCodeUseClient?: AuthCodeUseClient;
}

/**
 * When FLAGSHIP_DEV=1 the server registers a hardcoded "harry" user whose IRK
 * is derived from a fixed dev UMK seed (matches `DEV_UMK_SEED` in
 * `/dev/phone.html`). This is what lets the in-browser fake-phone sign valid
 * pairing claims so the full QR-login UX is demoable on a single host.
 */
function devDesktopPairOptions(): DesktopPairOptions | undefined {
  if (process.env.FLAGSHIP_DEV !== "1") return undefined;
  const devSeed = new Uint8Array(32).fill(7);
  const devIrk = deriveIRK({ seed: devSeed });
  return {
    resolveIrkPubKey: (uid) => (uid === "harry" ? devIrk.publicKey : null),
  };
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const surface: Surface = opts.surface ?? "both";
  const isCom = surface === "com" || surface === "both";
  const isServices = surface === "services" || surface === "both";

  const serverRegistry = opts.serverRegistry ?? new InMemoryServerRegistry();
  app.decorate("serverRegistry", serverRegistry);

  const usernameRegistry = opts.usernameRegistry ?? new InMemoryUsernameRegistry();
  if (isCom) {
    registerUsernameRegistry(app, { registry: usernameRegistry });
    app.decorate("usernameRegistry", usernameRegistry);
  }

  const authCodeStore = opts.authCodeStore ?? new InMemoryAuthCodeStore();
  if (isCom) {
    registerAuthCode(app, { store: authCodeStore, usernameRegistry });
    app.decorate("authCodeStore", authCodeStore);
  }

  if (isServices) {
    const useClient =
      opts.authCodeUseClient ?? inProcessAuthCodeUseClient(authCodeStore);
    registerServerRegister(app, {
      serverRegistry,
      authCodeUseClient: useClient,
    });
  }

  const buildTicketStore = opts.buildTicketStore ?? new InMemoryBuildTicketStore();
  if (isCom) {
    registerBuildTicket(app, { store: buildTicketStore, usernameRegistry });
    app.decorate("buildTicketStore", buildTicketStore);
  }

  const bootedAt = Date.now();
  app.get("/api/health", async () => {
    const mem = process.memoryUsage();
    return {
      ok: true,
      service: surface === "services" ? "flagship.services" : "flagshipserver.com",
      surface,
      uptimeMs: Date.now() - bootedAt,
      processUptimeSec: Math.round(process.uptime()),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      nodeVersion: process.version,
      pid: process.pid,
      now: new Date().toISOString(),
    };
  });

  let desktopSessions: DesktopSessionStore | undefined;
  if (isCom) {
    registerBuildImage(app);
    registerQrAuth(app);
    registerSecurityReport(app);
    desktopSessions = registerDesktopPair(app, opts.desktopPair ?? devDesktopPairOptions());
    app.decorate("desktopSessions", desktopSessions);

    // Logged-in user surface — backed by the paired desktop session.
    const sessions = desktopSessions;
    app.get<{ Querystring: { sessionId?: string } }>("/api/me/servers", async (req, reply) => {
      const sid = req.query.sessionId;
      if (!sid) return reply.status(400).send({ error: "sessionId required" });
      const view = sessions.getPaired(sid);
      if (!view) return reply.status(401).send({ error: "session not paired" });
      const servers = serverRegistry.listForUser(view.userId).map((s) => ({
        serverId: s.serverId,
        registeredAt: s.registeredAt,
        revoked: s.revokedAt
          ? { reason: s.revocationReason ?? "lost", at: s.revokedAt }
          : null,
      }));
      return { userId: view.userId, servers };
    });
    if (opts.migration) registerMigration(app, opts.migration);
  }

  if (isCom && opts.resolveUserIrk) {
    registerServerRegistry(app, {
      registry: serverRegistry,
      resolveUserIrk: opts.resolveUserIrk,
    });
    registerServerRevocation(app, {
      registry: serverRegistry,
      resolveUserIrk: opts.resolveUserIrk,
    });
  }

  const pushStore = opts.pushTokenStore ?? new InMemoryPushTokenStore();
  if (isCom) {
    const pushDispatcher = opts.pushDispatcher ?? new NoopPushDispatcher();
    registerPushRelay(app, { store: pushStore, dispatcher: pushDispatcher });
    app.decorate("pushTokenStore", pushStore);

    if (opts.resolveUserIrk) {
      registerAccountRecovery(app, {
        registry: serverRegistry,
        pushTokenStore: pushStore,
        resolveUserIrk: opts.resolveUserIrk,
      });
    }
  }

  const reciprocityLedger = opts.reciprocityLedger ?? new InMemoryReciprocityLedger();
  const peerCandidatePool = opts.peerCandidatePool ?? new InMemoryPeerCandidatePool();
  if (isServices) {
    registerPeerBackupMatchmaker(app, {
      serverRegistry,
      ledger: reciprocityLedger,
      pool: peerCandidatePool,
    });
    if (opts.zone && opts.tunnelIngressIp && opts.resolveUserIrk) {
      const serverDnsRegistry = opts.serverDnsRegistry ?? new InMemoryServerDnsRegistry();
      const publisher = new ServerDnsPublisher({
        zone: opts.zone,
        registry: serverDnsRegistry,
        tunnelIngressIp: opts.tunnelIngressIp,
      });
      registerServerDnsPublish(app, {
        publisher,
        resolveUserIrk: opts.resolveUserIrk,
      });
      app.decorate("serverDnsRegistry", serverDnsRegistry);

      // Per-server ACME DNS-01 helper. Daemons call this when their ACME flow
      // needs a TXT record published; STK signature ties each call to a known
      // server in the registry.
      const dnsChallenge = new DnsChallengeService(opts.zone);
      registerDns01Publish(app, {
        serverRegistry,
        dnsChallenge,
      });
    }
  }
  app.decorate("reciprocityLedger", reciprocityLedger);
  app.decorate("peerCandidatePool", peerCandidatePool);

  if (
    isCom &&
    opts.resolveUserIrk &&
    opts.promoIssuer &&
    opts.promoIdentityPepper
  ) {
    const ledger = opts.promoLedger ?? new InMemoryPromoLedger();
    const sms = opts.promoSms ?? new ConsoleSmsSender();
    registerLlmPromo(app, {
      resolveUserIrk: opts.resolveUserIrk,
      ledger,
      issuer: opts.promoIssuer,
      sms,
      identityPepper: opts.promoIdentityPepper,
    });
    app.decorate("promoLedger", ledger);
  }

  // Static surface (marketing + /webapp + /deck) is only on .com.
  if (isCom) app.register(fastifyStatic, {
    root: resolve(__dirname, "../public"),
    prefix: "/",
    decorateReply: false,
    // Allow `.well-known/*` (RFC 9116 security.txt etc.) which would otherwise
    // be filtered out by the default dotfile policy.
    serveDotFiles: true,
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    serverRegistry: ServerRegistry;
    pushTokenStore: PushTokenStore;
    desktopSessions: DesktopSessionStore;
    reciprocityLedger: ReciprocityLedger;
    peerCandidatePool: PeerCandidatePool;
    serverDnsRegistry?: ServerDnsRegistry;
    usernameRegistry?: UsernameRegistry;
    promoLedger?: PromoLedger;
    authCodeStore?: AuthCodeStore;
    buildTicketStore?: BuildTicketStore;
  }
}

export async function start(opts: {
  httpPort?: number;
  tunnelTcpPort?: number;
  host?: string;
} = {}): Promise<ServerHandle> {
  const httpPort = opts.httpPort ?? Number(process.env.PORT) ?? 3000;
  const host = opts.host ?? "0.0.0.0";

  // FLAGSHIP_SURFACE selects which routes this binary serves at boot:
  //   services → flagship.services (traffic + peer mesh)
  //   com      → flagshipserver.com (identity surface; usually deployed
  //              as the Cloudflare Worker in apps/com instead)
  //   both     → dev / single-machine deploy default
  const surface =
    process.env.FLAGSHIP_SURFACE === "services" ||
    process.env.FLAGSHIP_SURFACE === "com" ||
    process.env.FLAGSHIP_SURFACE === "both"
      ? (process.env.FLAGSHIP_SURFACE as "services" | "com" | "both")
      : "both";
  const app = buildServer({ surface });
  const serverRegistry = app.serverRegistry;
  const registry = new TunnelRegistry();
  await app.listen({ port: httpPort, host });
  const stopHub = startTunnelHub(app.server, registry, {
    authLookup: authLookupFromRegistry(serverRegistry),
  });

  let router: RunningSniRouter | null = null;
  if (opts.tunnelTcpPort !== undefined) {
    router = await startSniRouter(registry, { port: opts.tunnelTcpPort, host });
    console.log(`SNI router listening on :${router.port} (raw TCP / TLS passthrough)`);
  }

  console.log(`flagshipserver.com listening on :${httpPort}`);
  console.log(`tunnel hub: ws://${host}:${httpPort}/tunnel`);

  return {
    app,
    registry,
    serverRegistry,
    router,
    stopHub,
    async close() {
      if (router) await router.close();
      await stopHub();
      await app.close();
    },
  };
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const tunnelTcpPort = process.env.TUNNEL_TCP_PORT
    ? Number(process.env.TUNNEL_TCP_PORT)
    : undefined;
  start({ tunnelTcpPort }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
