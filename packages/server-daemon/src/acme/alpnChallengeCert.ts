import "reflect-metadata";
import { webcrypto } from "node:crypto";
import {
  cryptoProvider,
  Extension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { AsnSerializer, OctetString } from "@peculiar/asn1-schema";
import { sha256 } from "@noble/hashes/sha256";

const subtle = webcrypto.subtle;
// @peculiar/x509 reads from cryptoProvider when no crypto is passed explicitly.
cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0]);

/**
 * RFC 8737 §3 — the ALPN-01 challenge cert carries an X.509 extension at OID
 * 1.3.6.1.5.5.7.1.31 (id-pe-acmeIdentifier) whose DER-encoded value is the
 * SHA-256 of the keyAuthorization, wrapped as an OCTET STRING and marked
 * critical. The cert itself is self-signed, has the validating SNI as its
 * single SAN, and is presented under the ALPN protocol "acme-tls/1".
 */

const ACME_IDENTIFIER_OID = "1.3.6.1.5.5.7.1.31";

function digestKeyAuth(keyAuthorization: string): Uint8Array {
  return sha256(new TextEncoder().encode(keyAuthorization));
}

function buildAcmeIdentifierExtension(keyAuthorization: string): Extension {
  const digest = digestKeyAuth(keyAuthorization);
  const octets = new Uint8Array(digest);
  const octetString = new OctetString(octets.slice().buffer);
  const value = AsnSerializer.serialize(octetString);
  return new Extension(ACME_IDENTIFIER_OID, true, value);
}

export interface AlpnChallengeCert {
  certPem: string;
  privateKeyPem: string;
}

/**
 * Generate the self-signed cert + key the server will present when the ACME
 * validator connects to <sni>:443 with ALPN protocol "acme-tls/1". The key
 * is ephemeral — discard after the challenge resolves.
 */
export async function buildAlpnChallengeCert(
  keyAuthorization: string,
  sni: string,
): Promise<AlpnChallengeCert> {
  const keys = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;

  const now = new Date();
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + 24 * 60 * 60_000);

  // @peculiar/x509's typings come from the DOM lib; cast to satisfy structural
  // compatibility with Node's webcrypto.
  type LooseKeys = Parameters<typeof X509CertificateGenerator.createSelfSigned>[0]["keys"];
  type LooseAlg = Parameters<typeof X509CertificateGenerator.createSelfSigned>[0]["signingAlgorithm"];
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${sni}`,
    notBefore,
    notAfter,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" } as unknown as LooseAlg,
    keys: keys as unknown as LooseKeys,
    extensions: [
      new SubjectAlternativeNameExtension([{ type: "dns", value: sni }]),
      buildAcmeIdentifierExtension(keyAuthorization),
    ],
  });

  const certPem = cert.toString("pem");
  const pkcs8 = await subtle.exportKey("pkcs8", keys.privateKey);
  const privateKeyPem = derToPem(new Uint8Array(pkcs8), "PRIVATE KEY");
  return { certPem, privateKeyPem };
}

function derToPem(der: Uint8Array, label: string): string {
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = Buffer.from(bin, "binary").toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export const _internal = { ACME_IDENTIFIER_OID, digestKeyAuth };
