/**
 * Chunk B2's routes (docs/voici-and-messages.md §6.3, §9): the Messages key attestation, reports, and the owner's
 * admin tools under /api/admin/voici/*. All answer 404 while VOICI_ENABLED is off.
 */
import { abuseKeyFor, type AbuseKeyEntry } from "@flagship/protocol";
import { bundledAbuseKeys } from "./abuseKeys.js";
import { caEnforceFromEnv, workerCaTrustChain } from "./caTrustChainLoader.js";
import { LiveDeviceIntegrity, type DeviceIntegrity } from "./deviceIntegrity.js";
import { handleMessagesAttestation, MESSAGES_ATTESTATION_PATH, type MessagesAttestationEnv } from "./messagesAttestation.js";
import { handleVoiciAdmin, handleVoiciReport, json, voiciEnabled, VOICI_ADMIN_PREFIX, VOICI_REPORTS_PATH, type VoiciAbuseDeps, type VoiciAbuseEnv } from "./voiciAbuse.js";

export type VoiciAbuseRouteEnv = MessagesAttestationEnv & VoiciAbuseEnv & { CA_ENDORSEMENT_ENFORCE?: string };

export interface VoiciAbuseRouteDeps {
  now?: () => number;
  integrity?: DeviceIntegrity;
  abuseKeys?: readonly AbuseKeyEntry[];
  pages?: VoiciAbuseDeps["pages"];
  fetchFn?: typeof fetch;
}

export function isVoiciAbusePath(pathname: string): boolean {
  return pathname === VOICI_REPORTS_PATH || pathname.startsWith(VOICI_ADMIN_PREFIX) || MESSAGES_ATTESTATION_PATH.test(pathname);
}

export async function handleVoiciAbuseRoute(
  request: Request,
  env: VoiciAbuseRouteEnv,
  ctx?: { waitUntil(p: Promise<unknown>): void },
  over: VoiciAbuseRouteDeps = {},
): Promise<Response> {
  if (!voiciEnabled(env)) return json({ error: "not found" }, 404);
  const url = new URL(request.url);
  const now = over.now ?? (() => Date.now());
  const integrity = over.integrity ?? new LiveDeviceIntegrity(env, over.fetchFn);
  const abuseKeys = over.abuseKeys ?? bundledAbuseKeys();
  const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
  const m = MESSAGES_ATTESTATION_PATH.exec(url.pathname);
  if (m) {
    let account: string;
    try {
      account = decodeURIComponent(m[1]!);
    } catch {
      return json({ error: "not found", code: "not-found" }, 404);
    }
    return handleMessagesAttestation(request, env, account, {
      now,
      integrity,
      abuseKeys,
      caGate: { caTrustChain: workerCaTrustChain(), enforce: caEnforceFromEnv({ CA_ENDORSEMENT_ENFORCE: env.CA_ENDORSEMENT_ENFORCE }) },
      ...(waitUntil ? { waitUntil } : {}),
    });
  }
  const deps: VoiciAbuseDeps = {
    now,
    integrity,
    ...(over.pages ? { pages: over.pages } : {}),
    ...(over.fetchFn ? { fetchFn: over.fetchFn } : {}),
    ...(waitUntil ? { waitUntil } : {}),
  };
  if (url.pathname === VOICI_REPORTS_PATH) return handleVoiciReport(request, env, deps);
  return handleVoiciAdmin(request, env, {
    ...deps,
    abuseKeyStatus: () => {
      const e = abuseKeyFor(abuseKeys, now());
      return e ? { epoch: e.epoch, notAfter: e.notAfter } : null;
    },
  });
}
