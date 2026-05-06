/**
 * Install-time crypto helper. Invoked by `installer/install.sh` (which
 * runs from the live Alpine USB, where Node + the freshly-cloned repo
 * are available) for operations that the steady-state boot stage can't
 * do on its own (Ed25519 keypair generation, PKCS8 PEM emission, signing
 * `PutSealedLuksKey` for upload).
 *
 * Subcommands:
 *   gen-identity --out-priv <p> --out-pub <p> --out-pem <p>
 *       Generate a fresh server identity Ed25519 keypair. Writes:
 *         out-priv  — 32-byte hex (FLAGSHIP_IDENTITY_PRIV_HEX form)
 *         out-pub   — 32-byte hex
 *         out-pem   — PKCS8 PEM the boot stage feeds to openssl pkeyutl
 *
 *   pkcs8-from-hex --priv-hex <hex> > out.pem
 *       Stand-alone PKCS8 PEM emission from an existing raw priv hex.
 *
 *   sign-sealed-key --priv <hex-priv> --server-id <fqdn> --sealed-hex <hex>
 *                    --issued-at <ms> > body.json
 *       Build the JSON envelope for POST /api/server/:host/sealed-luks-key.
 *
 * Run:
 *   npx tsx scripts/install-helper.ts <subcommand> [args]
 */

import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import {
  ed,
  signPutSealedLuksKey,
  signServerRegister,
  type AuthCode,
  type Keypair,
  type PutSealedLuksKey,
  type ServerRegisterRequest,
} from "@flagship/protocol";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Wrap a 32-byte raw Ed25519 private key in PKCS8 PEM. The DER prefix
 * is constant for Ed25519 OneAsymmetricKey:
 *   30 2e        SEQUENCE (46 bytes)
 *     02 01 00       INTEGER version=0
 *     30 05          AlgorithmIdentifier SEQUENCE
 *       06 03 2b65 70    OID 1.3.101.112 (Ed25519)
 *     04 22          OCTET STRING (34 bytes)
 *       04 20          OCTET STRING (32 bytes — the raw key)
 *       <32 bytes>
 */
function pkcs8PemFromRaw(raw32: Uint8Array): string {
  if (raw32.length !== 32) throw new Error("Ed25519 priv must be exactly 32 bytes");
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const der = new Uint8Array(prefix.length + 32);
  der.set(prefix, 0);
  der.set(raw32, prefix.length);
  const b64 = Buffer.from(der).toString("base64");
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

function arg(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) {
    throw new Error(`missing required arg ${name}`);
  }
  return argv[i + 1]!;
}

function genIdentity(argv: string[]): void {
  const outPriv = arg(argv, "--out-priv");
  const outPub = arg(argv, "--out-pub");
  const outPem = arg(argv, "--out-pem");
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  const pub = ed.getPublicKey(priv);
  writeFileSync(outPriv, bytesToHex(priv) + "\n");
  chmodSync(outPriv, 0o600);
  writeFileSync(outPub, bytesToHex(pub) + "\n");
  chmodSync(outPub, 0o644);
  writeFileSync(outPem, pkcs8PemFromRaw(priv));
  chmodSync(outPem, 0o600);
  console.error(`[install-helper] wrote priv=${outPriv} pub=${outPub} pem=${outPem}`);
}

function pkcs8FromHex(argv: string[]): void {
  const privHex = arg(argv, "--priv-hex");
  process.stdout.write(pkcs8PemFromRaw(hexToBytes(privHex)));
}

function signRegister(argv: string[]): void {
  const privHex = arg(argv, "--priv-hex");
  const blobPath = arg(argv, "--auth-code-blob");
  const blob = JSON.parse(readFileSync(blobPath, "utf8")) as {
    authCode: {
      version: 1;
      serial: string;
      username: string;
      serverName: string;
      serverDomain: string;
      delegatedPubKey: string;
      userPubKey: string;
      issuedAt: number;
      expiresAt: number;
    };
    authCodeUserSignature: string;
  };
  const ac: AuthCode = {
    version: blob.authCode.version,
    serial: blob.authCode.serial,
    username: blob.authCode.username,
    serverName: blob.authCode.serverName,
    serverDomain: blob.authCode.serverDomain,
    delegatedPubKey: hexToBytes(blob.authCode.delegatedPubKey),
    userPubKey: hexToBytes(blob.authCode.userPubKey),
    issuedAt: blob.authCode.issuedAt,
    expiresAt: blob.authCode.expiresAt,
  };
  const userSig = hexToBytes(blob.authCodeUserSignature);

  const priv = hexToBytes(privHex);
  const identity: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  const issuedAt = Date.now();
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const req: ServerRegisterRequest = {
    authCode: ac,
    authCodeUserSignature: userSig,
    serverIdentityPubKey: identity.publicKey,
    issuedAt,
    nonce,
  };
  const sig = signServerRegister(req, identity);
  process.stdout.write(
    JSON.stringify({
      request: {
        authCode: {
          version: ac.version,
          serial: ac.serial,
          username: ac.username,
          serverName: ac.serverName,
          serverDomain: ac.serverDomain,
          delegatedPubKey: bytesToHex(ac.delegatedPubKey),
          userPubKey: bytesToHex(ac.userPubKey),
          issuedAt: ac.issuedAt,
          expiresAt: ac.expiresAt,
        },
        authCodeUserSignature: bytesToHex(userSig),
        serverIdentityPubKey: bytesToHex(identity.publicKey),
        issuedAt,
        nonce: bytesToHex(nonce),
      },
      signature: bytesToHex(sig),
    }) + "\n",
  );
}

function signSealedKey(argv: string[]): void {
  const privHex = arg(argv, "--priv");
  const serverId = arg(argv, "--server-id");
  const sealedHex = arg(argv, "--sealed-hex");
  const issuedAt = parseInt(arg(argv, "--issued-at"), 10);
  if (!Number.isFinite(issuedAt)) throw new Error("--issued-at must be a number");
  const priv = hexToBytes(privHex);
  const identity: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  const sealedKey = hexToBytes(sealedHex);
  const claim: PutSealedLuksKey = { serverId, sealedKey, issuedAt };
  const sig = signPutSealedLuksKey(claim, identity);
  process.stdout.write(
    JSON.stringify({
      request: { serverId, sealedKey: sealedHex, issuedAt },
      signature: bytesToHex(sig),
    }) + "\n",
  );
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "gen-identity":
      return genIdentity(rest);
    case "pkcs8-from-hex":
      return pkcs8FromHex(rest);
    case "sign-server-register":
      return signRegister(rest);
    case "sign-sealed-key":
      return signSealedKey(rest);
    default:
      console.error(
        "usage: install-helper <gen-identity|pkcs8-from-hex|sign-server-register|sign-sealed-key> [args]",
      );
      process.exit(2);
  }
}

main();
