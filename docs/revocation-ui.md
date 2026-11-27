# Removing a device — iOS, Android, webapp

What each client renders to take a device off the account, what that does on `.com` and on the servers, and what
the removed device does when it hears about it. Protocol details live in [[multi-device]] and [[wipe-restart]].
Rewritten for 0.5 (2026-11-27): the old per-device menu (Disconnect, Replace device, Wipe & restart) mixed one
device's removal with two account-wide key ceremonies.

## Where the actions live

| Action | Where | Who |
|---|---|---|
| Rename | Settings → Trusted devices → a device's menu ("Rename this device" on this device; "Set / Edit / Remove managed name" for an admin) | as before |
| **Remove from account** | Settings → Trusted devices → another device's menu (never on this device's own row) | `.com` takes it from an admin device or one with the `revoke-others` scope |
| Remove this device | Settings → danger zone (this device only; unchanged) | this device |
| **Reset account keys** | Settings → Account security | any signed-in device that can open the account key (the ceremony is unchanged) |

"Replace device" is gone from every client's device menu. It bumped the IRK version (`irk/vN` from the same UMK),
which gives no protection against a removed device: that device holds the UMK and derives every version. The pending
re-pair banner and its Finalize screen stay, because a recovery's re-pair still uses them.

## Copy (English; every string goes through `i18n/<surface>`)

Remove from account:

> **Remove {name} from your account?**
>
> It loses access to your account and your servers. The next time it goes online, Flagship erases your account's
> keys from it.
>
> [Remove from account] (destructive) · [Cancel]

On failure the alert is titled **Couldn't remove the device** and shows the real reason (`UserErrorText` on iOS and
Android, the webapp's error text helper): a non-admin device reads "This device isn't allowed to do that."; a
declined Face ID shows nothing.

Reset account keys (Account security):

> **Reset account keys** — Makes new keys for your account. Every other device is removed and has to join again,
> and every server has to be paired again. Your servers keep their data, and the account stays on this device.
>
> Confirmation **Reset your account keys?** with the same text plus "This can't be undone." and
> [Reset account keys] (destructive). The ceremony, its passkey registration and its confirmation are those of
> [[wipe-restart]].

The removed device's screen (full screen, above everything, like "This account was removed" in
[[account-gone]]):

> **This device was removed from your account** (webapp: "This browser was removed from your account")
>
> Another device on the account removed it, so Flagship erased the account's keys from this device. The account and
> its servers are not changed.
>
> Account: {name}
>
> [Join an account] (opens Connect to an existing account) · [Remove it from this device]

No "save my servers' data" offer: a device the account removed is not a rescue path.

## What Remove from account does

1. **`.com`** (`handleRevokeAccountDevice`, `DELETE /api/accounts/:u/devices/:id`): revokes the device identity, its
   capability grants, its voi.ci call keys, then its push tokens. Just before the tokens are dropped, a device
   removed by ANOTHER device gets one content-free push, category `device-removed` (`buildDeviceRemovedNotifier`):
   APNs with a fixed localized alert ("This device was removed from your Flagship account.") and
   `content-available: 1` so iOS can wake the app; FCM data-only, high priority; Web Push `{category, kind}`.
   A device removing itself is not pushed.
2. **Every later request from that device** gets one distinct answer, `403 { "error": "device-removed", "code":
   "device-removed" }`, from the two choke points: a signed account-directory request (`authorizeActiveDevice`'s
   refusal path, `deviceRefusal`: the directory, profiles, managed names, directory key grants, the device-path
   read-token mint) and a bearer read token minted for that device (`requireAccountRead`: `/pods`, `/stream`,
   `/audit`, `device-grants`, …). The code is given only when the request verifies, fresh, under that removed
   device's own key, or the token's MAC is good and names that device and key; anything else (another key, a stale
   request, the IRK path) keeps the generic refusal. Working devices never reach this code (it runs only after the
   normal check refused).
3. **The servers** drop the device from their device book on the next refresh (`GET /api/users/<u>/device-grants`,
   every 5 minutes, at the `grants` doorbell, or at once when the admin root revokes it locally). The book reports
   each device that leaves it (never on a load from disk, never when `.com` can't be reached), and the daemon ends
   that device's app sign-ins (`ServiceSessionStore.closeAllForAid`, sessions bound to its account device key) and
   its quantum-safe sessions (`PqChannelServer.closeForDevice`).

## What the removed device does

* **Never erases on the push.** The push only makes it ask `.com` now: a fresh device-path read-token mint
  (iOS `DeviceRemovedCheck` → `AccountReadTokenProvider.retryNow`; Android from the FCM service; the webapp's service
  worker messages open windows, or shows a content-free notification that opens the webapp, which checks on start).
* **Erases on `.com`'s answer.** The client's one `.com` choke point (iOS `gatedData` → `AccountGoneRegistry`;
  Android's account-gone interceptor; the webapp's `comFetch`) treats `403 device-removed` as removal only when the
  request went to the control apex itself (never a box's host, which could say anything) and its path names this
  device's own account. Then, without a biometric prompt (the account already removed this device), it runs the
  same erase as Sign out / Remove this device: the wrapped UMK, IRK slots, admin root, watch keys, PQ seeds, serving
  renewal key, read tokens, cert and server-key pins (iOS also the stored account device key and device id); signs
  out; stops every poller; and shows the screen above. Later calls for that account are answered locally.
* A device that is off, or whose app never runs again, keeps its keys: nothing on `.com` can reach it.

## Limits (as built, 0.5)

* **The UMK is shared.** A removed device that never comes online, or one in hostile hands, still holds the account
  key (UMK) and so the IRK. `.com` refuses its device key, and the servers end its device-key sessions, but the IRK
  path (IRK-signed read tokens, IRK-signed orders, owner paired-session tokens) still works for it. Real protection
  needs a new account key: the planned master-key rotation (another design; Remove from account is built so a
  "Could someone else unlock this device?" step can go between the confirmation and the call) or, today, Reset
  account keys.
* **A removed admin device keeps its copy of the admin root** until it erases itself. If it may be in someone
  else's hands, also use Account security → Rotate admin key.
* **Owner paired-session tokens** on the boxes are added by IRK-signed orders and name no device, so a box cannot end
  "that device's" paired sessions.
* Reset account keys revokes every grant on `.com` but not the other devices' identities, so they do not get
  `device-removed` (they get the account-reset banner on Home instead).

## What gets recorded

Every confirmed action writes an audit row (see [[multi-device]] § endpoints), shown in Activity on all three apps:
`device-disconnected` ("Disconnected device"), `device-replaced`, `device-added`, `wipe-restart`, `recovery-set-up`,
`recovery-rotated`.

## Tests

`packages/control-plane/tests/accountDirectory.test.ts` and `accountReadToken.test.ts` (who hears `device-removed`,
the push before the tokens go, none on self-removal), `pushBridge.test.ts` (the push shape),
`packages/server-daemon/tests/deviceRemovedSessions.test.ts` and `pqChannel.test.ts` (sessions end),
iOS `AccountGoneTests` + `GymAccountGoneTests` (`-gym-account-gone-mode removed|removed-box`) +
`GymSweepSettingsTests`, Android `AccountGoneTest`, the webapp's tests. Parity row `device-removed`.

## See also

- [[multi-device]] — protocol layer.
- [[wipe-restart]] — the Reset account keys ceremony in detail.
- [[account-gone]] — the sibling screen for an account that no longer exists.
