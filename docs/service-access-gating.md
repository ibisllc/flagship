# Service access gating — open/restricted + capability invite links

> Owner-designed (2026-06-18). Lets a service admin gate each service **open-to-all**
> or **restricted**; if restricted, manage an allow-list of people via **bearer
> invite links** that bind to the redeemer's user key. Identity answer: the friend's
> stable handle is their **user key (IRK)**, bound at first redemption — survives
> username changes; survives device swaps via the re-pair continuity chain; reset
> only by a brand-new account. See `gym-proof-ledger.md` for the gym test status.

## Identity / stability
- A person is identified by their **user key = IRK pubkey** (`UsernameRecord.irkPubHex`).
  Username is a remappable label (there's a `UsernameAliasStorage` chain old→current);
  the IRK is the anchor. A new account (new UMK) ⇒ new IRK ⇒ access intentionally lost.
- Device replacement rotates the IRK; `.com` tracks the rotation (re-pair chain / "verify
  under current IRK"), so a re-redeem of the same link can re-bind to the new IRK **only
  if it's a proven continuation** of the bound account.

## Invite id + the packet (on `.com`)
- `inviteId = hash(IRK_author) · hash(devicePub_author) · counter` — unique, attributable
  to the author + creating device, monotonic per (author, device). Used for revocation +
  the authorization graph.
- New `.com` store `service_invites` (D1): `{ inviteId, authorUserKey (=hash/hex IRK_author),
  serviceRef (server+service the invite grants), encryptedBundle, secretHash,
  boundUserKey (NULL until redeemed → friend IRK pub), boundAt, createdAt, revokedAt }`.
  Indexed by `secretHash` (redeem lookup) and `inviteId` (revoke) and `authorUserKey` (list).
- `secret` = random 32B capability in the link; `.com` stores only `secretHash` (and the
  redeem compares the presented secret's hash).
- `encryptedBundle` = AEAD({ name, photo? }) under a **household key** only the author's
  sibling devices + the author's servers hold (derived from the author's UMK, provisioned
  to the boxes over their pinned pipe). `.com` stores ciphertext only — it cannot read the
  friend's name/photo.

## Flows
1. **Create invite (admin phone):** pick name (+photo) → mint `inviteId` + `secret` →
   AEAD-encrypt the bundle → IRK-sign + `POST .com /api/service-invites` → build the link
   `https://<server>.<user>/invite#<secret>` (or the deep-link form) to copy-paste.
2. **Redeem (friend, first visit to ANY of the author's boxes):** the box receives the
   secret → `POST .com /api/service-invites/redeem { secret, visitorIRKpub, proof }` →
   `.com` first-redeem binds `boundUserKey = visitorIRK`, records author→friend, returns
   the binding + serviceRef → the box adds the friend IRK to the service's allow-list.
   - Re-redeem after a device swap: allowed iff the new IRK is a proven continuation of the
     bound account (re-pair chain); a different account ⇒ 409 "already bound".
3. **Cross-app reuse:** the author now knows friend→IRK, so adding them to another service
   is a pure allow-list write (no new link).
4. **Enforce (box):** per-service `access.mode ∈ {open, restricted}`. open ⇒ anyone;
   restricted ⇒ visitor IRK must be in the service's bound allow-list (the box verifies the
   visitor's session signature against an allow-listed IRK). The allow-list is the set of
   `boundUserKey`s for that service (synced from `.com` / pushed by the daemon).
5. **Revoke:** admin drops the binding (`POST .com /api/service-invites/revoke {inviteId}`
   or remove-from-allow-list) → the daemon prunes the IRK → the friend's next visit is denied.

## Build order
1. **Backend (this worker):** protocol (`inviteId`, the AEAD bundle, the `redeem`/`revoke`
   canonical bytes), `.com` `service_invites` store + handlers (create/redeem/revoke/list,
   first-bind + re-bind-on-continuation), the daemon redeem endpoint + per-service
   `access.mode` + allow-list enforcement + the household-key bundle decrypt. Tests.
2. **Clients:** admin UI (per-service open/restricted toggle + allow-list: add person =
   name/photo/invite-link, remove = revoke) on iOS/Android/webapp; friend deep-link that
   redeems the secret. Mirror the existing membership UI.
3. **Gym test:** drive admin (restrict + invite) → a second sim/context (the friend) opens
   the link → redeems → reaches the restricted service; admin revokes → friend denied. Plus
   the cross-app reuse + the username-change-keeps-access assertion.

## Notes
- Layers on existing `ServiceEntitlement` (IRK-signed access cert) + service `membership`.
- Bearer-link threat model: like any invite link, whoever holds it can redeem; first-bind
  locks it; the author sees who bound it (the graph) + can revoke. Send over a private channel.
