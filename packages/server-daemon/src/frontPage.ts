import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyPhoneOrder, type AdminGrantView, type PhoneOrder } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

/**
 * Owner-assignable apex ("front page") — the box's root domain 302s to one
 * of its installed services' tier-1 canonical (`https://<label>.<fqdn>/`),
 * or serves the default Flagship page when unassigned.
 *
 * A REDIRECT, deliberately not serve-in-place: every app keeps exactly one
 * origin (no split cookie jars / service-worker zombies when the owner
 * reassigns), and the URL bar lands on the tier-1 canonical — the pinned
 * trust tier. 302 + no-store, never 301: browsers cache permanent redirects
 * past the owner's change of mind.
 *
 * Set via `POST /api/front-page`, an `{ request, signature }` envelope
 * whose request is the `set-front-page` PhoneOrder, verified against the
 * box's config-pinned owner IRK — the same owner-IRK path as `/api/power`
 * (NOT the dead PSK/orders surface). The redirect itself only intercepts
 * GET/HEAD on "/" for the apex host, so the phone's pinned `/api/*` pipe
 * is untouchable by construction.
 */

const H = { "content-type": "application/json" };

/** One small persisted value, atomically replaced (deadman.json pattern). */
export class FrontPageStore {
  private label: string | null = null;
  private readonly statePath: string;

  constructor(statePath = "/var/flagship/front-page.json") {
    this.statePath = statePath;
  }

  /** Best-effort load — absent/corrupt state means "unassigned". */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as { label?: unknown };
      this.label = typeof raw.label === "string" && raw.label.length > 0 ? raw.label : null;
    } catch {
      this.label = null;
    }
  }

  get(): string | null {
    return this.label;
  }

  async set(label: string | null): Promise<void> {
    this.label = label && label.length > 0 ? label : null;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ label: this.label }), { mode: 0o644 });
    await rename(tmp, this.statePath);
  }
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface FrontPageHttpOptions {
  /** The box fqdn — both the order's serverId and the apex host to match. */
  serverId: string;
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the set-front-page order is gated by `requireMasterAdmin`, absent
   *  ⇒ legacy owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** This box's owner account (cfg.userId) — for the delegated-grant check. */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  store: FrontPageStore;
  /** Whether a service with this url-label is currently installed. */
  resolveLabel: (label: string) => boolean;
  now?: () => number;
  /** Replay window for `issuedAt`. Default 5 min — mirrors /api/power. */
  maxAgeMs?: number;
}

export function buildFrontPageHttp(opts: FrontPageHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path === "/api/front-page") {
      if (req.method === "GET") {
        const label = opts.store.get();
        return {
          status: 200,
          headers: H,
          body: JSON.stringify({
            label,
            active: label !== null && opts.resolveLabel(label),
          }),
        };
      }
      if (req.method !== "POST") {
        return { status: 405, headers: H, body: JSON.stringify({ error: "method not allowed" }) };
      }
      return handleSet(req);
    }

    // Apex redirect — browsing surface only (GET/HEAD on "/"), and only for
    // the apex host: a LAN-IP or fallen-through-label request keeps the
    // default page, and /api/* never reaches this branch.
    if ((req.path === "/" || req.path === "") && (req.method === "GET" || req.method === "HEAD")) {
      const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
      if (host !== opts.serverId.toLowerCase()) return null;
      const label = opts.store.get();
      // An assigned-but-uninstalled label falls back to the default page
      // rather than 302ing into a "no such app" error.
      if (label === null || !opts.resolveLabel(label)) return null;
      return {
        status: 302,
        headers: {
          location: `https://${label}.${opts.serverId}/`,
          "cache-control": "no-store",
          "content-type": "text/plain",
        },
        body: `redirecting to https://${label}.${opts.serverId}/`,
      };
    }

    return null;
  };

  async function handleSet(req: HttpRequest): Promise<HttpResponse> {
    let env: { request?: Record<string, unknown>; signature?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8"));
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid json" }) };
    }
    const r = env.request;
    if (!r || typeof r !== "object" || typeof env.signature !== "string") {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed body" }) };
    }
    const order = parseSetFrontPage(r);
    if (!order) {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed set-front-page order" }) };
    }
    if (order.serverId !== opts.serverId) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "serverId mismatch" }) };
    }
    if (Math.abs(now() - order.issuedAt) > maxAgeMs) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "stale request" }) };
    }
    if (order.label !== "" && !DNS_LABEL.test(order.label)) {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid label" }) };
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid signature hex" }) };
    }
    if (
      !authorizeSensitiveOrder({
        order,
        signature: sig,
        verify: verifyPhoneOrder,
        ownerIrkPub: opts.ownerIrkPub,
        adminRootPub: opts.adminRootPub,
        username: opts.username ?? "",
        activeGrants: opts.activeGrants,
      })
    ) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "invalid signature" }) };
    }
    if (order.label !== "" && !opts.resolveLabel(order.label)) {
      return { status: 422, headers: H, body: JSON.stringify({ error: "unknown service label" }) };
    }
    await opts.store.set(order.label === "" ? null : order.label);
    return { status: 200, headers: H, body: JSON.stringify({ ok: true, label: opts.store.get() }) };
  }
}

function parseSetFrontPage(
  r: Record<string, unknown>,
): Extract<PhoneOrder, { type: "set-front-page" }> | null {
  if (
    r.type !== "set-front-page" ||
    typeof r.serverId !== "string" ||
    typeof r.label !== "string" ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return { type: "set-front-page", serverId: r.serverId, label: r.label, issuedAt: r.issuedAt };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
