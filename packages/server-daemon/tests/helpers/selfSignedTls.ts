import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { X509CertificateGenerator, SubjectAlternativeNameExtension, cryptoProvider } from "@peculiar/x509";

cryptoProvider.set(webcrypto as unknown as Crypto);

/** A self-signed cert for `name`; pass `cert` as the client's `ca` to trust it. */
export async function selfSigned(name: string): Promise<{ cert: string; key: string }> {
  const keys = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
    extensions: [new SubjectAlternativeNameExtension([{ type: "dns", value: name }])],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  return { cert: cert.toString("pem"), key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n` };
}
