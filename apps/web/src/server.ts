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
  adaptServerRegistryToStorage,
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
import { registerServerRegister } from "./routes/serverRegister.js";
import { registerNfcRendezvous } from "./routes/nfcRendezvous.js";
import {
  registerUserPubKeyCert,
  caKeypairFromEnv,
  type CaIssuer,
} from "./routes/userPubKeyCert.js";
import {
  registerLlmPromo,
  InMemoryPromoLedger,
  ConsoleSmsSender,
  buildFlagshipInferenceIssuer,
  type PromoLedger,
  type PromoIssuer,
  type SmsSender,
} from "./routes/llmPromo.js";
import { registerServerDnsPublish } from "./routes/serverDnsPublish.js";
import {
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
import { UsageMeter } from "./tunnel/usageMeter.js";
import { startTunnelHub } from "./tunnel/tunnelHub.js";
import {
  HubBlessingProvider,
  loadOrCreateHubKeypair,
} from "./tunnel/hubBlessingProvider.js";
import { TunnelRegistry } from "./tunnel/registry.js";
import { RemoteUsernameResolver } from "./lib/remoteUsernameResolver.js";
import { RevocationCache } from "./tunnel/revocationCache.js";
import { EvictionCache } from "./tunnel/evictionCache.js";
import {
  registerControlRedirections,
  coldStartRedirections,
} from "./routes/controlRedirections.js";
import { registerGossipFanout } from "./routes/gossipFanout.js";

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
  /**
   * CA issuer for the /api/users/:username/pubkey-cert endpoint. Defaults
   * to a deterministic dev keypair so tests pass without secret setup; in
   * production set FLAGSHIP_CA_PRIV_HEX.
   */
  ca?: CaIssuer;
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
    registerServerRegister(app, {
      authCodes: authCodeStore,
      servers: adaptServerRegistryToStorage(serverRegistry),
    });
  }

  if (isCom) {
    const ca = opts.ca ?? caKeypairFromEnv();
    registerUserPubKeyCert(app, { ca, usernameRegistry });
    // C3 — NFC tap-to-pair cloud rendezvous. Lives on .com (identity
    // plane) since both the phone + box already trust it; the blob is
    // AEAD-sealed so .com is a pure opaque drop-box.
    registerNfcRendezvous(app);
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

      // (DNS-01 publish/delete moved to the .com Worker, which holds the
      // Cloudflare DNS API token. See apps/com/src/controlPlaneRoutes.ts +
      // packages/control-plane/src/dns01.ts.)
    }
  }
  app.decorate("reciprocityLedger", reciprocityLedger);
  app.decorate("peerCandidatePool", peerCandidatePool);

  // The promo issuer is either injected (tests) or built from the blessed
  // inference env (production) — the free-credits flow is one
  // `wrangler secret put FLAGSHIP_INFERENCE_ENDPOINT` +
  // `FLAGSHIP_INFERENCE_TOKEN_SECRET` away from live. The identity pepper
  // likewise defaults from env. `resolveUserIrk` is still caller-supplied
  // (it resolves username → IRK for signature checks); absent ⇒ the promo
  // routes stay unregistered (they 404) rather than accept unsigned issue.
  const promoIssuer = opts.promoIssuer ?? buildFlagshipInferenceIssuer(process.env);
  const promoPepper = opts.promoIdentityPepper ?? pepperFromEnv(process.env.FLAGSHIP_PROMO_IDENTITY_PEPPER);
  if (isCom && opts.resolveUserIrk && promoIssuer && promoPepper) {
    const ledger = opts.promoLedger ?? new InMemoryPromoLedger();
    const sms = opts.promoSms ?? new ConsoleSmsSender();
    registerLlmPromo(app, {
      resolveUserIrk: opts.resolveUserIrk,
      ledger,
      issuer: promoIssuer,
      sms,
      identityPepper: promoPepper,
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

/**
 * Parse the promo identity pepper from env: a 64-char hex string (32
 * bytes). Absent / malformed ⇒ null (promo routes stay unregistered
 * rather than salting identities with a weak/degenerate pepper).
 */
function pepperFromEnv(raw: string | undefined): Uint8Array | null {
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
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
  // The data-plane apex pod canonicals live under — `flagship.services`
  // in prod, `gym.flagship.services` in the test env (docs/ui-test-gym.md
  // §6.5). Unset ⇒ the prod literal, so prod routing is byte-identical;
  // the `gym.` test Fly app sets FLAGSHIP_SERVICES_APEX.
  const servicesApex = process.env.FLAGSHIP_SERVICES_APEX ?? "flagship.services";
  const registry = new TunnelRegistry({ apex: servicesApex });
  // #87 — custom-domain control channel. Must register before listen.
  const servicesControlSecret = process.env.SERVICES_CONTROL_SECRET;
  registerControlRedirections(app, { registry, secret: servicesControlSecret });
  // Per-account gossip fan-out (Phase 4): recognize
  // `broadcast--<user>.<apex>` at this TLS-terminating surface and mirror the
  // verbatim opaque body to every connected box of that account. Only on the
  // data plane (it needs the live tunnel registry).
  if (surface === "services" || surface === "both") {
    registerGossipFanout(app, { registry, apex: servicesApex });
  }
  await app.listen({ port: httpPort, host });
  // Authenticate tunnel HELLOs against .com's server registry over HTTPS.
  // 5-minute cache so reconnects don't hammer the API.
  const comBaseUrl = process.env.FLAGSHIP_COM_BASE_URL ?? "https://flagshipserver.com";
  // Warm the RAM redirection table from .com before routing starts
  // (best-effort + 5s-bounded; push backfills anything missed).
  await coldStartRedirections({ registry, comBaseUrl, secret: servicesControlSecret });
  const remoteAuthCache = new Map<string, { pub: Uint8Array; expiresAt: number }>();
  const remoteAuthLookup = async (serverId: string): Promise<Uint8Array | null> => {
    const local = authLookupFromRegistry(serverRegistry)(serverId);
    if (local) return local;
    const cached = remoteAuthCache.get(serverId);
    if (cached && cached.expiresAt > Date.now()) return cached.pub;
    try {
      const resp = await fetch(
        `${comBaseUrl}/api/server/by-domain/${encodeURIComponent(serverId)}`,
      );
      if (!resp.ok) return null;
      const body = (await resp.json()) as { identityPubKey?: string; revoked?: unknown };
      if (!body.identityPubKey || body.revoked) return null;
      const pub = new Uint8Array(body.identityPubKey.length / 2);
      for (let i = 0; i < pub.length; i++) {
        pub[i] = parseInt(body.identityPubKey.slice(i * 2, i * 2 + 2), 16);
      }
      remoteAuthCache.set(serverId, { pub, expiresAt: Date.now() + 5 * 60_000 });
      return pub;
    } catch {
      return null;
    }
  };
  // Resolve username → IRK pubkey from .com so the hub can verify the
  // Ed25519 signatures on each root/service entitlement (and on the
  // signed revocation list). Without this the hub would accept any
  // self-consistent entitlement, letting a registered box claim routing
  // for FQDNs in OTHER users' zones. Cached with a short TTL.
  const irkResolver = new RemoteUsernameResolver({ comBaseUrl });
  const irkLookup = (username: string): Promise<Uint8Array | null> =>
    irkResolver.lookup(username);
  // Per-user revoked-entitlement-cert set, pulled from .com's
  // phone-signed list and re-verified locally (the cache trusts the
  // IRK signature, not the Worker). Fail-open on a transient fetch
  // failure (returns null) so a .com blip can't brick live pods.
  const revocationCache = new RevocationCache({
    controlPlaneBaseUrl: comBaseUrl,
    irkLookup,
  });
  const revocationLookup = (username: string): Promise<Set<string> | null> =>
    revocationCache.lookup(username);

  // Per-podCanonical eviction chain, pulled from .com's
  // `/api/server/:pod/eviction-chain` (graceful decommission §8). After
  // entitlement/STK verification, the hub asks whether THIS box instance's
  // STK has been retired for its podCanonical; if so it NACKs "replaced".
  // 30s TTL so it's not a per-HELLO round trip. Fail-OPEN: a fetch failure
  // returns null so a .com blip can't brick fleet-wide registration (the
  // durable order / zombie-poll still closes the fight).
  const evictionCache = new EvictionCache({ controlPlaneBaseUrl: comBaseUrl });
  const evictionLookup = (podCanonical: string): Promise<Set<string> | null> =>
    evictionCache.lookup(podCanonical);

  // Relay blessing (docs/maintainer-trust-enforcement.md): on the data
  // plane, self-generate a hub key and fetch a `.com`-CA-signed
  // ServiceBlessing daily so each HELLO_ACK can prove the relay holds a
  // blessed key. OBSERVE-safe: if the blessing isn't fetched yet (startup
  // race / `.com` down) the hub omits it and the box keeps relaying. Set
  // FLAGSHIP_HUB_HOST to the served host (default flagship.services);
  // FLAGSHIP_HUB_KEY_PATH persists the key to a Fly volume if mounted.
  let blessingProvider: HubBlessingProvider | undefined;
  if (surface === "services" || surface === "both") {
    const hubHost = process.env.FLAGSHIP_HUB_HOST ?? "flagship.services";
    const keyPath = process.env.FLAGSHIP_HUB_KEY_PATH;
    const keypair = loadOrCreateHubKeypair(keyPath);
    blessingProvider = new HubBlessingProvider({
      keypair,
      hubHost,
      comBaseUrl,
    });
    // Best-effort: don't block listen() on the first fetch.
    void blessingProvider.start();
    console.log(`relay-blessing provider started hubKey=${keypair.publicKey.length === 32 ? "ok" : "bad"} host=${hubHost}`);
  }

  const stopHub = startTunnelHub(app.server, registry, {
    surface,
    apex: servicesApex,
    authLookup: remoteAuthLookup,
    irkLookup,
    revocationLookup,
    evictionLookup,
    ...(blessingProvider ? { blessingSource: blessingProvider } : {}),
  });

  // Public-egress metering (feat/metering). OFF unless USAGE_REPORT_SECRET is
  // set — so deploying this code is a no-op until the secret is provisioned.
  // The meter counts bytes per account in the SNI splice and flushes deltas to
  // .com; it also refuses NEW streams for over-quota free accounts.
  let meter: UsageMeter | undefined;
  const usageSecret = process.env.USAGE_REPORT_SECRET;
  if (usageSecret) {
    meter = new UsageMeter({
      reportUrl: `${comBaseUrl}/api/usage/report`,
      secret: usageSecret,
      flushIntervalMs: process.env.USAGE_FLUSH_MS ? Number(process.env.USAGE_FLUSH_MS) : undefined,
    });
    meter.start();
    console.log(`usage metering ON → ${comBaseUrl}/api/usage/report`);
  }

  let router: RunningSniRouter | null = null;
  if (opts.tunnelTcpPort !== undefined) {
    router = await startSniRouter(registry, { port: opts.tunnelTcpPort, host }, meter);
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
      meter?.stop();
      blessingProvider?.stop();
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
