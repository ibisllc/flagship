/**
 * LDAP pull (docs/org-directory.md §4): reads Active Directory or an open-source directory (OpenLDAP,
 * FreeIPA, 389-DS) over LDAPS on a schedule and yields people for the directory engine. Read-only:
 * it binds, searches and unbinds; it never writes back. The bind password comes from the connector's
 * setup (sealed to this box) and is never logged.
 *
 * The client is `ldapts` (MIT, maintained, TypeScript, no native code, one small dependency), used
 * through the narrow `LdapClient` interface so tests run it against an in-process fake server.
 */
import { Client } from "ldapts";
import type { DirectorySource, DirectoryUser } from "./source.js";

export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  /** Attribute names. */
  attributes: { externalId: string; userName: string; displayName: string; memberOf: string; disabled?: string };
  /** `ad`: userAccountControl bit 2 means disabled, objectGUID is binary; `openldap`: a `pwdAccountLockedTime` or explicit attribute. */
  flavor: "ad" | "openldap";
  /** Tests only: allow `ldap://` (production requires `ldaps://`). */
  allowPlaintextForTests?: boolean;
  timeoutMs?: number;
}

/** Defaults for Active Directory and OpenLDAP; an admin overrides any of them in the connector form. */
export const LDAP_DEFAULTS: Record<"ad" | "openldap", Pick<LdapConfig, "userFilter" | "attributes" | "flavor">> = {
  ad: {
    flavor: "ad",
    userFilter: "(&(objectCategory=person)(objectClass=user))",
    attributes: { externalId: "objectGUID", userName: "userPrincipalName", displayName: "displayName", memberOf: "memberOf", disabled: "userAccountControl" },
  },
  openldap: {
    flavor: "openldap",
    userFilter: "(objectClass=inetOrgPerson)",
    attributes: { externalId: "entryUUID", userName: "mail", displayName: "cn", memberOf: "memberOf", disabled: "pwdAccountLockedTime" },
  },
};

export interface LdapClient {
  bind(dn: string, password: string): Promise<void>;
  search(base: string, opts: { scope: "sub"; filter: string; attributes: string[]; paged: boolean; explicitBufferAttributes: string[] }): Promise<{ searchEntries: Array<Record<string, unknown>> }>;
  unbind(): Promise<void>;
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString("utf8") : String(x))));

/** AD's objectGUID bytes as the GUID string AD shows (little-endian first three groups). */
export function adGuidString(b: Buffer): string {
  if (b.length !== 16) return b.toString("hex");
  const h = (s: number, e: number, le: boolean) => {
    const part = b.subarray(s, e);
    return Buffer.from(le ? [...part].reverse() : part).toString("hex");
  };
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10, false)}-${h(10, 16, false)}`;
}

/** Maps one LDAP entry to a person; null when it lacks an id or a user name. */
export function ldapEntryToUser(e: Record<string, unknown>, cfg: Pick<LdapConfig, "attributes" | "flavor">): DirectoryUser | null {
  const a = cfg.attributes;
  const rawId = first(e[a.externalId]);
  const externalId = Buffer.isBuffer(rawId) ? (cfg.flavor === "ad" ? adGuidString(rawId) : rawId.toString("utf8")) : typeof rawId === "string" ? rawId : "";
  const userName = list(e[a.userName])[0] ?? "";
  if (!externalId || !userName) return null;
  let active = true;
  if (a.disabled) {
    const d = list(e[a.disabled])[0];
    if (cfg.flavor === "ad") active = d === undefined || (Number(d) & 2) === 0;
    else active = d === undefined || d === "" || d.toUpperCase() === "FALSE";
  }
  return { externalId, userName, displayName: list(e[a.displayName])[0] ?? userName, active, groups: list(e[a.memberOf]).sort() };
}

export class LdapDirectorySource implements DirectorySource {
  constructor(
    readonly id: string,
    private readonly cfg: LdapConfig,
    private readonly makeClient: (cfg: LdapConfig) => LdapClient = (c) => new Client({ url: c.url, timeout: c.timeoutMs ?? 30_000, connectTimeout: c.timeoutMs ?? 30_000 }) as unknown as LdapClient,
  ) {
    if (!/^ldaps:\/\//i.test(cfg.url) && !(cfg.allowPlaintextForTests && /^ldap:\/\//i.test(cfg.url))) throw new Error("LDAP pull needs an ldaps:// URL");
  }

  async *snapshot(): AsyncIterable<DirectoryUser> {
    const client = this.makeClient(this.cfg);
    const a = this.cfg.attributes;
    try {
      await client.bind(this.cfg.bindDn, this.cfg.bindPassword);
      const { searchEntries } = await client.search(this.cfg.baseDn, {
        scope: "sub",
        filter: this.cfg.userFilter,
        attributes: [a.externalId, a.userName, a.displayName, a.memberOf, ...(a.disabled ? [a.disabled] : [])],
        paged: this.cfg.flavor === "ad",
        explicitBufferAttributes: this.cfg.flavor === "ad" ? [a.externalId] : [],
      });
      for (const e of searchEntries) {
        const u = ldapEntryToUser(e, this.cfg);
        if (u) yield u;
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}

/** A connector setup's `ldap` block with the flavor's defaults filled in. */
export function ldapConfigFrom(setup: { url: string; bindDn: string; bindPassword: string; baseDn: string; userFilter: string }, flavor: "ad" | "openldap", attributes?: Partial<LdapConfig["attributes"]>): LdapConfig {
  const d = LDAP_DEFAULTS[flavor];
  return { ...setup, flavor, userFilter: setup.userFilter || d.userFilter, attributes: { ...d.attributes, ...(attributes ?? {}) } };
}
