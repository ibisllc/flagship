# Changing the account key (account master-key rotation)

Status: protocol, `.com` and box sides built on `release/0.5` (2026-11-27); client screens and the per-server
re-keys are next. Not deployed.

An admin device can replace the account's master key (UMK) with a new one, for example after a device was lost or
given away. The IRK and the AID, both derived from the UMK, change with it. Kept devices receive the new key; servers
follow without being paired again.

## The hop

One envelope moves the account from key epoch N to N+1:

```
flagship/account-key-rotation/v1|<username>|<fromEpoch>|<toEpoch>|<oldIrk>|<newIrk>|<newIrkScheme>|<oldAid>|<newAid>|
  <adminRoot>|<removedDeviceIds|none>|<keptDevicesDigest>|<recoveryRecordDigest|none>|<nonce>|<issuedAt>
```

- Authorised by the admin root the account pins, and only by it: not by the IRK, not by an admin device's own key.
- Signed by the new IRK and the new AID over the same bytes (proof of possession).
- `keptDevicesDigest` is SHA-256 of the sorted lines `<deviceId>:<devicePubHex>\n`.
- `recoveryRecordDigest` is the digest of the replacement cloud-recovery record (`recoveryRecordDigest` of its v2
  claim, signed by the new IRK), or `none` when the old record is deleted.
- Under strict assurance it carries its hybrid companion (`flagship/account-key-rotation/v2`) and the new IRK's
  `account-irk` binding. Outside strict a companion that is sent must verify.

Each kept device gets `flagship/umk-rotation-delivery/v1` (admin-root-signed), sealed with X-Wing to its receive key
(`flagship/device-receive-key/v1`, signed by its identity key). Outside strict, a device without a receive key may get
a classical seal to its identity key; under strict it is added again instead.

## `.com`

| Route | Auth | What |
|---|---|---|
| `POST /api/users/:u/account-key-rotation` | the hop's admin-root signature | apply one hop |
| `GET /api/users/:u/account-key-rotations` | account read token | the lane |
| `GET /api/accounts/:u/devices/:id/umk-rotation` | device-signed | that device's deliveries and the lane |
| `POST /api/accounts/:u/devices/:id/umk-rotation/ack` | device-signed | `{ toEpoch }` |
| `PUT /api/accounts/:u/devices/:id/receive-key` | device-signed | `{ receiveKey, signatureHex }` |
| `POST /api/accounts/:u/devices/:id/key` | new key + admin root | `flagship/device-key-rotate/v1`, with a grant for the new key |

The apply body is `{ rotation, signatures, pq?, kept, deliveries?, grants?, recovery?, accountProfile?,
managedProfiles?, adminRootRotation? }`. `.com` checks the hop against its own state (IRK, AID, epoch, pinned admin
root) and every part of the body, then applies it in one storage transaction: the IRK/AID swap and epoch, the lane
entry, the revocation of every device not kept (identity, grants, push tokens), replacement grants for kept devices
whose grant the old IRK signed, a pending re-pair marked objected, the recovery record replaced or deleted,
re-encrypted profiles (self profiles and directory key grants are dropped), the deliveries and an audit row. If the
account changed meanwhile nothing is applied (409). The same hop again answers 200 `applied: false`.

The lane lists admin-root rotations and account-key hops in replay order: a hop comes right after the admin-root
rotation that pinned the root which signed it. `keyEpoch` is on `/api/username/:u`, `/pods`, `/stream` and the box
doorbell (with a stamp of the lane).

## Boxes

A box that pins an admin root replays the lane itself from its pin (`account-key-pin.json`), with
`verifyAccountKeyRotationChain`. On a verified hop it adopts the new IRK and AID, re-anchors app membership, rewrites
the owner key on `/boot`, ends every owner and companion session (browsers approve again), discards unused
pre-deposited backup keys and flags the per-server re-keys as due, notes `account.key.rotated` in Activity and
restarts. A pin that cannot be read is rebuilt from the box's own key; until then, and whenever `.com` reports a
higher epoch than the box verified, the box refuses requests signed with the account key (orders, SWK/CGK and pairing
deliveries). `GET /api/screens/account-key/status` reports the epoch the box verified and its capability
(`account-key-rotation/v1`); clients offer the rotation only when every server reports it.

## Not covered by a rotation

Past backups stay openable with the old key; copies of the old key that were exported stay valid for what they
already protect; other accounts' servers learn the new per-app identities only when they process a rollover (later
phase).
