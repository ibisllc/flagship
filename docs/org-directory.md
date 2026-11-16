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

## 9. Owner decisions (2026-11-15)
- **Members see only the people and servers they share something with**; there is no company-wide address book. Built
  in 0.4 (every feature lands in 0.4).
- **SCIM tokens are per connector**, rotated by hand, with a warning after 365 days.
- **Connector setup through the admin's phone: accepted** (the phone makes the connector's seeds and seals them to the box).
- **A connector does not die silently when its approver leaves:** it is flagged "needs re-approval", keeps working for
  7 days, then is suspended until any org admin approves it again; the approver's removal or offboarding lists it among
  the pending rotations.

## 10. As built (branch `0.4/org-directory`, 2026-11-15)

Not deployed, not run on a real box or phone.

**Directory entries (§8 step 1).** `packages/protocol/src/orgDirectory.ts`; ports `apps/mobile/shared/Sources/FlagshipCore/OrgDirectory.swift`
and `apps/mobile/android/.../core/pq/OrgDirectory.kt`; vectors `test-vectors/org-directory` (`tools/org-directory-vectors.ts`),
read by TS, Swift and Kotlin. The ring kind is the existing `directory-key` (sealed to org admins only).
- Body `flagship/org-directory-entry/v1|body|<seatId>|<pendingId>|<pseudonym>|<displayName>|<email>|<externalId>|<source>|<groups>|<updatedAt>`:
  every free-text field is unpadded base64url of NFC UTF-8 (no control characters, byte limits 128/256/320/256, at most
  32 groups of 256), groups comma-joined and sorted, so no value can move a `|` or `,` boundary (AT-ENV-09). Exactly one
  of seatId and pendingId.
- Sealed with AES-256-GCM under `HKDF(directoryKey, info = <tag>|key|<orgId>|<entryId>|<keyVersion>)`, AAD
  `<tag>|seal|<orgId>|<entryId>|<keyVersion>|<sizeBucket>`, the body padded to a bucket of 256…8192 bytes. `.com` sees
  orgId, an opaque entryId, the key version and the bucket.
- `GET/POST /api/orgs/<id>/directory`: a write needs one org admin's `org-approval` over
  `<tag>|<orgId>|<entryId>|<keyVersion>|<sizeBucket>|<sealedSha256>|<issuedAt>`; `.com` keeps the newest per entryId (an
  older one is refused). Readers keep the newest `updatedAt` per seat, so a replayed older entry never renames anyone.
- Phones: the first admin who opens an org page announces its seat KEM key if `.com` lacks it, makes directory key v1
  (sealed to every admin with a KEM key) when none exists, opens every version it can and shows the pseudonyms in
  "Waiting to join", "People who can approve", "Keys to rotate" and Restore my access (iOS `OrgViewModel.loadNames`,
  Android the same). The inviter writes the person's entry as it makes the invitation, so the names show before they
  join. A directory-key rotation re-seals every entry under the new version. Until the directory opens (a locked
  phone, a member seat) a row says "Name hidden (<6 hex>)".
- The webapp has no org seat keys (`webapp-key-custody.md` is undecided), so it shows no names yet (parity allowlist).
- Member slices (the people a member shares with) are not built: the directory key goes to org admins only.

**Connectors and proposals (§8 step 2).** `packages/protocol/src/orgConnector.ts`, `.com`
`packages/control-plane/src/orgConnectors.ts`, ports `OrgConnector.swift` / `OrgConnector.kt`, vectors in
`test-vectors/org-directory` (`connectors`), forgery AT-ENV-48/49.
- `flagship/org-connector/v1|<orgId>|<connectorId>|<scim|ldap|custom>|<serverDomain>|<connectorKeyId>|<scopes>|<mappingSha256>|<active|paused|retired>|<issuedAt>`,
  approved by one org admin, the box one of the org's registered servers, `connectorKeyId` the id of a hybrid
  (Ed25519 + ML-DSA-65) key the connector box holds. A newer record replaces the older; a retired id never returns; the
  key never changes (add a new connector instead).
- `flagship/org-proposal/v1|<orgId>|<proposalId>|<connectorId>|<kind>|<subject>|<rolesHash>|<sealedSha256>|<issuedAt>`,
  signed by the connector key. The person's directory entry is hybrid-sealed (X-Wing) to each org admin's seat KEM key
  (context orgId, proposalId, recipient), and `sealedSha256` commits to every copy, so `.com` can neither read nor hide
  a copy. Scopes: `propose-invite` (invite, role-change), `propose-offboard`, `update-entry`.
- A proposal moves no authority. The admin acts with the usual invite, revoke or grant, then records
  `<tag>|decision|<orgId>|<proposalId>|<done|declined>|<refSha256>|<issuedAt>` under one org admin's approval; for "done"
  `.com` checks that refSha256 is already in the org log.
- Routes: `GET/POST /api/orgs/<id>/connectors`, `GET/POST /api/orgs/<id>/proposals`, `POST /api/orgs/<id>/proposals/decisions`.

**The connector box (§8 steps 3-5).** `packages/server-daemon/src/directory/`; developer guide
`docs/directory-connectors.md`.
- The admin's phone makes the connector's hybrid seeds and (SCIM) a bearer token shown once, approves the record, and
  seals the setup (`sealOrgConnectorSetup`: seeds, mapping, token SHA-256, LDAP settings and bind password) to the box's
  org KEM key; `.com` stores it as ciphertext beside the record. The box (`ConnectorRuntime`) re-reads the records every
  5 minutes, checks each under its own pinned chain (`verifyOrgConnector(..., { stored: true })`: the approval as of the
  record it names, its signers still org admins now), opens the setup and checks the seeds against the approved key id
  and the mapping against its digest. A token rotation is a re-post with a later `issuedAt` and a new setup; the box
  warns in Activity when a token is over 365 days old.
- `engine.ts` diffs each snapshot against the last and proposes invite / offboard / role-change / entry-update once
  each; a pending person is linked to a seat only when the decided invite proposal's `refSha256` matches an invite whose
  seat the box's pinned seat book holds.
- SCIM 2.0 (`scim.ts`) at `/scim/v2` on the box's own name: Users, Groups, ServiceProviderConfig, Schemas, ResourceTypes;
  filters `userName eq`, `externalId eq` (and `displayName eq` for Groups, which Entra sends); Entra's and Okta's PATCH
  shapes; 600 requests a minute; counts per 15 minutes in Activity, never names. Tests replay recorded Entra and Okta
  request sequences (`tests/fixtures/scim/`).
- LDAP pull (`ldap.ts`, `ldapts` 9.2.0: MIT, pure TypeScript, one dependency) over LDAPS only, AD and OpenLDAP defaults,
  every 15 minutes by default; tests run the real client against an in-process fake LDAP server. No CI job against an
  OpenLDAP container: no existing workflow runs service containers for the daemon's unit tests.
- `DirectorySource` (`source.ts`) with the sample `StaticDirectorySource` (a JSON file).
- Not built: a `changes()` delta feed for any built-in source, group sync beyond membership names, a webhook for the
  company's mailer, SCIM bulk.

**Admin console (§8 step 6).** iOS (`OrgDirectorySections` in `OrgScreens.swift`, `OrgViewModel`) and Android
(`OrgDirectorySections` in `OrgScreens.kt`, `OrgViewModel`), for org admins on the org page:
- **From your company directory:** each open proposal, checked against its connector record and opened with this admin's
  seat KEM key (one that changed after the connector signed it is not shown). Approve carries it out: an invite makes the
  invitation with the proposed roles and the person's entry (share the link as usual), an offboard revokes the seat
  (the key rotations follow in "Keys to rotate"), an entry update re-seals the entry; then the decision is recorded with
  the digest of what was done. A role change is shown but must be done from the person's seat (open). Decline records a
  decline.
- **People:** each entry's name, email and groups.
- **Directory connectors:** the org's connectors (kind, server, status) and "Add a SCIM connector": pick one of the org's
  servers; the phone makes the key and token, seals the setup to that server and shows the SCIM URL and token once.
- See "Second round" below for the LDAP form, the mapping editor, pause / retire / token rotation, role changes and the
  members' "Shared with" view. The webapp console waits for the key-custody branch.

**Second round (owner decisions above).**
- **Re-approval.** `orgConnectorStanding` (TS, Swift `OrgConnectors.standing`, Kotlin `OrgConnectorStandings.standing`,
  vectors `standing`): the stored approval is checked as of the record it names; when every approver is no longer an
  org admin the standing is `needs-reapproval` from the first record that dropped the last of them, and `suspended` 7 days
  later. The box keeps a `needs-reapproval` connector running with one Activity line saying when it stops, and stops a
  suspended one (Activity says so). `.com` returns each connector's standing on `GET /connectors` and the ones to
  re-approve as `pendingConnectors` on `GET /keys`; the phones list them under "Keys to rotate" with "Approve again",
  which posts the same record with a later `issuedAt` under the admin's own approval.
- **Members' slices.** `flagship/org-directory-slice/v1`: an org admin's phone seals to each live seat that is not an org
  admin (and announced a KEM key) the entries of the people it shares something with and the servers its roles name:
  every org admin, each seat whose roles name a server or app its roles name (`*` matches every server). Emails and
  external ids are left out. `GET/POST /api/orgs/<id>/directory/slices` (one org admin approves a write; the seat must be
  live and the slice sealed to its announced KEM key; newest per seat). A keyed tag (HMAC under the directory key) lets
  an admin see a stale slice without opening it; phones re-publish stale ones when an admin opens the org page. The
  member's phone checks an org admin approved its slice (anyone can seal to a public key), opens it and shows "Shared
  with" on the org page, and uses the names on its other org rows. Vectors `slices`; forgery AT-ENV-50.
- **Connector upkeep from the console** (iOS and Android): pause, resume, retire (with a confirmation), a new SCIM token
  (shown once), the group → role mapping editor, the LDAP form (AD or OpenLDAP, `ldaps://` only, the password sealed to
  the box), and "Add an LDAP connector". A later setup is partial: it carries only what changed (no seeds, or no mapping,
  or no token); the box keeps the rest of what it opened before in `<dataDir>/org-directory/<id>.setup.json` (0600, on
  the encrypted disk). The mapping also travels sealed under the directory key (`mappingSealed`) so any org admin can
  edit it.
- **Role-change proposals** are carried out with a new seat grant (the seat's existing keys, the proposed roles), through
  a ceremony when the roles need two admins; an admin role for a seat that has no admin key asks for a new invitation.
- **SCIM audit:** one content-free Activity line per request (`SCIM <method> <resource kind> <status> (connector <id8>)`;
  an unknown path reads "other"), so nothing a model could read names a person.
- **CI:** the `openldap` job in `ci.yml` runs LDAP pull against an `osixia/openldap:1.5.0` service container
  (`directory.openldap.integration.test.ts`, skipped without `FLAGSHIP_TEST_LDAP_URL`); not run locally (no Docker here).
- **Webapp (built, 2026-11-16, branch `0.4/webapp-custody`):** the webapp is an org seat (`docs/webapp-key-custody.md`
  item 1). `lib/orgDirectoryConsole.js` opens the directory key with the seat's X-Wing key (`deriveOrgSeatKemSeed`),
  reads the people, verifies and opens the proposals, shows each connector's standing, adds SCIM and LDAP connectors
  (`sealOrgConnectorSetup`), re-approves, pauses, resumes, retires, rotates the SCIM token, edits the mapping as text
  lines (`sealOrgConnectorMapping`), seals the members' slices, and shows a member its "Shared with"
  (`openOrgDirectorySlice` after `verifyOrgDirectorySliceApproval`). The functions are the bundled protocol code
  (`apps/web/public/webapp/vendor/flagship-org/org.js`); parity reads that bundle, so the org tags left the allowlist.

**Joining.** A joining seat signs its seat KEM statement (`org-seat-kem/v1`) with its member key at accept and sends it
with the accept; `.com` checks it against the member binding, keeps it, and records it as the seat's KEM key when the
grant lands, so a member receives key-ring versions without opening the org page (release-manager decision).

