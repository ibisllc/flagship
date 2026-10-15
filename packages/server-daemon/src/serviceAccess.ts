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

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  openInviteBundle,
  serviceInviteSecretHash,
  signServiceInviteCreateQuery,
  signServiceInviteListQuery,
  verifyAcceptServiceInvite,
  verifyCreateServiceInvite,
  verifyRedeemServiceInvite,
  verifyRemoveServiceAllow,
  verifyServiceVisitProof,
  verifySetServiceAccessMode,
  type AcceptServiceInvite,
  type CreateServiceInvite,
  type InviteBundle,
  type Keypair,
  type RemoveServiceAllow,
  type ServiceAccessMode,
  type ServiceInviteCreateQuery,
  type ServiceInviteListQuery,
  type ServiceVisitProof,
  type SetServiceAccessMode,
  APP_MEMBER_ROLES,
  parseServiceAccessModeV2,
  parseServiceAllowRemoveV2,
  verifyRevokeServiceInvite,
  verifyServiceAccessModeV2,
  verifyServiceAllowRemoveV2,
  type AdminGrantView,
  type AppMemberRoleTarget,
  type RevokeServiceInvite,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { Principal, PrincipalResolver } from "./accessPrincipals.js";

const H = { "content-type": "application/json" };

/** Header a restricted-service visitor presents the AID-signed proof under. */
export const VISIT_PROOF_HEADER = "x-flagship-visit";

interface ServiceAccessEntry {
  mode: ServiceAccessMode;
  /** Lower-hex bound AIDs allowed to reach a restricted service. */
  allow: string[];
  /**
   * Grants: inviteId → the AIDs that joined through that invite (a personal
   * invite holds one, a group link many). One person can hold several grants
   * (a personal invite and group links all bind the same per-author contact
   * AID); revoking one grant leaves the others. The AIDs also live in `allow`.
   * Binds recorded before personal invites were tracked here have no grant.
   */
  groups: Record<string, string[]>;
  /** Owner-set roles (docs/service-access-gating.md, "Open mode + members"). */
  roles: MemberRoles;
}

/**
 * Roles the owner set with signed `flagship/app-member-role/v1` orders, on
 * Flagship's three ordered ranks (only the box owner is `owner`). Every
 * redemption of an invite is its own grant: its role is its own (`grants`),
 * else the invite's (`invites`), else the app's default. A member's role is
 * the highest of their live grants and of any role set on them directly
 * (`aids`, for members who joined before grants were tracked).
 */
export interface MemberRoles {
  /** member AID → role */
  aids: Record<string, string>;
  /** inviteId → role, for everyone who joins through that invite */
  invites: Record<string, string>;
  /** `<inviteId>/<aid>` → role of one person's join (every redemption is its own grant) */
  grants: Record<string, string>;
  /** order target → the issuedAt of the last order applied to it (replay guard) */
  seq: Record<string, number>;
  /**
   * inviteId → who signed its create, as the box itself verified it: `admin`
   * (the admin root; on a box with no admin root, the owner key) or `member`
   * (the account's membership key on an admin-pinned box). A member invite's
   * joins are capped at Member unless an admin-signed role order raised them.
   * Invites bound before this was recorded have no entry (uncapped).
   */
  tiers: Record<string, string>;
  /**
   * inviteId → the key that signed its create, as the box verified it (the
   * admin root, an admin device's key or a non-admin device's key). Sticky:
   * set before anyone is bound and never replaced. A non-admin creator's links
   * let new people in only while that device is manager-class in the app, and
   * only that device (or an admin) may withdraw them.
   */
  creators: Record<string, string>;
  /**
   * Admin overrides of the account's own people (docs/service-access-gating.md
   * "Account members"): `device:<pub>` or `share:<shareId>` → `member`,
   * `manager`, `master` or `refused`. An override replaces the default
   * (admin device master, other devices and co-managers manager).
   */
  ranks: Record<string, string>;
}

/** Who signed an invite's create (docs/service-access-gating.md "Account members"). */
export type InviteTier = "admin" | "member";

/** An admin override of an account device or co-manager in one app. */
export type AccountRank = MemberRole | "refused";

/** The ranks an owner can give, lowest first (their wire names; the one place on the box). */
export const MEMBER_ROLE_LADDER = APP_MEMBER_ROLES;
export type MemberRole = (typeof MEMBER_ROLE_LADDER)[number];

/**
 * A rank: older role names map onto it (viewer → member, editor → manager,
 * admin → master), a stored or legacy `owner` reads as master (there is no
 * owner rank in apps), anything else is null.
 */
export function ladderRole(role: string | null | undefined): MemberRole | null {
  switch (role) {
    case "member":
    case "viewer":
      return "member";
    case "manager":
    case "editor":
      return "manager";
    case "master":
    case "admin":
    case "owner":
      return "master";
    default:
      return null;
  }
}

function higher(a: MemberRole | null, b: MemberRole | null): MemberRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return MEMBER_ROLE_LADDER.indexOf(a) >= MEMBER_ROLE_LADDER.indexOf(b) ? a : b;
}

function emptyRoles(): MemberRoles {
  return { aids: {}, invites: {}, grants: {}, seq: {}, tiers: {}, creators: {}, ranks: {} };
}

function readRoles(v: unknown): MemberRoles {
  const out = emptyRoles();
  if (!v || typeof v !== "object") return out;
  const r = v as Record<string, unknown>;
  const strMap = (m: unknown, into: Record<string, string>) => {
    if (!m || typeof m !== "object") return;
    for (const [k, x] of Object.entries(m)) if (typeof x === "string") into[k] = x;
  };
  strMap(r.aids, out.aids);
  strMap(r.invites, out.invites);
  strMap(r.grants, out.grants);
  strMap(r.tiers, out.tiers);
  strMap(r.creators, out.creators);
  strMap(r.ranks, out.ranks);
  for (const [k, v] of Object.entries(out.creators)) if (!/^[0-9a-f]{64}$/.test(v)) delete out.creators[k];
  for (const [k, v] of Object.entries(out.ranks)) {
    if (!/^(device:[0-9a-f]{64}|share:[0-9a-f]{32})$/.test(k) || accountRank(v) === null) delete out.ranks[k];
  }
  if (r.seq && typeof r.seq === "object") {
    for (const [k, x] of Object.entries(r.seq)) if (typeof x === "number") out.seq[k] = x;
  }
  return out;
}

function copyRoles(r: MemberRoles): MemberRoles {
  return {
    aids: { ...r.aids },
    invites: { ...r.invites },
    grants: { ...r.grants },
    seq: { ...r.seq },
    tiers: { ...r.tiers },
    creators: { ...r.creators },
    ranks: { ...r.ranks },
  };
}

function accountRank(v: string | undefined): AccountRank | null {
  if (v === "refused") return "refused";
  return v === "member" || v === "manager" || v === "master" ? v : null;
}

/** A rank at least Manager: the account people who may invite (at Member) and withdraw their own. */
export function isManagerClass(rank: MemberRole | null): boolean {
  return rank === "manager" || rank === "master";
}

type PersistShape = Record<string, Omit<ServiceAccessEntry, "roles"> & { roles?: MemberRoles }>;

/** Allow-list size cap per service (M5) — bounds a runaway/abusive group link. */
export const ALLOW_LIST_CAP = 5000;

/**
 * Persisted per-service access state — mode, allow-list, grants, ranks. Default
 * mode is `open`, so a service with no row behaves exactly as before this
 * feature. Who a signing key is (an account device, a co-manager) comes from
 * the {@link PrincipalResolver}; the account's people get default ranks the
 * admin can override per app (docs/service-access-gating.md "Account members").
 */
export class ServiceAccessStore {
  private byService = new Map<string, ServiceAccessEntry>();
  private readonly statePath: string;
  private readonly legacyPath: string | null;
  /**
   * M4 fail-open alert: set true when `load` hit absent/corrupt state and fell
   * open (every service back to OPEN). Surfaced to the owner so a silent revert
   * to OPEN is visible, not hidden. Distinguished from a genuinely-empty store.
   */
  private loadFellOpen = false;
  private loadError: string | null = null;
  private readonly onFailOpen?: (info: { error: string }) => void;

  private readonly ownerAidHex: string | null;
  private principals: PrincipalResolver | null;

  constructor(
    statePath = "/var/flagship/data/flagship-access/service-access.json",
    opts: {
      onFailOpen?: (info: { error: string }) => void;
      /**
       * The owner's stable AID. With no resolver it is the owner (an admin
       * device, master); with one, the resolver decides (a legacy device).
       */
      ownerAidHex?: string;
      /** Who a key is on this box (account devices, co-managers). */
      principals?: PrincipalResolver;
      /**
       * Where older boxes kept the state (outside the data folder Migrate
       * carries). Read once when `statePath` doesn't exist yet, then moved.
       */
      legacyPath?: string;
    } = {},
  ) {
    this.statePath = statePath;
    this.legacyPath = opts.legacyPath ?? null;
    this.onFailOpen = opts.onFailOpen;
    this.ownerAidHex = opts.ownerAidHex?.toLowerCase() ?? null;
    this.principals = opts.principals ?? null;
  }

  /** Wire (or replace) who-is-who on this box. */
  setPrincipals(p: PrincipalResolver): void {
    this.principals = p;
  }

  /** Whether the owner can be let through a restricted gate on this box. */
  knowsOwner(): boolean {
    return this.ownerAidHex !== null || (this.principals?.devices().length ?? 0) > 0;
  }

  /** Whether `aidHex` is the owner's stable AID (false when none is pinned). */
  isOwner(aidHex: string): boolean {
    return this.ownerAidHex !== null && aidHex.toLowerCase() === this.ownerAidHex;
  }

  /** Who a key is on this box: an account device, a co-manager, or null. */
  principal(pubHex: string): Principal | null {
    const pub = pubHex.toLowerCase();
    const p = this.principals?.classify(pub) ?? null;
    if (p) return p;
    if (!this.principals && this.ownerAidHex !== null && pub === this.ownerAidHex) {
      return { kind: "device", pub, deviceId: null, tier: "admin", legacy: true };
    }
    return null;
  }

  /** Learn about an unknown key before deciding (refreshes the device book; bounded). */
  async ensureKnown(pubHex: string): Promise<void> {
    if (this.principal(pubHex)) return;
    await this.principals?.ensure(pubHex.toLowerCase()).catch(() => {});
  }

  /** The account devices in the book and the co-managers (for the members list). */
  accountPeople(): Principal[] {
    if (!this.principals) return [];
    return [...this.principals.devices(), ...this.principals.coManagers()];
  }

  /** The id an app knows this person by: every device of the owning account is the one owner. */
  appIdentityKey(pubHex: string): string {
    const p = this.principal(pubHex);
    if (p?.kind === "device") return this.principals?.ownerAidHex() ?? this.ownerAidHex ?? p.pub;
    return pubHex.toLowerCase();
  }

  async load(): Promise<void> {
    let raw: PersistShape;
    let fromLegacy = false;
    try {
      raw = JSON.parse(await readFile(this.statePath, "utf8")) as PersistShape;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      let legacy: PersistShape | null = null;
      if (code === "ENOENT" && this.legacyPath) {
        try {
          legacy = JSON.parse(await readFile(this.legacyPath, "utf8")) as PersistShape;
        } catch (le) {
          if ((le as NodeJS.ErrnoException)?.code !== "ENOENT") e = le;
        }
      }
      if (legacy) {
        raw = legacy;
        fromLegacy = true;
      } else {
        // A genuinely-absent file (first boot, no restricted service yet) is the
        // normal empty case — NOT an alert. A PRESENT-but-corrupt file is the M4
        // case: we fall open (so an existing OPEN service is never bricked) but
        // RAISE a visible owner flag instead of failing silently.
        const c = (e as NodeJS.ErrnoException)?.code;
        this.byService.clear();
        this.loadFellOpen = c !== "ENOENT";
        this.loadError = this.loadFellOpen ? String((e as Error)?.message ?? e) : null;
        if (this.loadFellOpen) {
          console.error(
            `[service-access] state file unreadable (${this.loadError}); FAILING OPEN — restricted services revert to open until repaired`,
          );
          this.onFailOpen?.({ error: this.loadError ?? "corrupt state" });
        }
        return;
      }
    }
    this.byService.clear();
    this.loadFellOpen = false;
    this.loadError = null;
    for (const [ref, e] of Object.entries(raw ?? {})) {
      if (!e || (e.mode !== "open" && e.mode !== "restricted")) continue;
      const allow = Array.isArray(e.allow)
        ? e.allow.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase())
        : [];
      const groups: Record<string, string[]> = {};
      if (e.groups && typeof e.groups === "object") {
        for (const [gid, members] of Object.entries(e.groups)) {
          if (Array.isArray(members)) {
            groups[gid] = [...new Set(members.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()))];
          }
        }
      }
      this.byService.set(ref, { mode: e.mode, allow: [...new Set(allow)], groups, roles: readRoles(e.roles) });
    }
    if (fromLegacy && this.legacyPath) {
      // Into the data folder Migrate carries; the old file is set aside.
      await this.persist();
      await rename(this.legacyPath, `${this.legacyPath}.moved`).catch(() => {});
    }
  }

  /** M4 — true iff the last load fell open because the state file was corrupt. */
  failedOpen(): boolean {
    return this.loadFellOpen;
  }

  /** M4 — the load error message when `failedOpen()`, else null. */
  failOpenError(): string | null {
    return this.loadError;
  }

  mode(serviceRef: string): ServiceAccessMode {
    return this.byService.get(serviceRef)?.mode ?? "open";
  }

  /**
   * Whether `visitorAidHex` is let into `serviceRef`: an account device or a
   * co-manager unless an admin refused them there; anyone else only while on
   * the app's allow-list.
   */
  isAllowed(serviceRef: string, visitorAidHex: string): boolean {
    const key = visitorAidHex.toLowerCase();
    const p = this.principal(key);
    if (p) return this.accountRank(serviceRef, p) !== null;
    const e = this.byService.get(serviceRef);
    if (!e) return false; // only relevant when restricted; no row ⇒ no allow-list
    return e.allow.includes(key);
  }

  /** The admin override set on an account device or co-manager in an app (null: none). */
  rankOverride(serviceRef: string, p: Principal): AccountRank | null {
    return accountRank(this.byService.get(serviceRef)?.roles.ranks[rankKey(p)]);
  }

  /** An account device's or co-manager's rank in an app: the override, else the default; null when refused. */
  accountRank(serviceRef: string, p: Principal): MemberRole | null {
    const set = this.rankOverride(serviceRef, p);
    if (set === "refused") return null;
    if (set) return set;
    return p.kind === "device" && p.tier === "admin" ? "master" : "manager";
  }

  /**
   * Anyone's rank in an app: account people by {@link accountRank}, invited
   * people by their grants ({@link roleOf}, else the app's default); null when
   * they aren't let in.
   */
  effectiveRank(serviceRef: string, pubHex: string, defaultRole: string): MemberRole | null {
    const p = this.principal(pubHex);
    if (p) return this.accountRank(serviceRef, p);
    if (!this.isAllowed(serviceRef, pubHex)) return null;
    return this.roleOf(serviceRef, pubHex, defaultRole) ?? ladderRole(defaultRole) ?? "member";
  }

  allowList(serviceRef: string): string[] {
    return [...(this.byService.get(serviceRef)?.allow ?? [])];
  }

  private entry(serviceRef: string): ServiceAccessEntry {
    let e = this.byService.get(serviceRef);
    if (!e) {
      e = { mode: "open", allow: [], groups: {}, roles: emptyRoles() };
      this.byService.set(serviceRef, e);
    }
    return e;
  }

  /** A service's mode, allow-list and roles, to copy it to another server; null when it has none. */
  exportEntry(
    serviceRef: string,
  ): { mode: ServiceAccessMode; allow: string[]; groups: Record<string, string[]>; roles: MemberRoles } | null {
    const e = this.byService.get(serviceRef);
    if (!e) return null;
    return {
      mode: e.mode,
      allow: [...e.allow],
      groups: Object.fromEntries(Object.entries(e.groups).map(([k, v]) => [k, [...v]])),
      roles: copyRoles(e.roles),
    };
  }

  /** Take a copied service's mode and allow-list (appCopy/), replacing whatever this box had. */
  async importEntry(
    serviceRef: string,
    e: {
      mode: ServiceAccessMode;
      allow: readonly string[];
      groups: Readonly<Record<string, readonly string[]>>;
      roles?: MemberRoles;
    },
  ): Promise<void> {
    const hex = (a: string) => /^[0-9a-f]{64}$/.test(a);
    const allow = [...new Set(e.allow.map((a) => a.toLowerCase()).filter(hex))].slice(0, ALLOW_LIST_CAP);
    const groups: Record<string, string[]> = {};
    for (const [id, aids] of Object.entries(e.groups)) {
      const kept = aids.map((a) => a.toLowerCase()).filter((a) => allow.includes(a));
      if (kept.length > 0) groups[id] = kept;
    }
    const roles = readRoles(e.roles);
    for (const aid of Object.keys(roles.aids)) if (!allow.includes(aid)) delete roles.aids[aid];
    for (const key of Object.keys(roles.grants)) {
      const [id, aid] = key.split("/");
      if (!groups[id!]?.includes(aid!)) delete roles.grants[key];
    }
    this.byService.set(serviceRef, { mode: e.mode === "restricted" ? "restricted" : "open", allow, groups, roles });
    await this.persist();
  }

  /** Drop everything about an app (its uninstall): a reinstall under the same id starts clean. */
  async forget(serviceRef: string): Promise<boolean> {
    if (!this.byService.delete(serviceRef)) return false;
    await this.persist();
    return true;
  }

  async setMode(serviceRef: string, mode: ServiceAccessMode): Promise<void> {
    this.entry(serviceRef).mode = mode;
    await this.persist();
  }

  /**
   * Apply a verified mode order, latest order wins: one no newer than the last
   * applied for this app is refused (`stale`).
   */
  async applyModeOrder(serviceRef: string, mode: ServiceAccessMode, issuedAt: number): Promise<"ok" | "stale"> {
    const e = this.entry(serviceRef);
    const last = e.roles.seq.mode;
    if (last !== undefined && issuedAt <= last) return "stale";
    e.roles.seq.mode = issuedAt;
    e.mode = mode;
    await this.persist();
    return "ok";
  }

  /** Apply a verified removal order (latest order wins per person); true when someone was removed. */
  async applyRemoveOrder(serviceRef: string, aidHex: string, issuedAt: number): Promise<"removed" | "absent" | "stale"> {
    const aid = aidHex.toLowerCase();
    const e = this.entry(serviceRef);
    const key = `remove:${aid}`;
    const last = e.roles.seq[key];
    if (last !== undefined && issuedAt <= last) return "stale";
    e.roles.seq[key] = issuedAt;
    await this.persist();
    return (await this.removeAllowed(serviceRef, aid)) ? "removed" : "absent";
  }

  /**
   * Add an AID to a service's allow-list (idempotent). When `inviteId` is given
   * the AID is ALSO recorded under that group so a group-revoke can prune the
   * whole set. Returns whether the AID was newly added. Rejects (false) once the
   * list hits {@link ALLOW_LIST_CAP} unless the AID is already present.
   */
  async addAllowed(serviceRef: string, visitorAidHex: string, inviteId?: string): Promise<boolean> {
    const e = this.entry(serviceRef);
    const aid = visitorAidHex.toLowerCase();
    const already = e.allow.includes(aid);
    if (!already && e.allow.length >= ALLOW_LIST_CAP) {
      console.error(`[service-access] ${serviceRef} allow-list at cap (${ALLOW_LIST_CAP}); refusing add`);
      return false;
    }
    let changed = false;
    if (!already) {
      e.allow.push(aid);
      changed = true;
    }
    if (inviteId) {
      const g = (e.groups[inviteId] ??= []);
      if (!g.includes(aid)) {
        g.push(aid);
        changed = true;
      }
    }
    if (changed) await this.persist();
    return !already;
  }

  /** Remove an AID from a service's allow-list (idempotent). Also drops it from any group. */
  async removeAllowed(serviceRef: string, visitorAidHex: string): Promise<boolean> {
    const e = this.byService.get(serviceRef);
    if (!e) return false;
    const aid = visitorAidHex.toLowerCase();
    const before = e.allow.length;
    e.allow = e.allow.filter((x) => x !== aid);
    for (const gid of Object.keys(e.groups)) {
      e.groups[gid] = (e.groups[gid] ?? []).filter((x) => x !== aid);
      if (e.groups[gid]!.length === 0) delete e.groups[gid];
    }
    // A removed member keeps no role: on an open app they are an anonymous
    // visitor again, on a members-only one they are kept out.
    const hadRole = aid in e.roles.aids;
    delete e.roles.aids[aid];
    for (const key of Object.keys(e.roles.grants)) if (key.endsWith(`/${aid}`)) delete e.roles.grants[key];
    if (e.allow.length === before) {
      if (hadRole) await this.persist();
      return false;
    }
    await this.persist();
    return true;
  }

  /**
   * Group-prune: revoke EVERY AID bound via `inviteId` across a service (v2 group
   * revoke). Removes them from the allow-list + drops the group. Returns the count
   * pruned. `serviceRef` is optional — when omitted, prunes the group from every
   * service that carries it (the box revocation poller doesn't always know which).
   */
  async revokeGroup(inviteId: string, serviceRef?: string): Promise<number> {
    let pruned = 0;
    let changed = false;
    const refs = serviceRef ? [serviceRef] : [...this.byService.keys()];
    for (const ref of refs) {
      const e = this.byService.get(ref);
      if (!e) continue;
      const members = e.groups[inviteId];
      if (!members || members.length === 0) continue;
      delete e.groups[inviteId];
      delete e.roles.invites[inviteId];
      delete e.roles.tiers[inviteId];
      delete e.roles.creators[inviteId];
      for (const key of Object.keys(e.roles.grants)) if (key.startsWith(`${inviteId}/`)) delete e.roles.grants[key];
      // Revoking one grant leaves a person's others: only someone left with
      // no grant at all stops being a member.
      for (const aid of members) {
        if (this.grantsOf(e, aid).length > 0) continue;
        const before = e.allow.length;
        e.allow = e.allow.filter((x) => x !== aid);
        if (e.allow.length !== before) pruned++;
        delete e.roles.aids[aid];
      }
      changed = true;
    }
    if (changed) await this.persist();
    return pruned;
  }

  /** The apps on this box that know an invite (it was redeemed or accepted here). */
  servicesWithInvite(inviteId: string): string[] {
    return [...this.byService.entries()]
      .filter(([, e]) => inviteId in e.groups || inviteId in e.roles.creators || inviteId in e.roles.tiers)
      .map(([ref]) => ref);
  }

  private grantsOf(e: ServiceAccessEntry, aid: string): string[] {
    return Object.entries(e.groups)
      .filter(([, members]) => members.includes(aid))
      .map(([id]) => id);
  }

  /** The invites a member joined through (their grants), oldest first. */
  grants(serviceRef: string, aidHex: string): string[] {
    const e = this.byService.get(serviceRef);
    return e ? this.grantsOf(e, aidHex.toLowerCase()) : [];
  }

  /**
   * Record who signed an invite's create, BEFORE anyone is bound through it.
   * `member` is sticky: an invite once seen as a member invite is never
   * treated as an admin one, so a replayed or substituted create can only
   * lower a rank.
   */
  async setInviteTier(serviceRef: string, inviteId: string, tier: InviteTier): Promise<void> {
    const e = this.entry(serviceRef);
    const was = e.roles.tiers[inviteId];
    if (was === tier || was === "member") return;
    e.roles.tiers[inviteId] = tier;
    await this.persist();
  }

  /** Who signed an invite's create, as the box verified it (null: recorded before tiers). */
  inviteTier(serviceRef: string, inviteId: string): InviteTier | null {
    const t = this.byService.get(serviceRef)?.roles.tiers[inviteId];
    return t === "admin" || t === "member" ? t : null;
  }

  /** Record the key that signed an invite's create (first one wins). */
  async setInviteCreator(serviceRef: string, inviteId: string, pubHex: string): Promise<void> {
    const e = this.entry(serviceRef);
    if (e.roles.creators[inviteId]) return;
    e.roles.creators[inviteId] = pubHex.toLowerCase();
    await this.persist();
  }

  /** The key that signed an invite's create here (null: unknown or recorded before creators). */
  inviteCreator(serviceRef: string, inviteId: string): string | null {
    return this.byService.get(serviceRef)?.roles.creators[inviteId] ?? null;
  }

  /**
   * The rank a join gets when no admin-signed role order set one: the app's
   * default, except a member invite, which only ever lets people in at Member
   * (the default may be `master`, and old `admin` maps to master too).
   */
  private unsetRank(e: ServiceAccessEntry | undefined, inviteId: string, defaultRole: string): MemberRole {
    if (e?.roles.tiers[inviteId] === "member") return "member";
    return ladderRole(defaultRole) ?? "member";
  }

  /** The role an invite gives (unset: the app's default; a member invite: Member). */
  inviteRole(serviceRef: string, inviteId: string, defaultRole: string): MemberRole {
    const e = this.byService.get(serviceRef);
    const set = ladderRole(e?.roles.invites[inviteId]);
    return set ?? this.unsetRank(e, inviteId, defaultRole);
  }

  /** The role of one person's join through an invite: its own, else the invite's. */
  grantRole(serviceRef: string, inviteId: string, aidHex: string, defaultRole: string): MemberRole {
    const own = ladderRole(this.byService.get(serviceRef)?.roles.grants[`${inviteId}/${aidHex.toLowerCase()}`]);
    return own ?? this.inviteRole(serviceRef, inviteId, defaultRole);
  }

  /**
   * An invited person's role: an admin order on them (`aid:`) replaces
   * everything; otherwise the highest of their grants' roles; null when the
   * admin set none of those (the app's default then applies, through the
   * legacy membership store first).
   */
  roleOf(serviceRef: string, aidHex: string, defaultRole: string): MemberRole | null {
    const e = this.byService.get(serviceRef);
    if (!e) return null;
    const aid = aidHex.toLowerCase();
    const direct = ladderRole(e.roles.aids[aid]);
    if (direct !== null) return direct;
    let best: MemberRole | null = null;
    let anySet = false;
    for (const id of this.grantsOf(e, aid)) {
      const set = ladderRole(e.roles.grants[`${id}/${aid}`]) ?? ladderRole(e.roles.invites[id]);
      // A member invite's join counts as set (at Member), so the app's
      // default never stands in for it.
      if (set !== null || e.roles.tiers[id] === "member") anySet = true;
      best = higher(best, set ?? this.unsetRank(e, id, defaultRole));
    }
    return anySet ? best : null;
  }

  /** The roles the owner set on a service (a copy). */
  roles(serviceRef: string): MemberRoles {
    return copyRoles(this.byService.get(serviceRef)?.roles ?? emptyRoles());
  }

  /**
   * Remove a member only when they hold no grant any more (the revocation
   * poller's fallback for binds the grant map didn't capture).
   */
  async removeIfUngranted(serviceRef: string, aidHex: string): Promise<boolean> {
    const e = this.byService.get(serviceRef);
    if (!e || this.grantsOf(e, aidHex.toLowerCase()).length > 0) return false;
    return this.removeAllowed(serviceRef, aidHex);
  }

  /**
   * Apply a verified role order. `targetKey` is the order's target string; an
   * order no newer than the last one applied to that target is refused, so a
   * captured order can't be replayed or undo a later one.
   */
  async setRole(
    serviceRef: string,
    target: AppMemberRoleTarget,
    targetKey: string,
    role: MemberRole,
    issuedAt: number,
  ): Promise<"ok" | "stale"> {
    const e = this.entry(serviceRef);
    const last = e.roles.seq[targetKey];
    if (last !== undefined && issuedAt <= last) return "stale";
    e.roles.seq[targetKey] = issuedAt;
    if (target.kind === "aid") e.roles.aids[target.aid] = role;
    else if (target.kind === "invite") e.roles.invites[target.inviteId] = role;
    else e.roles.grants[`${target.inviteId}/${target.aid}`] = role;
    await this.persist();
    return "ok";
  }

  /** Apply a verified override of an account device (`device:<pub>`) or co-manager (`share:<id>`). */
  async setAccountRank(serviceRef: string, targetKey: string, rank: AccountRank, issuedAt: number): Promise<"ok" | "stale"> {
    const e = this.entry(serviceRef);
    const last = e.roles.seq[targetKey];
    if (last !== undefined && issuedAt <= last) return "stale";
    e.roles.seq[targetKey] = issuedAt;
    e.roles.ranks[targetKey] = rank;
    await this.persist();
    return "ok";
  }

  private async persist(): Promise<void> {
    const out: PersistShape = {};
    for (const [ref, e] of this.byService) {
      out[ref] = { mode: e.mode, allow: e.allow, groups: e.groups, roles: e.roles };
    }
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

/** The override key of an account person. */
export function rankKey(p: Principal): string {
  return p.kind === "device" ? `device:${p.pub}` : `share:${p.shareId}`;
}

/**
 * Cookie a browser carries the box-issued session under. Mirrors the existing
 * `Flagship-App-Session` bearer cookie (`serviceAccessGate.ts`, #84): the box
 * mints an OPAQUE random token (NOT a self-validating MAC — there is no new MAC
 * scheme) and looks it up server-side. A browser cannot set the AID-signed
 * `x-flagship-visit` header, so once a friend has redeemed (over their app/web)
 * the box hands them this cookie to reach the restricted service's WEBSITE.
 */
export const SESSION_COOKIE = "Flagship-App-Session";

/** Default browser-session lifetime — short-lived; re-issued via establish-session / a fresh redeem. */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;

interface SessionEntry {
  /** `<creator>-<slug>` this session is scoped to. A token reaches ONLY its service. */
  serviceRef: string;
  /** Lower-hex bound AID — re-checked against the allow-list on every request (so a revoke kills the cookie). */
  aid: string;
  /** Epoch-ms expiry. */
  expiresAt: number;
  /**
   * Phone-held opaque handle for the QR-login flow (docs "Web-experience
   * gating"). The PHONE authorizes a SEPARATE browser's session and holds THIS
   * id; it queries status + closes by it. Absent for sessions the friend's own
   * browser established (redeem / establish-session — no phone correlation).
   */
  secretId?: string;
  /** Browser UA recorded when the knock page was served — shown in "Open secured sessions". */
  browserAgent?: string;
  /** Session start (epoch-ms) — defaults to issue time. */
  startedAt?: number;
  /** Phone-initiated close: kills the browser cookie regardless of expiry. */
  closed?: boolean;
}

/** A phone-facing view of a session, addressed by its secretId. */
export interface SessionView {
  serviceRef: string;
  aid: string;
  browserAgent: string;
  startedAt: number;
  expiresAt: number;
  closed: boolean;
}

type SessionPersistShape = Record<string, SessionEntry>;

/**
 * Box-local browser-session store: an opaque token → { serviceRef, AID, expiry }.
 * Same atomically-replaced mode-0600 JSON file as `ServiceAccessStore`; reloaded
 * on boot so an in-flight browser session survives a daemon restart. Expired
 * rows are pruned lazily on lookup + eagerly on issue.
 */
export class ServiceSessionStore {
  private byToken = new Map<string, SessionEntry>();
  /** secretId → cookie token (the phone addresses a session by its secretId). */
  private bySecretId = new Map<string, string>();
  private readonly statePath: string;

  constructor(statePath = "/var/flagship/service-sessions.json") {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as SessionPersistShape;
      this.byToken.clear();
      this.bySecretId.clear();
      for (const [tok, e] of Object.entries(raw ?? {})) {
        if (
          !e ||
          typeof e.serviceRef !== "string" ||
          typeof e.aid !== "string" ||
          typeof e.expiresAt !== "number"
        ) {
          continue;
        }
        const entry: SessionEntry = {
          serviceRef: e.serviceRef,
          aid: e.aid.toLowerCase(),
          expiresAt: e.expiresAt,
        };
        if (typeof e.secretId === "string" && e.secretId.length > 0) entry.secretId = e.secretId;
        if (typeof e.browserAgent === "string") entry.browserAgent = e.browserAgent;
        if (typeof e.startedAt === "number") entry.startedAt = e.startedAt;
        if (e.closed === true) entry.closed = true;
        this.byToken.set(tok, entry);
        if (entry.secretId) this.bySecretId.set(entry.secretId, tok);
      }
    } catch {
      this.byToken.clear();
      this.bySecretId.clear();
    }
  }

  /**
   * Mint + persist a session token for an AID scoped to a service. Returns the
   * opaque cookie token. `extra` carries the QR-login fields — a `secretId`
   * (the phone's handle for the session) + the recorded `browserAgent`.
   */
  async issue(
    serviceRef: string,
    aidHex: string,
    now: number,
    ttlMs: number,
    extra?: { secretId?: string; browserAgent?: string; startedAt?: number },
  ): Promise<string> {
    this.pruneExpired(now);
    const token = bytesToHex(randomBytes(32));
    const entry: SessionEntry = {
      serviceRef,
      aid: aidHex.toLowerCase(),
      expiresAt: now + ttlMs,
      startedAt: extra?.startedAt ?? now,
    };
    if (extra?.secretId) entry.secretId = extra.secretId;
    if (extra?.browserAgent !== undefined) entry.browserAgent = extra.browserAgent;
    this.byToken.set(token, entry);
    if (entry.secretId) this.bySecretId.set(entry.secretId, token);
    await this.persist();
    return token;
  }

  /** Look up a live session for a cookie token, or null if absent/expired/closed. Does NOT check the allow-list. */
  lookup(token: string, now: number): { serviceRef: string; aid: string } | null {
    const e = this.byToken.get(token);
    if (!e) return null;
    if (e.closed || e.expiresAt <= now) {
      if (e.expiresAt <= now) this.drop(token);
      return null;
    }
    return { serviceRef: e.serviceRef, aid: e.aid };
  }

  /** A phone-facing view of the session a secretId addresses, or null if unknown. */
  lookupBySecretId(secretId: string): SessionView | null {
    const token = this.bySecretId.get(secretId);
    if (!token) return null;
    const e = this.byToken.get(token);
    if (!e) return null;
    return {
      serviceRef: e.serviceRef,
      aid: e.aid,
      browserAgent: e.browserAgent ?? "",
      startedAt: e.startedAt ?? 0,
      expiresAt: e.expiresAt,
      closed: e.closed === true,
    };
  }

  /** Phone-initiated close — kills the browser cookie. Idempotent; returns whether a session was closed. */
  async closeBySecretId(secretId: string): Promise<boolean> {
    const token = this.bySecretId.get(secretId);
    if (!token) return false;
    this.drop(token);
    await this.persist();
    return true;
  }

  /** Sign-out from the browser itself: kills the session its cookie names. Idempotent. */
  async closeByToken(token: string): Promise<boolean> {
    if (!this.byToken.has(token)) return false;
    this.drop(token);
    await this.persist();
    return true;
  }

  private drop(token: string): void {
    const e = this.byToken.get(token);
    this.byToken.delete(token);
    if (e?.secretId) this.bySecretId.delete(e.secretId);
  }

  private pruneExpired(now: number): void {
    for (const [tok, e] of this.byToken) {
      if (e.expiresAt <= now) this.drop(tok);
    }
  }

  private async persist(): Promise<void> {
    const out: SessionPersistShape = {};
    for (const [tok, e] of this.byToken) out[tok] = e;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

export type AccessDecision =
  | { allow: true; reason: "open" | "allow-listed" | "cookie" }
  | { allow: false; reason: "no-proof" | "bad-proof" | "not-allowed" | "stale-proof" };

export interface ServiceAccessHttpOptions {
  /** The box fqdn — the `serverId` the owner/visitor envelopes are bound to. */
  serverId: string;
  ownerIrkPub: Uint8Array;
  /**
   * The owner's STABLE AID pubkey (config-pinned `ownerAidPubHex`). v2
   * box-as-authority: the box verifies the `.com`-relayed signed create against
   * THIS (or the owner IRK, for the transition) before allow-listing — so a
   * rogue `.com` can't fabricate a binding by forging the owner's authority.
   * Optional: absent ⇒ the box verifies the create against the owner IRK only.
   */
  ownerAidPub?: Uint8Array;
  /**
   * The pinned admin master root. On an admin-pinned account `.com` accepts an
   * invite create only from the admin root, so the box must accept that
   * signature too or no invite of such an account could ever be redeemed.
   */
  adminRootPub?: Uint8Array;
  /**
   * The admin devices' grants from the device book: a device with an
   * admin-root-signed `admin` grant may sign admin-only orders too.
   */
  adminGrants?: () => readonly AdminGrantView[];
  store: ServiceAccessStore;
  /** Resolve `serviceRef` (`<creator>-<slug>`) → installed? Guards set-mode (422 if not). */
  serviceInstalled: (serviceRef: string) => boolean;
  /** Base URL of the control plane the box redeems against. */
  controlPlaneBaseUrl: string;
  /**
   * MANUAL-finalize create fetch (v2 box-as-authority, any-device finalize). The
   * author no longer carries the signed create in a per-device cache — at
   * `POST /api/service-access/accept` the box FETCHES the owner's signed create
   * from `.com` by the acceptance's inviteId, STK-signing the query (it holds no
   * owner key). These three are what that fetch needs. When ANY is absent the
   * accept path falls back to accepting a client-supplied `{create, createSig}`
   * in the body (back-compat / no-AID transition), so it never hard-breaks.
   */
  username?: string;
  /** The box's own FQDN — the server record `.com` resolves the STK against. */
  serverDomain?: string;
  /** The box's STK keypair — signs the by-inviteId create fetch. */
  stk?: Keypair;
  /** Injectable fetch (defaults to global). */
  fetchImpl?: typeof fetch;
  /**
   * Per-endpoint rate limit (M5): max requests per IP+endpoint per window.
   * Default 30/min. Applies to redeem / establish-session / accept (the knock
   * surface is rate-limited in serviceAccessWeb).
   */
  rateLimitPerMin?: number;
  /**
   * Household key provisioned to the box over its pinned pipe (UMK-derived;
   * flagshipserver.com never holds it). When present, the box can decrypt the
   * invite bundle (`{name, photo?}`) it stores as ciphertext. Optional — when
   * absent, `decryptBundle` returns null (the feature degrades, like SWK).
   */
  householdKey?: Uint8Array;
  /**
   * Browser-session store for the `Flagship-App-Session` cookie seam. When
   * present, a successful redeem (and `POST /api/service-access/establish-session`)
   * issues a cookie, and `decide` accepts it as well as the signed header — so a
   * friend who redeemed can reach the restricted service's WEBSITE in a plain
   * browser. Optional: absent ⇒ header-only enforcement (no behavior change).
   */
  sessions?: ServiceSessionStore;
  now?: () => number;
  /** Replay window for owner + visit + redeem envelopes. Default 5 min. */
  maxAgeMs?: number;
  /** Browser-session lifetime. Default 12h. */
  sessionTtlMs?: number;
}

/**
 * The serve-path decision: is this request allowed to reach `serviceRef`?
 * `open` ⇒ always; `restricted` ⇒ the request MUST carry EITHER a fresh
 * AID-signed visit proof (header `x-flagship-visit`, for app/web clients that
 * can sign) OR a live box-issued `Flagship-App-Session` cookie (for a plain
 * BROWSER, which cannot set the header). Either path must resolve to an AID
 * that is STILL in the service's allow-list (so a `.com` revoke kills both).
 */
export function decideServiceAccess(
  opts: Pick<ServiceAccessHttpOptions, "serverId" | "store"> & {
    sessions?: ServiceSessionStore;
    now?: () => number;
    maxAgeMs?: number;
  },
  serviceRef: string,
  req: HttpRequest,
): AccessDecision {
  if (opts.store.mode(serviceRef) === "open") return { allow: true, reason: "open" };
  const now = (opts.now ?? (() => Date.now()))();
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;

  const header = req.headers[VISIT_PROOF_HEADER];
  if (typeof header !== "string" || header.length === 0) {
    // No signed header — try a browser session cookie before denying.
    if (opts.sessions) {
      const token = readSessionCookie(req.headers.cookie);
      if (token) {
        const sess = opts.sessions.lookup(token, now);
        if (sess && sess.serviceRef === serviceRef && opts.store.isAllowed(serviceRef, sess.aid)) {
          return { allow: true, reason: "cookie" };
        }
      }
    }
    return { allow: false, reason: "no-proof" };
  }
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
  /** Which apps a signed invite revoke may prune here (the revocation poller uses it too). */
  verifyWithdraw: (r: RevokeServiceInvite, sig: Uint8Array) => string[];
  /** The browser-session store, when the cookie seam is enabled (else undefined). */
  sessions?: ServiceSessionStore;
}

/** Header a client presents the establish-session nonce-challenge answer under. */
export const ESTABLISH_NONCE_HEADER = "x-flagship-establish-nonce";

/**
 * In-memory single-use nonce store for the establish-session challenge (M3). A
 * captured 5-min visit proof shouldn't mint a 12h transferable cookie, so
 * establish-session is a two-step handshake: the client first GETs a fresh
 * short-lived nonce bound to its connection, then presents the SAME nonce inside
 * the signed proof body — the nonce is consumed on use (no replay), and the
 * cookie is additionally pinned to a client fingerprint (UA) so a lifted cookie
 * doesn't travel.
 */
class EstablishNonceStore {
  private nonces = new Map<string, number>(); // nonce → expiresAt
  constructor(private readonly ttlMs = 2 * 60_000) {}
  mint(now: number): string {
    this.prune(now);
    const nonce = bytesToHex(randomBytes(16));
    this.nonces.set(nonce, now + this.ttlMs);
    return nonce;
  }
  /** Consume a nonce (single-use). Returns true iff it was live. */
  consume(nonce: string, now: number): boolean {
    const exp = this.nonces.get(nonce);
    if (exp === undefined) return false;
    this.nonces.delete(nonce);
    return exp > now;
  }
  private prune(now: number): void {
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
  }
}

/** Simple fixed-window per-key rate limiter (M5). */
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxPerWindow: number, private readonly windowMs = 60_000) {}
  /** Returns true iff this call is allowed (under the limit). */
  allow(key: string, now: number): boolean {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    if (e.count >= this.maxPerWindow) return false;
    e.count++;
    return true;
  }
  private prune(now: number): void {
    if (this.hits.size < 4096) return;
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
  }
}

/** Best-effort client key for rate-limiting / cookie-pinning (no real IP on the box loopback). */
function clientKey(req: HttpRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const ip = typeof fwd === "string" ? fwd.split(",")[0]!.trim() : "";
  return ip || req.headers["user-agent"] || "anon";
}

export function buildServiceAccessHttp(opts: ServiceAccessHttpOptions): ServiceAccessHttp {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const establishNonces = new EstablishNonceStore();
  const rateLimiter = new RateLimiter(opts.rateLimitPerMin ?? 30);

  const pinnedRoot = opts.adminRootPub && opts.adminRootPub.length === 32 ? opts.adminRootPub : undefined;
  /** An admin-only order: the admin root (or an admin device) on a pinned box, the owner key otherwise. */
  function adminSigned<T>(order: T, sig: Uint8Array, verify: (o: T, s: Uint8Array, pub: Uint8Array) => boolean): boolean {
    return authorizeSensitiveOrder({
      order,
      signature: sig,
      verify,
      ownerIrkPub: opts.ownerIrkPub,
      ...(pinnedRoot ? { adminRootPub: pinnedRoot } : {}),
      username: opts.username ?? "",
      activeGrants: opts.adminGrants?.() ?? [],
      now: now(),
    });
  }
  const withdraw = buildInviteWithdrawVerifier({
    store: opts.store,
    adminSigned: (r, sig) =>
      adminSigned(r, sig, verifyRevokeServiceInvite) ||
      // A box with no admin root: the owner's AID is the owner's key too.
      (!pinnedRoot && !!opts.ownerAidPub && verifyRevokeServiceInvite(r, sig, opts.ownerAidPub)),
  });

  const decide = (serviceRef: string, req: HttpRequest): AccessDecision =>
    decideServiceAccess(
      { serverId: opts.serverId, store: opts.store, sessions: opts.sessions, now, maxAgeMs },
      serviceRef,
      req,
    );

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
    // Owner-IRK prune of a single AID from a service's allow-list (revoke /
    // "delete a friend"). `decide` re-checks the allow-list per request, so this
    // also kills any live browser cookie bound to that AID.
    if (req.path === "/api/service-access/allow-remove" && req.method === "POST") {
      return handleRemoveAllow(req);
    }
    // Withdraw an invite: an admin's revoke, or the creating device's own
    // while it is still manager-class in that app. Prunes who joined through it.
    if (req.path === "/api/service-access/invite-withdraw" && req.method === "POST") {
      if (!rateLimiter.allow(`withdraw:${clientKey(req)}`, now())) return bad(429, "rate limited");
      return handleWithdraw(req);
    }
    // M3 — establish-session nonce challenge: a client GETs a fresh single-use
    // nonce, then echoes it inside the signed proof body on the POST below.
    if (req.path === "/api/service-access/establish-session/nonce" && req.method === "GET") {
      return jsonResponse(200, { nonce: establishNonces.mint(now()) });
    }
    // Friend's app/web establishes a browser cookie from an AID-signed proof.
    if (req.path === "/api/service-access/establish-session" && req.method === "POST") {
      if (!rateLimiter.allow(`establish:${clientKey(req)}`, now())) return bad(429, "rate limited");
      return handleEstablishSession(req);
    }
    // MANUAL-approve: the AUTHOR submits the friend's AID-signed acceptance + the
    // owner's signed create; the box verifies both, then binds the contact AID.
    if (req.path === "/api/service-access/accept" && req.method === "POST") {
      if (!rateLimiter.allow(`accept:${clientKey(req)}`, now())) return bad(429, "rate limited");
      return handleAccept(req);
    }
    // Access-state read: GET /api/service-access/<serviceRef>. Unauthenticated
    // (the mode is already behaviorally observable; only the AID COUNT, never
    // the AIDs themselves, is exposed) so every client renders the true toggle
    // without a signature on a plain refresh.
    if (req.path.startsWith("/api/service-access/") && req.method === "GET") {
      const serviceRef = decodeURIComponent(req.path.slice("/api/service-access/".length));
      if (serviceRef.length === 0 || serviceRef.includes("/")) return bad(404, "not found");
      return jsonResponse(200, {
        serviceRef,
        mode: opts.store.mode(serviceRef),
        allowCount: opts.store.allowList(serviceRef).length,
      });
    }
    if (req.path === "/api/service-invites/redeem" && req.method === "POST") {
      if (!rateLimiter.allow(`redeem:${clientKey(req)}`, now())) return bad(429, "rate limited");
      return handleRedeem(req);
    }
    return null;
  }

  /**
   * POST /api/service-access/establish-session — a friend who already redeemed
   * (their AID is allow-listed) presents the SAME AID-signed `ServiceVisitProof`
   * the `x-flagship-visit` header carries (base64 body); the box mints a browser
   * cookie so a plain browser can then reach the restricted service. 400 on an
   * unparseable proof; 403 on a serverId/stale/signature failure; 401 if the AID
   * is not allow-listed for that restricted service; 404 when sessions are off.
   */
  async function handleEstablishSession(req: HttpRequest): Promise<HttpResponse> {
    if (!opts.sessions) return bad(404, "sessions not enabled");
    // M3 — single-use nonce challenge: the client must first GET a nonce and
    // present it here, so a captured visit proof can't be replayed into a fresh
    // long-lived cookie. The nonce is consumed (no replay) before any minting.
    const nonce = req.headers[ESTABLISH_NONCE_HEADER];
    if (typeof nonce !== "string" || !establishNonces.consume(nonce, now())) {
      return bad(403, "missing or stale establish nonce");
    }
    let parsed: { proof: ServiceVisitProof; sig: Uint8Array } | null;
    try {
      parsed = parseVisitHeader(req.body.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (!parsed) return bad(400, "malformed visit proof");
    const { proof, sig } = parsed;
    if (proof.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - proof.issuedAt) > maxAgeMs) return bad(403, "stale request");
    if (!verifyServiceVisitProof(proof, sig, proof.visitorAID)) return bad(403, "invalid signature");
    const aidHex = bytesToHex(proof.visitorAID);
    await opts.store.ensureKnown(aidHex);
    // A cookie is only issued to someone the service lets in (an account
    // device or co-manager not refused there, or an allow-listed AID): it
    // passes a restricted gate and, on any service, names the member to the
    // app (`appMemberSession.ts`).
    if (!opts.store.isAllowed(proof.serviceRef, aidHex)) {
      return bad(401, "not allow-listed for this service");
    }
    // Pin the cookie to the requesting client (UA) so a lifted token doesn't
    // travel to a different agent (M3 client-bind; re-checked in `decide`).
    const token = await opts.sessions.issue(proof.serviceRef, aidHex, now(), sessionTtlMs, {
      browserAgent: req.headers["user-agent"] ?? "",
    });
    return {
      status: 200,
      headers: { ...H, "set-cookie": sessionSetCookie(token, sessionTtlMs) },
      body: JSON.stringify({ established: true, serviceRef: proof.serviceRef, expiresInMs: sessionTtlMs }),
    };
  }

  async function handleSetMode(req: HttpRequest): Promise<HttpResponse> {
    const env = parseEnvelope(req);
    if (!env) return bad(400, "malformed body");
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return bad(400, "invalid signature hex");
    }
    // v2 names the app only; v1 also names this server. Both are admin-only.
    const v2 = parseServiceAccessModeV2(env.request);
    const v1 = v2 ? null : parseSetMode(env.request);
    const order = v2 ?? v1;
    if (!order) return bad(400, "malformed set-service-access-mode order");
    if (v1 && v1.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - order.issuedAt) > (v2 ? ADMIN_ORDER_MAX_SKEW_MS : maxAgeMs)) return bad(403, "stale request");
    const signed = v2
      ? adminSigned(v2, sig, verifyServiceAccessModeV2)
      : adminSigned(v1!, sig, verifySetServiceAccessMode);
    if (!signed) return bad(403, "only an admin device can change who may open this app");
    if (!opts.serviceInstalled(order.serviceRef)) {
      return bad(422, "unknown service");
    }
    if ((await opts.store.applyModeOrder(order.serviceRef, order.mode, order.issuedAt)) === "stale") {
      return bad(409, "a newer change was already made: sign it again");
    }
    return jsonResponse(200, {
      ok: true,
      serviceRef: order.serviceRef,
      mode: opts.store.mode(order.serviceRef),
    });
  }

  async function handleRemoveAllow(req: HttpRequest): Promise<HttpResponse> {
    const env = parseEnvelope(req);
    if (!env) return bad(400, "malformed body");
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return bad(400, "invalid signature hex");
    }
    const v2 = parseServiceAllowRemoveV2(env.request);
    const v1 = v2 ? null : parseRemoveAllow(env.request);
    const order = v2 ?? v1;
    if (!order) return bad(400, "malformed remove-allow order");
    if (v1 && v1.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - order.issuedAt) > (v2 ? ADMIN_ORDER_MAX_SKEW_MS : maxAgeMs)) return bad(403, "stale request");
    const signed = v2
      ? adminSigned(v2, sig, verifyServiceAllowRemoveV2)
      : adminSigned(v1!, sig, verifyRemoveServiceAllow);
    if (!signed) return bad(403, "only an admin device can remove someone");
    const r = await opts.store.applyRemoveOrder(order.serviceRef, order.aid, order.issuedAt);
    if (r === "stale") return bad(409, "a newer change was already made: sign it again");
    // Idempotent: a no-op prune (AID already absent) still returns ok. The next
    // request from that AID is denied regardless (decide re-checks the list).
    return jsonResponse(200, { ok: true, removed: r === "removed" });
  }

  async function handleWithdraw(req: HttpRequest): Promise<HttpResponse> {
    let body: { revoke?: { inviteId?: unknown; issuedAt?: unknown }; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return bad(400, "invalid json");
    }
    const r = body.revoke;
    if (
      !r ||
      typeof r.inviteId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(r.inviteId) ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      !/^[0-9a-f]{128}$/i.test(body.signature)
    ) {
      return bad(400, "malformed withdraw");
    }
    if (Math.abs(now() - r.issuedAt) > ADMIN_ORDER_MAX_SKEW_MS) return bad(403, "stale request");
    const revoke: RevokeServiceInvite = { inviteId: r.inviteId, issuedAt: r.issuedAt };
    const known = opts.store.servicesWithInvite(revoke.inviteId);
    if (known.length === 0) return jsonResponse(200, { ok: true, pruned: 0 });
    const refs = withdraw(revoke, hexToBytes(body.signature));
    if (refs.length === 0) {
      return bad(403, "only an admin, or the device that sent this invite while it may still invite here, can withdraw it");
    }
    let pruned = 0;
    for (const ref of refs) pruned += await opts.store.revokeGroup(revoke.inviteId, ref);
    return jsonResponse(200, { ok: true, pruned });
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

    // Delegate the first-bind arbitration to `.com`, which returns the owner's
    // SIGNED create so the box verifies the owner's authority ITSELF (it does NOT
    // trust `.com`'s serviceRef/boundAID alone — box-as-authority, v2 Phase 1).
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
    if (comRes.status === 410) return bad(410, "invite expired or full");
    if (!comRes.ok) return bad(502, "redeem rejected upstream");

    let comBody: {
      pending?: unknown;
      approvalMode?: unknown;
      serviceRef?: unknown;
      boundAID?: unknown;
      firstBind?: unknown;
      create?: unknown;
      createSig?: unknown;
      creatorPubHex?: unknown;
    };
    try {
      comBody = (await comRes.json()) as typeof comBody;
    } catch {
      return bad(502, "bad upstream response");
    }

    // Verify the owner's signed create (box-as-authority): a rogue `.com` cannot
    // forge the owner's AID/IRK signature, so it cannot fabricate a binding for a
    // service the owner never invited to. The create's secretHash MUST match the
    // redeemed secret (else `.com` could substitute a DIFFERENT real create).
    const verified = await verifyComCreate(comBody.create, comBody.createSig, secretHash, comBody.creatorPubHex);
    if (!verified) return bad(403, "owner create signature did not verify");
    if (!opts.serviceInstalled(verified.serviceRef)) {
      return bad(409, "invite is not for a service hosted on this box");
    }

    // MANUAL-approve: `.com` returns {pending} with NO bind. The box does NOT
    // allow-list here — the author finalizes via POST /api/service-access/accept.
    if (comBody.pending === true || comBody.approvalMode === "manual") {
      return jsonResponse(200, {
        pending: true,
        approvalMode: "manual",
        serviceRef: verified.serviceRef,
      });
    }

    if (typeof comBody.boundAID !== "string" || !/^[0-9a-f]{64}$/i.test(comBody.boundAID)) {
      return bad(502, "incomplete upstream response");
    }
    // The bound AID is the authority's answer; add IT (not the request's claim).
    // For a GROUP invite (create.maxRedemptions present) bind under the inviteId
    // so a group revoke can prune the whole set.
    const boundAID = comBody.boundAID.toLowerCase();
    const refused = creatorRefusal(verified);
    if (refused) return refused;
    // The tier lands before the bind, so a join is never briefly uncapped.
    await opts.store.setInviteTier(verified.serviceRef, verified.inviteId, verified.tier);
    await opts.store.setInviteCreator(verified.serviceRef, verified.inviteId, verified.creatorPub);
    // Every invite is a grant (a personal one holds one person), so revoking it
    // or giving it a role reaches exactly the people who joined through it.
    const added = await opts.store.addAllowed(verified.serviceRef, boundAID, verified.inviteId);
    if (!added && !opts.store.isAllowed(verified.serviceRef, boundAID)) {
      // The add was refused (allow-list at cap) and the AID is not already in.
      return bad(409, "service allow-list is full");
    }
    // Hand the redeemer a browser cookie bound to their AID + this service.
    const responseHeaders: Record<string, string> = { ...H };
    if (opts.sessions) {
      const token = await opts.sessions.issue(verified.serviceRef, boundAID, now(), sessionTtlMs, {
        browserAgent: req.headers["user-agent"] ?? "",
      });
      responseHeaders["set-cookie"] = sessionSetCookie(token, sessionTtlMs);
    }
    return {
      status: 200,
      headers: responseHeaders,
      body: JSON.stringify({
        redeemed: true,
        approvalMode: "auto",
        firstBind: comBody.firstBind === true,
        serviceRef: verified.serviceRef,
        boundAID,
        tier: verified.tier,
      }),
    };
  }

  /**
   * POST /api/service-access/accept — MANUAL-approve finalize (v2 Phase 3 tier 2).
   * The AUTHOR submits only the friend's AID-signed `AcceptServiceInvite`
   * (`{accept, acceptSig}`); the box FETCHES the owner's signed create from `.com`
   * by the acceptance's inviteId (STK-signed — box-as-authority, ANY-DEVICE
   * finalize), verifies the owner's create authority AND the friend's contact-AID
   * sig, confirms the create matches the acceptance's inviteId + serviceRef, then
   * binds the contact AID. The author finalizes (so a link-thief who never reached
   * the author's friend-channel can't produce an acceptance the author submits) —
   * and can do so from ANY of their devices (no local create cache).
   *
   * Back-compat: when the box has no STK-fetch identity wired, OR the fetch can't
   * resolve the create (an in-flight v1 row with no stored signature), it falls
   * back to a client-supplied `{create, createSig}` in the body — so a transitional
   * client that still carries the create never hard-fails.
   */
  async function handleAccept(req: HttpRequest): Promise<HttpResponse> {
    let body: {
      accept?: { inviteId?: unknown; serviceRef?: unknown; contactAID?: unknown; acceptedAt?: unknown };
      acceptSig?: unknown;
      create?: unknown;
      createSig?: unknown;
    };
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return bad(400, "invalid json");
    }
    const a = body.accept;
    if (
      !a ||
      typeof a.inviteId !== "string" ||
      typeof a.serviceRef !== "string" ||
      typeof a.contactAID !== "string" ||
      !/^[0-9a-f]{64}$/i.test(a.contactAID) ||
      typeof a.acceptedAt !== "number" ||
      typeof body.acceptSig !== "string" ||
      !/^[0-9a-f]{128}$/i.test(body.acceptSig)
    ) {
      return bad(400, "malformed acceptance");
    }

    // Obtain the owner's SIGNED create. Primary path: fetch it from `.com` by the
    // acceptance's inviteId (the author submits NO create). Fallback: a
    // body-supplied create (a transitional client / a row `.com` can't serve).
    const fetched = await fetchComCreate(a.inviteId);
    const verified =
      (fetched && (await verifyComCreate(fetched.create, fetched.createSig, undefined, fetched.creatorPubHex))) ||
      (await verifyComCreate(body.create, body.createSig, undefined, undefined));
    if (!verified) return bad(403, "owner create signature did not verify");
    if (verified.inviteId !== a.inviteId || verified.serviceRef !== a.serviceRef) {
      return bad(403, "acceptance does not match the create");
    }
    if (!opts.serviceInstalled(verified.serviceRef)) {
      return bad(409, "invite is not for a service hosted on this box");
    }
    // Verify the FRIEND's contact-AID signature over the acceptance.
    const accept: AcceptServiceInvite = {
      inviteId: a.inviteId,
      serviceRef: a.serviceRef,
      contactAID: hexToBytes(a.contactAID),
      acceptedAt: a.acceptedAt,
    };
    let acceptOk = false;
    try {
      acceptOk = verifyAcceptServiceInvite(accept, hexToBytes(body.acceptSig), hexToBytes(a.contactAID));
    } catch {
      acceptOk = false;
    }
    if (!acceptOk) return bad(403, "invalid acceptance signature");

    const contactAID = a.contactAID.toLowerCase();
    const refused = creatorRefusal(verified);
    if (refused) return refused;
    await opts.store.setInviteTier(verified.serviceRef, verified.inviteId, verified.tier);
    await opts.store.setInviteCreator(verified.serviceRef, verified.inviteId, verified.creatorPub);
    // Always bind under the inviteId so a later (group or single) revoke can find
    // + prune this acceptance.
    const added = await opts.store.addAllowed(verified.serviceRef, contactAID, verified.inviteId);
    if (!added && !opts.store.isAllowed(verified.serviceRef, contactAID)) {
      return bad(409, "service allow-list is full");
    }
    return jsonResponse(200, { bound: true, serviceRef: verified.serviceRef, boundAID: contactAID });
  }

  /**
   * Fetch the owner's signed create from `.com` by inviteId, STK-signing the
   * query (box-as-authority any-device finalize). Returns the raw `{create,
   * createSig}` the caller re-verifies, or null when the box has no STK-fetch
   * identity wired or `.com` can't serve it. Best-effort: any failure (no
   * identity / network / 404 / malformed) returns null so the body fallback runs.
   */
  async function fetchComCreate(
    inviteId: string,
  ): Promise<{ create: unknown; createSig: unknown; creatorPubHex?: unknown } | null> {
    if (!opts.username || !opts.serverDomain || !opts.stk) return null;
    if (typeof inviteId !== "string" || !/^[0-9a-f]+$/i.test(inviteId) || inviteId.length % 2 !== 0) {
      return null;
    }
    const query: ServiceInviteCreateQuery = {
      username: opts.username,
      inviteId: inviteId.toLowerCase(),
      serverDomain: opts.serverDomain,
      issuedAt: now(),
    };
    const sig = bytesToHex(signServiceInviteCreateQuery(query, opts.stk));
    const params = new URLSearchParams({
      serverDomain: query.serverDomain,
      issuedAt: String(query.issuedAt),
      sig,
    });
    let res: Response;
    try {
      res = await fetchImpl(
        `${opts.controlPlaneBaseUrl}/api/users/${encodeURIComponent(opts.username)}/service-invites/${encodeURIComponent(query.inviteId)}/create?${params.toString()}`,
        { method: "GET" } as RequestInit,
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let json: { create?: unknown; createSig?: unknown; creatorPubHex?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return null;
    }
    if (!json.create || typeof json.createSig !== "string") return null;
    return { create: json.create, createSig: json.createSig, creatorPubHex: json.creatorPubHex };
  }

  /**
   * Verify the `.com`-relayed signed create ITSELF and say who signed it
   * (docs/service-access-gating.md "Account members"): the admin root or an
   * admin device makes an ADMIN invite; a non-admin device of the account (its
   * key in the device book) a MEMBER invite, whose joins are capped at Member.
   * On a box with no admin root the owner's AID or IRK, or any device, is the
   * owner's authority (admin). The AID and IRK create nothing on a pinned box.
   * `.com`'s `creatorPubHex` is only a hint for which key to try first. When
   * `expectSecretHash` is given the create's secretHash must match the redeemed
   * secret. Returns the validated create fields, or null on any failure.
   */
  async function verifyComCreate(
    rawCreate: unknown,
    rawSig: unknown,
    expectSecretHash: string | undefined,
    creatorHint: unknown,
  ): Promise<{
    inviteId: string;
    serviceRef: string;
    secretHash: string;
    maxRedemptions?: number;
    tier: InviteTier;
    creatorPub: string;
  } | null> {
    if (!rawCreate || typeof rawCreate !== "object") return null;
    if (typeof rawSig !== "string" || !/^[0-9a-f]{128}$/i.test(rawSig)) return null;
    const c = rawCreate as Record<string, unknown>;
    if (
      typeof c.inviteId !== "string" ||
      typeof c.authorAID !== "string" ||
      !/^[0-9a-f]{64}$/i.test(c.authorAID) ||
      typeof c.serviceRef !== "string" ||
      typeof c.secretHash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(c.secretHash) ||
      typeof c.encryptedBundle !== "string" ||
      typeof c.issuedAt !== "number"
    ) {
      return null;
    }
    if (expectSecretHash !== undefined && c.secretHash.toLowerCase() !== expectSecretHash) {
      return null;
    }
    const create: CreateServiceInvite = {
      inviteId: c.inviteId,
      authorAID: hexToBytes(c.authorAID),
      serviceRef: c.serviceRef,
      secretHash: c.secretHash,
      encryptedBundle: c.encryptedBundle,
      issuedAt: c.issuedAt,
      ...(typeof c.maxRedemptions === "number" ? { maxRedemptions: c.maxRedemptions } : {}),
      ...(typeof c.expiresAt === "number" ? { expiresAt: c.expiresAt } : {}),
    };
    let sig: Uint8Array;
    try {
      sig = hexToBytes(rawSig);
    } catch {
      return null;
    }
    const hint = typeof creatorHint === "string" && /^[0-9a-f]{64}$/i.test(creatorHint) ? creatorHint.toLowerCase() : null;
    if (hint) await opts.store.ensureKnown(hint);
    const candidates: { pub: string; tier: InviteTier }[] = [];
    if (pinnedRoot) candidates.push({ pub: bytesToHex(pinnedRoot), tier: "admin" });
    for (const p of opts.store.accountPeople()) {
      if (p.kind !== "device" || p.legacy) continue;
      candidates.push({ pub: p.pub, tier: pinnedRoot && p.tier === "member" ? "member" : "admin" });
    }
    if (!pinnedRoot) {
      if (opts.ownerAidPub) candidates.push({ pub: bytesToHex(opts.ownerAidPub), tier: "admin" });
      candidates.push({ pub: bytesToHex(opts.ownerIrkPub), tier: "admin" });
    }
    if (hint) candidates.sort((a, b) => (a.pub === hint ? -1 : b.pub === hint ? 1 : 0));
    const hit = candidates.find((k) => verifyCreateServiceInvite(create, sig, hexToBytes(k.pub)));
    if (!hit) return null;
    return {
      inviteId: create.inviteId,
      serviceRef: create.serviceRef,
      secretHash: create.secretHash.toLowerCase(),
      ...(create.maxRedemptions !== undefined ? { maxRedemptions: create.maxRedemptions } : {}),
      tier: hit.tier,
      creatorPub: hit.pub,
    };
  }

  /**
   * A non-admin device's links let new people in only while that device is
   * still manager-class in the app (a demoted or refused device's open links
   * stop working; whoever already joined stays). Null when the join may go on.
   */
  function creatorRefusal(v: { serviceRef: string; inviteId: string; tier: InviteTier; creatorPub: string }): HttpResponse | null {
    if (v.tier !== "member") return null;
    const recorded = opts.store.inviteCreator(v.serviceRef, v.inviteId) ?? v.creatorPub;
    const p = opts.store.principal(recorded);
    if (p && isManagerClass(opts.store.accountRank(v.serviceRef, p))) return null;
    return bad(403, "the device that sent this invite can no longer invite people to this app: ask for a new link");
  }

  return { handle, decide, decryptBundle, store: opts.store, sessions: opts.sessions, verifyWithdraw: withdraw };

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

/** How old an admin-only order (or a withdraw) may be when it reaches the box. */
export const ADMIN_ORDER_MAX_SKEW_MS = 10 * 60_000;

/**
 * Which of this box's apps a signed invite revoke may prune
 * (docs/service-access-gating.md "Account members"): every app that knows the
 * invite when an admin signed it; otherwise only the apps where the invite's
 * recorded creator signed it and is still manager-class there (a device
 * demoted below manager, or refused, withdraws nobody). Empty when nothing may
 * be pruned.
 */
export function buildInviteWithdrawVerifier(opts: {
  store: Pick<ServiceAccessStore, "servicesWithInvite" | "inviteCreator" | "inviteTier" | "principal" | "accountRank">;
  adminSigned: (r: RevokeServiceInvite, sig: Uint8Array) => boolean;
}): (r: RevokeServiceInvite, sig: Uint8Array) => string[] {
  return (r, sig) => {
    const refs = opts.store.servicesWithInvite(r.inviteId);
    if (refs.length === 0) return [];
    if (opts.adminSigned(r, sig)) return refs;
    return refs.filter((ref) => {
      if (opts.store.inviteTier(ref, r.inviteId) !== "member") return false;
      const creator = opts.store.inviteCreator(ref, r.inviteId);
      if (!creator) return false;
      let ok = false;
      try {
        ok = verifyRevokeServiceInvite(r, sig, hexToBytes(creator));
      } catch {
        ok = false;
      }
      if (!ok) return false;
      const p = opts.store.principal(creator);
      return p !== null && isManagerClass(opts.store.accountRank(ref, p));
    });
  };
}

export interface RevocationPollerOptions {
  controlPlaneBaseUrl: string;
  /** The account username (the `.com` path segment). */
  username: string;
  /** The owner's STABLE AID (hex) — the authorAID the invites are scoped to. */
  authorAidHex: string;
  /** The box's own FQDN — `.com` resolves the STK against this server record. */
  serverDomain: string;
  /** The box's STK keypair — the box holds NO owner key, so it STK-signs the poll. */
  stk: Keypair;
  store: ServiceAccessStore;
  /**
   * Which of this box's apps a signed revoke may prune
   * ({@link buildInviteWithdrawVerifier}). A row without a signed revoke, or
   * one this returns nothing for, prunes nobody.
   */
  verifyRevoke: (r: RevokeServiceInvite, sig: Uint8Array) => string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Poll cadence (ms) — reuses the daemon-status heartbeat cadence. Default 5 min. */
  intervalMs?: number;
}

export interface RevocationPoller {
  /** Poll `.com` once + self-prune. Returns the number of AIDs pruned. */
  pollOnce(): Promise<number>;
  /** Start the heartbeat-cadence poll loop. */
  start(): void;
  /** Stop the loop. */
  stop(): void;
}

/**
 * v2 box-as-authority revocation convergence: the box POLLS `.com`'s
 * `revoked-since` on a heartbeat cadence and self-prunes the revoked AIDs (a
 * group revoke prunes the whole inviteId set), so a `.com` revoke is SUFFICIENT
 * and multi-box self-heals. The instant owner-prune (`allow-remove`) stays as the
 * PRIMARY path; this is the convergence backstop. The box authenticates with its
 * STK (it holds no owner key); `.com` verifies the STK against the registered
 * server record + that the server belongs to this username.
 */
export function buildRevocationPoller(opts: RevocationPollerOptions): RevocationPoller {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<number> {
    const query: ServiceInviteListQuery = {
      username: opts.username,
      authorAID: opts.authorAidHex.toLowerCase(),
      scope: "revoked-since",
      cursor,
      issuedAt: now(),
    };
    const sig = bytesToHex(signServiceInviteListQuery(query, opts.stk));
    const params = new URLSearchParams({
      authorAID: query.authorAID,
      scope: "revoked-since",
      cursor: String(cursor),
      issuedAt: String(query.issuedAt),
      sig,
      serverDomain: opts.serverDomain,
    });
    let res: Response;
    try {
      res = await fetchImpl(
        `${opts.controlPlaneBaseUrl}/api/users/${encodeURIComponent(opts.username)}/service-invites/revoked-since?${params.toString()}`,
        { method: "GET" } as RequestInit,
      );
    } catch {
      return 0; // best-effort; the instant owner-prune is the primary path
    }
    if (!res.ok) return 0;
    let body: {
      revoked?: {
        inviteId?: unknown;
        serviceRef?: unknown;
        boundAIDs?: unknown;
        revoke?: { inviteId?: unknown; issuedAt?: unknown } | null;
        revokeSig?: unknown;
      }[];
      cursor?: unknown;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return 0;
    }
    let pruned = 0;
    for (const r of body.revoked ?? []) {
      if (typeof r.inviteId !== "string") continue;
      // Only a revoke the box verifies itself prunes anyone: an admin's, or
      // the creating device's while it may still invite there. `.com`'s word
      // that an invite is revoked is not enough.
      const rv = r.revoke;
      if (
        !rv ||
        rv.inviteId !== r.inviteId ||
        typeof rv.issuedAt !== "number" ||
        typeof r.revokeSig !== "string" ||
        !/^[0-9a-f]{128}$/i.test(r.revokeSig)
      ) {
        continue;
      }
      const refs = opts.verifyRevoke({ inviteId: r.inviteId, issuedAt: rv.issuedAt }, hexToBytes(r.revokeSig));
      for (const ref of refs) {
        // Grant-prune by inviteId (covers personal + group; a personal invite is
        // a grant of one). Falls back to per-AID removal for any AID the grant
        // map didn't capture (an older bind), unless they hold another grant.
        pruned += await opts.store.revokeGroup(r.inviteId, ref);
        if (Array.isArray(r.boundAIDs) && r.serviceRef === ref) {
          for (const aid of r.boundAIDs) {
            if (typeof aid === "string" && (await opts.store.removeIfUngranted(ref, aid))) pruned++;
          }
        }
      }
    }
    if (typeof body.cursor === "number" && body.cursor > cursor) cursor = body.cursor;
    return pruned;
  }

  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Build the enforcement pre-handler for a given service-label resolver. It
 * intercepts requests to a RESTRICTED service and denies (403) those without a
 * valid allow-listed proof; OPEN services + unknown labels fall through
 * (returns null) so the normal serve path handles them.
 *
 * `resolveServiceRef(req, appServiceRef)` maps an inbound request to its
 * `<creator>-<slug>` service id, or null if the request isn't targeting a
 * gated service. On the SNI-routed per-app proxy path the router passes the
 * already-resolved `appServiceRef` (the service that selected the container),
 * which the resolver MUST prefer over any client-supplied `Host` — otherwise a
 * tier-2 leader-routed share URL or a spoofed `curl --resolve` Host skips
 * enforcement (v1-sec GAP 1). On the daemon's own chain `appServiceRef` is
 * undefined and the resolver falls back to its Host-based lookup.
 */
export function buildAccessEnforcementHandler(
  access: Pick<ServiceAccessHttp, "decide" | "store">,
  resolveServiceRef: (req: HttpRequest, appServiceRef?: string | null) => string | null,
  /**
   * Web-experience hook: on a DENY, this gets first refusal. For a top-level
   * browser navigation it returns the QR-login knock page (200 HTML); for an
   * API/asset request it returns null and the 403 JSON below is used. Absent ⇒
   * always 403 (no behavior change).
   */
  maybeServeKnock?: (serviceRef: string, req: HttpRequest) => HttpResponse | null,
  /**
   * On the SNI-routed app path only: a request this returns true for skips
   * the restricted-mode check, because the app proxy decides it instead. Used
   * for the owner's API keys (docs/app-apis.md §3): the proxy lets a valid key
   * through and answers any other `fsk_` key 401, so the container never sees
   * an unchecked request. Also for a members-only app's declared
   * `access.public_routes`, which the proxy forwards as anonymous.
   */
  proxyDecides?: (req: HttpRequest, serviceRef: string) => boolean,
): (req: HttpRequest, appServiceRef?: string | null) => Promise<HttpResponse | null> {
  return async (req: HttpRequest, appServiceRef?: string | null): Promise<HttpResponse | null> => {
    const serviceRef = resolveServiceRef(req, appServiceRef);
    if (!serviceRef) return null;
    if (access.store.mode(serviceRef) === "open") return null;
    if (appServiceRef && proxyDecides?.(req, serviceRef)) return null;
    const decision = access.decide(serviceRef, req);
    if (decision.allow) return null;
    const knock = maybeServeKnock?.(serviceRef, req);
    if (knock) return knock;
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

function parseRemoveAllow(r: Record<string, unknown>): RemoveServiceAllow | null {
  if (
    typeof r.serverId !== "string" ||
    typeof r.serviceRef !== "string" ||
    typeof r.aid !== "string" ||
    !/^[0-9a-f]{64}$/i.test(r.aid) ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return { serverId: r.serverId, serviceRef: r.serviceRef, aid: r.aid.toLowerCase(), issuedAt: r.issuedAt };
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

/**
 * Extract the `Flagship-App-Session` token from a Cookie header (RFC-loose,
 * same parsing shape as `serviceAccessGate.ts`). Returns null if absent.
 */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const t = part.trim();
    if (t.startsWith(`${SESSION_COOKIE}=`)) {
      const v = t.slice(SESSION_COOKIE.length + 1);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/**
 * Build the `Set-Cookie` value for a freshly issued browser session. HttpOnly
 * (no JS read), Secure (the box is HTTPS-only), SameSite=Lax (the friend lands
 * on the service from the redeem/deep-link), Path=/ (whole service origin),
 * Max-Age = the session lifetime.
 */
function sessionSetCookie(token: string, ttlMs: number): string {
  const maxAgeSec = Math.floor(ttlMs / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
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
