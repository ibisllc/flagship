# Org directory and directory connectors

Status: design (2026-11-15), owner decision: "there should be a directory. It should even offer a connect link
possible with standards like Microsoft Active Directory or the open source standard (a barebones connector is fine,
and devs build the connection to other systems)". This settles Q-E7 in `docs/enterprise-accounts.md` (named seats
bound to a company directory are allowed). Read with that doc's §5.4 (key ring), §7 (joining), §8 (offboarding) and
§11 (audit).

## 1. The answer in short

1. **The org directory** is the org's list of people and servers: each seat's pseudonym (the name the inviter chose),
   an optional display name, email and external id, its role, its groups, and the org's servers with their labels.
   It is sealed under the **org directory key**, a key-ring kind (`flagship/org-key-ring/v1`, kind `directory`).
   `.com` stores the sealed entries and sees only opaque ids, as for every other org object.
2. **Who reads it:** org admins read everything. Members read the slice the bylaws allow: by default, the names of
   the people and servers they share something with. `.com` and the AI never read it (owner rule: an AI never learns
   who or where the owner is).
3. **Connectors** sync the directory with a company's identity system, in two barebones forms:
   - a **SCIM 2.0 server** (RFC 7643/7644), which Microsoft Entra ID (Azure AD), Okta, Google Workspace and others
     push users and groups to;
   - an **LDAP pull** (LDAPS), which reads Active Directory or an open-source directory (OpenLDAP, FreeIPA, 389-DS)
     on a schedule.
   Both are built on one small TypeScript interface (`DirectorySource`) that developers implement for any other
   system.
4. **A connector proposes; admins decide.** A connector never holds org keys and can't admit, raise or remove anyone
   alone. A new user becomes a **pending seat invitation**, issued after the usual admin approval. A disabled or
   deleted user becomes an **offboarding proposal**. One admin can make a freeze take effect at once (as today); the
   removal and key rotations follow the bylaws.
5. **The connector runs on an org box**, never on `.com`. The identity system talks to the org's own server, so
   member names and emails never reach Flagship's infrastructure. The SCIM URL is
   `https://<server>.<org>.<apex>/scim/v2`, behind the box's TLS like every app.

## 2. Records

- `flagship/org-directory-entry/v1`, sealed under the directory key: `{seatId?, pendingId?, pseudonym, displayName?,
  email?, externalId?, source: "manual"|"scim"|"ldap"|"<custom>", groups[], updatedAt}`. Unsealed on `.com`:
  `orgId`, an opaque `entryId`, the key-ring version, a size bucket.
- `flagship/org-connector/v1`, an org authority record, approved like any org change (one admin, or as the bylaws
  say): `{connectorId, kind: scim|ldap|custom, box (STK), scopes: ["propose-invite","propose-offboard",
  "update-entry"], mapping digest, createdAt}`. The box holds the connector's signing key; every proposal it makes
  carries the connector's signature, so the audit shows which connector proposed what.
- `flagship/org-proposal/v1`: `{proposalId, connectorId, kind: invite|offboard|role-change|entry-update, the entry
  diff (sealed), issuedAt}`. A proposal executes only through the existing approval records
  (`flagship/org-approval/v1`), so nothing new can move authority.
- All new tags get strict field formats (no `|` can shift a field boundary, AT-ENV-09), forgery tests and shared
  vectors in TS, Swift and Kotlin.

## 3. SCIM 2.0 (barebones)

- Endpoints on the connector box: `GET/POST /Users`, `GET/PUT/PATCH/DELETE /Users/{id}`, `GET/POST/PATCH /Groups`,
  `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`. Filtering supports only `userName eq` and
  `externalId eq` (what Entra and Okta send).
- Auth: a bearer token the admin creates when adding the connector; only its hash is stored. Rate-limited, and every
  request is audited.
- Mapping: `userName` → email, `displayName` → display name, `externalId` → external id, `active=false` or DELETE →
  offboarding proposal, group membership → org roles and server scopes through an admin-edited table.
- Invitations: SCIM can't send email. A pending invitation shows in the admin console ("3 people from Entra are
  waiting for an invitation"); the admin approves it and shares the link the usual way. A later option is a webhook
  the company's own mailer calls.

## 4. LDAP pull (barebones)

- Config: an `ldaps://` URL, bind DN and password (sealed to the connector box), base DN, user filter, group filter,
  and attribute names for email, display name and external id. Defaults are given for AD (`objectGUID`,
  `userPrincipalName`, `memberOf`, `userAccountControl` for disabled accounts) and for OpenLDAP (`entryUUID`,
  `mail`, `memberOf`).
- Runs every 15 minutes by default. Computes the difference from the last snapshot and emits the same proposals as
  SCIM. Read-only: it never writes back to the directory.

## 5. `DirectorySource` (for developers)

```ts
interface DirectorySource {
  id: string;                                    // connector id
  snapshot(): AsyncIterable<DirectoryUser>;      // full list
  changes?(since: string): AsyncIterable<DirectoryChange>; // optional delta feed
}
```
The box diffs, maps and proposes; a source only reads its system. Docs and a sample source ship with the box.

## 6. UI

- **Admin console, Directory:** people (pseudonym, name, role, groups, source, last sync), pending invitations and
  proposals with Approve, connectors (add, the SCIM URL and token shown once, the LDAP form, last run, errors, pause).
- **Members:** the names they may see, in the server and app pages ("Shared with: Ana (Finance)").
- Every string through i18n on all three apps.

## 7. Webapp

The admin console is in every app. Who may sign approvals from the webapp depends on the webapp key-custody
decision (`docs/webapp-key-custody.md`).

## 8. Build order

1. Directory key in the ring and directory entries (TS, Swift, Kotlin, vectors), plus the admins' pseudonym view
   (this closes "Seat <id>").
2. Connector authority record and proposals, executed through approvals.
3. The SCIM server on the box, plus a conformance test with Entra's and Okta's request shapes (recorded fixtures).
4. LDAP pull, tested against an OpenLDAP container in CI.
5. Admin console screens (iOS first, then Android and the webapp).

## 9. Open (owner)
- Do members see a company address book (everyone's name), or only the people they share with? The default above is
  the second.
- Should the SCIM token be per connector, or also rotate on a schedule? Proposed default: per connector, manual
  rotation, with a warning after 365 days.
