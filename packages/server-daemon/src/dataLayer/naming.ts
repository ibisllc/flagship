/**
 * Naming helpers for the unified data layer. The contract:
 *
 *   - Postgres database + role: `flagship_<user>_<app>` (lowercase identifier-safe).
 *   - MinIO bucket: `<user>-<app>` (lowercase, DNS-safe per S3 bucket rules).
 *   - Redis user / prefix: `<user>_<app>` / `<user>:<app>:`
 *
 * `<user>` and `<app>` must already match RFC 1035 label rules (the manifest
 * validator and services-zone registry enforce that upstream); this module
 * just composes the names.
 */

const SAFE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function assertSafe(label: string, kind: string): void {
  if (!SAFE.test(label)) throw new Error(`${kind} ${JSON.stringify(label)} is not a valid DNS label`);
}

export interface AppNaming {
  username: string;
  appName: string;
}

export function pgDatabase(n: AppNaming): string {
  assertSafe(n.username, "username");
  assertSafe(n.appName, "appName");
  // Postgres identifiers: lowercase, max 63 chars, no leading digit.
  return `flagship_${n.username}_${n.appName}`.replace(/-/g, "_");
}

export function pgRole(n: AppNaming): string {
  return pgDatabase(n);
}

export function s3Bucket(n: AppNaming): string {
  assertSafe(n.username, "username");
  assertSafe(n.appName, "appName");
  // S3 bucket: 3–63 chars, lowercase, no underscores, must start with letter.
  return `${n.username}-${n.appName}`;
}

export function s3AccessKey(n: AppNaming): string {
  return s3Bucket(n);
}

export function redisUser(n: AppNaming): string {
  return pgRole(n);
}

export function redisPrefix(n: AppNaming): string {
  assertSafe(n.username, "username");
  assertSafe(n.appName, "appName");
  return `${n.username}:${n.appName}:`;
}

/**
 * Generate a 32-byte random secret encoded as a URL-safe base64 string for
 * use as a generated password / access key.
 */
export function generateSecret(rng?: () => Uint8Array): string {
  const r = rng ?? (() => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b;
  });
  return Buffer.from(r()).toString("base64url");
}
