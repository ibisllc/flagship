/**
 * The directory engine (docs/org-directory.md §3, §4): diffs what a source says now against what the
 * box saw last and turns the difference into proposal intents. Pure: the connector runtime persists
 * the state and seals and signs the proposals.
 *
 *   a new active person (in a mapped group, or with default roles) → invite (subject: a pending id)
 *   a person linked to a seat who is disabled or gone             → offboard (subject: the seat)
 *   a linked person whose roles from the mapping changed           → role-change
 *   a linked person whose name, email or groups changed            → entry-update
 *
 * A person is linked to a seat once an admin carried out their invite proposal (connector.ts reads it
 * from the decided proposal and the invite it names). Each intent is proposed once: the same kind,
 * subject, entry and roles are never proposed twice.
 */
import { createHash, randomBytes } from "node:crypto";
import { canonicalOrgDirectoryEntryBody, orgSeatRolesHash, type OrgConnectorMapping, type OrgDirectoryEntry, type OrgProposalKind, type OrgSeatRole } from "@flagship/protocol";
import type { DirectoryUser } from "./source.js";

export interface DirectoryLink {
  pendingId: string;
  seatId?: string;
}

export interface DirectoryState {
  users: Record<string, DirectoryUser>;
  links: Record<string, DirectoryLink>;
  /** Digest of every intent already proposed. */
  proposed: string[];
}

export const emptyDirectoryState = (): DirectoryState => ({ users: {}, links: {}, proposed: [] });

export interface ProposalIntent {
  kind: OrgProposalKind;
  subject: string;
  externalId: string;
  roles: OrgSeatRole[];
  rolesHash: string;
  /** The canonical directory entry body, sealed to the admins by the connector. */
  entry: OrgDirectoryEntry;
  digest: string;
}

const enc = new TextEncoder();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** Text a directory sends, made safe for an entry: NFC, no control characters, at most `max` UTF-8 bytes. */
export function cleanText(s: string, max: number): string {
  let t = (s ?? "").normalize("NFC").replace(CONTROL, " ").trim();
  while (enc.encode(t).length > max) t = t.slice(0, -1);
  return t;
}

/** The roles a person's groups map to (union, deduplicated), or the default roles. */
export function rolesFor(user: DirectoryUser, mapping: OrgConnectorMapping): OrgSeatRole[] {
  const out = new Map<string, OrgSeatRole>();
  const lower = new Map(Object.keys(mapping.groups).map((g) => [g.toLowerCase(), g]));
  for (const g of user.groups) {
    const key = lower.get(g.toLowerCase());
    if (!key) continue;
    for (const r of mapping.groups[key] as OrgSeatRole[]) out.set(JSON.stringify(r), r);
  }
  if (out.size === 0) for (const r of (mapping.defaultRoles ?? []) as OrgSeatRole[]) out.set(JSON.stringify(r), r);
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r);
}

export function entryFor(user: DirectoryUser, source: string, link: DirectoryLink, updatedAt: number): OrgDirectoryEntry {
  const displayName = cleanText(user.displayName, 256);
  const email = cleanText(user.userName, 320);
  const groups = [...new Set(user.groups.map((g) => cleanText(g, 256)).filter((g) => g.length > 0))].sort().slice(0, 32);
  return {
    seatId: link.seatId ?? "",
    pendingId: link.seatId ? "" : link.pendingId,
    pseudonym: cleanText(user.displayName || user.userName, 128) || "?",
    displayName,
    email,
    externalId: cleanText(user.externalId, 256),
    source,
    groups,
    updatedAt,
  };
}

const sameEntry = (a: DirectoryUser, b: DirectoryUser) =>
  a.displayName === b.displayName && a.userName === b.userName && JSON.stringify([...a.groups].sort()) === JSON.stringify([...b.groups].sort());

function digestOf(kind: string, subject: string, entry: OrgDirectoryEntry, rolesHash: string): string {
  const body = Buffer.from(canonicalOrgDirectoryEntryBody({ ...entry, updatedAt: 0 })).toString("hex");
  return createHash("sha256").update([kind, subject, body, rolesHash].join("|")).digest("hex");
}

/**
 * Applies a full snapshot: returns the new state (users replaced, links kept) and the intents not yet
 * proposed. `now` stamps the entries; `newId` makes pending ids (tests pass a fixed one).
 */
export function diffDirectory(
  prev: DirectoryState,
  next: readonly DirectoryUser[],
  mapping: OrgConnectorMapping,
  source: string,
  now: number,
  newId: () => string = () => randomBytes(16).toString("hex"),
): { state: DirectoryState; intents: ProposalIntent[] } {
  const links = { ...prev.links };
  const proposed = new Set(prev.proposed);
  const intents: ProposalIntent[] = [];
  const nextMap = new Map(next.map((u) => [u.externalId, u]));
  const add = (kind: OrgProposalKind, user: DirectoryUser, roles: OrgSeatRole[]) => {
    const link = links[user.externalId]!;
    const subject = kind === "invite" ? link.pendingId : link.seatId!;
    const rolesHash = kind === "invite" || kind === "role-change" ? orgSeatRolesHash(roles) : "";
    const entry = entryFor(user, source, link, now);
    const digest = digestOf(kind, subject, entry, rolesHash);
    if (proposed.has(digest)) return;
    proposed.add(digest);
    intents.push({ kind, subject, externalId: user.externalId, roles: kind === "invite" || kind === "role-change" ? roles : [], rolesHash, entry, digest });
  };

  for (const user of next) {
    const before = prev.users[user.externalId];
    const roles = rolesFor(user, mapping);
    let link = links[user.externalId];
    if (!link?.seatId) {
      if (user.active && roles.length > 0) {
        if (!link) links[user.externalId] = link = { pendingId: newId() };
        add("invite", user, roles);
      }
      continue;
    }
    if (!user.active) {
      add("offboard", user, []);
      continue;
    }
    if (before && JSON.stringify(rolesFor(before, mapping)) !== JSON.stringify(roles)) add("role-change", user, roles);
    if (before && !sameEntry(before, user)) add("entry-update", user, []);
  }
  for (const [externalId, user] of Object.entries(prev.users)) {
    if (nextMap.has(externalId)) continue;
    if (links[externalId]?.seatId) add("offboard", { ...user, active: false }, []);
  }
  return { state: { users: Object.fromEntries(nextMap), links, proposed: [...proposed].slice(-20_000) }, intents };
}
