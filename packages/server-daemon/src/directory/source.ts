/**
 * `DirectorySource`: the one small interface every directory connector is built on (docs/org-directory.md
 * §5; developer guide docs/directory-connectors.md). A source only READS its identity system and yields
 * people; the box diffs them against what it saw last, maps groups to org roles through the admins'
 * table, and turns the difference into proposals sealed to the org admins (directory/engine.ts,
 * directory/connector.ts). A source never sees an org key and never admits or removes anyone.
 *
 * Built-in sources: SCIM 2.0 (a push source: the identity system calls the box, directory/scim.ts) and
 * LDAP pull (directory/ldap.ts). `StaticDirectorySource` below is the sample: a JSON file.
 */
import { readFile } from "node:fs/promises";

/** One person as the identity system describes them. Names and email stay on the org's own box. */
export interface DirectoryUser {
  /** The identity system's stable id (Entra objectId, Okta id, AD objectGUID, entryUUID). */
  externalId: string;
  /** Usually the email or UPN. */
  userName: string;
  displayName: string;
  /** False when the account is disabled; a disabled or vanished person becomes an offboarding proposal. */
  active: boolean;
  /** Group names or DNs, matched against the connector's mapping. */
  groups: string[];
}

/** A delta feed entry: a person changed or appeared, or left the directory. */
export type DirectoryChange = { op: "upsert"; user: DirectoryUser } | { op: "remove"; externalId: string };

export interface DirectorySource {
  /** The connector id this source feeds (the org's `flagship/org-connector/v1` record). */
  id: string;
  /** Everyone in scope right now. The box treats anyone missing from a full snapshot as gone. */
  snapshot(): AsyncIterable<DirectoryUser>;
  /** Optional: changes since a cursor the source issued, when the system offers a delta feed. */
  changes?(since: string): AsyncIterable<DirectoryChange>;
}

/** Collects a snapshot, refusing duplicates and malformed rows (a source bug must not offboard people). */
export async function collectSnapshot(src: DirectorySource, max = 100_000): Promise<DirectoryUser[]> {
  const out = new Map<string, DirectoryUser>();
  for await (const u of src.snapshot()) {
    if (!isDirectoryUser(u)) throw new Error("directory source: a malformed person");
    if (out.has(u.externalId)) throw new Error("directory source: the same externalId twice");
    out.set(u.externalId, { ...u, groups: [...new Set(u.groups)].sort() });
    if (out.size > max) throw new Error("directory source: too many people");
  }
  return [...out.values()];
}

export function isDirectoryUser(u: unknown): u is DirectoryUser {
  const x = u as DirectoryUser;
  return (
    !!x &&
    typeof x.externalId === "string" &&
    x.externalId.length > 0 &&
    x.externalId.length <= 256 &&
    typeof x.userName === "string" &&
    typeof x.displayName === "string" &&
    typeof x.active === "boolean" &&
    Array.isArray(x.groups) &&
    x.groups.every((g) => typeof g === "string" && g.length > 0)
  );
}

/**
 * The sample source: people from a JSON file (`[{externalId, userName, displayName, active, groups}]`).
 * Copy it to start a connector for another system: replace `snapshot()` with calls to that system.
 */
export class StaticDirectorySource implements DirectorySource {
  constructor(
    readonly id: string,
    private readonly path: string,
  ) {}

  async *snapshot(): AsyncIterable<DirectoryUser> {
    const rows = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    if (!Array.isArray(rows)) throw new Error("directory file: expected an array");
    for (const r of rows) yield r as DirectoryUser;
  }
}
