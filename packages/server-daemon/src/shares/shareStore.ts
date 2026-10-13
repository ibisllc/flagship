/**
 * The shares this box honours (docs/share-a-server.md): each is the owner's
 * signed grant, kept with the other account's signed acceptance, plus the
 * share ids that ended (revoked or left), which never come back.
 *
 * `<dataDir>/shares.json` (mode 0600). Every grant re-verifies against the
 * owner's sensitive key on load, so a file edit can't add a share.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseServerShareAccept,
  parseServerShareGrant,
  verifyServerShareAccept,
  type ServerShareAccept,
  type ServerShareGrant,
} from "@flagship/protocol";

export interface HeldShare {
  grant: ServerShareGrant;
  signature: string;
  accept: ServerShareAccept;
  acceptSignature: string;
  /** First grant for this id (ms). */
  sharedAt: number;
  lastSeenAt: number | null;
}

export interface EndedShare {
  shareId: string;
  label: string;
  endedAt: number;
  reason: "revoked" | "left";
}

export type PutShareResult =
  | { ok: true; created: boolean; share: HeldShare }
  | { ok: false; status: number; error: string };

export interface ShareStoreOptions {
  serverDomain: string;
  /** The owner's sensitive key signed this grant. */
  verifyOwnerGrant: (g: ServerShareGrant, sig: Uint8Array) => boolean;
  now?: () => number;
}

const MAX_ACTIVE = 100;
const MAX_ENDED = 1000;

export class ShareStore {
  private readonly active = new Map<string, HeldShare>();
  private readonly ended = new Map<string, EndedShare>();
  /** `.com` share-ends cursor (ms). */
  private endsCursor = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  /** `path` null ⇒ memory only (tests). */
  constructor(
    private readonly path: string | null,
    private readonly opts: ShareStoreOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<{ dropped: number }> {
    if (!this.path) return { dropped: 0 };
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { dropped: 0 };
      throw e;
    }
    const parsed = JSON.parse(raw) as { active?: unknown[]; ended?: unknown[]; endsCursor?: unknown };
    let dropped = 0;
    for (const r of Array.isArray(parsed.ended) ? parsed.ended : []) {
      const e = r as Partial<EndedShare>;
      if (typeof e.shareId !== "string" || typeof e.endedAt !== "number") continue;
      this.ended.set(e.shareId, {
        shareId: e.shareId,
        label: typeof e.label === "string" ? e.label : "",
        endedAt: e.endedAt,
        reason: e.reason === "left" ? "left" : "revoked",
      });
    }
    for (const r of Array.isArray(parsed.active) ? parsed.active : []) {
      const h = this.verifyHeld(r);
      if (!h || this.ended.has(h.grant.shareId)) {
        dropped++;
        continue;
      }
      this.active.set(h.grant.shareId, h);
    }
    if (typeof parsed.endsCursor === "number") this.endsCursor = parsed.endsCursor;
    return { dropped };
  }

  private verifyHeld(r: unknown): HeldShare | null {
    const o = r as Record<string, unknown>;
    const grant = parseServerShareGrant(o?.grant);
    const accept = parseServerShareAccept(o?.accept);
    if (!grant || !accept || typeof o.signature !== "string" || typeof o.acceptSignature !== "string") return null;
    if (!this.chainOk(grant, o.signature, accept, o.acceptSignature)) return null;
    return {
      grant,
      signature: o.signature,
      accept,
      acceptSignature: o.acceptSignature,
      sharedAt: typeof o.sharedAt === "number" ? o.sharedAt : grant.issuedAt,
      lastSeenAt: typeof o.lastSeenAt === "number" ? o.lastSeenAt : null,
    };
  }

  private chainOk(grant: ServerShareGrant, sigHex: string, accept: ServerShareAccept, acceptSigHex: string): boolean {
    const sig = hexBytes(sigHex);
    const acceptSig = hexBytes(acceptSigHex);
    if (!sig || !acceptSig) return false;
    if (grant.serverDomain !== this.opts.serverDomain) return false;
    if (!this.opts.verifyOwnerGrant(grant, sig)) return false;
    if (accept.serverDomain !== grant.serverDomain || accept.shareId !== grant.shareId) return false;
    if (accept.memberPubHex !== grant.memberPubHex) return false;
    return verifyServerShareAccept(accept, acceptSig, hexBytes(accept.memberPubHex)!);
  }

  get(shareId: string): HeldShare | null {
    return this.active.get(shareId) ?? null;
  }

  isEnded(shareId: string): boolean {
    return this.ended.has(shareId);
  }

  list(): HeldShare[] {
    return [...this.active.values()].sort((a, b) => a.sharedAt - b.sharedAt);
  }

  listEnded(): EndedShare[] {
    return [...this.ended.values()].sort((a, b) => b.endedAt - a.endedAt);
  }

  cursor(): number {
    return this.endsCursor;
  }

  /**
   * Take a new or changed grant. The first grant for an id must carry the
   * other account's acceptance; a change keeps the same key and a later time.
   */
  async put(
    grant: ServerShareGrant,
    signature: string,
    accept?: ServerShareAccept,
    acceptSignature?: string,
  ): Promise<PutShareResult> {
    if (grant.serverDomain !== this.opts.serverDomain) return { ok: false, status: 403, error: "grant is for a different server" };
    if (this.ended.has(grant.shareId)) return { ok: false, status: 410, error: "share-ended" };
    const held = this.active.get(grant.shareId);
    let a = accept;
    let aSig = acceptSignature;
    if (held) {
      if (grant.memberPubHex !== held.grant.memberPubHex) return { ok: false, status: 409, error: "a share keeps its key" };
      if (grant.issuedAt <= held.grant.issuedAt) return { ok: false, status: 409, error: "a newer grant is already applied" };
      a ??= held.accept;
      aSig ??= held.acceptSignature;
    }
    if (!a || !aSig) return { ok: false, status: 400, error: "the first grant needs the acceptance" };
    if (!this.chainOk(grant, signature, a, aSig)) return { ok: false, status: 403, error: "invalid signature" };
    for (const other of this.active.values()) {
      if (other.grant.shareId !== grant.shareId && other.grant.memberPubHex === grant.memberPubHex) {
        return { ok: false, status: 409, error: "this key already holds another share" };
      }
    }
    if (!held && this.active.size >= MAX_ACTIVE) return { ok: false, status: 409, error: "too many shares" };
    const share: HeldShare = {
      grant,
      signature: signature.toLowerCase(),
      accept: a,
      acceptSignature: aSig.toLowerCase(),
      sharedAt: held?.sharedAt ?? this.now(),
      lastSeenAt: held?.lastSeenAt ?? null,
    };
    this.active.set(grant.shareId, share);
    await this.save();
    return { ok: true, created: !held, share };
  }

  /** End a share for good. Returns the ended share, or null when it wasn't active or already ended. */
  async end(shareId: string, reason: EndedShare["reason"]): Promise<EndedShare | null> {
    if (this.ended.has(shareId)) return null;
    const held = this.active.get(shareId);
    this.active.delete(shareId);
    const e: EndedShare = { shareId, label: held?.grant.label ?? "", endedAt: this.now(), reason };
    this.ended.set(shareId, e);
    while (this.ended.size > MAX_ENDED) {
      const oldest = [...this.ended.values()].sort((x, y) => x.endedAt - y.endedAt)[0]!;
      this.ended.delete(oldest.shareId);
    }
    await this.save();
    return held ? e : null;
  }

  async touch(shareId: string): Promise<void> {
    const h = this.active.get(shareId);
    if (!h) return;
    h.lastSeenAt = this.now();
    await this.save();
  }

  async setCursor(ms: number): Promise<void> {
    if (ms <= this.endsCursor) return;
    this.endsCursor = ms;
    await this.save();
  }

  private save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const body = JSON.stringify({ active: [...this.active.values()], ended: [...this.ended.values()], endsCursor: this.endsCursor });
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, path);
    });
    return this.chain;
  }
}

export function defaultShareStorePath(dataDir: string): string {
  return join(dataDir, "shares.json");
}

export function hexBytes(h: string): Uint8Array | null {
  if (typeof h !== "string" || !/^([0-9a-fA-F]{2})+$/.test(h)) return null;
  return Uint8Array.from(Buffer.from(h, "hex"));
}
