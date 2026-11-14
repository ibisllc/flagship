/**
 * Direct access, the box's half (docs/direct-access-and-domains.md §1, §5, §6 steps 1-2).
 *
 * The owner's admin device signs a `flagship/direct-access/v1` order (protocol/directAccess.ts)
 * naming the public addresses the box may be reached at, and the ranges inside which the box may
 * report its own address. Nothing here happens without that order:
 *
 *   - the public listener binds only interface addresses the order allows, on the order's port,
 *     and is the same byte forwarder LAN-direct uses (lanDirect.ts): every connection goes into
 *     the loopback TLS server the tunnel feeds, so certificates, SNI routing, auth and app access
 *     are unchanged. It never marks a connection as LAN (rescue stays LAN-only);
 *   - the v2 hint lists public endpoints only inside the order, and carries the order so a device
 *     can verify it under the owner's key before dialing;
 *   - the signed address update names only addresses the order allows.
 *
 * Owner rule (2026-11-08): this is the owner's infrastructure. The box never adds an address the
 * owner didn't grant, never falls back to the relay on a direct name, and never re-points anything
 * when it is down. The relay keeps working regardless; a direct route that fails is a no-op.
 */
import os from "node:os";
import {
  canonicalDirectAccessOrder,
  canonicalDirectNameOrder,
  canonicalIp,
  directAccessOrderProblem,
  directAccessOrderSha256,
  directOrderAllows,
  isPublicAddress,
  parseDirectAccessOrder,
  signDirectAddressUpdate,
  signLanHintV2,
  verifyDirectAccessOrder,
  verifyDirectNameOrder,
  DIRECT_MAX_ADDRESSES,
  LAN_HINT_MAX_ENDPOINTS,
  LAN_HINT_MAX_TTL_MS,
  type AdminGrantView,
  type DirectAccessOrder,
  type DirectAddressUpdate,
  type DirectNameOrder,
  type LanEndpoint,
  type LanHintV2,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";
import { languageFor, t } from "./i18n/index.js";
import { leafCertSha256, startLanListener, type LanListener } from "./lanDirect.js";
import { hybridOrderSignature } from "./pqAuthority.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import { trustedNow } from "./trustedClock.js";

export const DIRECT_ACCESS_PATH = "/api/screens/direct-access";
export const DIRECT_ADDRESS_PATH = "/api/screens/direct-access/address";
export const LAN_HINT_V2_PATH = "/api/screens/lan-hint/v2";

/** Interfaces whose public-looking addresses are not the box's own uplink (containers, VPNs). */
const VIRTUAL_IFACE = /^(docker|br-|fs-|veth|virbr|vnet|vmnet|cni|flannel|cali|lxc|lxd|podman|tailscale|wg|tun|tap|zt|utun)/i;

/** The box's public interface addresses, canonical text (what an ISP gave a home box, or a VPS its own). */
export function publicInterfaceAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, infos] of Object.entries(ifaces)) {
    if (!infos || VIRTUAL_IFACE.test(name)) continue;
    for (const i of infos) {
      if (i.internal) continue;
      const c = canonicalIp(i.address);
      if (c && isPublicAddress(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

export interface DirectAuthority {
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username: string;
  activeGrants?: readonly AdminGrantView[];
}

export interface DirectAccessView {
  on: boolean;
  addresses: string[];
  prefixes: string[];
  port: number | null;
  issuedAt: number | null;
  /** Where the box can be reached right now: the order's addresses plus its own inside the order's prefixes. */
  endpoints: LanEndpoint[];
}

interface SignedOrder {
  order: DirectAccessOrder;
  signatureHex: string;
  pqSignature?: unknown;
}

interface DirectAccessState {
  version: 1;
  /** Newest `issuedAt` taken; an order not newer is a replay. */
  floorIssuedAt: number;
  current: SignedOrder | null;
}

export interface DirectAccessOptions {
  serverDomain: string;
  authority: () => DirectAuthority;
  /** `<dataDir>/direct-access.json`. */
  statePath: string;
  /** Box activity: `server.direct-access.{on,changed,off}`. */
  activity?: (kind: string, detail: string) => void;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  now?: () => number;
  /** How far an order may be from the box clock. Default 10 min. */
  maxSkewMs?: number;
  log?: (m: string) => void;
}

export type DirectResult =
  | { ok: true; view: DirectAccessView; change: "on" | "changed" | "off" | "unchanged" }
  | { ok: false; status: number; error: string; code: string };

const HEX_SIG = /^[0-9a-fA-F]{128}$/;

export class DirectAccessController {
  private state: DirectAccessState = { version: 1, floorIssuedAt: 0, current: null };
  private ready: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private lastUpdate: { key: string; update: DirectAddressUpdate; signatureHex: string } | null = null;

  constructor(private readonly opts: DirectAccessOptions) {
    this.now = opts.now ?? trustedNow;
    this.log = opts.log ?? (() => {});
  }

  /** Load the saved order. A damaged file turns direct access off and refuses every order signed before now. Never throws. */
  start(): Promise<void> {
    if (!this.ready) this.ready = this.serial(() => this.load()).catch((e) => this.log(`[direct-access] start failed: ${(e as Error).message}`));
    return this.ready;
  }

  /** Called after every change of the order (the public listener restarts on it). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The order in force, or null when direct access is off. */
  order(): DirectAccessOrder | null {
    const o = this.state.current?.order;
    return o && o.enabled ? o : null;
  }

  /** The order in force with its signature, for a device to verify itself. */
  signedOrder(): { order: DirectAccessOrder; signatureHex: string; pqSignature?: unknown } | null {
    const c = this.state.current;
    return c && c.order.enabled ? { ...c } : null;
  }

  /** Interface addresses the order allows: what the public listener binds. */
  listenAddresses(): string[] {
    const o = this.order();
    if (!o) return [];
    return publicInterfaceAddresses(this.opts.interfaces?.()).filter((a) => directOrderAllows(o, a)).slice(0, DIRECT_MAX_ADDRESSES);
  }

  /** The order's exact addresses plus the box's own addresses inside the order, on the order's port. */
  endpoints(): LanEndpoint[] {
    const o = this.order();
    if (!o) return [];
    const all = [...new Set([...o.addresses, ...this.listenAddresses()])].sort();
    return all.slice(0, DIRECT_MAX_ADDRESSES).map((address) => ({ address, port: o.port }));
  }

  view(): DirectAccessView {
    const o = this.order();
    return {
      on: o !== null,
      addresses: o ? [...o.addresses] : [],
      prefixes: o ? [...o.prefixes] : [],
      port: o ? o.port : null,
      issuedAt: o ? o.issuedAt : null,
      endpoints: this.endpoints(),
    };
  }

  /**
   * The box's signed address update for the order in force, or null when off. Re-signed only when
   * the addresses or the order change, so `issuedAt` moves only with them (a consumer keeps the newest).
   */
  addressUpdate(sign: (msg: Uint8Array) => Uint8Array): { update: DirectAddressUpdate; signatureHex: string } | null {
    const o = this.order();
    const addresses = this.endpoints().map((e) => e.address);
    if (!o || addresses.length === 0) return null;
    const orderSha256 = directAccessOrderSha256(o);
    const key = `${orderSha256}|${addresses.join(",")}`;
    if (this.lastUpdate?.key === key) return { update: this.lastUpdate.update, signatureHex: this.lastUpdate.signatureHex };
    const issuedAt = Math.max(this.now(), (this.lastUpdate?.update.issuedAt ?? 0) + 1);
    const update: DirectAddressUpdate = { serverDomain: this.opts.serverDomain, orderSha256, addresses, port: o.port, issuedAt };
    const signatureHex = Buffer.from(signDirectAddressUpdate(update, sign)).toString("hex");
    this.lastUpdate = { key, update, signatureHex };
    return { update, signatureHex };
  }

  /** An order from an admin device (`{order, signatureHex, pqSignature?}`). */
  async take(body: unknown, lang = "en"): Promise<DirectResult> {
    await this.start();
    return this.serial(() => this.apply(body, lang));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async load(): Promise<void> {
    const read = await readStateFile(this.opts.statePath);
    if (read.kind === "missing") return;
    if (read.kind === "ok") {
      try {
        const s = JSON.parse(read.text) as DirectAccessState;
        if (s && s.version === 1 && typeof s.floorIssuedAt === "number") {
          const current = s.current ? this.reverify(s.current) : null;
          this.state = { version: 1, floorIssuedAt: s.floorIssuedAt, current };
          if (s.current && !current) {
            await this.save();
            this.opts.activity?.("server.direct-access.off", "Direct access turned off: its order no longer verifies under this account's admin key. Turn it on again.");
          }
          return;
        }
        throw new Error("not a direct-access state");
      } catch (e) {
        await keepCorruptAside(this.opts.statePath, e, "Direct access was turned off.");
      }
    } else {
      await keepCorruptAside(this.opts.statePath, read.error, "Direct access was turned off.");
    }
    this.state = { version: 1, floorIssuedAt: this.now(), current: null };
    await this.save();
  }

  /** A saved order is trusted only while it still verifies under today's authority (an admin-root rotation voids it). */
  private reverify(saved: SignedOrder): SignedOrder | null {
    const order = parseDirectAccessOrder(saved.order);
    if (!order || typeof saved.signatureHex !== "string" || !HEX_SIG.test(saved.signatureHex)) return null;
    if (order.serverDomain.toLowerCase() !== this.opts.serverDomain.toLowerCase()) return null;
    return this.authorized(order, saved.signatureHex, saved.pqSignature) ? { ...saved, order } : null;
  }

  /**
   * Whether the owner's `direct-name/v1` order verifies under today's sensitive-order authority, the rule this box
   * applies to its direct-access orders. The box serves a direct name only when this holds (directNames.ts).
   */
  verifyNameOrder(order: DirectNameOrder, signatureHex: string, pqSignature?: unknown): boolean {
    if (!HEX_SIG.test(signatureHex) || order.serverDomain.toLowerCase() !== this.opts.serverDomain.toLowerCase()) return false;
    const a = this.opts.authority();
    try {
      return authorizeSensitiveOrder({
        order,
        signature: Uint8Array.from(Buffer.from(signatureHex, "hex")),
        verify: (o: DirectNameOrder, sig: Uint8Array, pub: Uint8Array) => verifyDirectNameOrder(o, sig, pub),
        ownerIrkPub: a.ownerIrkPub,
        ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
        username: a.username,
        ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
        now: this.now(),
        hybrid: hybridOrderSignature(canonicalDirectNameOrder(order), pqSignature),
      });
    } catch {
      return false;
    }
  }

  private authorized(order: DirectAccessOrder, signatureHex: string, pqSignature: unknown): boolean {
    const a = this.opts.authority();
    try {
      return authorizeSensitiveOrder({
        order,
        signature: Uint8Array.from(Buffer.from(signatureHex, "hex")),
        verify: verifyDirectAccessOrder,
        ownerIrkPub: a.ownerIrkPub,
        ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
        username: a.username,
        ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
        now: this.now(),
        hybrid: hybridOrderSignature(canonicalDirectAccessOrder(order), pqSignature),
      });
    } catch {
      return false;
    }
  }

  private async save(): Promise<void> {
    await writeFileDurable(this.opts.statePath, JSON.stringify(this.state));
  }

  private async apply(body: unknown, lang: string): Promise<DirectResult> {
    const refuse = (status: number, code: string, error: string): DirectResult => ({ ok: false, status, code, error });
    const b = body as { order?: unknown; signatureHex?: unknown; pqSignature?: unknown } | null;
    const order = b && typeof b === "object" ? parseDirectAccessOrder(b.order) : null;
    if (!order || typeof b!.signatureHex !== "string" || !HEX_SIG.test(b!.signatureHex)) {
      return refuse(400, "malformed", t(lang, "That direct access order can't be read."));
    }
    const problem = directAccessOrderProblem(order);
    if (problem === "private-address") {
      return refuse(422, problem, t(lang, "Direct access takes only public addresses. Private, local and reserved addresses can't be used."));
    }
    if (problem) return refuse(422, problem, t(lang, "That direct access order isn't valid ({0}).", problem));
    if (order.serverDomain.toLowerCase() !== this.opts.serverDomain.toLowerCase()) {
      return refuse(422, "wrong-server", t(lang, "That direct access order is for another server."));
    }
    const signatureHex = b!.signatureHex.toLowerCase();
    if (!this.authorized(order, signatureHex, b!.pqSignature)) {
      return refuse(403, "not-admin", t(lang, "This server takes direct access orders only from an admin device of this account."));
    }
    if (order.issuedAt <= this.state.floorIssuedAt) {
      return refuse(409, "replayed", t(lang, "That direct access order is older than the last change. Try again."));
    }
    if (Math.abs(this.now() - order.issuedAt) > (this.opts.maxSkewMs ?? 10 * 60_000)) {
      return refuse(422, "stale", t(lang, "This device's clock is too far from the server's. Check the time and try again."));
    }
    const wasOn = this.order() !== null;
    this.state = {
      version: 1,
      floorIssuedAt: order.issuedAt,
      current: order.enabled
        ? { order, signatureHex, ...(b!.pqSignature !== undefined && b!.pqSignature !== null ? { pqSignature: b!.pqSignature } : {}) }
        : null,
    };
    await this.save();
    this.lastUpdate = null;
    const change = order.enabled ? (wasOn ? "changed" : "on") : wasOn ? "off" : "unchanged";
    if (change !== "unchanged") {
      this.opts.activity?.(
        `server.direct-access.${change}`,
        order.enabled
          ? `Direct access ${wasOn ? "changed" : "turned on"}: ${[...order.addresses, ...order.prefixes].join(", ")} on port ${order.port}.`
          : "Direct access turned off. The relay still reaches this server.",
      );
    }
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        this.log(`[direct-access] change listener failed: ${(e as Error).message}`);
      }
    }
    return { ok: true, view: this.view(), change };
  }
}

/** The v2 hint the paired-device API serves, or null when there is nothing honest to say. */
export function buildSignedLanHintV2(args: {
  serverDomain: string;
  certPem: string | null;
  lan: LanEndpoint[];
  direct: DirectAccessController | null;
  sign: (msg: Uint8Array) => Uint8Array;
  now?: number;
  ttlMs?: number;
}): { hint: LanHintV2; signatureHex: string; directAccess?: { order: DirectAccessOrder; signatureHex: string; pqSignature?: unknown } } | null {
  if (!args.certPem) return null;
  const certSha256 = leafCertSha256(args.certPem);
  if (!certSha256) return null;
  const signed = args.direct?.signedOrder() ?? null;
  const direct = signed ? (args.direct?.endpoints() ?? []) : [];
  const lan = args.lan.slice(0, LAN_HINT_MAX_ENDPOINTS);
  if (lan.length === 0 && direct.length === 0) return null;
  const now = args.now ?? Date.now();
  const hint: LanHintV2 = {
    serverDomain: args.serverDomain,
    certSha256,
    lan,
    direct,
    orderSha256: direct.length > 0 && signed ? directAccessOrderSha256(signed.order) : "",
    issuedAt: now,
    expiresAt: now + Math.min(args.ttlMs ?? 6 * 60 * 60_000, LAN_HINT_MAX_TTL_MS),
  };
  return {
    hint,
    signatureHex: Buffer.from(signLanHintV2(hint, args.sign)).toString("hex"),
    ...(direct.length > 0 && signed ? { directAccess: signed } : {}),
  };
}

/**
 *   GET  /api/screens/direct-access           → DirectAccessView
 *   POST /api/screens/direct-access           {order, signatureHex, pqSignature?} → {ok, change, directAccess}
 *   GET  /api/screens/direct-access/address   → {update, signatureHex, directAccess} | 204 when off
 *   GET  /api/screens/lan-hint/v2             → {hint, signatureHex, directAccess?} | 204
 * A refusal is `{error, code}` with the sentence to show. Companion sessions can't post.
 */
export function buildDirectAccessHttp(deps: {
  controller: DirectAccessController;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
  sign: (msg: Uint8Array) => Uint8Array;
  lanHintV2: () => ReturnType<typeof buildSignedLanHintV2>;
}) {
  const J = { "content-type": "application/json", "cache-control": "no-store" };
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path === LAN_HINT_V2_PATH) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const signed = deps.lanHintV2();
      return signed ? json(200, signed) : { status: 204, headers: {}, body: "" };
    }
    if (path === DIRECT_ADDRESS_PATH) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      await deps.controller.start();
      const u = deps.controller.addressUpdate(deps.sign);
      const signed = deps.controller.signedOrder();
      return u && signed ? json(200, { ...u, directAccess: signed }) : { status: 204, headers: {}, body: "" };
    }
    if (path !== DIRECT_ACCESS_PATH) return null;
    await deps.controller.start();
    if (method === "GET") return json(200, deps.controller.view());
    if (method !== "POST") return json(405, { error: "method not allowed" });
    const denied = deps.denyCompanion(req);
    if (denied) return denied;
    let body: unknown;
    try {
      body = req.body.length === 0 ? null : JSON.parse(req.body.toString("utf-8"));
    } catch {
      return json(400, { error: "body must be JSON", code: "malformed" });
    }
    const r = await deps.controller.take(body, languageFor(req.headers));
    if (!r.ok) return json(r.status, { error: r.error, code: r.code });
    return json(200, { ok: true, change: r.change, directAccess: r.view });
  };
}

/**
 * The public listener: LAN-direct's forwarder bound to the interface addresses the order allows,
 * on the order's port. Restarted when the order changes; rescans every minute for renumbering.
 * Its connections are never recorded as LAN. Failure leaves the box relay-only, as before.
 */
export function startDirectListener(o: {
  controller: DirectAccessController;
  backendPort: number;
  zone: string;
  log?: (m: string) => void;
  rescanMs?: number;
  /** The box's verified direct names (directNames.ts), admitted at the TLS gate besides its own zone. */
  directNames?: () => readonly string[];
}): { close(): Promise<void> } {
  const log = o.log ?? ((m: string) => console.log(`[direct-access] ${m}`));
  let current: LanListener | null = null;
  let serving: number | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const reconcile = (): void => {
    chain = chain.then(async () => {
      const order = o.controller.order();
      const want = order?.issuedAt ?? null;
      if (current && want === serving) return;
      if (current) {
        await current.close();
        current = null;
        log("stopped the public listener");
      }
      serving = want;
      if (closed || !order) return;
      try {
        current = await startLanListener({
          port: order.port,
          backendPort: o.backendPort,
          zone: o.zone,
          listAddresses: () => o.controller.listenAddresses(),
          maxPerSource: 16,
          ingress: "public",
          ...(o.directNames ? { extraNames: o.directNames } : {}),
          log: (m) => log(m),
          ...(o.rescanMs ? { rescanMs: o.rescanMs } : {}),
        });
      } catch (e) {
        log(`could not start (${(e as Error).message}); relay only`);
      }
    });
  };
  const off = o.controller.onChange(reconcile);
  void o.controller.start().then(reconcile);
  return {
    close: async () => {
      closed = true;
      off();
      await chain;
      await current?.close();
      current = null;
    },
  };
}
