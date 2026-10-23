import { X509Certificate } from "node:crypto";
import { KeydAcmeIssuer, type KeydAcmeApi } from "./keydAcme.js";
import type { DnsChallengeWriter, AcmeIssuancePhase, LeEnvironment } from "./letsEncryptIssuer.js";

export const LE_DIRECTORY: Record<LeEnvironment, string> = {
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
  production: "https://acme-v02.api.letsencrypt.org/directory",
};

/** What the runtime needs from keyd for a box whose TLS key lives there. */
export interface OpaqueTlsKeyd {
  acme: KeydAcmeApi;
  active(): Promise<{ handle: string; chainPem: string; notAfter: number; names: string[]; legacy: boolean } | null>;
  activate(handle: string): Promise<void>;
  /** Remove keys that came from the old process's PEM files and are no longer in service. */
  pruneLegacy?(): Promise<void>;
}

/**
 * The runtime's issuer interface (`issue` -> cert, `revokeCertificate`) over keyd: it orders a
 * certificate for a key keyd makes, and puts it into service. The "private key" it reports is
 * always empty; nothing in this process ever has one.
 */
export function buildOpaqueIssuer(o: {
  keyd: OpaqueTlsKeyd;
  environment: LeEnvironment;
  email: string;
  dns: DnsChallengeWriter;
  onPhase?: (p: AcmeIssuancePhase) => void;
  fetchImpl?: typeof fetch;
  dns01PropagationDelayMs?: number;
  pollIntervalMs?: number;
}): {
  issue(names: string[], perIssue?: { dns?: DnsChallengeWriter }): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }>;
  revokeCertificate(certPem: string, reason?: number): Promise<void>;
} {
  const acme = new KeydAcmeIssuer({
    keyd: o.keyd.acme,
    directoryUrl: LE_DIRECTORY[o.environment],
    email: o.email,
    dns: o.dns,
    ...(o.onPhase ? { onPhase: o.onPhase } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.dns01PropagationDelayMs !== undefined ? { dns01PropagationDelayMs: o.dns01PropagationDelayMs } : {}),
    ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
  });
  return {
    async issue(names, perIssue) {
      const r = await acme.issue(names, perIssue);
      // Serving switches only once keyd has the certificate for the key it made.
      await o.keyd.activate(r.handle);
      await o.keyd.pruneLegacy?.().catch(() => {});
      return { certPem: r.chainPem, privateKeyPem: "", notAfter: r.notAfter };
    },
    async revokeCertificate(certPem, reason = 1) {
      const leaf = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
      if (!leaf) throw new Error("no certificate to revoke");
      await acme.revoke(new X509Certificate(leaf).raw, reason);
    },
  };
}
