# Directory connectors: a developer guide

How an org box syncs people from a company's identity system, and how to write a connector for a system Flagship
doesn't support yet. Design: `docs/org-directory.md`. Code: `packages/server-daemon/src/directory/`.

## What a connector may do

A connector **proposes**; org admins decide. It never holds an org key, and nothing it sends can admit, raise or
remove anyone. Each change becomes a `flagship/org-proposal/v1`, signed with the connector's own hybrid key and carrying
the person's directory entry (name, email, external id, groups) sealed to every org admin's seat key. `.com` sees which
connector proposed what kind of change about an opaque id, never a name. An admin carries the proposal out with the
usual invite, revoke or grant on a phone, and records the decision.

Names and emails stay on the org's own box and in the sealed proposals. They are never logged in clear, never sent to
`.com` unsealed and never put in a model prompt.

## The interface

```ts
// packages/server-daemon/src/directory/source.ts
interface DirectoryUser {
  externalId: string;   // the system's stable id (objectGUID, entryUUID, Okta id)
  userName: string;     // usually the email or UPN
  displayName: string;
  active: boolean;      // false = disabled; a disabled or vanished person is proposed for offboarding
  groups: string[];     // names or DNs, matched against the admins' mapping table
}

interface DirectorySource {
  id: string;                                                // the connector id
  snapshot(): AsyncIterable<DirectoryUser>;                  // everyone in scope now
  changes?(since: string): AsyncIterable<DirectoryChange>;   // optional delta feed
}
```

A source only reads. The box does the rest:

1. `collectSnapshot(source)` gathers the people and refuses a malformed row or a duplicate `externalId` (a source bug
   must never offboard everyone).
2. `diffDirectory` (`engine.ts`) compares them with the last snapshot and the admins' mapping:
   a new active person in a mapped group → **invite**; a linked person disabled or gone → **offboard**; their mapped
   roles changed → **role-change**; their name, email or groups changed → **entry-update**. Each is proposed once.
3. `ConnectorRuntime.sync` (`connector.ts`) seals each entry to the org admins it verified under the box's pinned org
   chain, signs and posts the proposal, and links a pending person to their seat once an admin carried out the invite.

## The sample source

`StaticDirectorySource` reads people from a JSON file. Copy it to start:

```ts
import { collectSnapshot, type DirectorySource, type DirectoryUser } from "./source.js";

export class HrisSource implements DirectorySource {
  constructor(readonly id: string, private readonly apiBase: string, private readonly token: string) {}
  async *snapshot(): AsyncIterable<DirectoryUser> {
    let next: string | null = `${this.apiBase}/employees?limit=200`;
    while (next) {
      const r = await fetch(next, { headers: { authorization: `Bearer ${this.token}` } });
      const page = (await r.json()) as { items: Array<{ id: string; email: string; name: string; status: string; teams: string[] }>; next: string | null };
      for (const e of page.items) yield { externalId: e.id, userName: e.email, displayName: e.name, active: e.status === "active", groups: e.teams };
      next = page.next;
    }
  }
}
```

Then run it the way `wiring.ts` runs LDAP: `await rt.sync(connectorId, await collectSnapshot(source))` on a schedule.
Register its connector with `kind: "custom"`. Credentials it needs travel in the connector's setup, sealed to the box
(see below), never in the box's config files.

## The built-in connectors

- **SCIM 2.0** (`scim.ts`): Entra ID, Okta, Google Workspace and others push to `https://<server>.<org>.<apex>/scim/v2`.
  Users and Groups with the filters those providers send (`userName eq`, `externalId eq`, `displayName eq`), both PATCH
  shapes (Entra's capitalised ops and string booleans, Okta's path-less objects), bearer-token auth by SHA-256,
  600 requests a minute, request counts in the box's Activity every 15 minutes. Tests replay recorded Entra and Okta
  sessions (`tests/fixtures/scim/`).
- **LDAP pull** (`ldap.ts`, client `ldapts`): LDAPS only, binds, searches, unbinds, every 15 minutes by default.
  Defaults for Active Directory (`objectGUID`, `userPrincipalName`, `memberOf`, `userAccountControl` bit 2 = disabled,
  paged search) and OpenLDAP (`entryUUID`, `mail`, `cn`, `memberOf`, `pwdAccountLockedTime`). Tests run the real client
  against an in-process fake server (`tests/support-fakeLdap.ts`).

## Adding a connector (what the admin's phone does)

1. Makes the connector's hybrid key seeds, its id, and for SCIM a random bearer token (shown once).
2. Builds `flagship/org-connector/v1` (kind, the box, the key id, scopes, the mapping's digest) and approves it with
   the seat admin key.
3. Seals the setup to the box's org KEM key (`sealOrgConnectorSetup`: the seeds, the mapping, the token's SHA-256, LDAP
   settings and bind password) and posts both to `POST /api/orgs/<id>/connectors`.
4. The box picks it up within 5 minutes, checks the record under its own pinned org chain, opens the setup and checks the
   seeds against the approved key id and the mapping against its digest.

To rotate a SCIM token, post the record again (same key, a later `issuedAt`) with a new setup. The console warns when a
token is over a year old. To stop a connector, post it `paused` or `retired` (a retired id never returns).

## Limits

The engine keeps the last snapshot per connector on the box (`<dataDir>/org-directory/`). A full snapshot is the truth:
anyone missing from it is treated as gone, so a source that fails half-way must throw rather than yield a partial list.
