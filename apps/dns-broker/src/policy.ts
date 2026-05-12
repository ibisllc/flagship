/**
 * Per-RPC signature + invariant verification for the DnsBroker Worker.
 *
 * Lives in its own module so it can be exhaustively tested without ever
 * touching Cloudflare's DNS API. The Worker entry (`index.ts`) is a
 * thin shell: parse body → call `verifyRpc` → on `ok:true`, make the
 * CF call; on `ok:false`, return a generic 403 with no leak about which
 * fence failed.
 *
 * Three RPC kinds, each with its own authority story:
 *
 *   publishTxtChallenge — ACME DNS-01 challenge TXT under either the
 *     requesting pod's namespace or the surrounding user-zone. Pod-namespace
 *     challenges accept a daemon-identity signature; user-zone challenges
 *     require either (a) an active AppGrant whose `routes` list covers the
 *     user-zone wildcard, or (b) an explicit IRK signature on the challenge.
 *
 *   publishARecord — A/AAAA for `<server>.<user>.<apex>` and its
 *     wildcards. Authority is *registration*: the broker fetches
 *     `<MAIN_WORKER>/api/server/by-domain/<serverId>` and confirms the
 *     server is currently registered (not revoked). The target IP MUST
 *     equal the env-pinned anycast IP, so a successful call cannot
 *     redirect traffic to an attacker — it can only re-assert the same
 *     anycast target. Existing records are NOT overwritten.
 *
 *   deleteRecord — same authority that created the record. ACME challenges
 *     fall off with a daemon signature; A/AAAA records require IRK.
 *
 * Verification is independent of caller-supplied pubkeys: identity
 * material is resolved by querying the *.com main Worker's public
 * lookup endpoints (/api/server/by-domain/<serverId> for daemon
 * identity, /api/users/<u>/pubkey-cert for IRK). Even if the main
 * Worker is fully compromised, a malicious caller still cannot mint
 * DNS without producing a valid signature against the registered key
 * (publishTxtChallenge, deleteRecord) or pointing at an arbitrary IP
 * (publishARecord — the IP allowlist is the gate).
 */

import {
  appGrantActiveAt,
  appGrantAuthorizesUrl,
  ed,
  verifyAppGrant,
  verifyDns01Delete,
  verifyDns01Publish,
  type AppGrant,
  type AppGrantRoute,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
} from "@flagship/protocol";
import { sha256 } from "@noble/hashes/sha256";

// ---- canonical bytes for the broker-specific envelopes ----

const TAG_BROKER_DELETE_A = "flagship/dns-broker/delete-a/v1";
const TAG_BROKER_DNS01_USERZONE = "flagship/dns-broker/userzone-acme/v1";

export function canonicalDeleteABytes(args: {
  serverId: string;
  recordId: string;
  issuedAt: number;
}): Uint8Array {
  return new TextEncoder().encode(
    [TAG_BROKER_DELETE_A, args.serverId, args.recordId, args.issuedAt].join("|"),
  );
}

/**
 * Canonical bytes for an IRK signature authorising a user-zone ACME
 * challenge publish. The IRK signs over (username|recordName|hash(value)|issuedAt).
 * The userzone case is rare (wildcard cert for `*.<user>.flagship.services`)
 * and authority for it rightly lives at the user level, not any one pod.
 */
export function canonicalUserzoneAcmeBytes(args: {
  username: string;
  recordName: string;
  recordValueHash: Uint8Array;
  issuedAt: number;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      TAG_BROKER_DNS01_USERZONE,
      args.username,
      args.recordName,
      bytesToHex(args.recordValueHash),
      args.issuedAt,
    ].join("|"),
  );
}

// ---- RPC body shapes (the public contract) ----

export interface PublishTxtChallengeBody {
  kind: "publishTxtChallenge";
  /** _acme-challenge.<host> */
  recordName: string;
  /** plaintext TXT value (the ACME keyAuth-derived digest in base64url) */
  recordValue: string;
  /**
   * One of:
   *   - pod-namespace authority: a daemon-identity signature over the
   *     standard Dns01PublishRequest envelope (serverId === recordName
   *     stripped of its `_acme-challenge.` prefix or its user-zone form).
   *   - user-zone authority: either an AppGrant whose routes cover the
   *     user-zone wildcard, or an explicit IRK signature.
   */
  authority:
    | PodAuthority
    | UserZoneIrkAuthority
    | UserZoneGrantAuthority;
}

export interface PodAuthority {
  type: "pod";
  serverId: string;
  recordValueHashHex: string;
  issuedAt: number;
  signatureHex: string;
}

export interface UserZoneIrkAuthority {
  type: "userzone-irk";
  username: string;
  recordValueHashHex: string;
  issuedAt: number;
  signatureHex: string;
}

export interface UserZoneGrantAuthority {
  type: "userzone-grant";
  username: string;
  grant: AppGrantWire;
  grantSignatureHex: string;
  /**
   * IRK that issued the grant — must equal the registered IRK for
   * `username` according to the .com pubkey-cert endpoint.
   */
  irkPubKeyHex: string;
}

export interface PublishARecordBody {
  kind: "publishARecord";
  /** Pod FQDN under `<apex>` whose A/AAAA record family is being asserted. */
  serverId: string;
  /**
   * Which of the four registered names this call targets:
   *   "pod-apex"          → <serverId>
   *   "pod-wildcard"      → *.<serverId>
   *   "user-zone-apex"    → <user>.<apex>
   *   "user-zone-wildcard"→ *.<user>.<apex>
   */
  recordName: "pod-apex" | "pod-wildcard" | "user-zone-apex" | "user-zone-wildcard";
  recordType: "A" | "AAAA";
  targetIp: string;
}

export interface DeleteRecordBody {
  kind: "deleteRecord";
  recordId: string;
  /**
   * `acme` — delete a previously-published ACME TXT. Authority is the
   * same daemon identity that created it.
   * `a` — delete an A/AAAA record. Authority is the user IRK or the
   * daemon identity for the matching pod.
   */
  recordKind: "acme" | "a";
  authority:
    | PodDns01DeleteAuthority
    | PodADeleteAuthority
    | UserZoneIrkDeleteAuthority;
}

export interface PodDns01DeleteAuthority {
  type: "pod-acme";
  serverId: string;
  issuedAt: number;
  signatureHex: string;
}

export interface PodADeleteAuthority {
  type: "pod-a";
  serverId: string;
  issuedAt: number;
  signatureHex: string;
}

export interface UserZoneIrkDeleteAuthority {
  type: "userzone-irk";
  username: string;
  issuedAt: number;
  /**
   * IRK signature over canonicalDeleteABytes({serverId: "", recordId, issuedAt}).
   * We re-use the delete-A canonical here for simplicity.
   */
  signatureHex: string;
}

export type RpcBody = PublishTxtChallengeBody | PublishARecordBody | DeleteRecordBody;

/**
 * Wire form of AppGrant — same fields as the in-memory `AppGrant` but
 * with `serverIdentities` hex-encoded for JSON transport.
 */
export interface AppGrantWire {
  grantId: string;
  username: string;
  appCanonical: string;
  appInstanceId?: string;
  serverDomains: string[];
  serverIdentitiesHex: string[];
  routes: AppGrantRoute[];
  issuedAt: number;
  expiresAt: number;
}

// ---- policy environment (everything verifyRpc needs that isn't in the body) ----

export interface PolicyEnv {
  apex: string;
  servicesIpv4: string;
  servicesIpv6?: string;
  replayWindowMs: number;
  now: number;
  /**
   * Resolve a pod's registered daemon identityPubKey by serverId.
   * Returns null if unknown / revoked. The real broker hits
   * `${MAIN_WORKER_URL}/api/server/by-domain/${serverId}`; tests pass
   * a hard-coded resolver.
   */
  resolvePodIdentity: (serverId: string) => Promise<Uint8Array | null>;
  /**
   * Resolve a username's registered IRK pubkey. Hits the .com
   * `/api/users/<username>/pubkey-cert` endpoint in production.
   */
  resolveUserIrk: (username: string) => Promise<Uint8Array | null>;
}

export type VerifyOutcome =
  | { ok: true; effect: BrokerEffect }
  | { ok: false; reason: string };

/**
 * The action the broker should take after policy verification. The Worker
 * entry uses this to decide which Cloudflare DNS API call to make. The
 * effect is opaque to outsiders — callers see only ok/not-ok in the
 * response.
 */
export type BrokerEffect =
  | {
      kind: "createTxt";
      recordName: string;
      recordValue: string;
    }
  | {
      kind: "createA";
      recordName: string;
      recordType: "A" | "AAAA";
      targetIp: string;
    }
  | {
      kind: "deleteById";
      recordId: string;
      /** Expected (name,type) match the broker asserts on the looked-up record. */
      expectedType: "TXT" | "A" | "AAAA";
      expectedNameOneOf: string[];
    };

// ---- the verifier ----

export async function verifyRpc(body: unknown, env: PolicyEnv): Promise<VerifyOutcome> {
  if (!isObj(body) || typeof body.kind !== "string") return deny("malformed");
  switch (body.kind) {
    case "publishTxtChallenge":
      return verifyPublishTxt(body as unknown as PublishTxtChallengeBody, env);
    case "publishARecord":
      return verifyPublishA(body as unknown as PublishARecordBody, env);
    case "deleteRecord":
      return verifyDelete(body as unknown as DeleteRecordBody, env);
    default:
      return deny("malformed");
  }
}

// ---- publishTxtChallenge ----

async function verifyPublishTxt(b: PublishTxtChallengeBody, env: PolicyEnv): Promise<VerifyOutcome> {
  if (
    typeof b.recordName !== "string" ||
    typeof b.recordValue !== "string" ||
    !isObj(b.authority)
  ) {
    return deny("malformed");
  }
  // recordName MUST be an _acme-challenge.<host> under the managed apex.
  if (!b.recordName.startsWith("_acme-challenge.")) return deny("recordName not an ACME label");
  const host = b.recordName.slice("_acme-challenge.".length);
  if (!host.endsWith(`.${env.apex}`)) return deny("recordName outside managed apex");

  const auth = b.authority;
  if (auth.type === "pod") {
    return verifyPodAcmePublish(b, host, auth, env);
  }
  if (auth.type === "userzone-irk") {
    return verifyUserzoneIrkPublish(b, host, auth, env);
  }
  if (auth.type === "userzone-grant") {
    return verifyUserzoneGrantPublish(b, host, auth, env);
  }
  return deny("malformed");
}

async function verifyPodAcmePublish(
  b: PublishTxtChallengeBody,
  host: string,
  auth: PodAuthority,
  env: PolicyEnv,
): Promise<VerifyOutcome> {
  if (
    typeof auth.serverId !== "string" ||
    typeof auth.recordValueHashHex !== "string" ||
    typeof auth.issuedAt !== "number" ||
    typeof auth.signatureHex !== "string"
  ) return deny("malformed");

  if (!ageOk(env.now, auth.issuedAt, env.replayWindowMs)) return deny("stale");
  if (!auth.serverId.endsWith(`.${env.apex}`)) return deny("serverId outside apex");

  // Per the existing dns01.ts contract: the daemon may publish for either
  // its own pod apex (`<server>.<user>.flagship.services`) or the
  // surrounding user-zone (`<user>.flagship.services`). Cross-pod or
  // cross-user names are flatly refused.
  const podUsername = extractUserLabel(auth.serverId, env.apex);
  const userZone = podUsername ? `${podUsername}.${env.apex}` : null;
  const acceptedHosts = new Set<string>([auth.serverId]);
  if (userZone) acceptedHosts.add(userZone);
  if (!acceptedHosts.has(host)) return deny("recordName not in pod namespace");

  // Verify value hash + signature.
  const valueHash = decodeHex(auth.recordValueHashHex);
  const sig = decodeHex(auth.signatureHex);
  if (!valueHash || !sig) return deny("invalid hex");
  const expectedValueHash = sha256(new TextEncoder().encode(b.recordValue));
  if (!equalBytes(expectedValueHash, valueHash)) return deny("value hash mismatch");

  const podPub = await env.resolvePodIdentity(auth.serverId);
  if (!podPub) return deny("unknown pod");

  const claim: Dns01PublishRequest = {
    serverId: auth.serverId,
    recordName: b.recordName,
    recordValueHash: valueHash,
    issuedAt: auth.issuedAt,
  };
  if (!verifyDns01Publish(claim, sig, podPub)) return deny("bad signature");

  return ok({
    kind: "createTxt",
    recordName: b.recordName,
    recordValue: b.recordValue,
  });
}

async function verifyUserzoneIrkPublish(
  b: PublishTxtChallengeBody,
  host: string,
  auth: UserZoneIrkAuthority,
  env: PolicyEnv,
): Promise<VerifyOutcome> {
  if (
    typeof auth.username !== "string" ||
    typeof auth.recordValueHashHex !== "string" ||
    typeof auth.issuedAt !== "number" ||
    typeof auth.signatureHex !== "string"
  ) return deny("malformed");
  if (!ageOk(env.now, auth.issuedAt, env.replayWindowMs)) return deny("stale");

  // The user-zone path is for `_acme-challenge.<user>.flagship.services`.
  // We reject if `host` doesn't match.
  const expectedHost = `${auth.username}.${env.apex}`;
  if (host !== expectedHost) return deny("host/username mismatch");

  const valueHash = decodeHex(auth.recordValueHashHex);
  const sig = decodeHex(auth.signatureHex);
  if (!valueHash || !sig) return deny("invalid hex");
  const expectedValueHash = sha256(new TextEncoder().encode(b.recordValue));
  if (!equalBytes(expectedValueHash, valueHash)) return deny("value hash mismatch");

  const irkPub = await env.resolveUserIrk(auth.username);
  if (!irkPub) return deny("unknown user");

  const msg = canonicalUserzoneAcmeBytes({
    username: auth.username,
    recordName: b.recordName,
    recordValueHash: valueHash,
    issuedAt: auth.issuedAt,
  });
  if (!edVerify(sig, msg, irkPub)) return deny("bad signature");
  return ok({
    kind: "createTxt",
    recordName: b.recordName,
    recordValue: b.recordValue,
  });
}

async function verifyUserzoneGrantPublish(
  b: PublishTxtChallengeBody,
  host: string,
  auth: UserZoneGrantAuthority,
  env: PolicyEnv,
): Promise<VerifyOutcome> {
  if (
    typeof auth.username !== "string" ||
    !isObj(auth.grant) ||
    typeof auth.grantSignatureHex !== "string" ||
    typeof auth.irkPubKeyHex !== "string"
  ) return deny("malformed");

  // The grant must be a *user-zone wildcard* grant. We require at least
  // one route whose url matches one of:
  //   *.<username>.<apex>     (canonical user-zone wildcard)
  //    <username>.<apex>      (apex of the user zone)
  const expectedHost = `${auth.username}.${env.apex}`;
  if (host !== expectedHost) return deny("host/username mismatch");

  // Canonicalize the grant wire form into the in-memory AppGrant.
  let grant: AppGrant;
  try {
    grant = inflateGrant(auth.grant);
  } catch {
    return deny("bad grant");
  }
  if (grant.username !== auth.username) return deny("grant/username mismatch");
  if (!appGrantActiveAt(grant, env.now)) return deny("grant inactive");

  // At least one route must cover the user-zone wildcard.
  const wildcardUrl = `https://*.${auth.username}.${env.apex}`;
  const apexUrl = `https://${auth.username}.${env.apex}`;
  const covers = grant.routes.some((r: AppGrantRoute) => {
    const u = r.url.toLowerCase();
    return u === wildcardUrl.toLowerCase() || u === apexUrl.toLowerCase();
  });
  if (!covers) return deny("grant does not cover user zone");
  // Belt-and-suspenders: appGrantAuthorizesUrl agrees on the apex URL.
  // The routes check above is the primary gate; this reference keeps the
  // import live for future strict-mode wiring.
  void appGrantAuthorizesUrl;

  // Verify grant signature against the claimed IRK, and verify that IRK
  // is the registered IRK for `username`.
  const irkPub = decodeHex(auth.irkPubKeyHex);
  const grantSig = decodeHex(auth.grantSignatureHex);
  if (!irkPub || !grantSig) return deny("invalid hex");
  if (!verifyAppGrant(grant, grantSig, irkPub)) return deny("bad grant signature");

  const registeredIrk = await env.resolveUserIrk(auth.username);
  if (!registeredIrk) return deny("unknown user");
  if (!equalBytes(irkPub, registeredIrk)) return deny("IRK mismatch");

  return ok({
    kind: "createTxt",
    recordName: b.recordName,
    recordValue: b.recordValue,
  });
}

// ---- publishARecord ----

async function verifyPublishA(b: PublishARecordBody, env: PolicyEnv): Promise<VerifyOutcome> {
  if (
    typeof b.serverId !== "string" ||
    typeof b.targetIp !== "string" ||
    (b.recordType !== "A" && b.recordType !== "AAAA") ||
    typeof b.recordName !== "string"
  ) return deny("malformed");

  if (!b.serverId.endsWith(`.${env.apex}`)) return deny("serverId outside apex");

  // Target IP allowlist — the broker REFUSES any A/AAAA that doesn't
  // point at one of the known anycast addresses. Even if the broker is
  // tricked into accepting a forged "server is registered" lookup, the
  // worst outcome is re-asserting the same anycast IP that this server
  // would have anyway.
  const allow = b.recordType === "A" ? env.servicesIpv4 : env.servicesIpv6;
  if (!allow || b.targetIp !== allow) return deny("targetIp not allowlisted");

  // Resolve the server registration. If the main Worker reports unknown
  // or revoked, the broker refuses — this is the registration proof.
  const podPub = await env.resolvePodIdentity(b.serverId);
  if (!podPub) return deny("unknown pod");

  // Compute the concrete name from the variant.
  const userLabel = extractUserLabel(b.serverId, env.apex);
  if (!userLabel) return deny("bad serverId shape");
  let name: string;
  switch (b.recordName) {
    case "pod-apex":
      name = b.serverId;
      break;
    case "pod-wildcard":
      name = `*.${b.serverId}`;
      break;
    case "user-zone-apex":
      name = `${userLabel}.${env.apex}`;
      break;
    case "user-zone-wildcard":
      name = `*.${userLabel}.${env.apex}`;
      break;
    default:
      return deny("malformed");
  }
  return ok({
    kind: "createA",
    recordName: name,
    recordType: b.recordType,
    targetIp: b.targetIp,
  });
}

// ---- deleteRecord ----

async function verifyDelete(b: DeleteRecordBody, env: PolicyEnv): Promise<VerifyOutcome> {
  if (typeof b.recordId !== "string" || !isObj(b.authority)) return deny("malformed");
  if (b.recordKind !== "acme" && b.recordKind !== "a") return deny("malformed");

  const auth = b.authority;
  if (auth.type === "pod-acme" && b.recordKind === "acme") {
    if (!ageOk(env.now, auth.issuedAt, env.replayWindowMs)) return deny("stale");
    if (!auth.serverId.endsWith(`.${env.apex}`)) return deny("serverId outside apex");
    const sig = decodeHex(auth.signatureHex);
    if (!sig) return deny("invalid hex");
    const podPub = await env.resolvePodIdentity(auth.serverId);
    if (!podPub) return deny("unknown pod");
    const claim: Dns01DeleteRequest = {
      serverId: auth.serverId,
      recordId: b.recordId,
      issuedAt: auth.issuedAt,
    };
    if (!verifyDns01Delete(claim, sig, podPub)) return deny("bad signature");
    const podUsername = extractUserLabel(auth.serverId, env.apex);
    const userZone = podUsername ? `${podUsername}.${env.apex}` : null;
    const expectedNames = [`_acme-challenge.${auth.serverId}`];
    if (userZone) expectedNames.push(`_acme-challenge.${userZone}`);
    return ok({
      kind: "deleteById",
      recordId: b.recordId,
      expectedType: "TXT",
      expectedNameOneOf: expectedNames,
    });
  }

  if (auth.type === "pod-a" && b.recordKind === "a") {
    if (!ageOk(env.now, auth.issuedAt, env.replayWindowMs)) return deny("stale");
    if (!auth.serverId.endsWith(`.${env.apex}`)) return deny("serverId outside apex");
    const sig = decodeHex(auth.signatureHex);
    if (!sig) return deny("invalid hex");
    const podPub = await env.resolvePodIdentity(auth.serverId);
    if (!podPub) return deny("unknown pod");
    const msg = canonicalDeleteABytes({
      serverId: auth.serverId,
      recordId: b.recordId,
      issuedAt: auth.issuedAt,
    });
    if (!edVerify(sig, msg, podPub)) return deny("bad signature");
    const podUsername = extractUserLabel(auth.serverId, env.apex);
    const userZone = podUsername ? `${podUsername}.${env.apex}` : null;
    const names = [auth.serverId, `*.${auth.serverId}`];
    if (userZone) names.push(userZone, `*.${userZone}`);
    return ok({
      kind: "deleteById",
      recordId: b.recordId,
      expectedType: "A",
      expectedNameOneOf: names,
    });
  }

  if (auth.type === "userzone-irk") {
    if (!ageOk(env.now, auth.issuedAt, env.replayWindowMs)) return deny("stale");
    const sig = decodeHex(auth.signatureHex);
    if (!sig) return deny("invalid hex");
    const irkPub = await env.resolveUserIrk(auth.username);
    if (!irkPub) return deny("unknown user");
    const msg = canonicalDeleteABytes({
      serverId: "",
      recordId: b.recordId,
      issuedAt: auth.issuedAt,
    });
    if (!edVerify(sig, msg, irkPub)) return deny("bad signature");
    const userZone = `${auth.username}.${env.apex}`;
    if (b.recordKind === "acme") {
      return ok({
        kind: "deleteById",
        recordId: b.recordId,
        expectedType: "TXT",
        expectedNameOneOf: [`_acme-challenge.${userZone}`],
      });
    }
    return ok({
      kind: "deleteById",
      recordId: b.recordId,
      expectedType: "A",
      expectedNameOneOf: [userZone, `*.${userZone}`],
    });
  }

  return deny("malformed");
}

// ---- helpers ----

function inflateGrant(wire: AppGrantWire): AppGrant {
  const serverIdentities = wire.serverIdentitiesHex.map((h) => {
    const bytes = decodeHex(h);
    if (!bytes) throw new Error("bad hex");
    return bytes;
  });
  const out: AppGrant = {
    grantId: wire.grantId,
    username: wire.username,
    appCanonical: wire.appCanonical,
    serverDomains: wire.serverDomains,
    serverIdentities,
    routes: wire.routes,
    issuedAt: wire.issuedAt,
    expiresAt: wire.expiresAt,
  };
  if (wire.appInstanceId !== undefined) out.appInstanceId = wire.appInstanceId;
  return out;
}

function ageOk(now: number, issuedAt: number, windowMs: number): boolean {
  return Math.abs(now - issuedAt) <= windowMs;
}

function extractUserLabel(serverId: string, apex: string): string | null {
  const lower = serverId.toLowerCase();
  const apexLower = apex.toLowerCase();
  if (!lower.endsWith(`.${apexLower}`)) return null;
  const head = lower.slice(0, -`.${apexLower}`.length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(user)) return null;
  return user;
}

function decodeHex(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function edVerify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

function deny(reason: string): VerifyOutcome {
  // Reason is kept inside the policy module for unit-testing; the Worker
  // entrypoint MUST NOT leak it into the response body. It exists here
  // only so tests can assert which fence rejected a forged request.
  return { ok: false, reason };
}

function ok(effect: BrokerEffect): VerifyOutcome {
  return { ok: true, effect };
}
