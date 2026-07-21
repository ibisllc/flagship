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
  mintDevEntitlements,
  sealForEd25519Recipient,
  sealForRecipient,
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
      adminRootPubKey?: string;
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
    ...(blob.authCode.adminRootPubKey
      ? { adminRootPubKey: hexToBytes(blob.authCode.adminRootPubKey) }
      : {}),
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
          ...(ac.adminRootPubKey
            ? { adminRootPubKey: bytesToHex(ac.adminRootPubKey) }
            : {}),
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

/**
 * seal-for-bak --bak-x25519-pub <hex> --in <path> > sealed.hex
 *   OR  --bak-ed25519-pub <hex> --in <path> > sealed.hex
 *
 * Encrypt the bytes at `--in` against the BAK pubkey using the Flagship
 * sealed-box construction (ephemeral X25519 + AES-GCM). Output is hex on
 * stdout — install.sh feeds that hex straight into the
 * ServerRegisterRequest's sealedKey field.
 *
 * `--bak-x25519-pub` accepts a 32-byte raw X25519 pubkey (the strict
 * production path). `--bak-ed25519-pub` accepts the Ed25519 pubkey from
 * the auth-code's `phoneDelegatedPubKey` and converts it via the
 * standard Ed25519→X25519 birational map; the matching phone-side
 * unsealer runs the same conversion on its Ed25519 private key. This
 * fallback exists because v1 auth-codes only carry the phone's Ed25519
 * key; once the phone sends a dedicated BAK X25519 pubkey the strict
 * path supersedes it.
 *
 * The phone is the only entity that can decrypt the output;
 * flagshipserver.com stores the sealed blob but cannot recover the LUKS
 * unlock key without the phone's private key.
 */
function sealForBak(argv: string[]): void {
  const inPath = arg(argv, "--in");
  const plaintext = readFileSync(inPath);
  const xHexIdx = argv.indexOf("--bak-x25519-pub");
  const eHexIdx = argv.indexOf("--bak-ed25519-pub");
  let sealed: Uint8Array;
  if (xHexIdx >= 0) {
    const bakPub = hexToBytes(argv[xHexIdx + 1]!);
    sealed = sealForRecipient(plaintext, bakPub);
  } else if (eHexIdx >= 0) {
    const edPub = hexToBytes(argv[eHexIdx + 1]!);
    sealed = sealForEd25519Recipient(plaintext, edPub);
  } else {
    throw new Error("seal-for-bak requires --bak-x25519-pub or --bak-ed25519-pub");
  }
  process.stdout.write(bytesToHex(sealed) + "\n");
}

/**
 * mint-entitlements --irk-priv <hex> --pod-pub <hex> --username <u>
 *                   --pod-canonical <fqdn> [--service-canonicals a,b,c]
 *                   --out <path>
 *
 * Mint the IRK-signed entitlement bundle the daemon presents on every
 * tunnel HELLO (N12b). The RootEntitlement binds the server's identity
 * pubkey (`--pod-pub`, the STK) to its canonical FQDN, signed by the
 * user's IRK private key. Writes the bundle JSON (the
 * `EntitlementBundleFile` shape parsed by
 * server-daemon/entitlementBundleStore.ts) to `--out`, 0600.
 *
 * This runs on-box because the STK is generated on-box; the IRK private
 * key is supplied by the provisioner. On the demo cloud-init path the
 * deterministic-from-KEK demo IRK priv is shipped in the cloud-init
 * write_files and shredded after this step.
 */
function mintEntitlements(argv: string[]): void {
  const irkPrivHex = arg(argv, "--irk-priv");
  const podPubHex = arg(argv, "--pod-pub");
  const username = arg(argv, "--username");
  const podCanonical = arg(argv, "--pod-canonical");
  const outPath = arg(argv, "--out");
  const scIdx = argv.indexOf("--service-canonicals");
  const serviceCanonicals =
    scIdx >= 0 && argv[scIdx + 1]
      ? argv[scIdx + 1]!
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0)
      : [];

  const irkPriv = hexToBytes(irkPrivHex);
  const irk: Keypair = { privateKey: irkPriv, publicKey: ed.getPublicKey(irkPriv) };
  const podPubKey = hexToBytes(podPubHex);

  const bundle = mintDevEntitlements({
    irk,
    podPubKey,
    username,
    podCanonical,
    ...(serviceCanonicals.length > 0 ? { serviceCanonicals } : {}),
  });

  const file = {
    rootEntitlement: {
      username: bundle.rootEntitlement.username,
      podPubKey: bytesToHex(bundle.rootEntitlement.podPubKey),
      podCanonical: bundle.rootEntitlement.podCanonical,
      issuedAt: bundle.rootEntitlement.issuedAt,
    },
    rootEntitlementSig: bytesToHex(bundle.rootEntitlementSig),
    serviceEntitlement: bundle.serviceEntitlement
      ? {
          username: bundle.serviceEntitlement.username,
          podPubKey: bytesToHex(bundle.serviceEntitlement.podPubKey),
          canonicals: bundle.serviceEntitlement.canonicals,
          issuedAt: bundle.serviceEntitlement.issuedAt,
          expiresAt: bundle.serviceEntitlement.expiresAt,
        }
      : null,
    serviceEntitlementSig: bundle.serviceEntitlementSig
      ? bytesToHex(bundle.serviceEntitlementSig)
      : null,
  };
  writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(outPath, 0o600);
  console.error(`[install-helper] wrote entitlement bundle to ${outPath}`);
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
    case "seal-for-bak":
      return sealForBak(rest);
    case "mint-entitlements":
      return mintEntitlements(rest);
    default:
      console.error(
        "usage: install-helper <gen-identity|pkcs8-from-hex|sign-server-register|sign-sealed-key|seal-for-bak|mint-entitlements> [args]",
      );
      process.exit(2);
  }
}

main();
