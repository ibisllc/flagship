/**
 * Co-manager invites, box side (owner decision 2026-10-16;
 * docs/service-access-gating.md "Co-manager invites").
 *
 * Someone this server is shared with at "Can manage" is Manager in every app
 * by default, and like a non-admin device of the owner's account they may
 * invite people at Member while they stay manager-class there:
 *
 *   GET  /api/shares/invites?service=<serviceRef>   (any share session)
 *        → {serviceRef, canInvite, why, rank, ownerAid, invites:[…their own…]}
 *   POST /api/shares/invites            {request, signature}   (Can manage)
 *        the create, signed with the share's member key; the box checks the
 *        standing and the signature, then relays it to `.com` with its STK
 *        (`flagship/service-invite-co-manager/v1`): `.com` never learns who
 *        shares with whom, so it trusts the member key only on the box's word.
 *   POST /api/shares/invites/withdraw   {revoke, signature}
 *        their own invite, while they may still invite there: removes the
 *        people who joined through it, here and on the app's other servers,
 *        and tells `.com`.
 *
 * The box keeps which invites each share made (`share-invites.json`) so the
 * co-manager can list and withdraw them; the names stay sealed under a key
 * only the co-manager's devices hold. The app's other servers learn about the
 * co-manager from a `share` journal entry (the owner's signed grant, then its
 * end) recorded with the first invite and on every later change of the share.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  signServiceInviteCoManagerRelay,
  verifyCreateServiceInvite,
  verifyRevokeServiceInvite,
  type CreateServiceInvite,
  type Keypair,
  type RevokeServiceInvite,
  type ServerShareGrant,
} from "@flagship/protocol";
import { keepCorruptAside, writeFileDurable } from "../durableFile.js";
import type { AccessEntry, ShareEnd } from "../accessJournal.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { CoManagerInviteRefusal, ServiceAccessStore } from "../serviceAccess.js";
import type { ActivityLog } from "./activityLog.js";
import { hexBytes } from "./shareStore.js";

/** An invite a co-manager made on this server. */
export interface ShareInviteRecord {
  inviteId: string;
  shareId: string;
  memberPubHex: string;
  serviceRef: string;
  createdAt: number;
  /** Sealed under the co-manager's share-invite bundle key (their devices open it). */
  encryptedBundle: string;
  maxRedemptions: number | null;
  expiresAt: number | null;
}

/** Open invites a share may hold on one server. */
export const MAX_SHARE_INVITES = 200;

/** `<dataDir>/share-invites.json`, mode 0600. */
export class ShareInviteStore {
  private byId = new Map<string, ShareInviteRecord>();

  /** `path` null ⇒ memory only (tests). */
  constructor(private readonly path: string | null) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { invites?: unknown };
      if (!raw || !Array.isArray(raw.invites)) throw new Error("not a share invite list");
      for (const r of raw.invites) {
        const rec = readRecord(r);
        if (rec) this.byId.set(rec.inviteId, rec);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      this.byId.clear();
      await keepCorruptAside(
        this.path,
        e,
        "People this server is shared with no longer see the invites they sent; the invites still work until withdrawn by an admin.",
      );
    }
  }

  get(inviteId: string): ShareInviteRecord | null {
    return this.byId.get(inviteId) ?? null;
  }

  list(shareId: string, serviceRef?: string): ShareInviteRecord[] {
    return [...this.byId.values()]
      .filter((r) => r.shareId === shareId && (serviceRef === undefined || r.serviceRef === serviceRef))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The apps a share invited people to here. */
  servicesFor(shareId: string): string[] {
    return [...new Set(this.list(shareId).map((r) => r.serviceRef))];
  }

  async put(rec: ShareInviteRecord): Promise<void> {
    this.byId.set(rec.inviteId, rec);
    await this.save();
  }

  async delete(inviteId: string): Promise<void> {
    if (this.byId.delete(inviteId)) await this.save();
  }

  /** A share ended: its invites aren't listed for anyone any more. */
  async dropShare(shareId: string): Promise<void> {
    let changed = false;
    for (const [id, r] of this.byId) {
      if (r.shareId === shareId) {
        this.byId.delete(id);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    return writeFileDurable(this.path, JSON.stringify({ invites: [...this.byId.values()] }));
  }
}

export function defaultShareInviteStorePath(dataDir: string): string {
  return join(dataDir, "share-invites.json");
}

function readRecord(v: unknown): ShareInviteRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.inviteId !== "string" ||
    typeof r.shareId !== "string" ||
    typeof r.memberPubHex !== "string" ||
    typeof r.serviceRef !== "string" ||
    typeof r.createdAt !== "number" ||
    typeof r.encryptedBundle !== "string"
  ) {
    return null;
  }
  return {
    inviteId: r.inviteId,
    shareId: r.shareId,
    memberPubHex: r.memberPubHex,
    serviceRef: r.serviceRef,
    createdAt: r.createdAt,
    encryptedBundle: r.encryptedBundle,
    maxRedemptions: typeof r.maxRedemptions === "number" ? r.maxRedemptions : null,
    expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
  };
}

/** The share behind a request (shares/sharesHttp.ts ShareCaller, the parts used here). */
export interface InviteCaller {
  shareId: string;
  label: string;
  level: "view" | "manage";
  memberPubHex: string;
  grant: ServerShareGrant;
  grantSignature: string;
}

export interface ShareInvitesDeps {
  serverDomain: string;
  /** The owner's account (the `.com` path segment). */
  username: string;
  /** The owner's AID, hex: every invite to the owner's apps names it as the author. */
  ownerAidHex: string | null;
  controlPlaneBaseUrl: string;
  /** The box's STK: signs the relay to `.com`. */
  stk: Keypair;
  store: ShareInviteStore;
  /** The access store, once the owner handlers are up (null until then). */
  access: () => ServiceAccessStore | null;
  /** Whether an app is installed here. */
  installed: (serviceRef: string) => boolean;
  /** Keep an accepted change in the app's journal and hand it to its other servers. */
  record: (serviceRef: string, entry: AccessEntry) => void;
  activity?: ActivityLog;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

/** What each refusal tells the co-manager (the box's own sentence; apps show it as is). */
export const CO_MANAGER_INVITE_REFUSALS: Record<CoManagerInviteRefusal, string> = {
  "not-shared": "This server isn't shared with you anymore.",
  "view-only": "You can view this server but not manage it, so you can't invite people to its apps.",
  demoted: "An admin made you a Member of this app, so you can't invite people to it.",
  refused: "An admin turned off your access to this app.",
  "catching-up": "This server is catching up with the app's other servers. Try again in a moment.",
};

const CREATE_MAX_SKEW_MS = 5 * 60_000;
const WITHDRAW_MAX_SKEW_MS = 10 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const J = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
const err = (status: number, error: string, code?: string): HttpResponse =>
  json(status, { error, ...(code ? { code } : {}) });

export function buildShareInvites(deps: ShareInvitesDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.controlPlaneBaseUrl.replace(/\/+$/, "");

  function body(req: HttpRequest): Record<string, unknown> | null {
    try {
      const v = JSON.parse(req.body.toString("utf8")) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  function standing(access: ServiceAccessStore, ref: string, c: InviteCaller) {
    if (c.level !== "manage") return { ok: false as const, why: "view-only" as const };
    return access.coManagerInviteStanding(ref, c.memberPubHex);
  }

  /** The share's grant, for the app's journal: its other servers check the co-manager against it. */
  function shareEntry(grant: ServerShareGrant, signature: string, end?: ShareEnd): AccessEntry {
    return { kind: "share", grant: { ...grant }, signature: signature.toLowerCase(), ...(end ? { end } : {}) };
  }

  async function noteLocally(access: ServiceAccessStore, ref: string, grant: ServerShareGrant, ended: boolean): Promise<void> {
    await access.noteCoManager(ref, grant.shareId, {
      pub: grant.memberPubHex,
      level: grant.level,
      label: grant.label,
      serverDomain: grant.serverDomain,
      issuedAt: grant.issuedAt,
      ended,
    });
  }

  async function list(c: InviteCaller, req: HttpRequest): Promise<HttpResponse> {
    const access = deps.access();
    if (!access) return err(503, "This server is still starting. Try again in a moment.", "starting");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const ref = q.get("service") ?? "";
    if (!ref || !deps.installed(ref)) return err(404, "There's no such app on this server.", "no-such-app");
    const s = deps.ownerAidHex ? standing(access, ref, c) : { ok: false as const, why: "not-shared" as const };
    const p = access.principal(c.memberPubHex);
    return json(200, {
      serviceRef: ref,
      canInvite: s.ok,
      why: s.ok ? null : s.why,
      whyText: s.ok ? null : CO_MANAGER_INVITE_REFUSALS[s.why],
      rank: p ? access.accountRank(ref, p) : null,
      ownerAid: deps.ownerAidHex,
      invites: deps.store.list(c.shareId, ref).map((r) => ({
        inviteId: r.inviteId,
        createdAt: r.createdAt,
        encryptedBundle: r.encryptedBundle,
        maxRedemptions: r.maxRedemptions,
        expiresAt: r.expiresAt,
        joined: access.boundThrough(ref, r.inviteId),
      })),
    });
  }

  async function create(c: InviteCaller, req: HttpRequest): Promise<HttpResponse> {
    if (c.level !== "manage") return err(403, CO_MANAGER_INVITE_REFUSALS["view-only"], "view-only");
    const access = deps.access();
    if (!access) return err(503, "This server is still starting. Try again in a moment.", "starting");
    const b = body(req);
    const r = b?.request as Record<string, unknown> | undefined;
    const sigHex = typeof b?.signature === "string" ? b.signature.toLowerCase() : "";
    if (
      !r ||
      typeof r.inviteId !== "string" ||
      !HEX64.test(r.inviteId) ||
      typeof r.authorAID !== "string" ||
      typeof r.serviceRef !== "string" ||
      typeof r.secretHash !== "string" ||
      !HEX64.test(r.secretHash) ||
      typeof r.encryptedBundle !== "string" ||
      !/^([0-9a-f]{2}){28,32768}$/.test(r.encryptedBundle) ||
      typeof r.issuedAt !== "number" ||
      !HEX128.test(sigHex)
    ) {
      return err(400, "malformed invite", "malformed");
    }
    if (r.approvalMode !== undefined && r.approvalMode !== "auto") {
      return err(422, "Invites you send let people in when they open the link.", "manual-not-offered");
    }
    const maxRedemptions = r.maxRedemptions;
    const expiresAt = r.expiresAt;
    if (maxRedemptions !== undefined && (!Number.isSafeInteger(maxRedemptions) || (maxRedemptions as number) < 0)) {
      return err(400, "malformed invite", "malformed");
    }
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= now())) {
      return err(400, "The link's expiry has to be in the future.", "malformed");
    }
    if (Math.abs(now() - r.issuedAt) > CREATE_MAX_SKEW_MS) {
      return err(403, "Your device's clock looks off. Check it and try again.", "stale");
    }
    const ref = r.serviceRef;
    if (!deps.installed(ref)) return err(404, "There's no such app on this server.", "no-such-app");
    if (!deps.ownerAidHex || r.authorAID.toLowerCase() !== deps.ownerAidHex) {
      return err(403, "The invite doesn't name this server's owner.", "wrong-author");
    }
    const s = standing(access, ref, c);
    if (!s.ok) return err(403, CO_MANAGER_INVITE_REFUSALS[s.why], s.why);
    const createEnv: CreateServiceInvite = {
      inviteId: r.inviteId,
      authorAID: hexBytes(r.authorAID.toLowerCase())!,
      serviceRef: ref,
      secretHash: r.secretHash,
      encryptedBundle: r.encryptedBundle,
      issuedAt: r.issuedAt,
      ...(maxRedemptions !== undefined ? { maxRedemptions: maxRedemptions as number } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt as number } : {}),
    };
    if (!verifyCreateServiceInvite(createEnv, hexBytes(sigHex)!, hexBytes(c.memberPubHex)!)) {
      return err(403, "invalid signature", "invalid-signature");
    }
    if (deps.store.get(r.inviteId)) return err(409, "That invite already exists.", "exists");
    if (deps.store.list(c.shareId).length >= MAX_SHARE_INVITES) {
      return err(409, "You have too many open invites on this server. Withdraw some first.", "too-many-invites");
    }

    const relayAt = now();
    const relaySig = signServiceInviteCoManagerRelay(
      {
        username: deps.username.toLowerCase(),
        serverDomain: deps.serverDomain,
        inviteId: r.inviteId,
        serviceRef: ref,
        creatorPubHex: c.memberPubHex,
        createSigHex: sigHex,
        issuedAt: relayAt,
      },
      deps.stk,
    );
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/users/${encodeURIComponent(deps.username)}/service-invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: {
            inviteId: r.inviteId,
            authorAID: deps.ownerAidHex,
            serviceRef: ref,
            secretHash: r.secretHash,
            encryptedBundle: r.encryptedBundle,
            issuedAt: r.issuedAt,
            ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            creatorPubHex: c.memberPubHex,
          },
          signature: sigHex,
          relay: { serverDomain: deps.serverDomain, issuedAt: relayAt, signature: Buffer.from(relaySig).toString("hex") },
        }),
      });
    } catch {
      return err(502, "Couldn't reach flagshipserver.com. Try again.", "com-unreachable");
    }
    if (!res.ok) {
      log(`[share-invites] .com refused a co-manager invite: ${res.status}`);
      if (res.status === 409) return err(409, "That invite already exists.", "exists");
      return err(502, "flagshipserver.com didn't take the invite. Try again.", "com-refused");
    }
    // Who made it lands before anyone can join through it (sticky on this box).
    await access.setInviteTier(ref, r.inviteId, "co-manager");
    await access.setInviteCreator(ref, r.inviteId, c.memberPubHex);
    await deps.store.put({
      inviteId: r.inviteId,
      shareId: c.shareId,
      memberPubHex: c.memberPubHex,
      serviceRef: ref,
      createdAt: now(),
      encryptedBundle: r.encryptedBundle,
      maxRedemptions: typeof maxRedemptions === "number" ? maxRedemptions : null,
      expiresAt: typeof expiresAt === "number" ? expiresAt : null,
    });
    await noteLocally(access, ref, c.grant, false);
    deps.record(ref, shareEntry(c.grant, c.grantSignature));
    deps.activity?.record({ actor: { kind: "share", shareId: c.shareId, label: c.label }, action: "app.invite.create", target: ref, ok: true });
    return json(200, { created: true, inviteId: r.inviteId, tier: "co-manager" });
  }

  async function withdraw(c: InviteCaller, req: HttpRequest): Promise<HttpResponse> {
    const access = deps.access();
    if (!access) return err(503, "This server is still starting. Try again in a moment.", "starting");
    const b = body(req);
    const rv = b?.revoke as Record<string, unknown> | undefined;
    const sigHex = typeof b?.signature === "string" ? b.signature.toLowerCase() : "";
    if (!rv || typeof rv.inviteId !== "string" || !HEX64.test(rv.inviteId) || typeof rv.issuedAt !== "number" || !HEX128.test(sigHex)) {
      return err(400, "malformed withdraw", "malformed");
    }
    const rec = deps.store.get(rv.inviteId);
    if (!rec || rec.shareId !== c.shareId) return err(404, "That isn't one of your invites.", "not-yours");
    if (Math.abs(now() - rv.issuedAt) > WITHDRAW_MAX_SKEW_MS) {
      return err(403, "Your device's clock looks off. Check it and try again.", "stale");
    }
    const revoke: RevokeServiceInvite = { inviteId: rv.inviteId, issuedAt: rv.issuedAt };
    if (!verifyRevokeServiceInvite(revoke, hexBytes(sigHex)!, hexBytes(c.memberPubHex)!)) {
      return err(403, "invalid signature", "invalid-signature");
    }
    // Mirrors a non-admin device: only while they may still invite there.
    const s = standing(access, rec.serviceRef, c);
    if (!s.ok) return err(403, CO_MANAGER_INVITE_REFUSALS[s.why], s.why);
    const pruned = await access.revokeGroup(revoke.inviteId, rec.serviceRef);
    await access.noteWithdrawn(rec.serviceRef, revoke.inviteId, revoke.issuedAt, sigHex);
    deps.record(rec.serviceRef, { kind: "withdraw", revoke, signature: sigHex });
    let comNotified = false;
    try {
      const res = await fetchImpl(`${base}/api/users/${encodeURIComponent(deps.username)}/service-invites/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: revoke, signature: sigHex }),
      });
      comNotified = res.ok;
    } catch {
      comNotified = false;
    }
    if (!comNotified) log(`[share-invites] couldn't tell .com about a withdrawn co-manager invite`);
    await deps.store.delete(revoke.inviteId);
    deps.activity?.record({ actor: { kind: "share", shareId: c.shareId, label: c.label }, action: "app.invite.withdraw", target: rec.serviceRef, ok: true });
    return json(200, { ok: true, pruned, comNotified });
  }

  /** `/api/shares/invites*` for a resolved share session; null for other paths. */
  async function handle(c: InviteCaller, req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    const method = req.method.toUpperCase();
    if (path === "/api/shares/invites" && method === "GET") return list(c, req);
    if (path === "/api/shares/invites" && method === "POST") return create(c, req);
    if (path === "/api/shares/invites/withdraw" && method === "POST") return withdraw(c, req);
    return null;
  }

  /**
   * A share changed (a new grant: level, label) or ended: every app it
   * invited people to here records the owner's signed word on it, so the
   * app's other servers stop (or keep) letting people in through its invites.
   */
  async function onShareChange(ch: { grant: ServerShareGrant; signature: string; end?: ShareEnd }): Promise<void> {
    const access = deps.access();
    const refs = deps.store.servicesFor(ch.grant.shareId);
    for (const ref of refs) {
      if (access) await noteLocally(access, ref, ch.grant, !!ch.end).catch(() => {});
      deps.record(ref, shareEntry(ch.grant, ch.signature, ch.end));
    }
    if (ch.end) await deps.store.dropShare(ch.grant.shareId);
  }

  return { handle, onShareChange };
}

export type ShareInvites = ReturnType<typeof buildShareInvites>;
