/**
 * Who a signing key is on this box (docs/service-access-gating.md, "Account
 * members, ranks and who may change them").
 *
 * A sign-in to an app (knock, visit proof, establish-session) is signed by one
 * key. The box classifies it itself:
 *
 *   - a DEVICE of the account that owns the box: its account device key is in
 *     the device book, every grant verified here under the keys the box pins.
 *     An `admin`-scope grant signed by the admin root is an admin device; any
 *     other verifying grant a non-admin device. The account's legacy AID counts
 *     as a non-admin device (admin on a box with no admin root);
 *   - a CO-MANAGER: the member key of an active share of this server;
 *   - otherwise nobody (an invited person is found on the app's allow-list).
 *
 * The book comes from `.com` (`GET /api/users/<u>/device-grants`, the box's
 * read token) but `.com` can only drop a device from it: it can't sign a grant.
 * A grant's expiry is a refresh horizon, not an authority horizon
 * (device-admin-tier-spec §4.1).
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileDurable } from "./durableFile.js";
import {
  DEVICE_SCOPES,
  verifyDeviceCapabilityGrant,
  type AdminGrantView,
  type DeviceCapabilityGrant,
  type DeviceScope,
} from "@flagship/protocol";

export type DeviceTier = "admin" | "member";

export type Principal =
  | { kind: "device"; pub: string; deviceId: string | null; tier: DeviceTier; legacy: boolean }
  | { kind: "co-manager"; pub: string; shareId: string; label: string };

/** What the access store asks about a signing key. */
export interface PrincipalResolver {
  /** Who `pubHex` is on this box, or null (an invited person, or nobody). */
  classify(pubHex: string): Principal | null;
  /** Refresh what the box knows when `pubHex` is unknown (bounded; never throws). */
  ensure(pubHex: string): Promise<void>;
  /** Every device of the account in the book (the legacy AID excluded). */
  devices(): Extract<Principal, { kind: "device" }>[];
  /** Every active co-manager of this server. */
  coManagers(): Extract<Principal, { kind: "co-manager" }>[];
  /** The owner AID, hex: every account device shows to an app as this one person. */
  ownerAidHex(): string | null;
}

/** One grant as `.com` lists it (and the book keeps it on disk). */
export interface ListedGrant {
  grantId: string;
  username: string;
  deviceId: string;
  devicePubHex: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  signatureHex: string;
  signerRoot?: string;
}

interface BookDevice {
  deviceId: string;
  pub: string;
  tier: DeviceTier;
  grant: ListedGrant;
}

export interface AccountDeviceBookOptions {
  /** Cache file (re-verified on load). */
  path: string;
  username: string;
  /** The pinned keys, read on every verify (a rotation may change them). */
  ownerIrkPub: () => Uint8Array;
  adminRootPub: () => Uint8Array | undefined;
  ownerAidHex?: string;
  /** `.com`'s list of the account's grants (`{grants:[…]}`), or null when unreachable. */
  fetchGrants?: () => Promise<unknown>;
  now?: () => number;
  /** Least time between two refreshes asked for by an unknown key. Default 30 s. */
  minRefreshMs?: number;
  log?: (m: string) => void;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SCOPES = new Set<string>(DEVICE_SCOPES);

export class AccountDeviceBook {
  private byPub = new Map<string, BookDevice>();
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: AccountDeviceBookOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.opts.path, "utf8")) as { grants?: unknown };
      this.adopt(raw.grants);
    } catch {
      this.byPub.clear();
    }
  }

  /** Verify and take `.com`'s list; persist it. Keeps the old book when `.com` is unreachable. */
  async refresh(): Promise<void> {
    if (!this.opts.fetchGrants) return;
    this.refreshing ??= (async () => {
      this.lastRefresh = this.now();
      try {
        const body = (await this.opts.fetchGrants!()) as { grants?: unknown } | null;
        if (!body || !Array.isArray(body.grants)) return;
        this.adopt(body.grants);
        await this.persist();
      } catch (e) {
        this.opts.log?.(`[device-book] refresh failed: ${String((e as Error)?.message ?? e)}`);
      }
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  /** Refresh when `pubHex` isn't known and the last refresh is older than `minRefreshMs`. */
  async ensure(pubHex: string): Promise<void> {
    const pub = pubHex.toLowerCase();
    if (this.byPub.has(pub) || pub === this.opts.ownerAidHex?.toLowerCase()) return;
    if (this.now() - this.lastRefresh < (this.opts.minRefreshMs ?? 30_000)) return;
    await this.refresh();
  }

  classify(pubHex: string): Extract<Principal, { kind: "device" }> | null {
    const pub = pubHex.toLowerCase();
    const d = this.byPub.get(pub);
    if (d) return { kind: "device", pub, deviceId: d.deviceId, tier: d.tier, legacy: false };
    if (this.opts.ownerAidHex && pub === this.opts.ownerAidHex.toLowerCase()) {
      return { kind: "device", pub, deviceId: null, tier: this.pinned() ? "member" : "admin", legacy: true };
    }
    return null;
  }

  devices(): Extract<Principal, { kind: "device" }>[] {
    return [...this.byPub.values()].map((d) => ({
      kind: "device" as const,
      pub: d.pub,
      deviceId: d.deviceId,
      tier: d.tier,
      legacy: false,
    }));
  }

  /** The admin devices' grants, for the sensitive-order gate (`authorizeSensitiveOrder`). */
  adminGrants(): AdminGrantView[] {
    const out: AdminGrantView[] = [];
    for (const d of this.byPub.values()) {
      if (d.tier !== "admin" || !this.pinned()) continue;
      const g = toGrant(d.grant);
      if (g) out.push({ grant: g, signatureHex: d.grant.signatureHex, signerRoot: "admin-root", revokedAt: null });
    }
    return out;
  }

  private pinned(): boolean {
    const root = this.opts.adminRootPub();
    return !!root && root.length === 32;
  }

  private adopt(raw: unknown): void {
    const next = new Map<string, BookDevice>();
    if (Array.isArray(raw)) {
      for (const r of raw) {
        const listed = parseListed(r);
        if (!listed || listed.username.toLowerCase() !== this.opts.username.toLowerCase()) continue;
        const tier = this.verify(listed);
        if (!tier) continue;
        const prev = next.get(listed.devicePubHex);
        if (prev && (prev.tier === "admin" || tier === "member")) continue;
        next.set(listed.devicePubHex, { deviceId: listed.deviceId, pub: listed.devicePubHex, tier, grant: listed });
      }
    }
    this.byPub = next;
  }

  private verify(l: ListedGrant): DeviceTier | null {
    const g = toGrant(l);
    if (!g) return null;
    const sig = fromHex(l.signatureHex);
    if (!sig) return null;
    const root = this.opts.adminRootPub();
    if (root && root.length === 32) {
      if (verifyDeviceCapabilityGrant(g, sig, root)) return g.scopes.includes("admin") ? "admin" : "member";
      return verifyDeviceCapabilityGrant(g, sig, this.opts.ownerIrkPub()) ? "member" : null;
    }
    return verifyDeviceCapabilityGrant(g, sig, this.opts.ownerIrkPub()) ? "admin" : null;
  }

  private async persist(): Promise<void> {
    const grants = [...this.byPub.values()].map((d) => d.grant);
    await writeFileDurable(this.opts.path, JSON.stringify({ grants }));
  }
}

/** A share this server holds, as the resolver needs it. */
export interface ShareView {
  shareId: string;
  memberPubHex: string;
  label: string;
}

/**
 * The box's resolver: the device book plus the active shares. Either may be
 * wired late (the share store comes up with the local API).
 */
export class AccessPrincipals implements PrincipalResolver {
  book: AccountDeviceBook | null = null;
  shares: (() => ShareView[]) | null = null;

  constructor(private readonly ownerAid: string | null = null) {}

  classify(pubHex: string): Principal | null {
    const pub = pubHex.toLowerCase();
    const d = this.book?.classify(pub);
    if (d) return d;
    const s = this.shares?.().find((x) => x.memberPubHex.toLowerCase() === pub);
    if (s) return { kind: "co-manager", pub, shareId: s.shareId, label: s.label };
    if (!this.book && this.ownerAid && pub === this.ownerAid) {
      return { kind: "device", pub, deviceId: null, tier: "admin", legacy: true };
    }
    return null;
  }

  async ensure(pubHex: string): Promise<void> {
    if (this.classify(pubHex)) return;
    await this.book?.ensure(pubHex);
  }

  devices(): Extract<Principal, { kind: "device" }>[] {
    return this.book?.devices() ?? [];
  }

  coManagers(): Extract<Principal, { kind: "co-manager" }>[] {
    return (this.shares?.() ?? []).map((s) => ({
      kind: "co-manager" as const,
      pub: s.memberPubHex.toLowerCase(),
      shareId: s.shareId,
      label: s.label,
    }));
  }

  ownerAidHex(): string | null {
    return this.ownerAid;
  }
}

function parseListed(r: unknown): ListedGrant | null {
  if (!r || typeof r !== "object") return null;
  const g = r as Record<string, unknown>;
  if (
    typeof g.grantId !== "string" ||
    typeof g.username !== "string" ||
    typeof g.deviceId !== "string" ||
    typeof g.devicePubHex !== "string" ||
    !HEX64.test(g.devicePubHex.toLowerCase()) ||
    !Array.isArray(g.scopes) ||
    typeof g.issuedAt !== "number" ||
    typeof g.expiresAt !== "number" ||
    typeof g.signatureHex !== "string"
  ) {
    return null;
  }
  if (!g.scopes.every((s) => typeof s === "string" && SCOPES.has(s))) return null;
  return {
    grantId: g.grantId,
    username: g.username,
    deviceId: g.deviceId,
    devicePubHex: g.devicePubHex.toLowerCase(),
    scopes: g.scopes as string[],
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    signatureHex: g.signatureHex.toLowerCase(),
    ...(typeof g.signerRoot === "string" ? { signerRoot: g.signerRoot } : {}),
  };
}

function toGrant(l: ListedGrant): DeviceCapabilityGrant | null {
  const pub = fromHex(l.devicePubHex);
  if (!pub || pub.length !== 32) return null;
  return {
    grantId: l.grantId,
    username: l.username.toLowerCase(),
    deviceId: l.deviceId,
    devicePubKey: pub,
    scopes: l.scopes as DeviceScope[],
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
  };
}

function fromHex(h: string): Uint8Array | null {
  if (!/^([0-9a-f]{2})*$/i.test(h)) return null;
  return Uint8Array.from(Buffer.from(h, "hex"));
}
