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
} from "@flagship/tunnel-protocol";
import {
  appEntitlementCertId,
  appGrantActiveAt,
  appGrantAuthorizesPod,
  appGrantId,
  rootEntitlementCertId,
  verifyAppEntitlement,
  verifyAppGrant,
  verifyRootEntitlement,
  verifyTunnelHelloV2,
  type AppEntitlement,
  type AppGrant,
  type AppGrantRoute,
  type Bytes,
  type RootEntitlement,
  type TunnelHelloV2,
} from "@flagship/protocol";
import type { RegisteredTunnel, StreamCallbacks, TunnelRegistry } from "./registry.js";

const TUNNEL_PATH = "/tunnel";

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
  /** Reject HELLOs whose issuedAt is older than this. Default 5 min. */
  maxHelloAgeMs?: number;
  /** Idle close: empty state on hello → close after this many ms. Default 60s. */
  idleCloseMs?: number;
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
      // Build the canonical list from the validated entitlements +
      // the validated AppGrants' route hosts (#6). The hub's SNI
      // allowlist is the UNION of every authorized source. We use the
      // VALIDATED grants (auth.validatedGrants) rather than the
      // raw helloOk.appGrants so an unverified grant can never
      // contribute a host to the allowlist.
      const canonicals: string[] = [helloOk.rootEntitlement.podCanonical];
      if (helloOk.appEntitlement) {
        for (const c of helloOk.appEntitlement.canonicals) canonicals.push(c);
      }
      for (const host of appGrantHosts(auth.validatedGrants)) canonicals.push(host);
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
      send(helloAckFrame(true));
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
      const canonicals: string[] = [helloOk.rootEntitlement.podCanonical];
      if (helloOk.appEntitlement) {
        for (const c of helloOk.appEntitlement.canonicals) canonicals.push(c);
      }
      for (const host of appGrantHosts(auth.validatedGrants)) canonicals.push(host);
      const reg = registry.register({ tunnel: registered, canonicals });
      lastHelloIssuedAt = helloOk.issuedAt;
      send(helloAckFrame(true));
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
  appEntitlement: AppEntitlement | null;
  appEntitlementSig: Bytes | null;
  appEntitlementCertId: string;
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
  grant: AppGrant;
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

  let app: AppEntitlement | null = null;
  let appSig: Bytes | null = null;
  let appCertId = "";
  if (o.appEntitlement !== undefined && o.appEntitlement !== null) {
    if (typeof o.appEntitlement !== "object") {
      return { ok: false, reason: "HELLO.appEntitlement not an object" };
    }
    if (typeof o.appEntitlementSig !== "string" || !/^[0-9a-f]{128}$/.test(o.appEntitlementSig)) {
      return { ok: false, reason: "HELLO.appEntitlementSig must be 64-byte hex" };
    }
    if (typeof o.appEntitlementCertId !== "string" || !/^[0-9a-f]{64}$/.test(o.appEntitlementCertId)) {
      return { ok: false, reason: "HELLO.appEntitlementCertId must be 32-byte hex" };
    }
    const ae = parseAppEntitlement(o.appEntitlement);
    if (!ae.ok) return { ok: false, reason: ae.reason };
    app = ae.value;
    appSig = hexToBytes(o.appEntitlementSig);
    appCertId = o.appEntitlementCertId;
  }

  // #6 — optional AppGrant list. Each entry: { grant, signatureHex }.
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
    appEntitlement: app,
    appEntitlementSig: appSig,
    appEntitlementCertId: appCertId,
    nonce: hexToBytes(o.nonce),
    issuedAt: o.issuedAt,
    signature: hexToBytes(o.signature),
    appGrants,
  };
}

/**
 * Inflate a wire AppGrant (with `serverIdentitiesHex`) into the
 * in-memory shape (with `serverIdentities: Bytes[]`). Validates basic
 * field shapes; signature verification is the caller's job.
 */
function inflateAppGrantWire(
  o: Record<string, unknown>,
): { ok: true; value: AppGrant } | { ok: false; reason: string } {
  if (typeof o.grantId !== "string") return { ok: false, reason: "AppGrant.grantId missing" };
  if (typeof o.username !== "string") return { ok: false, reason: "AppGrant.username missing" };
  if (typeof o.appCanonical !== "string") return { ok: false, reason: "AppGrant.appCanonical missing" };
  if (!Array.isArray(o.serverDomains)) return { ok: false, reason: "AppGrant.serverDomains must be an array" };
  if (!Array.isArray(o.serverIdentitiesHex)) return { ok: false, reason: "AppGrant.serverIdentitiesHex must be an array" };
  if (!Array.isArray(o.routes)) return { ok: false, reason: "AppGrant.routes must be an array" };
  if (typeof o.issuedAt !== "number") return { ok: false, reason: "AppGrant.issuedAt must be a number" };
  if (typeof o.expiresAt !== "number") return { ok: false, reason: "AppGrant.expiresAt must be a number" };
  for (const d of o.serverDomains) {
    if (typeof d !== "string") return { ok: false, reason: "AppGrant.serverDomains must be strings" };
  }
  const serverIdentities: Bytes[] = [];
  for (const h of o.serverIdentitiesHex) {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
      return { ok: false, reason: "AppGrant.serverIdentitiesHex must be 32-byte hex" };
    }
    serverIdentities.push(hexToBytes(h));
  }
  const routes: AppGrantRoute[] = [];
  for (const r of o.routes) {
    if (typeof r !== "object" || r === null) {
      return { ok: false, reason: "AppGrant.route not object" };
    }
    const rr = r as Record<string, unknown>;
    if (typeof rr.url !== "string") return { ok: false, reason: "AppGrant.route.url missing" };
    if (rr.scope !== "canonical" && rr.scope !== "non-canonical" && rr.scope !== "subpath") {
      return { ok: false, reason: "AppGrant.route.scope invalid" };
    }
    routes.push({ url: rr.url, scope: rr.scope });
  }
  const out: AppGrant = {
    grantId: o.grantId,
    username: o.username,
    appCanonical: o.appCanonical,
    serverDomains: o.serverDomains as string[],
    serverIdentities,
    routes,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
  };
  if (typeof o.appInstanceId === "string") out.appInstanceId = o.appInstanceId;
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

function parseAppEntitlement(o: unknown): { ok: true; value: AppEntitlement } | { ok: false; reason: string } {
  if (typeof o !== "object" || o === null) return { ok: false, reason: "appEntitlement not object" };
  const r = o as Record<string, unknown>;
  if (typeof r.username !== "string") return { ok: false, reason: "appEntitlement.username missing" };
  if (typeof r.podPubKey !== "string" || !/^[0-9a-f]{64}$/.test(r.podPubKey)) {
    return { ok: false, reason: "appEntitlement.podPubKey must be 32-byte hex" };
  }
  if (!Array.isArray(r.canonicals)) return { ok: false, reason: "appEntitlement.canonicals must be an array" };
  for (const c of r.canonicals) {
    if (typeof c !== "string" || !c) return { ok: false, reason: "appEntitlement.canonicals contains a non-string" };
  }
  if (typeof r.issuedAt !== "number") return { ok: false, reason: "appEntitlement.issuedAt must be a number" };
  if (typeof r.expiresAt !== "number") return { ok: false, reason: "appEntitlement.expiresAt must be a number" };
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
  | { ok: true; validatedGrants: AppGrant[] }
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
  // Pod-zone identity check: rootEntitlement.podCanonical's middle
  // label must equal rootEntitlement.username (the user-zone owner).
  const podUser = extractMiddleLabel(hello.rootEntitlement.podCanonical);
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
  if (hello.appEntitlement) {
    const computedAppId = await appEntitlementCertId(hello.appEntitlement);
    if (computedAppId !== hello.appEntitlementCertId) {
      return { ok: false, reason: "appEntitlementCertId does not match cert", closeCode: 1002 };
    }
    // App entitlement expiry check.
    if (hello.appEntitlement.expiresAt <= now()) {
      return { ok: false, reason: "appEntitlement expired", closeCode: 1008 };
    }
    if (hello.appEntitlement.username !== hello.rootEntitlement.username) {
      return { ok: false, reason: "appEntitlement.username mismatches root", closeCode: 1008 };
    }
    // Bind: app cert's podPubKey must equal root cert's podPubKey.
    if (!equalBytes(hello.appEntitlement.podPubKey, hello.rootEntitlement.podPubKey)) {
      return { ok: false, reason: "appEntitlement.podPubKey mismatches root", closeCode: 1008 };
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
    if (hello.appEntitlement && hello.appEntitlementSig) {
      if (!verifyAppEntitlement(hello.appEntitlement, hello.appEntitlementSig, irkPub)) {
        return { ok: false, reason: "appEntitlement signature failed verification", closeCode: 1008 };
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
      if (hello.appEntitlement && revoked.has(hello.appEntitlementCertId)) {
        return { ok: false, reason: "appEntitlement is revoked", closeCode: 1008 };
      }
    }
  }
  // Verify the STK signature on the HELLO envelope.
  const envelope: TunnelHelloV2 = {
    serverId: hello.serverId,
    rootEntitlementCertId: hello.rootEntitlementCertId,
    appEntitlementCertId: hello.appEntitlementCertId,
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

  // #6 — AppGrant gate. Verify each presented AppGrant against the
  // user's IRK, confirm this pod is in serverIdentities, confirm
  // the grant is active (issuedAt ≤ now < expiresAt) and not on
  // the revocation list. The union of validated grants' route URLs
  // becomes the SNI allowlist along with the legacy entitlement
  // canonicals (caller does the union).
  //
  // FAIL CLOSED: if AppGrants are present and the IRK lookup or
  // revocation lookup fails, reject the HELLO. Better to refuse a
  // legitimate connection than to silently accept a hostile grant.
  const validatedGrants: AppGrant[] = [];
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
      if (!verifyAppGrant(pg.grant, pg.signature, irkPub)) {
        return {
          ok: false,
          reason: "AppGrant signature failed verification",
          closeCode: 1008,
        };
      }
      if (!appGrantActiveAt(pg.grant, now())) {
        return {
          ok: false,
          reason: "AppGrant outside active window",
          closeCode: 1008,
        };
      }
      if (!appGrantAuthorizesPod(pg.grant, hello.rootEntitlement.podPubKey)) {
        return {
          ok: false,
          reason: "AppGrant does not authorize this pod",
          closeCode: 1008,
        };
      }
      const computedId = await appGrantId(pg.grant);
      if (revoked && revoked.has(computedId)) {
        return {
          ok: false,
          reason: "AppGrant is revoked",
          closeCode: 1008,
        };
      }
      validatedGrants.push(pg.grant);
    }
  }
  return { ok: true, validatedGrants };
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
 * Extract the unique host portion of every route URL across a set of
 * validated AppGrants. `subpath`-scoped routes encode their path after
 * the first '/', which we strip for SNI-allowlist purposes (TLS doesn't
 * see paths). Callers MUST pass only grants that have been verified by
 * `authenticateHello` — this function performs no validation of its own.
 *
 * Exported only for the `__internal__` test surface below.
 */
export function appGrantHosts(grants: AppGrant[]): string[] {
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

function extractMiddleLabel(serverId: string): string | null {
  const lower = serverId.toLowerCase();
  if (!lower.endsWith(".flagship.services")) return null;
  const head = lower.slice(0, -".flagship.services".length);
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
