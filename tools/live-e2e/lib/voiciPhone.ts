/**
 * The admin phone's voi.ci operations (docs/voici-and-messages.md §8.2), for the simulated phone in lib/phoneSim.ts:
 * `GET /api/phone/live`, the `OPTIONS` preflight and `POST /api/phone/deliver`, decided by the shared `phoneWebCheck`
 * the iOS and Android endpoints mirror. A voici-message is checked as the apps check it (checkVoiciMessage, then
 * blocks, revocations and a repeated msgId), forwarded to the mailbox with `direct: true`, and acked with the owner
 * messages signing key; a voici-draft is checked against the account's grant chain and acked with the admin device
 * key. A blocked sender gets `200 {accepted:true}` and no ack (no oracle). Set it on a sim phone with
 * `phone.endpoint.web = new VoiciPhoneWeb(...)`; the sim's older session routes stay for requests it doesn't own.
 */
import {
  checkVoiciDraft,
  checkVoiciMessage,
  ed,
  phoneWebCheck,
  PHONE_DELIVER_MAX_BYTES,
  signVoiciAck,
  VOICI_DRAFT_MAX_ENVELOPE_BYTES,
  type WebEnvelope,
} from "@flagship/protocol";
import { answer, type HttpRequestHead } from "./phoneSim.js";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface VoiciPhoneWebOptions {
  account: string;
  /** PHONE_WEB_ORIGINS (gym: PHONE_WEB_ORIGINS_GYM). */
  origins: readonly string[];
  /** The website origin a delegation must name (gym https://gym.voi.ci). */
  webOrigin: string;
  /** The phone's route-claim key (its account device key): `phoneRoutePub` in every ack, and the draft ack's signer. */
  deviceSeed: Uint8Array;
  /** CA keys an attestation may be signed by. */
  caKeys: readonly string[];
  /** The account's grant-chain check for a draft's cred (admin root, else IRK). */
  grantOk(grant: unknown, grantSignature: string, devicePub: string): boolean;
  /** Forwards an accepted message to the mailbox (POST /api/voici/web/send with direct: true). */
  forward(envelope: WebEnvelope): Promise<void>;
  now?: () => number;
}

/** The page the phone holds keys for; changes on every publish. */
export interface VoiciPhonePage {
  pageId: string;
  acceptsMessages: boolean;
  ownerSignPub: string;
  ownerSignSeed: Uint8Array;
}

export class VoiciPhoneWeb {
  page: VoiciPhonePage | null = null;
  readonly blocked = new Set<string>();
  readonly revoked = new Set<string>();
  readonly messages: WebEnvelope[] = [];
  readonly drafts: WebEnvelope[] = [];
  readonly forwardErrors: string[] = [];
  private readonly seen = new Set<string>();
  readonly phoneRoutePub: string;

  constructor(private readonly o: VoiciPhoneWebOptions) {
    this.phoneRoutePub = hexOf(ed.getPublicKey(o.deviceSeed));
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Null for a request this handler doesn't own (no Origin and neither operation): the sim's other routes answer. */
  respond(req: HttpRequestHead, hostname: string): string | Promise<string> | null {
    const path = req.path.split("?")[0]!;
    const v = phoneWebCheck(
      {
        method: req.method,
        path,
        host: (req.headers.host ?? "").split(":")[0]!,
        origin: req.headers.origin ?? null,
        contentType: req.headers["content-type"] ?? null,
        acrMethod: req.headers["access-control-request-method"] ?? null,
        acrHeaders: req.headers["access-control-request-headers"] ?? null,
      },
      { hostname, origins: this.o.origins },
    );
    if (v.kind === "other") return null;
    if (v.kind === "refuse") return answer(v.status, { error: v.code, code: v.code });
    if (v.kind === "preflight") return answer(204, null, lines(v.headers));
    const cors = lines(v.corsHeaders);
    if (v.kind === "live") {
      if (!this.page) return answer(404, { code: "not-live" }, cors);
      return answer(200, { live: true, account: this.o.account, ownerSignPub: this.page.ownerSignPub }, cors);
    }
    return this.deliver(req.body, cors);
  }

  private async deliver(body: string, cors: string): Promise<string> {
    const page = this.page;
    if (!page) return answer(503, { code: "unavailable" }, cors);
    if (Buffer.byteLength(body) > VOICI_DRAFT_MAX_ENVELOPE_BYTES) return answer(413, { code: "too-large" }, cors);
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return answer(400, { code: "malformed" }, cors);
    }
    const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
    const now = this.now();
    if (kind === "voici-draft") {
      const r = checkVoiciDraft(raw, { username: this.o.account, checkGrant: this.o.grantOk, freshAt: now });
      if (!r.ok) return answer(403, { code: r.code }, cors);
      const key = `draft|${r.envelope.msgId}`;
      if (this.seen.has(key)) return answer(409, { code: "duplicate" }, cors);
      this.seen.add(key);
      this.drafts.push(r.envelope);
      const ack = signVoiciAck({ conv: "", msgId: r.envelope.msgId, receivedAt: now, phoneRoutePub: this.phoneRoutePub }, this.o.deviceSeed);
      return answer(200, { ack }, cors);
    }
    if (Buffer.byteLength(body) > PHONE_DELIVER_MAX_BYTES) return answer(413, { code: "too-large" }, cors);
    const from = raw && typeof raw === "object" ? (raw as { from?: unknown }).from : undefined;
    if (typeof from === "string" && this.blocked.has(from)) return answer(200, { accepted: true }, cors);
    const r = checkVoiciMessage(raw, {
      pageId: page.pageId,
      acceptsMessages: page.acceptsMessages,
      origin: this.o.webOrigin,
      caKeys: this.o.caKeys,
      now,
      blocked: this.blocked,
      revoked: this.revoked,
    });
    if (!r.ok) return r.code === "blocked" ? answer(200, { accepted: true }, cors) : answer(403, { code: r.code }, cors);
    const key = `${r.envelope.conv}|${r.envelope.msgId}`;
    if (this.seen.has(key)) return answer(409, { code: "duplicate" }, cors);
    this.seen.add(key);
    this.messages.push(r.envelope);
    // Every message ends in the mailbox (§8.2): forward, then ack.
    await this.o.forward(r.envelope).catch((e: unknown) => void this.forwardErrors.push(String(e)));
    const ack = signVoiciAck({ conv: r.envelope.conv, msgId: r.envelope.msgId, receivedAt: now, phoneRoutePub: this.phoneRoutePub }, page.ownerSignSeed);
    return answer(200, { ack }, cors);
  }
}

function lines(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
}
