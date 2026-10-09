#!/usr/bin/env node
/**
 * Install-time helper invoked by packages/installer-apkovl/scripts/
 * flagship-bootstrap.start AFTER the endorsement gate. Verifies that the
 * CA's pubkey-cert binding (username → IRK) the bootstrap fetched is really
 * signed by a CA key that the PINNED maintainer authority currently
 * endorses — not merely that it arrived over TLS from flagshipserver.com.
 *
 * Trust is anchored exactly as the Worker anchors it
 * (apps/com/src/caTrustChainLoader.ts): the ca-track mandate chain in the
 * cloned repo's `.maintainers/` is verified forward from
 * MAINTAINER_PINNED_MANDATE_HASH, the committed CaEndorsement leases
 * resolve the CA keys live at `now`, and the protocol chokepoint
 * `verifyCaSignedUserPubKeyBinding` checks TTL + signature. The clone has
 * already passed the release-endorsement gate, so its `.maintainers/` is
 * trusted.
 *
 * Usage:
 *   verify-ca-binding.mjs --repo <clone> --cert <pubkey-cert.json> \
 *     --username <u> --irk-pub <hex>
 * Exits 0 when the binding verifies AND names exactly that username + key.
 *
 * Run via `node --import tsx` (like verify-endorsement.mjs): the clone has
 * no compiled `dist/`, so @flagship/protocol is imported from source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizedCaKeys, verifyMandateChainFromPin } from "@ibisllc/maintainers";
import {
  MAINTAINER_PINNED_MANDATE_HASH,
  verifyCaSignedUserPubKeyBinding,
} from "../packages/protocol/src/maintainerCa.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function hexToBytes(h) {
  return Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
}

/** The committed ca-track trust chain of a repo checkout. */
export function repoCaTrustChain(repoPath, pinnedMandateHash = MAINTAINER_PINNED_MANDATE_HASH) {
  const dir = join(repoPath, ".maintainers", "tracks", "ca", "mandates");
  // Filename-sorted = canonical-log order (the daemon's readStoreFromDisk rule).
  const mandates = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const endorsements = JSON.parse(
    readFileSync(join(repoPath, ".maintainers", "ca-endorsements", "bundle.json"), "utf8"),
  );
  const verified = verifyMandateChainFromPin(pinnedMandateHash, mandates);
  return {
    authorizedCaKeys: (now) => authorizedCaKeys(endorsements, verified, new Date(now)),
  };
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyCaBinding({ repoPath, cert, username, irkPubHex, now, pinnedMandateHash }) {
  const b = cert?.binding;
  if (
    !b || b.version !== 1 || typeof b.username !== "string" ||
    typeof b.pubKey !== "string" || !HEX64.test(b.pubKey.toLowerCase()) ||
    typeof b.issuedAt !== "number" || typeof b.expiresAt !== "number" ||
    typeof b.issuer !== "string" ||
    typeof cert.signature !== "string" || !HEX128.test(cert.signature.toLowerCase())
  ) {
    return { ok: false, reason: "malformed-cert" };
  }
  if (b.username !== username) return { ok: false, reason: "username-mismatch" };
  if (b.pubKey.toLowerCase() !== irkPubHex.toLowerCase()) return { ok: false, reason: "irk-mismatch" };
  let chain;
  try {
    chain = repoCaTrustChain(repoPath, pinnedMandateHash);
  } catch (e) {
    return { ok: false, reason: `ca-chain-unverified: ${e instanceof Error ? e.message : e}` };
  }
  const binding = { ...b, pubKey: hexToBytes(b.pubKey.toLowerCase()) };
  const v = verifyCaSignedUserPubKeyBinding(
    binding,
    hexToBytes(cert.signature.toLowerCase()),
    chain,
    now,
    pinnedMandateHash,
  );
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoPath = arg("repo");
  const certPath = arg("cert");
  const username = arg("username");
  const irkPubHex = arg("irk-pub");
  if (!repoPath || !certPath || !username || !irkPubHex) {
    process.stderr.write("usage: verify-ca-binding.mjs --repo <clone> --cert <file> --username <u> --irk-pub <hex>\n");
    process.exit(2);
  }
  let cert;
  try {
    cert = JSON.parse(readFileSync(certPath, "utf8"));
  } catch {
    process.stderr.write("verify-ca-binding: cert is not JSON\n");
    process.exit(1);
  }
  const r = verifyCaBinding({ repoPath, cert, username, irkPubHex, now: Date.now() });
  if (!r.ok) {
    process.stderr.write(`verify-ca-binding: ${r.reason}\n`);
    process.exit(1);
  }
  process.stdout.write("verify-ca-binding: OK\n");
}
