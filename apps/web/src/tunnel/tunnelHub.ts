import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  decodeFrame,
  domainGrantedFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_REQUEST_TRANSFER,
  helloAckFrame,
  type Frame,
  type HelloAckTrust,
} from "@flagship/tunnel-protocol";
import {
  serviceEntitlementCertId,
  serviceGrantActiveAt,
  serviceGrantAuthorizesPod,
  serviceGrantId,
  rootEntitlementCertId,
  verifyServiceEntitlement,
  verifyServiceGrant,
  verifyRootEntitlement,
  verifyTunnelHelloV2,
  type ServiceEntitlement,
  type ServiceGrant,
  type ServiceGrantRoute,
  type Bytes,
  type RootEntitlement,
  type TunnelHelloV2,
} from "@flagship/protocol";
import type { RegisteredTunnel, StreamCallbacks, TunnelRegistry } from "./registry.js";

const TUNNEL_PATH = "/tunnel";

/**
 * Source of the current relay blessing + nonce-signer
 * (docs/maintainer-trust-enforcement.md). When present, the hub attaches
 * its `.com`-CA-signed ServiceBlessing + a proof-of-possession `hubSig`
 * over the box's HELLO nonce on every accepting HELLO_ACK. Absent ⇒ the
 * hub sends a plain ack (OBSERVE-safe: the box keeps relaying).
 */
export interface RelayBlessingSource {
  currentBlessing(): import("@flagship/protocol").ServiceBlessing | null;
  /** lower-hex Ed25519 signature over `nonce`, signed with the blessed key. */
  signNonce(nonce: Uint8Array): string;
}

export interface TunnelAuthLookup {
  /**
   * Look up a server's registered tunnel-auth (STK) pubkey. Returns
   * null if the server is unknown / revoked.
   */
  (serverId: string): Bytes | null | Promise<Bytes | null>;
}

export interface IrkLookup {
  /**
   * Look up a username's registered IRK pubkey. Used to verify
   * entitlement-cert signatures. Returns null if the username isn't
   * registered with .com.
   */
  (username: string): Bytes | null | Promise<Bytes | null>;
}

export interface TunnelHubOptions {
  /**
   * Which surface the host process is serving. When "services" (the
   * production data plane) the hub FAILS CLOSED if `irkLookup` is
   * absent — an unverified entitlement signature would let a box claim
   * routing for another user's zone. Dev/test harnesses leave this
   * unset (or "both") and the missing-lookup case only warns.
   */
  surface?: "com" | "services" | "both";
  /**
   * Required in production: lets the hub verify the STK signature on
   * the HELLO envelope against .com's registered server identity.
   * Tests may pass a closure mapping serverIds → STK pubkeys.
   *
   * If omitted, STK signature verification is SKIPPED (v0 dev only).
   */
  authLookup?: TunnelAuthLookup;
  /**
   * Required in production: lets the hub verify the IRK signature on
   * each entitlement cert. Tests pass a static map.
   *
   * If omitted, IRK verification is SKIPPED (v0 dev only).
   */
  irkLookup?: IrkLookup;
  /**
   * Optional: list of revoked entitlement cert ids per user. Hub
   * fetches via this callback (caller caches with TTL) on every HELLO.
   * Returning null means "couldn't fetch — accept anyway" (fail-open
   * to avoid bricking pods on a transient .com outage). Returning
   * an empty Set means "definitely empty list."
   */
  revocationLookup?: (username: string) => Promise<Set<string> | null>;
  /**
   * Optional: per-podCanonical set of EVICTED box STK pubkeys (lowercased
   * hex) — the graceful-decommission eviction chain's `retiredStkPubHex`
   * set (docs/server-replacement-graceful-decommission.md §8). The hub
   * calls this AFTER entitlement/STK verification succeeds; if the
   * connecting box's own STK pubkey is in the returned set, the HELLO is
   * rejected with the typed reason "replaced" (the box's `.com` poll then
   * delivers the signed decommission order).
   *
   * Returning `null` means "couldn't fetch — accept anyway" (FAIL-OPEN:
   * a `.com` outage must NOT brick a box's ability to register
   * fleet-wide; the worst case is a brief flap the order/zombie-poll
   * still closes — §8 availability trade-off). This is the deliberate
   * INVERSE of irkLookup's fail-closed contract above: an unverifiable
   * *signature* is fatal, but an unreachable *eviction list* is not.
   * Returning an empty Set means "definitely no evictions for this pod."
   */
  evictionLookup?: (podCanonical: string) => Promise<Set<string> | null>;
  /**
   * Optional relay-blessing source. When set, every accepting HELLO_ACK
   * carries the hub's `.com`-CA-signed ServiceBlessing + a `hubSig` over
   * the box's HELLO nonce. Omitted ⇒ a plain ack (old behavior).
   */
  blessingSource?: RelayBlessingSource;
  /** Reject HELLOs whose issuedAt is older than this. Default 5 min. */
  maxHelloAgeMs?: number;
  /** Idle close: empty state on hello → close after this many ms. Default 60s. */
  idleCloseMs?: number;
  /**
   * The data-plane apex pod canonicals live under — `flagship.services`
   * in prod, `gym.flagship.services` in the test env (docs/ui-test-gym.md
   * §6.5). Drives the apex-RELATIVE shape/middle-label parse. Defaults to
   * the prod literal so prod behavior is byte-identical.
   */
  apex?: string;
  now?: () => number;
}

/**
 * Mounts the tunnel WebSocket endpoint at /tunnel on the given HTTP server.
 * Returns a close function for graceful shutdown.
 */
export function startTunnelHub(
  httpServer: HttpServer,
  registry: TunnelRegistry,
  opts: TunnelHubOptions = {},
): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  if (!opts.irkLookup && opts.surface === "services") {
    // Production data plane MUST verify entitlement-IRK signatures.
    // Without irkLookup the entitlement-cert check is skipped entirely,
    // so any registered box could claim routing for FQDNs in another
    // user's zone. Refuse to start rather than run wide open.
    throw new Error(
      "[flagship tunnel hub] refusing to start on surface=services without irkLookup — " +
        "entitlement-cert signatures would not be verified (a box could hijack another user's routing).",
    );
  }
  if (!opts.authLookup) {
    console.warn(
      "[flagship tunnel hub] no authLookup — STK signatures will not be verified. v0 dev only.",
    );
  }
  if (!opts.irkLookup) {
    console.warn(
      "[flagship tunnel hub] no irkLookup — entitlement-cert signatures will not be verified. v0 dev only.",
    );
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (req.url !== TUNNEL_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => attachTunnel(ws, registry, opts));
  };
  httpServer.on("upgrade", onUpgrade);

  return async () => {
    httpServer.off("upgrade", onUpgrade);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
}

function attachTunnel(
  ws: WsSocket,
  registry: TunnelRegistry,
  opts: TunnelHubOptions,
): void {
  let registered: RegisteredTunnel | null = null;
  let lastHelloIssuedAt = 0;
  let nextStream = 1;
  const streams = new Map<number, StreamCallbacks>();
  let buffered: Uint8Array = new Uint8Array(0);
  const now = opts.now ?? (() => Date.now());
  const maxHelloAgeMs = opts.maxHelloAgeMs ?? 5 * 60_000;
  const idleCloseMs = opts.idleCloseMs ?? 60_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (frame: Frame) => {
    if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame), { binary: true });
  };

  /**
   * Build the relay-trust attachment for an accepting HELLO_ACK: the
   * current blessing + a hub signature over the box's HELLO nonce. Returns
   * undefined when no blessing source is wired or no blessing is held yet
   * (OBSERVE-safe — the box keeps relaying). The hubSig is over the SAME
   * nonce bytes the box signed in its HELLO, defeating blessing replay.
   */
  const buildTrust = (nonce: Uint8Array): HelloAckTrust | undefined => {
    const src = opts.blessingSource;
    if (!src) return undefined;
    const blessing = src.currentBlessing();
    if (!blessing) return undefined;
    try {
      return { serviceBlessing: blessing, hubSig: src.signNonce(nonce) };
    } catch {
      return undefined;
    }
  };

  const armIdleClose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      ws.close(1000, "no canonicals after register");
    }, idleCloseMs);
  };
  const cancelIdleClose = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  ws.on("message", (raw: Buffer) => {
    const view = new Uint8Array(raw.byteLength);
    view.set(raw);
    buffered = concat(buffered, view);
    void drain();
  });

  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const r = decodeFrame(buffered);
        if (r.kind === "incomplete") return;
        if (r.kind === "error") {
          send(helloAckFrame(false, r.reason));
          ws.close(1002, "frame decode error");
          return;
        }
        buffered = buffered.subarray(r.consumed);
        await handleFrame(r.frame);
      }
    } finally {
      draining = false;
    }
  }

  ws.on("close", () => {
    cancelIdleClose();
    if (registered) {
      const result = registry.unregister(registered.podCanonical);
      // Re-broadcast snapshots to every set affected by the removal.
      for (const key of result.affectedSets) {
        broadcastSnapshot(registry, key);
      }
    }
    for (const cb of streams.values()) cb.onRemoteClose();
    streams.clear();
  });

  ws.on("error", () => { /* close handler does cleanup */ });

  async function handleFrame(f: Frame): Promise<void> {
    if (!registered) {
      if (f.type !== FRAME_HELLO) {
        send(helloAckFrame(false, "expected HELLO as first frame"));
        ws.close(1002, "no HELLO");
        return;
      }
      const helloOk = parseHello(f.payload);
      if (!helloOk.ok) {
        send(helloAckFrame(false, helloOk.reason));
        ws.close(1002, "bad HELLO");
        return;
      }
      const auth = await authenticateHello(helloOk, opts, now, maxHelloAgeMs);
      if (!auth.ok) {
        send(helloAckFrame(false, auth.reason));
        ws.close(auth.closeCode, "auth failed");
        return;
      }
      // Eviction gate (graceful decommission §8). Consulted ONLY after the
      // entitlement/STK verification above succeeds — a forged entitlement
      // is rejected by `authenticateHello` first, so this never adjudicates
      // an unverified box. Fail-OPEN on a `.com` outage (see checkEvicted).
      const evicted = await checkEvicted(helloOk, opts);
      if (evicted) {
        send(helloAckFrame(false, "replaced"));
        ws.close(1008, "replaced");
        return;
      }
      const built = buildClaimedCanonicals(
        helloOk.rootEntitlement.podCanonical,
        helloOk.serviceEntitlement,
        auth.validatedGrants,
        helloOk.rootEntitlement.username,
        opts.apex,
      );
      if (!built.ok) {
        send(helloAckFrame(false, built.reason));
        ws.close(1008, "claim rejected");
        return;
      }
      const canonicals = built.canonicals;
      const tunnel: RegisteredTunnel = {
        podCanonical: helloOk.rootEntitlement.podCanonical.toLowerCase(),
        send,
        attachStream: (id, cb) => streams.set(id, cb),
        detachStream: (id) => streams.delete(id),
        nextStreamId: () => nextStream++,
      };
      const reg = registry.register({ tunnel, canonicals });
      registered = tunnel;
      lastHelloIssuedAt = helloOk.issuedAt;
      send(helloAckFrame(true, undefined, buildTrust(helloOk.nonce)));
      // Broadcast a fresh snapshot to every affected set so all
      // currently-connected pods learn about the new arrival.
      for (const key of reg.affectedSets) broadcastSnapshot(registry, key);
      if (canonicals.length === 0) armIdleClose();
      return;
    }

    if (f.type === FRAME_HELLO) {
      // HELLO update on a registered tunnel: re-authenticate, then
      // refresh the pod's canonicals via the allocator (idempotent
      // when nothing changed; allocates new canonicals when the cert
      // grew, drops on shrink).
      const helloOk = parseHello(f.payload);
      if (!helloOk.ok) {
        send(helloAckFrame(false, helloOk.reason));
        return;
      }
      if (
        helloOk.rootEntitlement.podCanonical.toLowerCase() !== registered.podCanonical
      ) {
        send(helloAckFrame(false, "HELLO podCanonical changed mid-WS"));
        ws.close(1008, "podCanonical changed");
        return;
      }
      if (helloOk.issuedAt <= lastHelloIssuedAt) {
        send(helloAckFrame(false, "HELLO issuedAt did not advance (replay?)"));
        return;
      }
      const auth = await authenticateHello(helloOk, opts, now, maxHelloAgeMs);
      if (!auth.ok) {
        send(helloAckFrame(false, auth.reason));
        return;
      }
      // Eviction gate on the HELLO refresh too: a box evicted mid-session
      // self-retires on its next HELLO. Same after-verification ordering +
      // fail-open contract as the initial accept path.
      const evicted = await checkEvicted(helloOk, opts);
      if (evicted) {
        send(helloAckFrame(false, "replaced"));
        ws.close(1008, "replaced");
        return;
      }
      const built = buildClaimedCanonicals(
        helloOk.rootEntitlement.podCanonical,
        helloOk.serviceEntitlement,
        auth.validatedGrants,
        helloOk.rootEntitlement.username,
        opts.apex,
      );
      if (!built.ok) {
        send(helloAckFrame(false, built.reason));
        return;
      }
      const canonicals = built.canonicals;
      const reg = registry.register({ tunnel: registered, canonicals });
      lastHelloIssuedAt = helloOk.issuedAt;
      send(helloAckFrame(true, undefined, buildTrust(helloOk.nonce)));
      for (const key of reg.affectedSets) broadcastSnapshot(registry, key);
      if (canonicals.length === 0) armIdleClose();
      else cancelIdleClose();
      return;
    }

    if (f.type === FRAME_REQUEST_TRANSFER) {
      let body: { fqdn?: unknown };
      try {
        body = JSON.parse(new TextDecoder().decode(f.payload));
      } catch {
        return;
      }
      if (typeof body.fqdn !== "string") return;
      const r = registry.requestTransfer({
        podCanonical: registered.podCanonical,
        fqdn: body.fqdn,
      });
      if (r.ok) {
        broadcastSnapshot(registry, r.affectedSet);
      }
      return;
    }
    if (f.type === FRAME_DATA) {
      const cb = streams.get(f.streamId);
      if (cb) cb.onData(f.payload);
      return;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      const cb = streams.get(f.streamId);
      if (cb) cb.onRemoteClose();
      streams.delete(f.streamId);
      return;
    }
  }
}

interface ParsedHelloV2 {
  serverId: string;
  rootEntitlement: RootEntitlement;
  rootEntitlementSig: Bytes;
  rootEntitlementCertId: string;
  serviceEntitlement: ServiceEntitlement | null;
  serviceEntitlementSig: Bytes | null;
  serviceEntitlementCertId: string;
  nonce: Bytes;
  issuedAt: number;
  signature: Bytes;
  /**
   * Optional list of AppGrants the daemon also presents (#6). Each
   * grant carries its IRK signature; the hub verifies it against the
   * user's known IRK pubkey and, if this pod is in serverIdentities
   * and not revoked/expired, unions the grant's route URLs into the
   * SNI allowlist.
   */
  appGrants: ParsedAppGrant[];
}

interface ParsedAppGrant {
  grant: ServiceGrant;
  signature: Bytes;
  /** SHA-256 hex of the grant's canonical bytes. */
  grantIdHash: string;
}

type HelloParse = ({ ok: true } & ParsedHelloV2) | { ok: false; reason: string };

function parseHello(payload: Uint8Array): HelloParse {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { ok: false, reason: "HELLO payload not JSON" };
  }
  if (typeof obj !== "object" || obj === null) return { ok: false, reason: "HELLO not object" };
  const o = obj as Record<string, unknown>;
  if (o.version !== 2) return { ok: false, reason: "HELLO version must be 2" };
  if (typeof o.serverId !== "string" || !o.serverId.length) {
    return { ok: false, reason: "HELLO.serverId missing" };
  }
  if (typeof o.issuedAt !== "number" || !Number.isFinite(o.issuedAt)) {
    return { ok: false, reason: "HELLO.issuedAt must be a number" };
  }
  if (typeof o.nonce !== "string" || !/^[0-9a-f]{64}$/.test(o.nonce)) {
    return { ok: false, reason: "HELLO.nonce must be 32-byte hex" };
  }
  if (typeof o.signature !== "string" || !/^[0-9a-f]{128}$/.test(o.signature)) {
    return { ok: false, reason: "HELLO.signature must be 64-byte hex" };
  }
  if (typeof o.rootEntitlement !== "object" || o.rootEntitlement === null) {
    return { ok: false, reason: "HELLO.rootEntitlement missing" };
  }
  if (typeof o.rootEntitlementSig !== "string" || !/^[0-9a-f]{128}$/.test(o.rootEntitlementSig)) {
    return { ok: false, reason: "HELLO.rootEntitlementSig must be 64-byte hex" };
  }
  if (typeof o.rootEntitlementCertId !== "string" || !/^[0-9a-f]{64}$/.test(o.rootEntitlementCertId)) {
    return { ok: false, reason: "HELLO.rootEntitlementCertId must be 32-byte hex" };
  }
  const re = parseRootEntitlement(o.rootEntitlement);
  if (!re.ok) return { ok: false, reason: re.reason };

  let app: ServiceEntitlement | null = null;
  let appSig: Bytes | null = null;
  let appCertId = "";
  if (o.serviceEntitlement !== undefined && o.serviceEntitlement !== null) {
    if (typeof o.serviceEntitlement !== "object") {
      return { ok: false, reason: "HELLO.serviceEntitlement not an object" };
    }
    if (typeof o.serviceEntitlementSig !== "string" || !/^[0-9a-f]{128}$/.test(o.serviceEntitlementSig)) {
      return { ok: false, reason: "HELLO.serviceEntitlementSig must be 64-byte hex" };
    }
    if (typeof o.serviceEntitlementCertId !== "string" || !/^[0-9a-f]{64}$/.test(o.serviceEntitlementCertId)) {
      return { ok: false, reason: "HELLO.serviceEntitlementCertId must be 32-byte hex" };
    }
    const ae = parseServiceEntitlement(o.serviceEntitlement);
    if (!ae.ok) return { ok: false, reason: ae.reason };
    app = ae.value;
    appSig = hexToBytes(o.serviceEntitlementSig);
    appCertId = o.serviceEntitlementCertId;
  }

  // #6 — optional ServiceGrant list. Each entry: { grant, signatureHex }.
  const appGrants: ParsedAppGrant[] = [];
  if (o.appGrants !== undefined) {
    if (!Array.isArray(o.appGrants)) {
      return { ok: false, reason: "HELLO.appGrants must be an array" };
    }
    for (const raw of o.appGrants) {
      if (typeof raw !== "object" || raw === null) {
        return { ok: false, reason: "HELLO.appGrants entry not object" };
      }
      const r = raw as Record<string, unknown>;
      const wire = r.grant;
      if (typeof wire !== "object" || wire === null) {
        return { ok: false, reason: "HELLO.appGrants entry missing grant" };
      }
      const wireG = wire as Record<string, unknown>;
      if (typeof r.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(r.signatureHex)) {
        return { ok: false, reason: "HELLO.appGrants entry signatureHex must be 64-byte hex" };
      }
      const parsed = inflateAppGrantWire(wireG);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      appGrants.push({
        grant: parsed.value,
        signature: hexToBytes(r.signatureHex),
        grantIdHash: "", // computed in authenticate after we verify the signature
      });
    }
  }

  return {
    ok: true,
    serverId: o.serverId,
    rootEntitlement: re.value,
    rootEntitlementSig: hexToBytes(o.rootEntitlementSig),
    rootEntitlementCertId: o.rootEntitlementCertId,
    serviceEntitlement: app,
    serviceEntitlementSig: appSig,
    serviceEntitlementCertId: appCertId,
    nonce: hexToBytes(o.nonce),
    issuedAt: o.issuedAt,
    signature: hexToBytes(o.signature),
    appGrants,
  };
}

/**
 * Inflate a wire ServiceGrant (with `serverIdentitiesHex`) into the
 * in-memory shape (with `serverIdentities: Bytes[]`). Validates basic
 * field shapes; signature verification is the caller's job.
 */
function inflateAppGrantWire(
  o: Record<string, unknown>,
): { ok: true; value: ServiceGrant } | { ok: false; reason: string } {
  if (typeof o.grantId !== "string") return { ok: false, reason: "ServiceGrant.grantId missing" };
  if (typeof o.username !== "string") return { ok: false, reason: "ServiceGrant.username missing" };
  if (typeof o.serviceCanonical !== "string") return { ok: false, reason: "ServiceGrant.serviceCanonical missing" };
  if (!Array.isArray(o.serverDomains)) return { ok: false, reason: "ServiceGrant.serverDomains must be an array" };
  if (!Array.isArray(o.serverIdentitiesHex)) return { ok: false, reason: "ServiceGrant.serverIdentitiesHex must be an array" };
  if (!Array.isArray(o.routes)) return { ok: false, reason: "ServiceGrant.routes must be an array" };
  if (typeof o.issuedAt !== "number") return { ok: false, reason: "ServiceGrant.issuedAt must be a number" };
  if (typeof o.expiresAt !== "number") return { ok: false, reason: "ServiceGrant.expiresAt must be a number" };
  for (const d of o.serverDomains) {
    if (typeof d !== "string") return { ok: false, reason: "ServiceGrant.serverDomains must be strings" };
  }
  const serverIdentities: Bytes[] = [];
  for (const h of o.serverIdentitiesHex) {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
      return { ok: false, reason: "ServiceGrant.serverIdentitiesHex must be 32-byte hex" };
    }
    serverIdentities.push(hexToBytes(h));
  }
  const routes: ServiceGrantRoute[] = [];
  for (const r of o.routes) {
    if (typeof r !== "object" || r === null) {
      return { ok: false, reason: "ServiceGrant.route not object" };
    }
    const rr = r as Record<string, unknown>;
    if (typeof rr.url !== "string") return { ok: false, reason: "ServiceGrant.route.url missing" };
    if (rr.scope !== "canonical" && rr.scope !== "non-canonical" && rr.scope !== "subpath") {
      return { ok: false, reason: "ServiceGrant.route.scope invalid" };
    }
    routes.push({ url: rr.url, scope: rr.scope });
  }
  const out: ServiceGrant = {
    grantId: o.grantId,
    username: o.username,
    serviceCanonical: o.serviceCanonical,
    serverDomains: o.serverDomains as string[],
    serverIdentities,
    routes,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
  };
  if (typeof o.serviceInstanceId === "string") out.serviceInstanceId = o.serviceInstanceId;
  return { ok: true, value: out };
}

function parseRootEntitlement(o: unknown): { ok: true; value: RootEntitlement } | { ok: false; reason: string } {
  if (typeof o !== "object" || o === null) return { ok: false, reason: "rootEntitlement not object" };
  const r = o as Record<string, unknown>;
  if (typeof r.username !== "string" || !r.username) return { ok: false, reason: "rootEntitlement.username missing" };
  if (typeof r.podPubKey !== "string" || !/^[0-9a-f]{64}$/.test(r.podPubKey)) {
    return { ok: false, reason: "rootEntitlement.podPubKey must be 32-byte hex" };
  }
  if (typeof r.podCanonical !== "string" || !r.podCanonical) return { ok: false, reason: "rootEntitlement.podCanonical missing" };
  if (typeof r.issuedAt !== "number") return { ok: false, reason: "rootEntitlement.issuedAt must be a number" };
  return {
    ok: true,
    value: {
      username: r.username,
      podPubKey: hexToBytes(r.podPubKey),
      podCanonical: r.podCanonical.toLowerCase(),
      issuedAt: r.issuedAt,
    },
  };
}

function parseServiceEntitlement(o: unknown): { ok: true; value: ServiceEntitlement } | { ok: false; reason: string } {
  if (typeof o !== "object" || o === null) return { ok: false, reason: "serviceEntitlement not object" };
  const r = o as Record<string, unknown>;
  if (typeof r.username !== "string") return { ok: false, reason: "serviceEntitlement.username missing" };
  if (typeof r.podPubKey !== "string" || !/^[0-9a-f]{64}$/.test(r.podPubKey)) {
    return { ok: false, reason: "serviceEntitlement.podPubKey must be 32-byte hex" };
  }
  if (!Array.isArray(r.canonicals)) return { ok: false, reason: "serviceEntitlement.canonicals must be an array" };
  for (const c of r.canonicals) {
    if (typeof c !== "string" || !c) return { ok: false, reason: "serviceEntitlement.canonicals contains a non-string" };
  }
  if (typeof r.issuedAt !== "number") return { ok: false, reason: "serviceEntitlement.issuedAt must be a number" };
  if (typeof r.expiresAt !== "number") return { ok: false, reason: "serviceEntitlement.expiresAt must be a number" };
  return {
    ok: true,
    value: {
      username: r.username,
      podPubKey: hexToBytes(r.podPubKey),
      canonicals: (r.canonicals as string[]).map((s) => s.toLowerCase()),
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
    },
  };
}

async function authenticateHello(
  hello: ParsedHelloV2,
  opts: TunnelHubOptions,
  now: () => number,
  maxHelloAgeMs: number,
): Promise<
  | { ok: true; validatedGrants: ServiceGrant[] }
  | { ok: false; reason: string; closeCode: number }
> {
  const age = now() - hello.issuedAt;
  if (age > maxHelloAgeMs || age < -60_000) {
    return { ok: false, reason: "HELLO issuedAt is stale or in the future", closeCode: 1008 };
  }
  // serverId must match the rootEntitlement's podCanonical (the pod's
  // own URL is the only thing it can serverId-as).
  if (hello.serverId.toLowerCase() !== hello.rootEntitlement.podCanonical) {
    return { ok: false, reason: "serverId must equal rootEntitlement.podCanonical", closeCode: 1002 };
  }
  // Shape gate: podCanonical must be a real `<server>.<user>` pod name
  // made of plain DNS labels — in particular no `*`. The A′ per-box
  // wildcard is a CLAIM (`*.<podCanonical>`, see buildClaimedCanonicals),
  // never an identity; a wildcard podCanonical would otherwise sail
  // through the middle-label check below.
  if (!podCanonicalShapeOk(hello.rootEntitlement.podCanonical, opts.apex)) {
    return {
      ok: false,
      reason: "rootEntitlement.podCanonical is not a valid pod name under the data-plane apex",
      closeCode: 1008,
    };
  }
  // Pod-zone identity check: rootEntitlement.podCanonical's middle
  // label must equal rootEntitlement.username (the user-zone owner).
  const podUser = extractMiddleLabel(hello.rootEntitlement.podCanonical, opts.apex);
  if (!podUser || podUser !== hello.rootEntitlement.username) {
    return {
      ok: false,
      reason: "rootEntitlement.podCanonical does not live in its declared user zone",
      closeCode: 1008,
    };
  }
  // Verify the cert ids the envelope advertises match the actual certs.
  const computedRootId = await rootEntitlementCertId(hello.rootEntitlement);
  if (computedRootId !== hello.rootEntitlementCertId) {
    return { ok: false, reason: "rootEntitlementCertId does not match cert", closeCode: 1002 };
  }
  if (hello.serviceEntitlement) {
    const computedAppId = await serviceEntitlementCertId(hello.serviceEntitlement);
    if (computedAppId !== hello.serviceEntitlementCertId) {
      return { ok: false, reason: "serviceEntitlementCertId does not match cert", closeCode: 1002 };
    }
    // App entitlement expiry check.
    if (hello.serviceEntitlement.expiresAt <= now()) {
      return { ok: false, reason: "serviceEntitlement expired", closeCode: 1008 };
    }
    if (hello.serviceEntitlement.username !== hello.rootEntitlement.username) {
      return { ok: false, reason: "serviceEntitlement.username mismatches root", closeCode: 1008 };
    }
    // Bind: app cert's podPubKey must equal root cert's podPubKey.
    if (!equalBytes(hello.serviceEntitlement.podPubKey, hello.rootEntitlement.podPubKey)) {
      return { ok: false, reason: "serviceEntitlement.podPubKey mismatches root", closeCode: 1008 };
    }
  }
  // Verify entitlement IRK signatures against the user's IRK.
  if (opts.irkLookup) {
    const irkPub = await opts.irkLookup(hello.rootEntitlement.username);
    if (!irkPub) {
      return { ok: false, reason: "username not registered with .com", closeCode: 1008 };
    }
    if (!verifyRootEntitlement(hello.rootEntitlement, hello.rootEntitlementSig, irkPub)) {
      return { ok: false, reason: "rootEntitlement signature failed verification", closeCode: 1008 };
    }
    if (hello.serviceEntitlement && hello.serviceEntitlementSig) {
      if (!verifyServiceEntitlement(hello.serviceEntitlement, hello.serviceEntitlementSig, irkPub)) {
        return { ok: false, reason: "serviceEntitlement signature failed verification", closeCode: 1008 };
      }
    }
  }
  // Revocation check.
  if (opts.revocationLookup) {
    const revoked = await opts.revocationLookup(hello.rootEntitlement.username);
    if (revoked) {
      if (revoked.has(hello.rootEntitlementCertId)) {
        return { ok: false, reason: "rootEntitlement is revoked", closeCode: 1008 };
      }
      if (hello.serviceEntitlement && revoked.has(hello.serviceEntitlementCertId)) {
        return { ok: false, reason: "serviceEntitlement is revoked", closeCode: 1008 };
      }
    }
  }
  // Verify the STK signature on the HELLO envelope.
  const envelope: TunnelHelloV2 = {
    serverId: hello.serverId,
    rootEntitlementCertId: hello.rootEntitlementCertId,
    serviceEntitlementCertId: hello.serviceEntitlementCertId,
    nonce: hello.nonce,
    issuedAt: hello.issuedAt,
  };
  if (opts.authLookup) {
    const stkPub = await opts.authLookup(hello.serverId);
    if (!stkPub) {
      return { ok: false, reason: "serverId not registered with .com", closeCode: 1008 };
    }
    // STK pubkey must match the cert's podPubKey — closes a substitution loophole.
    if (!equalBytes(stkPub, hello.rootEntitlement.podPubKey)) {
      return { ok: false, reason: "STK pubkey mismatches rootEntitlement.podPubKey", closeCode: 1008 };
    }
    if (!verifyTunnelHelloV2(envelope, hello.signature, stkPub)) {
      return { ok: false, reason: "HELLO STK signature failed verification", closeCode: 1008 };
    }
  }

  // #6 — ServiceGrant gate. Verify each presented ServiceGrant against the
  // user's IRK, confirm this pod is in serverIdentities, confirm
  // the grant is active (issuedAt ≤ now < expiresAt) and not on
  // the revocation list. The union of validated grants' route URLs
  // becomes the SNI allowlist along with the legacy entitlement
  // canonicals (caller does the union).
  //
  // FAIL CLOSED: if AppGrants are present and the IRK lookup or
  // revocation lookup fails, reject the HELLO. Better to refuse a
  // legitimate connection than to silently accept a hostile grant.
  const validatedGrants: ServiceGrant[] = [];
  if (hello.appGrants.length > 0) {
    if (!opts.irkLookup) {
      return {
        ok: false,
        reason: "AppGrants presented but no irkLookup configured",
        closeCode: 1008,
      };
    }
    const irkPub = await opts.irkLookup(hello.rootEntitlement.username);
    if (!irkPub) {
      return {
        ok: false,
        reason: "AppGrants username not registered with .com",
        closeCode: 1008,
      };
    }
    const revoked = opts.revocationLookup
      ? await opts.revocationLookup(hello.rootEntitlement.username)
      : null;
    for (const pg of hello.appGrants) {
      if (!verifyServiceGrant(pg.grant, pg.signature, irkPub)) {
        return {
          ok: false,
          reason: "ServiceGrant signature failed verification",
          closeCode: 1008,
        };
      }
      if (!serviceGrantActiveAt(pg.grant, now())) {
        return {
          ok: false,
          reason: "ServiceGrant outside active window",
          closeCode: 1008,
        };
      }
      if (!serviceGrantAuthorizesPod(pg.grant, hello.rootEntitlement.podPubKey)) {
        return {
          ok: false,
          reason: "ServiceGrant does not authorize this pod",
          closeCode: 1008,
        };
      }
      const computedId = await serviceGrantId(pg.grant);
      if (revoked && revoked.has(computedId)) {
        return {
          ok: false,
          reason: "ServiceGrant is revoked",
          closeCode: 1008,
        };
      }
      validatedGrants.push(pg.grant);
    }
  }
  return { ok: true, validatedGrants };
}

/**
 * Eviction gate for the graceful-decommission hand-off (§8). Returns
 * `true` iff the connecting box's own STK pubkey is on the eviction
 * chain for its podCanonical (so the HELLO must be rejected as
 * "replaced"), `false` otherwise.
 *
 * The box's STK pubkey is `rootEntitlement.podPubKey` — `authenticateHello`
 * has already bound it to the HELLO-envelope signer (`verifyTunnelHelloV2`)
 * and, when `authLookup` is wired, to `.com`'s registered STK — so by the
 * time we get here it is the proven identity of the connecting instance,
 * not an attacker-asserted field.
 *
 * FAIL-OPEN: a `null` from `evictionLookup` (a `.com` outage) is treated
 * as "not evicted" — registration proceeds. A momentary `.com` blip must
 * never brick the fleet's ability to register; the worst case is a brief
 * route flap that the durable order / zombie-poll still closes (§8). This
 * is the deliberate inverse of the fail-CLOSED signature checks above.
 */
async function checkEvicted(
  hello: ParsedHelloV2,
  opts: TunnelHubOptions,
): Promise<boolean> {
  if (!opts.evictionLookup) return false;
  const retired = await opts.evictionLookup(hello.rootEntitlement.podCanonical);
  if (!retired) return false; // null ⇒ outage ⇒ fail-open
  const myStkHex = bytesToHex(hello.rootEntitlement.podPubKey).toLowerCase();
  return retired.has(myStkHex);
}

/**
 * Send a domain-granted-style snapshot to every member of the set.
 * We reuse FRAME_DOMAIN_GRANTED for now (one frame per slot) so the
 * existing tunnel-client onDomainGranted path keeps working. The
 * allocator's per-slot model maps cleanly into per-slot frames.
 */
function broadcastSnapshot(registry: TunnelRegistry, key: import("./allocator.js").AppUserSetKey): void {
  const snap = registry.snapshotByKey(key);
  if (!snap) return;
  const members = registry.membersOf(key);
  if (members.length === 0) return;
  for (const slot of snap.slotHolders) {
    const f = domainGrantedFrame({ fqdn: slot.fqdn, ownerServerId: slot.podCanonical });
    for (const t of members) {
      try { t.send(f); } catch { /* swallow */ }
    }
  }
}

/**
 * Build the registry-bound canonical list from a validated HELLO. The
 * hub's SNI allowlist is the UNION of every authorized source: the
 * root entitlement's podCanonical, the service entitlement's
 * canonicals, and the validated AppGrants' route hosts (#6) — callers
 * MUST pass `auth.validatedGrants`, never the raw HELLO grants, so an
 * unverified grant can never contribute a host.
 *
 * A′ per-box wildcard claims: a pod may claim `*.<its own
 * podCanonical>` (the scope of its per-box wildcard cert
 * `*.<server>.<user>.flagship.services`) and ONLY that. A matching
 * claim is CONSUMED here rather than forwarded as a literal — the
 * registry's one-label-strip fallback already routes
 * `<service>.<podCanonical>` to the pod, which is exactly the
 * wildcard's one-label scope. Any other wildcard (the retired
 * user-zone `*.<user>`, another box's `*.<server>.<user>`, deeper or
 * embedded `*`) rejects the HELLO outright: the wildcard's base must
 * BE the IRK+STK-verified pod identity, mirroring the rigor applied
 * to podCanonical itself, so a box can never widen its routing past
 * its own name.
 *
 * Defense-in-depth (cross-zone hijack): every non-wildcard claim must
 * live in the SAME user zone as the IRK-verified root entitlement — its
 * `<server>.<user>.flagship.services` user-zone label must equal
 * `username`. The IRK signature already binds an entitlement to one
 * user, but this guard is a belt-and-suspenders check that no claimed
 * canonical names a FQDN in ANOTHER user's zone even if a signature
 * gate is ever weakened or bypassed. `username` is the verified
 * `rootEntitlement.username` from `authenticateHello`; callers MUST
 * pass it, never an attacker-controlled field.
 */
export function buildClaimedCanonicals(
  podCanonical: string,
  serviceEntitlement: ServiceEntitlement | null,
  validatedGrants: ServiceGrant[],
  username: string,
  apex: string = DEFAULT_HUB_APEX,
): { ok: true; canonicals: string[] } | { ok: false; reason: string } {
  const pc = podCanonical.toLowerCase();
  const user = username.toLowerCase();
  const claims: string[] = [];
  if (serviceEntitlement) claims.push(...serviceEntitlement.canonicals);
  claims.push(...appGrantHosts(validatedGrants));
  const canonicals: string[] = [pc];
  for (const claim of claims) {
    const c = claim.toLowerCase();
    if (c.startsWith("*.")) {
      if (c.slice(2) !== pc) {
        return {
          ok: false,
          reason: `wildcard claim ${c} rejected — a pod may only claim its own per-box wildcard *.${pc}`,
        };
      }
      continue;
    }
    if (c.includes("*")) {
      return {
        ok: false,
        reason: `claim ${c} rejected — '*' is only valid as the leading label of *.${pc}`,
      };
    }
    // Cross-zone guard: a claim must name a FQDN in this user's own
    // zone. The user-zone label is the label immediately left of the
    // configured apex suffix.
    const claimUser = extractMiddleLabel(c, apex);
    if (!claimUser || claimUser !== user) {
      return {
        ok: false,
        reason: `claim ${c} rejected — outside user zone '${user}' (foreign-zone canonical)`,
      };
    }
    canonicals.push(c);
  }
  return { ok: true, canonicals };
}

/**
 * Extract the unique host portion of every route URL across a set of
 * validated AppGrants. `subpath`-scoped routes encode their path after
 * the first '/', which we strip for SNI-allowlist purposes (TLS doesn't
 * see paths). Callers MUST pass only grants that have been verified by
 * `authenticateHello` — this function performs no validation of its own.
 *
 * Exported only for the `__internal__` test surface below.
 */
export function appGrantHosts(grants: ServiceGrant[]): string[] {
  const hosts = new Set<string>();
  for (const g of grants) {
    for (const route of g.routes) {
      const slash = route.url.indexOf("/");
      const host = (slash === -1 ? route.url : route.url.slice(0, slash)).toLowerCase();
      if (host.length > 0) hosts.add(host);
    }
  }
  return Array.from(hosts);
}

function podCanonicalShapeOk(podCanonical: string, apex: string = DEFAULT_HUB_APEX): boolean {
  const suffix = "." + apex;
  if (!podCanonical.endsWith(suffix)) return false;
  const head = podCanonical.slice(0, -suffix.length);
  const parts = head.split(".");
  if (parts.length < 2) return false;
  return parts.every((p) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(p));
}

// The data-plane apex helpers below default to. Threaded from
// TunnelHubOptions.apex so the test env (`gym.flagship.services`) parses
// apex-RELATIVE — the user is the last label after the apex suffix is
// stripped, never a fixed offset from the right.
const DEFAULT_HUB_APEX = "flagship.services";

function extractMiddleLabel(serverId: string, apex: string = DEFAULT_HUB_APEX): string | null {
  const suffix = "." + apex;
  const lower = serverId.toLowerCase();
  if (!lower.endsWith(suffix)) return null;
  const head = lower.slice(0, -suffix.length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(user)) return null;
  return user;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}
