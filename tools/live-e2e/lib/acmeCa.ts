// Which CA the gym `.com` issues from (docs/gym-test-acme.md). The gym runs on a private Pebble by default, so its
// certificates spend nothing of flagship.services' Let's Encrypt budget and never reach a public CT log; once per release
// candidate it runs on real Let's Encrypt (the gym Worker deployed with ISSUANCE_ACME_DIRECTORY empty). The harness reads
// the directory from `GET /api/certificates/account`, and off Let's Encrypt it trusts the test CA's current root for this
// run only: the checks that only mean something against Let's Encrypt (the apex CAA, the budget probe, the issuer name)
// skip or change their expectation.
import { X509Certificate, createHash } from "node:crypto";

export const LETS_ENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
/** The reason a Let's Encrypt-only check gives when the gym issues from a test CA. */
export const NOT_LETS_ENCRYPT = "not Let's Encrypt";
/** shared-run sets this for every group: "letsencrypt" or "test". Unset means Let's Encrypt (the old behaviour). */
export const ISSUANCE_CA_ENV = "GYM_ISSUANCE_CA";

export interface IssuanceCa {
  directory: string;
  letsEncrypt: boolean;
  accountUri: string | null;
}

export function isLetsEncryptProduction(directory: string | null | undefined): boolean {
  if (!directory) return false;
  try {
    const u = new URL(directory);
    return u.protocol === "https:" && u.host === "acme-v02.api.letsencrypt.org";
  } catch {
    return false;
  }
}

/** The CA the gym `.com` issues from, or null when it has no issuance account (the issuance group says why). */
export async function readIssuanceCa(control: string, fetchImpl: typeof fetch = fetch): Promise<IssuanceCa | null> {
  const r = await fetchImpl(`https://${control}/api/certificates/account`);
  if (r.status !== 200) return null;
  const j = (await r.json()) as { directory?: unknown; accountUri?: unknown };
  const directory = typeof j.directory === "string" && j.directory ? j.directory : LETS_ENCRYPT_PRODUCTION;
  return { directory, letsEncrypt: isLetsEncryptProduction(directory), accountUri: typeof j.accountUri === "string" ? j.accountUri : null };
}

/** Whether this run's groups should expect Let's Encrypt. Fails toward Let's Encrypt: only an explicit "test" relaxes. */
export function runIsOnLetsEncrypt(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ISSUANCE_CA_ENV] !== "test";
}

/** The issuer a box's certificate must name in this run. */
export function expectedIssuer(env: NodeJS.ProcessEnv = process.env): RegExp {
  return runIsOnLetsEncrypt(env) ? /Let's Encrypt/i : /Pebble/i;
}

/**
 * Where the test CA publishes its current root and intermediate: Pebble's management `/roots/0` and `/intermediates/0`,
 * which the gym's Caddy front serves next to the directory (infra/acme-gym/Caddyfile).
 */
export function testCaRootUrls(directory: string): string[] {
  const u = new URL(directory);
  if (u.protocol !== "https:") throw new Error(`the test CA's directory is not https: ${directory}`);
  return [`${u.origin}/roots/0`, `${u.origin}/intermediates/0`];
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

export function splitPems(text: string): string[] {
  return (text.match(PEM_RE) ?? []).map((p) => `${p.replace(/\r/g, "").trim()}\n`);
}

/** SHA-256 of the certificate's DER, lowercase hex. */
export function pemFingerprint(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

/** The test CA's root and intermediate, each checked to be a CA certificate (never a leaf a front could slip in). */
export async function fetchTestCaRoots(directory: string, fetchImpl: typeof fetch = fetch): Promise<{ root: string; pems: string[] }> {
  const pems: string[] = [];
  for (const url of testCaRootUrls(directory)) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    const found = splitPems(await r.text());
    if (found.length === 0) throw new Error(`${url} returned no certificate`);
    for (const p of found) {
      if (!new X509Certificate(p).ca) throw new Error(`${url} returned a certificate that is not a CA`);
      pems.push(p);
    }
  }
  return { root: pems[0]!, pems };
}

/**
 * The run's roots file with `pems` added. Earlier roots stay (a Pebble restart mid-run makes a new root, and boxes that
 * already hold a certificate from the old one keep serving it), and a certificate already in the file is not repeated.
 */
export function mergeRootsFile(existing: string, pems: readonly string[]): string {
  const out = splitPems(existing);
  const seen = new Set(out.map(pemFingerprint));
  for (const p of pems) {
    const fp = pemFingerprint(p);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(p.endsWith("\n") ? p : `${p}\n`);
  }
  return out.join("");
}
