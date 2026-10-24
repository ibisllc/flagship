#!/usr/bin/env node
import { join } from "node:path";
import { KeydServer, fileKeyStore, readKeyFile } from "./server.js";
import { KeydService } from "./service.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { AcmeAccount } from "./acme.js";
import { TlsKeys } from "./tls.js";
import { CEREMONY_TOKEN_FILE, CEREMONY_WINDOW_MS, handOverToKeydUser, legacyTlsFiles, loadOwnerAnchor, loadPolicy, migrateKeyFiles, namesFor, scrubEnvFile, writeOwnerAnchorFromConfig, writePolicyFromEnv } from "./migrate.js";
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
    // The owner key a sealed SWK/CGK delivery must be signed by, from root's copy of the config.
    writeOwnerAnchorFromConfig(
      { serverJson: process.env.FLAGSHIP_CONFIG ?? "/etc/flagship/server.json", installBlob: process.env.FLAGSHIP_INSTALL_BLOB ?? join(legacy, "install-blob.json") },
      STATE,
    );
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
  // The STK's ML-DSA-65 seed lives next to it; a keyd that has none makes one (once) from the OS
  // RNG, never derived from the STK.
  let pqSeed = readKeyFile(join(STATE, "identity-mldsa.key"));
  if (!pqSeed) {
    pqSeed = new Uint8Array(randomBytes(32));
    fileKeyStore(STATE).save("identity-mldsa", pqSeed);
  }
  const swk = readKeyFile(join(STATE, "swk.key"));
  const cgk = readKeyFile(join(STATE, "cgk.key"));
  const policy = loadPolicy(STATE);
  const tls = policy ? new TlsKeys(new Set(namesFor(policy.serverFqdn)), join(STATE, "tls")) : undefined;
  const acme = tls ? new AcmeAccount(tls, undefined, join(STATE, "acme-account.key")) : undefined;
  const owner = loadOwnerAnchor(STATE);
  // The boot ceremony: while a slot is empty, a fresh one-time token that only keyd and root can
  // read lets a key the box already held move in, for a few minutes after this start.
  const tokenPath = join(STATE, CEREMONY_TOKEN_FILE);
  let ceremony: { token: Uint8Array; notAfter: number } | null = null;
  rmSync(tokenPath, { force: true });
  if (!swk || !cgk) {
    ceremony = { token: new Uint8Array(randomBytes(32)), notAfter: Date.now() + CEREMONY_WINDOW_MS };
    writeFileSync(tokenPath, Buffer.from(ceremony.token).toString("hex"), { mode: 0o400 });
  }
  const service = new KeydService({
    identitySeed: identity, pqSeed, swk, cgk, store: fileKeyStore(STATE), ...(tls ? { tls } : {}), ...(acme ? { acme } : {}),
    owner: owner && policy ? { irkPubHex: owner.irkPubHex, serverFqdn: policy.serverFqdn } : null,
    ceremony,
  });
  identity.fill(0);
  pqSeed.fill(0);
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
