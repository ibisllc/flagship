/**
 * GYM BRANCH ONLY (docs/gym-test-acme.md item 7). Gym boxes get their certificates from the gym's private Pebble, so
 * a box fetching a sibling box (access sync, app copy, migrate, peer backups) must trust that run's Pebble root. The
 * proposal's systemd drop-in with NODE_EXTRA_CA_CERTS cannot work: every Flagship unit drops that variable on purpose
 * (privd unit.ts UNSAFE_ENV). So the daemon adds the root to Node's default CA list itself, fetched from the Pebble
 * app over its publicly trusted certificate. Only CA certificates are taken, and the list only ever grows (a Pebble
 * restart makes a new root while siblings may still serve the old one). This file must never reach `main`.
 */
import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";

export const GYM_ACME_ROOT_URLS = ["https://flagship-acme-gym.fly.dev/roots/0", "https://flagship-acme-gym.fly.dev/intermediates/0"];
const REFRESH_MS = 10 * 60_000;
const PEM_RE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

type TlsWithDefaults = typeof tls & {
  setDefaultCACertificates?: (certs: string[]) => void;
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
};

export interface GymAcmeTrustDeps {
  fetchImpl?: typeof fetch;
  tlsApi?: TlsWithDefaults;
  log?: (m: string) => void;
}

/** One pass: fetch the roots and add the CA certificates not yet trusted. Returns how many were added. */
export async function addGymAcmeRoots(deps: GymAcmeTrustDeps = {}): Promise<number> {
  const t = deps.tlsApi ?? (tls as TlsWithDefaults);
  if (typeof t.setDefaultCACertificates !== "function" || typeof t.getCACertificates !== "function") {
    deps.log?.("[gym-acme] this Node cannot extend its default CA list; gym certificates from Pebble stay untrusted");
    return 0;
  }
  const f = deps.fetchImpl ?? fetch;
  const found: string[] = [];
  for (const url of GYM_ACME_ROOT_URLS) {
    const r = await f(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    for (const pem of (await r.text()).match(PEM_RE) ?? []) {
      if (!new X509Certificate(pem).ca) throw new Error(`${url} returned a certificate that is not a CA`);
      found.push(pem.trim());
    }
  }
  const current = t.getCACertificates("default");
  const have = new Set(current.map((p) => new X509Certificate(p).fingerprint256));
  const fresh = found.filter((p) => !have.has(new X509Certificate(p).fingerprint256));
  if (fresh.length) t.setDefaultCACertificates([...current, ...fresh]);
  return fresh.length;
}

/** At start (bounded) and every 10 minutes; a failure is logged and never stops the daemon. */
export async function startGymAcmeTrust(deps: GymAcmeTrustDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const pass = async () => {
    try {
      const n = await addGymAcmeRoots({ ...deps, log });
      if (n) log(`[gym-acme] trusting ${n} new certificate(s) from the gym's test CA`);
    } catch (e) {
      log(`[gym-acme] could not read the gym's test CA roots: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await pass();
  setInterval(() => void pass(), REFRESH_MS).unref();
}
