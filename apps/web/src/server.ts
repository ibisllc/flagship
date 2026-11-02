import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerBuildImage } from "./routes/buildImage.js";
import { registerSecurityReport } from "./routes/securityReport.js";
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
import { routerStats } from "./tunnel/routerStats.js";
import { startAddressEcho, type RunningAddressEcho } from "./lib/addressEcho.js";
import { UsageMeter } from "./tunnel/usageMeter.js";
import { overQuotaBytesPerSec } from "./tunnel/throttle.js";
import { startTunnelHub, type TunnelHubHandle } from "./tunnel/tunnelHub.js";
import { DEFAULT_DRAIN_GRACE_MS, drainOnSignal } from "./tunnel/drainOnSignal.js";
import { OutboundRelay } from "./tunnel/outboundRelay.js";
import { ComHostPolicy, KnownHostsPolicy } from "./tunnel/outboundHostPolicy.js";
import { MailboxRegistry } from "./tunnel/mailboxRelay.js";
import { registerMailboxRelay } from "./routes/mailboxRelayRoute.js";
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
import { comServingFetcher, meshServingFetcher, ServingGate } from "./tunnel/servingGate.js";
import { comStkLookup } from "./tunnel/stkLookup.js";
import { ServingFeedClient } from "./tunnel/servingFeedClient.js";
import { comPhoneEligibility, comPhoneRouteLedger, PhoneRoutes } from "./tunnel/phoneRoute.js";
import { startPhoneTunnel, type PhoneTunnelHandle } from "./tunnel/phoneTunnel.js";
import { MeshNode } from "./tunnel/mesh/node.js";
import { httpFeedSource, MeshFeedKeys, plainFeedCipher, type FeedCipher } from "./tunnel/mesh/feed.js";
import { meshPhoneEligibility } from "./tunnel/mesh/phoneLedger.js";
import { RelayBlessingProvider, relayKeypairFromSeed } from "./tunnel/hubBlessingProvider.js";
import type { RelayKind } from "@flagship/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  app: FastifyInstance;
  registry: TunnelRegistry;
  serverRegistry: ServerRegistry;
  router: RunningSniRouter | null;
  stopHub: TunnelHubHandle;
  /** The relay mesh node when FLAGSHIP_MESH=on, else null. */
  mesh: MeshNode | null;
  /** Tell drain-v1 boxes to move, serve the rest for `graceMs`, then close every tunnel. */
  drain(graceMs: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Which surface this Fastify instance is serving.
 *
 *  - "com"      — flagshipserver.com (identity surface): static pages, /webapp,
 *                 account recovery, push relay, promo issuance. Sees no traffic.
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
  /**
   * Relay mesh (relay-mesh.md §2): `/api/health` answers 503 with the reasons while this says not ready. Unset: the
   * health route answers as before.
   */
  health?: { check(): { ok: boolean; reasons?: string[] } };
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
  }

  const bootedAt = Date.now();
  app.get("/api/health", async (_req, reply) => {
    const mem = process.memoryUsage();
    const gate = opts.health?.check();
    if (gate && !gate.ok) reply.code(503);
    return {
      ok: gate ? gate.ok : true,
      ...(gate ? { mesh: { ready: gate.ok, reasons: gate.reasons ?? [] } } : {}),
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

  if (isCom) {
    registerBuildImage(app);
    registerSecurityReport(app);
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
  /** Port for the "which address did you reach me at" echo (PROXY protocol); off when unset. */
  relayEchoPort?: number;
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
  // The mesh's readiness, filled in once the mesh node exists (FLAGSHIP_MESH=on).
  const health: { check: () => { ok: boolean; reasons?: string[] } } = { check: () => ({ ok: true }) };
  const meshOn = process.env.FLAGSHIP_MESH === "on" && (surface === "services" || surface === "both");
  const app = buildServer({ surface, ...(meshOn ? { health } : {}) });
  refuseUnclaimedUpgrades(app.server);
  const serverRegistry = app.serverRegistry;
  // The data-plane apex pod canonicals live under — `flagship.services`
  // in prod, `gym.flagship.services` in the test env (docs/ui-test-gym.md
  // §6.5). Unset ⇒ the prod literal, so prod routing is byte-identical;
  // the `gym.` test Fly app sets FLAGSHIP_SERVICES_APEX.
  const servicesApex = process.env.FLAGSHIP_SERVICES_APEX ?? "flagship.services";
  const registry = new TunnelRegistry({ apex: servicesApex });
  const comBaseUrl = process.env.FLAGSHIP_COM_BASE_URL ?? "https://flagshipserver.com";
  // #87 — custom-domain control channel. Must register before listen.
  const servicesControlSecret = process.env.SERVICES_CONTROL_SECRET;
  registerControlRedirections(app, { registry, secret: servicesControlSecret });

  // Filled in once the serving authority starts (after listen); null while it is off.
  let servingStats: () => unknown = () => null;
  let meshStats: () => unknown = () => null;

  // What the router has done since this machine started (docs/ops-command.md). Guarded by the
  // hub's shared secret; off when there is none.
  if (surface === "services" || surface === "both") {
    app.get("/api/stats", async (req, reply) => {
      const secret = process.env.USAGE_REPORT_SECRET;
      const given = String(req.headers["x-usage-secret"] ?? "");
      const a = Buffer.from(given);
      const b = Buffer.from(secret ?? "");
      if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(secret ? 403 : 503).send({ error: secret ? "forbidden" : "stats are off (USAGE_REPORT_SECRET missing)" });
      }
      return {
        service: "flagship.services",
        uptimeSec: Math.round(process.uptime()),
        tunnelsOnline: registry.size(),
        router: routerStats.snapshot(),
        serving: servingStats(),
        ...(meshOn ? { mesh: meshStats() } : {}),
        now: new Date().toISOString(),
      };
    });
  }

  // Per-account gossip fan-out (Phase 4): recognize
  // `broadcast--<user>.<apex>` at this TLS-terminating surface and mirror the
  // verbatim opaque body to every connected box of that account. Only on the
  // data plane (it needs the live tunnel registry).
  if (surface === "services" || surface === "both") {
    registerGossipFanout(app, { registry, apex: servicesApex });
  }
  // Peer-backup mailboxes between accounts (docs/peer-backup.md §5.3).
  // FLAGSHIP_PB_MAIL=off stops advertising them.
  const mailboxes = (surface === "services" || surface === "both") && process.env.FLAGSHIP_PB_MAIL !== "off" ? new MailboxRegistry() : undefined;
  if (mailboxes) registerMailboxRelay(app, { mailboxes });
  if (meshOn) {
    const running = await startMeshRelay({ app, registry, mailboxes, servicesApex, comBaseUrl, health, host, opts });
    meshStats = () => running.node.stats();
    return running.handle;
  }
  await app.listen({ port: httpPort, host });
  // Warm the RAM redirection table from .com before routing starts
  // (best-effort + 5s-bounded; push backfills anything missed).
  await coldStartRedirections({ registry, comBaseUrl, secret: servicesControlSecret });
  const remoteAuthLookup = comStkLookup({ comBaseUrl, local: authLookupFromRegistry(serverRegistry) });
  // Resolve username → IRK pubkey from .com so the hub can verify the
  // Ed25519 signatures on each root/service entitlement (and on the
  // signed revocation list). Without this the hub would accept any
  // self-consistent entitlement, letting a registered box claim routing
  // for FQDNs in OTHER users' zones. Cached with a short TTL.
  const irkResolver = new RemoteUsernameResolver({ comBaseUrl });
  const irkLookup = (username: string): Promise<Uint8Array | null> =>
    irkResolver.lookup(username);
  const authorityLookup = (username: string) =>
    irkResolver.lookupAuthority(username);

  // The serving authority (docs/architecture-v2/serving-wiring.md §2): on when this relay is given `.com`'s
  // revocation public key. It then fails closed: no new tunnels after 60 s without a frame from `.com`'s feed, and
  // every tunnel closed after 10 min.
  let serving: { gate: ServingGate; feed: ServingFeedClient } | undefined;
  let phoneRoutes: PhoneRoutes | undefined;
  const revocationPub = process.env.FLAGSHIP_SERVING_REVOCATION_PUB?.trim().toLowerCase();
  if (revocationPub && (surface === "services" || surface === "both")) {
    if (!servicesControlSecret) {
      throw new Error("FLAGSHIP_SERVING_REVOCATION_PUB is set but SERVICES_CONTROL_SECRET is not: the serving feed cannot authenticate");
    }
    const gate = new ServingGate({
      fetchRecord: comServingFetcher({ comBaseUrl, secret: servicesControlSecret }),
      adminKeyLookup: async (username) => {
        const a = await irkResolver.lookupAuthority(username);
        const key = a?.adminRootPub ?? a?.irkPub;
        return key ? Buffer.from(key).toString("hex") : null;
      },
      log: (m) => console.log(m),
      // Lost-contact thresholds (60 s / 10 min) and the check cadence; tests and the relay conformance harness shorten them.
      ...envMs("FLAGSHIP_SERVING_REFUSE_NEW_MS", "refuseNewAfterMs"),
      ...envMs("FLAGSHIP_SERVING_CLOSE_ALL_MS", "closeAllAfterMs"),
    });
    const relayId = process.env.FLAGSHIP_RELAY_ID ?? process.env.FLY_MACHINE_ID ?? hostname();
    // The phone's bare name (plan H3, docs/architecture-v2/phone-route.md) needs `.com`'s ledger and eligibility, so
    // it rides on the serving authority; FLAGSHIP_PHONE_ROUTE=off leaves the bare name closed.
    if (process.env.FLAGSHIP_PHONE_ROUTE !== "off") {
      phoneRoutes = new PhoneRoutes({
        relayId,
        apex: servicesApex,
        ledger: comPhoneRouteLedger({ comBaseUrl, secret: servicesControlSecret }),
        eligibility: comPhoneEligibility({ comBaseUrl, secret: servicesControlSecret }),
        log: (m) => console.log(m),
      });
      registry.setPhoneRoutes(phoneRoutes);
    }
    const feed = new ServingFeedClient({
      comBaseUrl,
      secret: servicesControlSecret,
      relayId,
      revocationKey: revocationPub,
      gate,
      ...(phoneRoutes ? { phone: phoneRoutes } : {}),
    });
    gate.start(envMs("FLAGSHIP_SERVING_CHECK_MS", "checkMs").checkMs);
    feed.start();
    serving = { gate, feed };
    servingStats = () => ({ ...gate.stats(), feedConnection: feed.stats(), ...(phoneRoutes ? { phoneRoutes: phoneRoutes.stats() } : {}) });
    console.log(`serving authority ON (feed ${comBaseUrl}/api/internal/serving-feed)`);
  }
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
  // FLAGSHIP_HUB_HOST to the served host (default: the services apex, which
  // is what `.com` allows); FLAGSHIP_HUB_KEY_PATH persists the key to a Fly
  // volume if mounted.
  let blessingProvider: HubBlessingProvider | undefined;
  if (surface === "services" || surface === "both") {
    const hubHost = process.env.FLAGSHIP_HUB_HOST ?? servicesApex;
    const keyPath = process.env.FLAGSHIP_HUB_KEY_PATH;
    const keypair = loadOrCreateHubKeypair(keyPath);
    blessingProvider = new HubBlessingProvider({
      keypair,
      hubHost,
      comBaseUrl,
      ...(servicesControlSecret ? { sharedSecret: servicesControlSecret } : {}),
    });
    // Best-effort: don't block listen() on the first fetch.
    void blessingProvider.start();
    console.log(`relay-blessing provider started hubKey=${keypair.publicKey.length === 32 ? "ok" : "bad"} host=${hubHost}`);
  }

  // AI provider relay (docs/ai-privacy-and-staging.md §4): boxes reach public
  // host:443 through this hub over their tunnel. FLAGSHIP_OUTBOUND_RELAY=off
  // stops advertising it; boxes then refuse relay-on AI calls.
  // Which hosts it may reach comes from `.com`'s list (docs/outbound-hosts.md); without the
  // shared secret only the known AI providers are allowed.
  const outboundSecret = process.env.USAGE_REPORT_SECRET;
  const outboundRelay =
    process.env.FLAGSHIP_OUTBOUND_RELAY === "off"
      ? undefined
      : new OutboundRelay({
          hostPolicy: outboundSecret ? new ComHostPolicy({ baseUrl: comBaseUrl, secret: outboundSecret }) : new KnownHostsPolicy(),
        });
  const stopHub = startTunnelHub(app.server, registry, {
    surface,
    apex: servicesApex,
    ...(outboundRelay ? { outboundRelay } : {}),
    ...(mailboxes ? { mailboxes } : {}),
    authLookup: remoteAuthLookup,
    irkLookup,
    authorityLookup,
    revocationLookup,
    evictionLookup,
    ...(blessingProvider ? { blessingSource: blessingProvider } : {}),
    ...(serving ? { serving: serving.gate } : {}),
  });

  const stopPhoneTunnel: PhoneTunnelHandle | null = phoneRoutes ? startPhoneTunnel(app.server, phoneRoutes) : null;

  // Public-egress metering. OFF unless USAGE_REPORT_SECRET is set — so
  // deploying this code is a no-op until the secret is provisioned. The meter
  // counts bytes per account in the SNI splice and enforces the budget leases
  // .com answers with (docs/metering.md): accounts near a lease's end report
  // within ~500 ms, everyone else every USAGE_FLUSH_MS (default 60 s). An
  // over-quota free account is slowed to FLAGSHIP_OVER_QUOTA_KBPS (kbit/s,
  // default 256), never refused.
  let meter: UsageMeter | undefined;
  const usageSecret = process.env.USAGE_REPORT_SECRET;
  if (usageSecret) {
    meter = new UsageMeter({
      reportUrl: `${comBaseUrl}/api/usage/report`,
      secret: usageSecret,
      flushIntervalMs: process.env.USAGE_FLUSH_MS ? Number(process.env.USAGE_FLUSH_MS) : undefined,
      throttleBytesPerSec: overQuotaBytesPerSec(process.env.FLAGSHIP_OVER_QUOTA_KBPS),
    });
    meter.start();
    console.log(`usage metering ON → ${comBaseUrl}/api/usage/report`);
  }

  let router: RunningSniRouter | null = null;
  if (opts.tunnelTcpPort !== undefined) {
    router = await startSniRouter(registry, { port: opts.tunnelTcpPort, host }, meter);
    console.log(`SNI router listening on :${router.port} (raw TCP / TLS passthrough)`);
  }

  let echo: RunningAddressEcho | null = null;
  if (opts.relayEchoPort !== undefined) {
    echo = await startAddressEcho({ port: opts.relayEchoPort, host });
    console.log(`relay echo listening on :${echo.port} (PROXY protocol)`);
  }

  console.log(`flagshipserver.com listening on :${httpPort}`);
  console.log(`tunnel hub: ws://${host}:${httpPort}/tunnel`);

  return {
    app,
    registry,
    serverRegistry,
    router,
    stopHub,
    mesh: null,
    drain: (graceMs: number) => stopHub.drain(graceMs),
    async close() {
      meter?.stop();
      blessingProvider?.stop();
      serving?.feed.stop();
      serving?.gate.stop();
      await stopPhoneTunnel?.();
      if (router) await router.close();
      if (echo) await echo.close();
      await stopHub();
      await app.close();
    },
  };
}

/**
 * The relay in mesh mode (FLAGSHIP_MESH=on, docs/architecture-v2/relay-mesh.md): the relay key from its seed, the
 * blessing renewed with proof of key, the public relay log in place of `.com`'s internal routes (HELLO lookups,
 * serving inputs, revocations, eviction), bridges on `/mesh`, the phone ledger on the relays, and `/api/health` 503
 * until mesh-ready. Never calls `.com`'s internal serving, revocation, eviction or phone routes.
 */
async function startMeshRelay(o: {
  app: FastifyInstance;
  registry: TunnelRegistry;
  mailboxes: MailboxRegistry | undefined;
  servicesApex: string;
  comBaseUrl: string;
  health: { check: () => { ok: boolean; reasons?: string[] } };
  host: string;
  opts: { httpPort?: number; tunnelTcpPort?: number; relayEchoPort?: number };
}): Promise<{ node: MeshNode; handle: ServerHandle }> {
  const env = process.env;
  const relayId = env.FLAGSHIP_RELAY_ID;
  const seed = env.FLAGSHIP_RELAY_KEY_SEED;
  const logKey = (env.FLAGSHIP_RELAY_LOG_PUB ?? env.FLAGSHIP_SERVING_REVOCATION_PUB)?.trim().toLowerCase();
  if (!relayId || !seed || !logKey) throw new Error("FLAGSHIP_MESH=on needs FLAGSHIP_RELAY_ID, FLAGSHIP_RELAY_KEY_SEED and FLAGSHIP_RELAY_LOG_PUB");
  const relayKind: RelayKind = env.FLAGSHIP_RELAY_KIND === "entry" ? "entry" : "full";
  // The CA keys a relay checks blessings and the directory under. Until the relay reads the maintainer chain itself,
  // they come from the environment; none means nothing verifies and the relay never turns ready (fail closed).
  const caKeyList = (env.FLAGSHIP_MESH_CA_KEYS ?? "").split(",").map((k) => k.trim().toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k));
  if (caKeyList.length === 0) console.warn("[mesh] FLAGSHIP_MESH_CA_KEYS is empty: no blessing or directory will verify");
  const caKeys = () => caKeyList;
  const keypair = relayKeypairFromSeed(seed);
  const controlApex = new URL(o.comBaseUrl).hostname;
  const feedBase = (env.FLAGSHIP_RELAY_FEED_URL ?? `https://feed.${controlApex}/v1`).replace(/\/+$/, "");
  // The head and pages are sealed to the mesh key (§4.5.1): the epoch keys come with every blessing renewal, or from
  // `keys/<relayId>.json` when a file names an epoch this relay does not hold yet.
  const keys = new MeshFeedKeys({
    servicesApex: o.servicesApex,
    relayId,
    seed: keypair.privateKey,
    fetchKeyFile: async () => {
      try {
        const r = await fetch(`${feedBase}/keys/${encodeURIComponent(relayId)}.json`, { signal: AbortSignal.timeout(5_000) });
        return r.ok ? ((await r.json()) as unknown) : null;
      } catch {
        return null;
      }
    },
    log: (m) => console.log(m),
  });
  // FLAGSHIP_RELAY_FEED_PLAIN=1 reads a clear feed (a local harness); production feeds are always sealed.
  const cipher: FeedCipher = env.FLAGSHIP_RELAY_FEED_PLAIN === "1" ? plainFeedCipher : keys.cipher();
  const blessing = new RelayBlessingProvider({
    keypair,
    relayId,
    servicesApex: o.servicesApex,
    comBaseUrl: o.comBaseUrl,
    caKeys,
    onIssued: (body) => void keys.adopt(body.meshKeys),
  });
  const n = (name: string): number | undefined => {
    const v = Number(env[name]);
    return env[name] && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  // `FLAGSHIP_MESH_PEER_URLS` (`relayId=url,…`): dial a peer there instead of its direct name, as the Rust relay
  // reads it (a local harness dials loopback; tools/relay-conformance).
  const peerUrls = new Map<string, string>();
  for (const pair of (env.FLAGSHIP_MESH_PEER_URLS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`FLAGSHIP_MESH_PEER_URLS entry ${JSON.stringify(pair)} is not relayId=url`);
    peerUrls.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const node = new MeshNode({
    relayId,
    relayKind,
    servicesApex: o.servicesApex,
    logKey,
    caKeys,
    blessing,
    feedSource: httpFeedSource({ baseUrl: feedBase, cipher: () => cipher }),
    registry: o.registry,
    ...(peerUrls.size > 0 ? { peerUrl: (p: { relayId: string; tunnelHost: string }) => peerUrls.get(p.relayId) ?? `wss://${p.tunnelHost}:8443/mesh` } : {}),
    ...(o.mailboxes ? { mailboxes: o.mailboxes } : {}),
    ...(n("FLAGSHIP_MESH_FEED_POLL_MS") !== undefined ? { feedPollMs: n("FLAGSHIP_MESH_FEED_POLL_MS") } : {}),
    ...(n("FLAGSHIP_SERVING_REFUSE_NEW_MS") !== undefined ? { refuseNewMs: n("FLAGSHIP_SERVING_REFUSE_NEW_MS") } : {}),
    ...(n("FLAGSHIP_SERVING_CLOSE_ALL_MS") !== undefined ? { closeAllMs: n("FLAGSHIP_SERVING_CLOSE_ALL_MS") } : {}),
    ...(n("FLAGSHIP_MESH_REBALANCE_MS") !== undefined ? { rebalanceMs: n("FLAGSHIP_MESH_REBALANCE_MS") } : {}),
    ...(n("FLAGSHIP_MESH_MIN_MOVE_MS") !== undefined ? { minMoveMs: n("FLAGSHIP_MESH_MIN_MOVE_MS") } : {}),
    ...(n("FLAGSHIP_MESH_CAPACITY") !== undefined ? { capacity: n("FLAGSHIP_MESH_CAPACITY") } : {}),
    log: (m) => console.log(m),
  });
  const r = await wireMeshRelay({
    httpServer: o.app.server,
    registry: o.registry,
    node,
    blessing,
    servicesApex: o.servicesApex,
    mailboxes: o.mailboxes,
    ...(o.opts.tunnelTcpPort !== undefined ? { tunnelTcpPort: o.opts.tunnelTcpPort } : {}),
    host: o.host,
    meter: usageMeterFromEnv(o.comBaseUrl),
  });
  o.health.check = () => {
    const rd = node.readiness();
    return { ok: rd.ready, reasons: rd.reasons };
  };
  await o.app.listen({ port: o.opts.httpPort ?? (Number(env.PORT) || 3000), host: o.host });
  r.start();
  void blessing.start();
  let echo: RunningAddressEcho | null = null;
  if (o.opts.relayEchoPort !== undefined) echo = await startAddressEcho({ port: o.opts.relayEchoPort, host: o.host });
  console.log(`relay mesh ON: ${relayId} (${relayKind}), relay key ${blessing.relayKeyHex()}`);
  const handle: ServerHandle = {
    app: o.app,
    registry: o.registry,
    serverRegistry: o.app.serverRegistry,
    router: r.router,
    stopHub: r.hub,
    mesh: node,
    drain: (graceMs: number) => {
      node.beginDrain(graceMs);
      return r.hub.drain(graceMs);
    },
    async close() {
      blessing.stop();
      await r.stop();
      if (echo) await echo.close();
      await o.app.close();
    },
  };
  return { node, handle };
}

/**
 * A WebSocket upgrade no mounted path took (`/tunnel`, `/phone-tunnel`, `/mesh` each ignore other paths) is answered
 * 404 and closed, instead of holding the socket open forever (which also kept `close()` from finishing). Checked after
 * every upgrade listener ran: a taken socket has a WebSocket reading it or was already answered.
 */
function refuseUnclaimedUpgrades(server: import("node:http").Server): void {
  server.on("upgrade", (_req: unknown, socket: import("node:stream").Duplex) => {
    setImmediate(() => {
      if (socket.destroyed || socket.writableEnded || socket.listenerCount("data") > 0) return;
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
}

function usageMeterFromEnv(comBaseUrl: string): UsageMeter | undefined {
  const usageSecret = process.env.USAGE_REPORT_SECRET;
  if (!usageSecret) return undefined;
  return new UsageMeter({
    reportUrl: `${comBaseUrl}/api/usage/report`,
    secret: usageSecret,
    flushIntervalMs: process.env.USAGE_FLUSH_MS ? Number(process.env.USAGE_FLUSH_MS) : undefined,
    throttleBytesPerSec: overQuotaBytesPerSec(process.env.FLAGSHIP_OVER_QUOTA_KBPS),
  });
}

/**
 * Wire a mesh node into a relay's pieces on an HTTP server: the serving gate on the log (§4.4, §4.6 with the
 * indefinite-policy outage rule), the phone routes on the mesh ledger (§8), the tunnel hub with mesh hooks and log
 * lookups, `/phone-tunnel`, `/mesh`, and the SNI router with the §7.2 algorithm. Used by `start()` and by the
 * in-process three-relay test, so both run the same wiring.
 */
export async function wireMeshRelay(o: {
  httpServer: import("node:http").Server;
  registry: TunnelRegistry;
  node: MeshNode;
  blessing: RelayBlessingProvider;
  servicesApex: string;
  mailboxes?: MailboxRegistry | undefined;
  tunnelTcpPort?: number;
  host?: string;
  meter?: UsageMeter | undefined;
  /** Test overrides for the hub and router. */
  hubOverrides?: Partial<import("./tunnel/tunnelHub.js").TunnelHubOptions>;
  holdTimeoutMs?: number;
  checkMs?: number;
}): Promise<{ router: RunningSniRouter | null; hub: TunnelHubHandle; gate: ServingGate; phoneRoutes: PhoneRoutes; start(): void; stop(): Promise<void> }> {
  const { node, registry } = o;
  const gate = new ServingGate({
    fetchRecord: meshServingFetcher(() => node.feed.state, o.servicesApex),
    contactAgeMs: () => node.feed.quietMs(),
    refuseNewAfterMs: node.feed.refuseNewMs,
    closeAllAfterMs: node.feed.closeAllMs,
    keepIndefiniteOnLoss: true,
    hasAppliedState: () => node.feed.hasAppliedState(),
    log: (m) => console.log(m),
  });
  node.serving = gate;
  const phoneRoutes = new PhoneRoutes({
    relayId: node.selfRelayId,
    apex: o.servicesApex,
    ledger: node.phoneClient,
    eligibility: meshPhoneEligibility(() => node.feed.state),
    accepting: () => node.fresh(),
    log: (m) => console.log(m),
  });
  node.setPhoneRoutes(phoneRoutes);
  registry.setPhoneRoutes(phoneRoutes);
  if (o.mailboxes) {
    const mb = o.mailboxes;
    node.setMailboxes(mb);
    mb.setRemote({
      onAnnounce: (list) => node.announceMailboxes(list),
      has: (id) => node.store.mailboxRelay(id) !== null,
      deliver: (id, env) => node.deliverRemote(id, env),
    });
  }
  const lookups = node.helloLookups();
  const hub = startTunnelHub(o.httpServer, registry, {
    surface: "services",
    apex: o.servicesApex,
    ...(o.mailboxes ? { mailboxes: o.mailboxes } : {}),
    authLookup: lookups.authLookup,
    irkLookup: lookups.irkLookup,
    authorityLookup: lookups.authorityLookup,
    revocationLookup: lookups.revocationLookup,
    evictionLookup: lookups.evictionLookup,
    blessingSource: o.blessing,
    serving: gate,
    mesh: { ackFields: () => node.ackFields(), boxUp: (t) => node.boxUp(t), drainsByHint: () => node.bestOtherRelay() !== null },
    ...(o.hubOverrides ?? {}),
  });
  const stopPhone = startPhoneTunnel(o.httpServer, phoneRoutes);
  const detachMesh = node.attach(o.httpServer);
  let router: RunningSniRouter | null = null;
  if (o.tunnelTcpPort !== undefined) {
    router = await startSniRouter(registry, { port: o.tunnelTcpPort, host: o.host ?? "0.0.0.0", mesh: node, ...(o.holdTimeoutMs !== undefined ? { holdTimeoutMs: o.holdTimeoutMs } : {}) }, o.meter);
    const rt = router;
    node.setRouterEntry((stream, sni, bytes, ctx) => rt.routeBridged(stream, sni, bytes, ctx));
  }
  return {
    router,
    hub,
    gate,
    phoneRoutes,
    start() {
      node.start();
      gate.start(o.checkMs ?? 5_000);
      o.meter?.start();
    },
    async stop() {
      o.meter?.stop();
      gate.stop();
      await node.stop();
      detachMesh();
      await stopPhone();
      if (router) await router.close();
      await hub();
    },
  };
}

function envMs<K extends string>(name: string, key: K): { [P in K]?: number } {
  const n = Number(process.env[name]);
  return (process.env[name] && Number.isFinite(n) && n >= 0 ? { [key]: n } : {}) as { [P in K]?: number };
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const tunnelTcpPort = process.env.TUNNEL_TCP_PORT
    ? Number(process.env.TUNNEL_TCP_PORT)
    : undefined;
  const relayEchoPort = process.env.RELAY_ECHO_PORT ? Number(process.env.RELAY_ECHO_PORT) : undefined;
  const graceEnv = Number(process.env.FLAGSHIP_DRAIN_GRACE_MS);
  start({ tunnelTcpPort, relayEchoPort }).then((running) => {
    drainOnSignal(running, {
      graceMs: Number.isFinite(graceEnv) && graceEnv >= 0 ? graceEnv : DEFAULT_DRAIN_GRACE_MS,
    });
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
