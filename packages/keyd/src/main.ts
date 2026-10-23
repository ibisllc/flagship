#!/usr/bin/env node
import { join } from "node:path";
import { KeydServer, fileKeyStore, readKeyFile } from "./server.js";
import { KeydService } from "./service.js";
import { readFileSync } from "node:fs";
import { AcmeAccount } from "./acme.js";
import { TlsKeys } from "./tls.js";
import { handOverToKeydUser, legacyTlsFiles, loadPolicy, migrateKeyFiles, namesFor, scrubEnvFile, writePolicyFromEnv } from "./migrate.js";
import { KEYD_CLIENT_GROUP, KEYD_USER } from "./unit.js";

const STATE = process.env.FLAGSHIP_KEYD_STATE ?? "/var/lib/flagship-keyd";
const SOCKET = process.env.FLAGSHIP_KEYD_SOCKET ?? "/run/flagship-keyd/keyd.sock";

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "migrate") {
    const legacy = process.env.FLAGSHIP_KEYD_LEGACY_DIR ?? "/var/flagship";
    const r = migrateKeyFiles({ legacyDir: legacy, keydDir: STATE });
    // Which names this box may have a certificate for, from its own recipe, once.
    const policy = writePolicyFromEnv("/etc/flagship/daemon.env", STATE);
    // A box that already serves TLS keeps serving: its certificate and key move into keyd and
    // are replaced by a key keyd makes as soon as the daemon can order one.
    let tlsImported = false;
    if (policy) {
      const tls = new TlsKeys(new Set(namesFor(policy.serverFqdn)), join(STATE, "tls"));
      const files = legacyTlsFiles(legacy, policy.serverFqdn);
      if (files && tls.list().length === 0) {
        tls.importLegacy(readFileSync(files.keyPath, "utf8"), readFileSync(files.certPath, "utf8"));
        tlsImported = true;
      }
    }
    handOverToKeydUser(STATE, KEYD_USER, KEYD_CLIENT_GROUP);
    // The identity key must not ride back in through the daemon's environment files.
    const scrubbed = [
      scrubEnvFile("/etc/flagship/daemon.env", ["FLAGSHIP_IDENTITY_PRIV_HEX", "FLAGSHIP_SWK_HEX"]),
      scrubEnvFile("/etc/flagship-bootstrap.env", ["SERVER_IDENTITY_PRIV_HEX"]),
    ];
    console.log(JSON.stringify({ ...r, tlsImported, scrubbedEnvFiles: scrubbed.filter(Boolean).length }));
    return;
  }
  if (cmd !== "serve") throw new Error(`unknown command ${cmd}`);
  const identity = readKeyFile(join(STATE, "identity.key"));
  if (!identity) throw new Error("no identity key: run `flagship-keyd migrate` or provision one first");
  const swk = readKeyFile(join(STATE, "swk.key"));
  const cgk = readKeyFile(join(STATE, "cgk.key"));
  const policy = loadPolicy(STATE);
  const tls = policy ? new TlsKeys(new Set(namesFor(policy.serverFqdn)), join(STATE, "tls")) : undefined;
  const acme = tls ? new AcmeAccount(tls, undefined, join(STATE, "acme-account.key")) : undefined;
  const service = new KeydService({ identitySeed: identity, swk, cgk, store: fileKeyStore(STATE), ...(tls ? { tls } : {}), ...(acme ? { acme } : {}) });
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
