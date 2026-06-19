/**
 * Per-service access gating on the box (docs/service-access-gating.md).
 *
 * Each installed service has an `access.mode ∈ {open, restricted}` (default
 * `open` — no behavior change for existing services). A `restricted` service
 * serves only visitors who present an AID-signed visit proof whose stable AID
 * (`deriveAccountId(UMK)`) is in the service's allow-list. The allow-list is
 * populated when a friend REDEEMS a capability invite against the box:
 *
 *   friend → box  POST /api/service-invites/redeem { secretHash, visitorAID, aidSig, redeemedAt }
 *     1. box verifies the friend's AID signature over the redeem,
 *     2. box calls `.com` POST /api/service-invites/redeem (first-bind /
 *        same-AID-idempotent / reject-different-AID — `.com` is the authority
 *        on the binding), and on success
 *     3. box adds boundAID to the local allow-list for the returned serviceRef.
 *
 * The mode + allow-list persist in one atomically-replaced JSON file (the
 * deadman.json / front-page.json pattern). The owner sets the mode with an
 * IRK-signed `set-service-access-mode` envelope over the box's OWN pinned pipe
 * (the `/api/power` shape — NOT the dead PSK orders surface); flagshipserver.com
 * is never in that path.
 *
 * Enforcement is exposed two ways: `decide(serviceRef, req)` for the serve path
 * to consult (a restricted service with no/invalid/foreign proof is denied),
 * and a pre-handler (`enforcementHandler`) that fronts the per-service reverse
 * proxy. The household-key bundle decrypt is a box-side helper, available only
 * when the household key has been provisioned to the box.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  openInviteBundle,
  serviceInviteSecretHash,
  verifyRedeemServiceInvite,
  verifyServiceVisitProof,
  verifySetServiceAccessMode,
  type InviteBundle,
  type ServiceAccessMode,
  type ServiceVisitProof,
  type SetServiceAccessMode,
} from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const H = { "content-type": "application/json" };

/** Header a restricted-service visitor presents the AID-signed proof under. */
export const VISIT_PROOF_HEADER = "x-flagship-visit";

interface ServiceAccessEntry {
  mode: ServiceAccessMode;
  /** Lower-hex bound AIDs allowed to reach a restricted service. */
  allow: string[];
}

type PersistShape = Record<string, ServiceAccessEntry>;

/**
 * Persisted per-service access state — mode + AID allow-list. Default mode is
 * `open`, so a service with no row behaves exactly as before this feature.
 */
export class ServiceAccessStore {
  private byService = new Map<string, ServiceAccessEntry>();
  private readonly statePath: string;

  constructor(statePath = "/var/flagship/service-access.json") {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as PersistShape;
      this.byService.clear();
      for (const [ref, e] of Object.entries(raw ?? {})) {
        if (!e || (e.mode !== "open" && e.mode !== "restricted")) continue;
        const allow = Array.isArray(e.allow)
          ? e.allow.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase())
          : [];
        this.byService.set(ref, { mode: e.mode, allow: [...new Set(allow)] });
      }
    } catch {
      // Absent / corrupt → everything defaults to open (fail-open: this
      // feature must never make an existing OPEN service unreachable).
      this.byService.clear();
    }
  }

  mode(serviceRef: string): ServiceAccessMode {
    return this.byService.get(serviceRef)?.mode ?? "open";
  }

  isAllowed(serviceRef: string, visitorAidHex: string): boolean {
    const e = this.byService.get(serviceRef);
    if (!e) return false; // only relevant when restricted; no row ⇒ no allow-list
    return e.allow.includes(visitorAidHex.toLowerCase());
  }

  allowList(serviceRef: string): string[] {
    return [...(this.byService.get(serviceRef)?.allow ?? [])];
  }

  private entry(serviceRef: string): ServiceAccessEntry {
    let e = this.byService.get(serviceRef);
    if (!e) {
      e = { mode: "open", allow: [] };
      this.byService.set(serviceRef, e);
    }
    return e;
  }

  async setMode(serviceRef: string, mode: ServiceAccessMode): Promise<void> {
    this.entry(serviceRef).mode = mode;
    await this.persist();
  }

  /** Add an AID to a service's allow-list (idempotent). Returns whether it was new. */
  async addAllowed(serviceRef: string, visitorAidHex: string): Promise<boolean> {
    const e = this.entry(serviceRef);
    const aid = visitorAidHex.toLowerCase();
    if (e.allow.includes(aid)) return false;
    e.allow.push(aid);
    await this.persist();
    return true;
  }

  /** Remove an AID from a service's allow-list (idempotent). */
  async removeAllowed(serviceRef: string, visitorAidHex: string): Promise<boolean> {
    const e = this.byService.get(serviceRef);
    if (!e) return false;
    const aid = visitorAidHex.toLowerCase();
    const before = e.allow.length;
    e.allow = e.allow.filter((x) => x !== aid);
    if (e.allow.length === before) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const out: PersistShape = {};
    for (const [ref, e] of this.byService) out[ref] = { mode: e.mode, allow: e.allow };
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

export type AccessDecision =
  | { allow: true; reason: "open" | "allow-listed" }
  | { allow: false; reason: "no-proof" | "bad-proof" | "not-allowed" | "stale-proof" };

export interface ServiceAccessHttpOptions {
  /** The box fqdn — the `serverId` the owner/visitor envelopes are bound to. */
  serverId: string;
  ownerIrkPub: Uint8Array;
  store: ServiceAccessStore;
  /** Resolve `serviceRef` (`<creator>-<slug>`) → installed? Guards set-mode (422 if not). */
  serviceInstalled: (serviceRef: string) => boolean;
  /** Base URL of the control plane the box redeems against. */
  controlPlaneBaseUrl: string;
  /** Injectable fetch (defaults to global). */
  fetchImpl?: typeof fetch;
  /**
   * Household key provisioned to the box over its pinned pipe (UMK-derived;
   * flagshipserver.com never holds it). When present, the box can decrypt the
   * invite bundle (`{name, photo?}`) it stores as ciphertext. Optional — when
   * absent, `decryptBundle` returns null (the feature degrades, like SWK).
   */
  householdKey?: Uint8Array;
  now?: () => number;
  /** Replay window for owner + visit + redeem envelopes. Default 5 min. */
  maxAgeMs?: number;
}

/**
 * The serve-path decision: is this request allowed to reach `serviceRef`?
 * `open` ⇒ always; `restricted` ⇒ the request MUST carry a fresh AID-signed
 * visit proof (header `x-flagship-visit`) for an allow-listed AID.
 */
export function decideServiceAccess(
  opts: Pick<ServiceAccessHttpOptions, "serverId" | "store"> & { now?: () => number; maxAgeMs?: number },
  serviceRef: string,
  req: HttpRequest,
): AccessDecision {
  if (opts.store.mode(serviceRef) === "open") return { allow: true, reason: "open" };
  const now = (opts.now ?? (() => Date.now()))();
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;

  const header = req.headers[VISIT_PROOF_HEADER];
  if (typeof header !== "string" || header.length === 0) return { allow: false, reason: "no-proof" };
  let parsed: { proof: ServiceVisitProof; sig: Uint8Array } | null;
  try {
    parsed = parseVisitHeader(header);
  } catch {
    parsed = null;
  }
  if (!parsed) return { allow: false, reason: "bad-proof" };
  const { proof, sig } = parsed;
  if (proof.serverId !== opts.serverId || proof.serviceRef !== serviceRef) {
    return { allow: false, reason: "bad-proof" };
  }
  if (Math.abs(now - proof.issuedAt) > maxAgeMs) return { allow: false, reason: "stale-proof" };
  if (!verifyServiceVisitProof(proof, sig, proof.visitorAID)) {
    return { allow: false, reason: "bad-proof" };
  }
  if (!opts.store.isAllowed(serviceRef, bytesToHex(proof.visitorAID))) {
    return { allow: false, reason: "not-allowed" };
  }
  return { allow: true, reason: "allow-listed" };
}

export interface ServiceAccessHttp {
  /** Pre-handler chain entry: serves `/api/service-access` + `/api/service-invites/redeem`. */
  handle: (req: HttpRequest) => Promise<HttpResponse | null>;
  /** Serve-path guard the per-service proxy calls before forwarding. */
  decide: (serviceRef: string, req: HttpRequest) => AccessDecision;
  /**
   * Decrypt an invite's `{name, photo?}` bundle with the provisioned household
   * key, or null when no household key is provisioned / the ciphertext is bad.
   */
  decryptBundle: (encryptedBundleHex: string, inviteId: string) => InviteBundle | null;
  store: ServiceAccessStore;
}

export function buildServiceAccessHttp(opts: ServiceAccessHttpOptions): ServiceAccessHttp {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const decide = (serviceRef: string, req: HttpRequest): AccessDecision =>
    decideServiceAccess({ serverId: opts.serverId, store: opts.store, now, maxAgeMs }, serviceRef, req);

  const decryptBundle = (encryptedBundleHex: string, inviteId: string): InviteBundle | null => {
    if (!opts.householdKey) return null;
    try {
      return openInviteBundle(encryptedBundleHex, opts.householdKey, inviteId);
    } catch {
      return null;
    }
  };

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path === "/api/service-access" && req.method === "POST") {
      return handleSetMode(req);
    }
    if (req.path === "/api/service-invites/redeem" && req.method === "POST") {
      return handleRedeem(req);
    }
    return null;
  }

  async function handleSetMode(req: HttpRequest): Promise<HttpResponse> {
    const env = parseEnvelope(req);
    if (!env) return bad(400, "malformed body");
    const order = parseSetMode(env.request);
    if (!order) return bad(400, "malformed set-service-access-mode order");
    if (order.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - order.issuedAt) > maxAgeMs) return bad(403, "stale request");
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return bad(400, "invalid signature hex");
    }
    if (!verifySetServiceAccessMode(order, sig, opts.ownerIrkPub)) {
      return bad(403, "invalid signature");
    }
    if (!opts.serviceInstalled(order.serviceRef)) {
      return bad(422, "unknown service");
    }
    await opts.store.setMode(order.serviceRef, order.mode);
    return jsonResponse(200, {
      ok: true,
      serviceRef: order.serviceRef,
      mode: opts.store.mode(order.serviceRef),
    });
  }

  async function handleRedeem(req: HttpRequest): Promise<HttpResponse> {
    let body: {
      secret?: unknown;
      secretHash?: unknown;
      visitorAID?: unknown;
      aidSig?: unknown;
      redeemedAt?: unknown;
    };
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return bad(400, "invalid json");
    }
    // The box accepts EITHER the raw 32-byte secret (then hashes it) or the
    // hash directly. The friend's AID sig is over { secretHash, visitorAID,
    // redeemedAt } regardless.
    let secretHash: string;
    if (typeof body.secret === "string" && /^[0-9a-f]{64}$/i.test(body.secret)) {
      secretHash = serviceInviteSecretHash(hexToBytes(body.secret));
    } else if (typeof body.secretHash === "string" && /^[0-9a-f]{64}$/i.test(body.secretHash)) {
      secretHash = body.secretHash.toLowerCase();
    } else {
      return bad(400, "secret or secretHash required");
    }
    if (
      typeof body.visitorAID !== "string" ||
      !/^[0-9a-f]{64}$/i.test(body.visitorAID) ||
      typeof body.aidSig !== "string" ||
      !/^[0-9a-f]{128}$/i.test(body.aidSig) ||
      typeof body.redeemedAt !== "number"
    ) {
      return bad(400, "malformed redeem body");
    }
    if (Math.abs(now() - body.redeemedAt) > maxAgeMs) return bad(403, "stale request");

    const visitorAID = body.visitorAID.toLowerCase();
    // Verify the friend controls visitorAID BEFORE calling .com (so the box is
    // not a confused deputy binding a victim's AID to a held secret).
    const proofOk = verifyServiceVisitRedeem(secretHash, visitorAID, body.redeemedAt, body.aidSig);
    if (!proofOk) return bad(403, "invalid AID signature");

    // Delegate the binding decision to `.com` (the authority on first-bind /
    // same-AID-idempotent / reject-different-AID).
    let comRes: Response;
    try {
      comRes = await fetchImpl(`${opts.controlPlaneBaseUrl}/api/service-invites/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secretHash, visitorAID, aidSig: body.aidSig, redeemedAt: body.redeemedAt }),
      } as RequestInit);
    } catch {
      return bad(502, "control plane unreachable");
    }
    if (comRes.status === 404) return bad(404, "unknown invite");
    if (comRes.status === 409) return bad(409, "already bound to another account");
    if (comRes.status === 403) return bad(403, "invite revoked");
    if (!comRes.ok) return bad(502, "redeem rejected upstream");

    let comBody: { serviceRef?: unknown; boundAID?: unknown; firstBind?: unknown };
    try {
      comBody = (await comRes.json()) as typeof comBody;
    } catch {
      return bad(502, "bad upstream response");
    }
    if (typeof comBody.serviceRef !== "string" || typeof comBody.boundAID !== "string") {
      return bad(502, "incomplete upstream response");
    }
    // The bound AID is the authority's answer; add IT (not the request's claim)
    // to the allow-list, so a `.com` that bound a different AID can't be tricked
    // here. They match on the happy path.
    await opts.store.addAllowed(comBody.serviceRef, comBody.boundAID);
    return jsonResponse(200, {
      redeemed: true,
      firstBind: comBody.firstBind === true,
      serviceRef: comBody.serviceRef,
      boundAID: comBody.boundAID,
    });
  }

  return { handle, decide, decryptBundle, store: opts.store };

  // Local: verify the AID sig over the redeem tuple (mirrors .com's check; the
  // box does it first so it never relays a forged binding request upstream).
  function verifyServiceVisitRedeem(
    secretHash: string,
    visitorAID: string,
    redeemedAt: number,
    aidSigHex: string,
  ): boolean {
    try {
      // Re-verify the friend's AID sig over the SAME RedeemServiceInvite shape
      // `.com` will check, so the box never relays a forged binding upstream.
      return verifyRedeemServiceInvite(
        { secretHash, visitorAID: hexToBytes(visitorAID), redeemedAt },
        hexToBytes(aidSigHex),
        hexToBytes(visitorAID),
      );
    } catch {
      return false;
    }
  }
}

/**
 * Build the enforcement pre-handler for a given service-label resolver. It
 * intercepts requests to a RESTRICTED service and denies (403) those without a
 * valid allow-listed proof; OPEN services + unknown labels fall through
 * (returns null) so the normal serve path handles them.
 *
 * `resolveServiceRef(req)` maps an inbound request to its `<creator>-<slug>`
 * service id (e.g. via the Host/url-label → installed-service lookup), or null
 * if the request isn't targeting a gated service.
 */
export function buildAccessEnforcementHandler(
  access: Pick<ServiceAccessHttp, "decide" | "store">,
  resolveServiceRef: (req: HttpRequest) => string | null,
): (req: HttpRequest) => Promise<HttpResponse | null> {
  return async (req: HttpRequest): Promise<HttpResponse | null> => {
    const serviceRef = resolveServiceRef(req);
    if (!serviceRef) return null;
    if (access.store.mode(serviceRef) === "open") return null;
    const decision = access.decide(serviceRef, req);
    if (decision.allow) return null;
    return {
      status: 403,
      headers: H,
      body: JSON.stringify({ error: "access restricted", reason: decision.reason }),
    };
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function parseEnvelope(req: HttpRequest): { request: Record<string, unknown>; signature: string } | null {
  let env: { request?: unknown; signature?: unknown };
  try {
    env = JSON.parse(req.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!env.request || typeof env.request !== "object" || typeof env.signature !== "string") {
    return null;
  }
  return { request: env.request as Record<string, unknown>, signature: env.signature };
}

function parseSetMode(r: Record<string, unknown>): SetServiceAccessMode | null {
  if (
    typeof r.serverId !== "string" ||
    typeof r.serviceRef !== "string" ||
    (r.mode !== "open" && r.mode !== "restricted") ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return { serverId: r.serverId, serviceRef: r.serviceRef, mode: r.mode, issuedAt: r.issuedAt };
}

/** The visit header is `base64(JSON({ proof, sig }))`. */
function parseVisitHeader(header: string): { proof: ServiceVisitProof; sig: Uint8Array } | null {
  const json = Buffer.from(header, "base64").toString("utf8");
  const obj = JSON.parse(json) as { proof?: Record<string, unknown>; sig?: unknown };
  const p = obj.proof;
  if (
    !p ||
    typeof p.serverId !== "string" ||
    typeof p.serviceRef !== "string" ||
    typeof p.visitorAID !== "string" ||
    !/^[0-9a-f]{64}$/i.test(p.visitorAID) ||
    typeof p.issuedAt !== "number" ||
    typeof obj.sig !== "string" ||
    !/^[0-9a-f]{128}$/i.test(obj.sig)
  ) {
    return null;
  }
  return {
    proof: {
      serverId: p.serverId,
      serviceRef: p.serviceRef,
      visitorAID: hexToBytes(p.visitorAID),
      issuedAt: p.issuedAt,
    },
    sig: hexToBytes(obj.sig),
  };
}

function bad(status: number, error: string): HttpResponse {
  return { status, headers: H, body: JSON.stringify({ error }) };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: H, body: JSON.stringify(body) };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
