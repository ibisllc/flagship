// Shared by the P04/P05 live groups (wasiApps.ts, appGroupsDb.ts): uploading a WASI module, a signed
// install of a manifest, and reading how an installed app runs (/api/app-runtime).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { signInstallService, type InstallServiceRequest } from "@flagship/protocol";
import type { Account, Box } from "../../lib/fleet.js";
import { assert, http, postJson, short, tryHttp } from "../../lib/harness.js";

const FIXTURES = join(import.meta.dirname, "../../../../rust/crates/flagship-wasi/tests/fixtures");

/** The SDK fixture apps (rust/wasi-sdk, built for wasm32-wasip1 and committed). */
export function wasiFixture(name: "sdk-wasi-fixture" | "sdk-wasi-hostcalls"): { bytes: Buffer; digest: string } {
  const bytes = readFileSync(join(FIXTURES, `${name}.wasm`));
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

export async function uploadModule(box: Box, session: string, bytes: Uint8Array): Promise<string> {
  const r = await http(`https://${box.fqdn}/api/wasi/modules`, { method: "POST", headers: { "x-flagship-session": session, "content-type": "application/wasm" }, body: bytes }, 60_000);
  assert(r.status === 200, `module upload ${r.status}: ${short(r.text)}`);
  return String(r.json?.digest);
}

/** POST a signed install or update (PUT) of `manifest`; returns the box's answer. */
export async function signedInstall(acct: Account, box: Box, slug: string, manifest: Record<string, unknown>, update = false) {
  // Installs on a box go through one queue: a request that waited behind other groups' installs is "stale" by the time its
  // turn comes. That is the box's freshness rule, not a failure of this one: sign it again and send it again.
  let last: Awaited<ReturnType<typeof postJson>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const req: InstallServiceRequest = { serverId: box.fqdn, creator: acct.username, slug, manifestJson: JSON.stringify(manifest), addOwnerToMembership: true, issuedAt: Date.now() };
    const body = { request: req, signature: bytesToHex(signInstallService(req, acct.keys.irk)) };
    last = !update
      ? await postJson(`https://${box.fqdn}/api/services`, body, {}, 240_000)
      : await http(`https://${box.fqdn}/api/services/${encodeURIComponent(`${acct.username}--${slug}`)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 240_000);
    if (!(last.status === 400 && /stale request/.test(last.text))) return last;
  }
  return last!;
}

export async function appRuntime(box: Box, session: string, serviceId: string): Promise<Record<string, any>> {
  const r = await tryHttp(`https://${box.fqdn}/api/app-runtime/${encodeURIComponent(serviceId)}`, { headers: { "x-flagship-session": session } });
  assert(r.status === 200, `app-runtime ${r.status}: ${short(r.text)}`);
  return r.json as Record<string, any>;
}

/** An app request that is not a navigation (so no generation redirect). */
export const api = (extra: Record<string, string> = {}) => ({ headers: { "sec-fetch-mode": "cors", ...extra } });

export function baseManifest(slug: string): Record<string, unknown> {
  return {
    schema_version: 2,
    name: slug,
    version: "1.0.0",
    description: "gym runtime probe",
    data: {},
    network: { subdomain: slug },
    access: { enabled: true, public_routes: ["/*"] },
    migration: { verification: "standard" },
  };
}
