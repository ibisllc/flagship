# Changing the account key (account master-key rotation)

Status: protocol, `.com`, box and client sides (iOS, Android, webapp) built on `release/0.5` (2026-11-27); the
per-server re-keys are next. Not deployed; not run on real devices yet.

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

## Clients

**Device keys.** A device's account key is random and never derived from the UMK: the UMK yields only the IRK and the
AID. New accounts, account renames and the webapp make a random key before `.com` sees it. A device that still has a
key derived from the UMK and holds the admin root replaces it once, after an unlock it already asked for
(`flagship/device-key-rotate/v1` with an admin-root grant for the new key, same scopes). A non-admin device with a
derived key cannot do that and is removed and added again at the next rotation. Every device publishes an X-Wing
receive key (`flagship/device-receive-key/v1`), kept under the same protection as its UMK.

**Admins by grant.** Add a device promotes an admin with an admin-root-signed grant (scope `admin`) to the new
device's own key; the join bundle carries the admin root's public key (`adminRootPubHex`) and no longer the root
itself, so the bare root stays on the device that holds it and in the recovery escrow. Member grants from a
root-holding device are admin-root-signed too. Join still accepts a bundle with the sealed root from an older app.
The joining device pins the admin root named by its bundle (the bundle is authenticated by the pairing code) and
replays account-key changes from it; a device with no pin cannot take a new key and is added again. Operations that
still need the bare root (adding servers, server orders, rotations) stay with the root-holding device.

**Removing a device.** An admin device asks "Could someone else unlock this device?". "No" removes it as before.
"Yes, or I'm not sure" shows what changing the account key does and runs the rotation:

1. If the removed device's grant carries `admin`, the admin root rotates in the same request.
2. A new UMK is kept in a pending slot with the request.
3. The kept set is exactly the devices that get a delivery, plus the rotating device. A device that cannot receive one
   (a derived key, no receive key under strict) is revoked in the hop and named in the summary with the reason.
4. Kept devices whose grant the old IRK signed get an admin-root grant; account and managed names are re-encrypted.
5. The old cloud-recovery record is deleted in the hop; the app then offers recovery setup with a new passkey and
   warns until it is done.
6. The new UMK becomes current on `200`, or on the next start when `.com`'s IRK is the one it derives. The old UMK is
   kept in a retired slot per epoch.

The browser signs no hybrid companion, so under strict it does not rotate and points to the phone apps.

**Kept devices.** On the `account-key-rotated` push, on unlock and on foreground a device fetches its delivery,
replays the lane from the admin root it pinned, checks it is in the kept list, opens the seal, checks that the new UMK
gives the hop's IRK and AID, installs it (IRK in the rotator's scheme, version 1), keeps the old one retired,
publishes its own profile again and acknowledges. A progress card on admin devices counts devices back in the
directory and servers whose verified epoch reached the new one.

## Not covered by a rotation

Past backups stay openable with the old key; copies of the old key that were exported stay valid for what they
already protect; other accounts' servers learn the new per-app identities only when they process a rollover (later
phase).
