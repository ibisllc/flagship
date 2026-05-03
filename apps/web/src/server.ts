import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveIRK } from "@flagship/protocol";
import { registerBuildImage } from "./routes/buildImage.js";
import { registerQrAuth } from "./routes/qrAuth.js";
import { registerSecurityReport } from "./routes/securityReport.js";
import { registerDesktopPair, type DesktopPairOptions } from "./routes/desktopPair.js";
import { registerMigration, type MigrationOptions } from "./routes/migration.js";
import {
  registerServerRegistry,
  InMemoryServerRegistry,
  authLookupFromRegistry,
  type ServerRegistry,
} from "./routes/serverRegistry.js";
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

export interface BuildServerOptions {
  migration?: MigrationOptions;
  desktopPair?: DesktopPairOptions;
  /** Pre-built server registry (tests pass a seeded one). Defaults to in-memory. */
  serverRegistry?: ServerRegistry;
  /** Resolves a userId to its IRK pubkey for registration verification. */
  resolveUserIrk?: (userId: string) => Uint8Array | null;
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
  const serverRegistry = opts.serverRegistry ?? new InMemoryServerRegistry();
  app.decorate("serverRegistry", serverRegistry);

  app.get("/api/health", async () => ({ ok: true, service: "flagshipserver.com" }));

  registerBuildImage(app);
  registerQrAuth(app);
  registerSecurityReport(app);
  registerDesktopPair(app, opts.desktopPair ?? devDesktopPairOptions());
  if (opts.migration) registerMigration(app, opts.migration);

  if (opts.resolveUserIrk) {
    registerServerRegistry(app, {
      registry: serverRegistry,
      resolveUserIrk: opts.resolveUserIrk,
    });
  }

  app.register(fastifyStatic, {
    root: resolve(__dirname, "../public"),
    prefix: "/",
    decorateReply: false,
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    serverRegistry: ServerRegistry;
  }
}

export async function start(opts: {
  httpPort?: number;
  tunnelTcpPort?: number;
  host?: string;
} = {}): Promise<ServerHandle> {
  const httpPort = opts.httpPort ?? Number(process.env.PORT) ?? 3000;
  const host = opts.host ?? "0.0.0.0";

  const app = buildServer();
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
