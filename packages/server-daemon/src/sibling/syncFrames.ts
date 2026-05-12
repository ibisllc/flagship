/**
 * Wire frames for the persistent sibling-sync channel (#86).
 *
 * Distinct from the legacy sibling-handshake/app-message frames (frames.ts)
 * which live on `/.flagship/sibling-handshake` and carry opaque
 * sibling-app-message routing. This protocol lives on
 * `/.flagship/sibling-sync` and carries routine cert + key sharing
 * between a user's pods. Authoritative state on each pod is the local
 * AppGrant store; sibling-sync just keeps the population eventually
 * consistent without an authoritative phone round-trip per change.
 *
 * Wire shape: each WS message is one binary blob beginning with a
 * 1-byte frame type, followed by a UTF-8 JSON payload. Same envelope
 * as frames.ts.
 *
 * Frames:
 *
 *   0x01 sibling-sync-hello — mutual auth via IRK-signed
 *        PodIdentityBinding (the peer presents its binding; we verify
 *        against the user's IRK pubkey which we know via shared UMK
 *        derivation). Plus a nonce + signature-over-nonce by the pod's
 *        STK so a captured binding alone can't impersonate.
 *
 *   0x10 cert-sync-offer — inventory frame. The sender advertises every
 *        AppGrant it currently holds: { grantId, expiresAt, appCanonical,
 *        appInstanceId? }. The peer compares against its own set and
 *        replies with pull-request for grants it lacks (or whose copy
 *        is older — staler-cert-loses).
 *
 *   0x11 pull-request — list of grantIds the sender wants pushed.
 *
 *   0x12 push-cert — full AppGrant + IRK signature. Receiver verifies
 *        the signature against the user's known IRK pubkey, applies if
 *        valid and fresher than what it already holds.
 *
 *   0x13 sync-noop — opt-in keepalive marker. The WS-level ping/pong
 *        is the primary keepalive; this frame is reserved for a future
 *        explicit-keepalive design and is currently silently consumed.
 */

import type { Bytes } from "@flagship/protocol";

export const SYNC_FRAME_HELLO = 0x01;
export const SYNC_FRAME_OFFER = 0x10;
export const SYNC_FRAME_PULL = 0x11;
export const SYNC_FRAME_PUSH = 0x12;
export const SYNC_FRAME_NOOP = 0x13;

export type SyncFrameType =
  | typeof SYNC_FRAME_HELLO
  | typeof SYNC_FRAME_OFFER
  | typeof SYNC_FRAME_PULL
  | typeof SYNC_FRAME_PUSH
  | typeof SYNC_FRAME_NOOP;

export interface SyncHelloPayload {
  protocolVersion: 1;
  /** Username at issuance time — used to scope the IRK lookup. */
  username: string;
  /** The pod identity pubkey (32-byte hex). */
  podIdentityPubKeyHex: string;
  /** The pod's canonical FQDN. */
  serverDomain: string;
  /** ms epoch when the binding was registered with .com. */
  registeredAt: number;
  /** Ed25519 signature over canonicalPodIdentityBinding(binding) by the user's IRK. */
  bindingSignatureHex: string;
  /** 32-byte hex challenge nonce issued by THIS side. */
  challengeHex: string;
  /**
   * Optional hex Ed25519 signature over the PEER's challenge by THIS
   * pod's identity key. Absent on the very first hello (we haven't seen
   * the peer's challenge yet); present on the response hello.
   */
  challengeResponseSignatureHex?: string;
}

export interface CertInventoryEntry {
  grantId: string;
  appCanonical: string;
  appInstanceId?: string;
  /** ms epoch — recipient uses this for the fresher-cert-wins comparison. */
  issuedAt: number;
  expiresAt: number;
}

export interface CertSyncOfferPayload {
  inventory: CertInventoryEntry[];
}

export interface PullRequestPayload {
  grantIds: string[];
}

export interface PushCertPayload {
  /** Wire form of AppGrant. */
  grant: {
    grantId: string;
    username: string;
    appCanonical: string;
    appInstanceId?: string;
    serverDomains: string[];
    serverIdentitiesHex: string[];
    routes: Array<{ url: string; scope: "canonical" | "non-canonical" | "subpath" }>;
    issuedAt: number;
    expiresAt: number;
  };
  /** IRK signature over the grant's canonical bytes. */
  signatureHex: string;
}

export type SyncFrame =
  | { type: typeof SYNC_FRAME_HELLO; payload: SyncHelloPayload }
  | { type: typeof SYNC_FRAME_OFFER; payload: CertSyncOfferPayload }
  | { type: typeof SYNC_FRAME_PULL; payload: PullRequestPayload }
  | { type: typeof SYNC_FRAME_PUSH; payload: PushCertPayload }
  | { type: typeof SYNC_FRAME_NOOP; payload: Record<string, never> };

export function encodeSyncFrame(f: SyncFrame): Uint8Array {
  const json = JSON.stringify(f.payload);
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(1 + body.length);
  out[0] = f.type;
  out.set(body, 1);
  return out;
}

export type DecodeSyncFrameResult =
  | { kind: "ok"; frame: SyncFrame }
  | { kind: "error"; reason: string };

export function decodeSyncFrame(buf: Uint8Array): DecodeSyncFrameResult {
  if (buf.length < 1) return { kind: "error", reason: "empty frame" };
  const type = buf[0]!;
  if (!isSyncFrameType(type)) {
    return { kind: "error", reason: `unknown frame type 0x${type.toString(16)}` };
  }
  const body = buf.subarray(1);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "error", reason: "payload not JSON" };
  }
  const v = validatePayload(type, raw);
  if (!v.ok) return { kind: "error", reason: v.reason };
  return { kind: "ok", frame: { type, payload: v.payload } as SyncFrame };
}

function isSyncFrameType(t: number): t is SyncFrameType {
  return (
    t === SYNC_FRAME_HELLO ||
    t === SYNC_FRAME_OFFER ||
    t === SYNC_FRAME_PULL ||
    t === SYNC_FRAME_PUSH ||
    t === SYNC_FRAME_NOOP
  );
}

type ValidateResult<T> = { ok: true; payload: T } | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function validatePayload(
  type: SyncFrameType,
  raw: unknown,
): ValidateResult<SyncFrame["payload"]> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload not object" };
  }
  const o = raw as Record<string, unknown>;
  switch (type) {
    case SYNC_FRAME_HELLO: {
      if (
        o.protocolVersion !== 1 ||
        typeof o.username !== "string" ||
        typeof o.podIdentityPubKeyHex !== "string" ||
        !HEX64.test(o.podIdentityPubKeyHex) ||
        typeof o.serverDomain !== "string" ||
        typeof o.registeredAt !== "number" ||
        typeof o.bindingSignatureHex !== "string" ||
        !HEX128.test(o.bindingSignatureHex) ||
        typeof o.challengeHex !== "string" ||
        !HEX64.test(o.challengeHex)
      ) {
        return { ok: false, reason: "malformed sync-hello" };
      }
      if (
        o.challengeResponseSignatureHex !== undefined &&
        (typeof o.challengeResponseSignatureHex !== "string" ||
          !HEX128.test(o.challengeResponseSignatureHex))
      ) {
        return { ok: false, reason: "malformed challengeResponseSignatureHex" };
      }
      const p: SyncHelloPayload = {
        protocolVersion: 1,
        username: o.username,
        podIdentityPubKeyHex: o.podIdentityPubKeyHex,
        serverDomain: o.serverDomain,
        registeredAt: o.registeredAt,
        bindingSignatureHex: o.bindingSignatureHex,
        challengeHex: o.challengeHex,
        challengeResponseSignatureHex: o.challengeResponseSignatureHex as
          | string
          | undefined,
      };
      return { ok: true, payload: p };
    }
    case SYNC_FRAME_OFFER: {
      if (!Array.isArray(o.inventory)) {
        return { ok: false, reason: "malformed offer" };
      }
      const inv: CertInventoryEntry[] = [];
      for (const e of o.inventory) {
        if (typeof e !== "object" || e === null) {
          return { ok: false, reason: "malformed inventory entry" };
        }
        const r = e as Record<string, unknown>;
        if (
          typeof r.grantId !== "string" ||
          typeof r.appCanonical !== "string" ||
          typeof r.issuedAt !== "number" ||
          typeof r.expiresAt !== "number"
        ) {
          return { ok: false, reason: "malformed inventory entry" };
        }
        const entry: CertInventoryEntry = {
          grantId: r.grantId,
          appCanonical: r.appCanonical,
          issuedAt: r.issuedAt,
          expiresAt: r.expiresAt,
        };
        if (typeof r.appInstanceId === "string") {
          entry.appInstanceId = r.appInstanceId;
        }
        inv.push(entry);
      }
      return { ok: true, payload: { inventory: inv } };
    }
    case SYNC_FRAME_PULL: {
      if (!Array.isArray(o.grantIds)) {
        return { ok: false, reason: "malformed pull" };
      }
      for (const id of o.grantIds) {
        if (typeof id !== "string") {
          return { ok: false, reason: "malformed pull entry" };
        }
      }
      return { ok: true, payload: { grantIds: o.grantIds as string[] } };
    }
    case SYNC_FRAME_PUSH: {
      if (typeof o.grant !== "object" || o.grant === null) {
        return { ok: false, reason: "malformed push" };
      }
      const g = o.grant as Record<string, unknown>;
      if (
        typeof g.grantId !== "string" ||
        typeof g.username !== "string" ||
        typeof g.appCanonical !== "string" ||
        !Array.isArray(g.serverDomains) ||
        !Array.isArray(g.serverIdentitiesHex) ||
        !Array.isArray(g.routes) ||
        typeof g.issuedAt !== "number" ||
        typeof g.expiresAt !== "number" ||
        typeof o.signatureHex !== "string" ||
        !HEX128.test(o.signatureHex)
      ) {
        return { ok: false, reason: "malformed push grant" };
      }
      for (const d of g.serverDomains) {
        if (typeof d !== "string") return { ok: false, reason: "bad serverDomains" };
      }
      for (const h of g.serverIdentitiesHex) {
        if (typeof h !== "string" || !HEX64.test(h)) {
          return { ok: false, reason: "bad serverIdentitiesHex" };
        }
      }
      const routes: Array<{ url: string; scope: "canonical" | "non-canonical" | "subpath" }> = [];
      for (const r of g.routes) {
        if (typeof r !== "object" || r === null) {
          return { ok: false, reason: "bad route" };
        }
        const rr = r as Record<string, unknown>;
        if (
          typeof rr.url !== "string" ||
          (rr.scope !== "canonical" &&
            rr.scope !== "non-canonical" &&
            rr.scope !== "subpath")
        ) {
          return { ok: false, reason: "bad route" };
        }
        routes.push({ url: rr.url, scope: rr.scope });
      }
      const grant: PushCertPayload["grant"] = {
        grantId: g.grantId,
        username: g.username,
        appCanonical: g.appCanonical,
        serverDomains: g.serverDomains as string[],
        serverIdentitiesHex: g.serverIdentitiesHex as string[],
        routes,
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
      };
      if (typeof g.appInstanceId === "string") {
        grant.appInstanceId = g.appInstanceId;
      }
      return { ok: true, payload: { grant, signatureHex: o.signatureHex } };
    }
    case SYNC_FRAME_NOOP:
      return { ok: true, payload: {} };
  }
}

/**
 * Canonical bytes the peer signs to prove possession of its STK on the
 * sync channel. Identical shape to the hello-challenge in frames.ts,
 * but the tag differs so a signature can never be replayed across the
 * two channels.
 *
 * Form: `flagship/sibling-sync/v1|<peerDomain>|<myDomain>|<challengeHex>`
 */
export function syncHelloChallenge(args: {
  peerDomain: string;
  myDomain: string;
  challengeHex: string;
}): Bytes {
  return new TextEncoder().encode(
    `flagship/sibling-sync/v1|${args.peerDomain}|${args.myDomain}|${args.challengeHex}`,
  );
}
