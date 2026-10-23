#!/usr/bin/env node
import { join } from "node:path";
import { KeydServer, fileKeyStore, readKeyFile } from "./server.js";
import { KeydService } from "./service.js";
import { migrateKeyFiles } from "./migrate.js";

const STATE = process.env.FLAGSHIP_KEYD_STATE ?? "/var/lib/flagship-keyd";
const SOCKET = process.env.FLAGSHIP_KEYD_SOCKET ?? "/run/flagship-keyd/keyd.sock";

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "migrate") {
    const legacy = process.env.FLAGSHIP_KEYD_LEGACY_DIR ?? "/var/flagship";
    const r = migrateKeyFiles({ legacyDir: legacy, keydDir: STATE });
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd !== "serve") throw new Error(`unknown command ${cmd}`);
  const identity = readKeyFile(join(STATE, "identity.key"));
  if (!identity) throw new Error("no identity key: run `flagship-keyd migrate` or provision one first");
  const swk = readKeyFile(join(STATE, "swk.key"));
  const cgk = readKeyFile(join(STATE, "cgk.key"));
  const service = new KeydService({ identitySeed: identity, swk, cgk, store: fileKeyStore(STATE) });
  identity.fill(0);
  const server = new KeydServer({ socketPath: SOCKET, service, auditPath: join(STATE, "audit.log") });
  await server.start();
  console.log(`flagship-keyd serving ${SOCKET} for key ${service.publicKeyHex.slice(0, 16)}…`);
  const stop = () => void server.stop().finally(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((e) => {
  console.error(`flagship-keyd: ${(e as Error).message}`);
  process.exit(1);
});
