# Manual tests run by the coordinator → must become gym scenarios

Device: Harry's Samsung (Android 16), build feat/phone-usb-burn 4d14960a1, prod .com, fresh account.

| # | Flow (manual) | Result | Gym scenario needed (mock: all apps; live: tools/live-e2e) | Owner agent | Done |
|---|---|---|---|---|---|
| M1 | Welcome → Create your account → handle → Generate keys → Open account (biometric) | pass | onboarding create-account to Home, real biometric stubbed; live: new real account via the app | connect-account / gym sweeps | |
| M2 | New real account, no server: Services/Home show NO fixtures | FAIL (mock fallback) | "new live account with no server shows no fixtures" (Android GymLiveAccountTest), same on iOS/web | device-bugs (Android) | |
| M3 | Secure my account → Cloud recovery → passphrase → Configure → passkey create (Samsung Pass) | FAIL first time, pass on retry | fake credential provider with no PRF on create → still succeeds; wording provider-neutral; configured state | device-bugs (C1–C4) | |
| M4 | Home banner disappears after recovery configured | pass | assert banner gone after setup | gym sweeps | |
| M5 | App lock screen → biometric unlock → Home | pass | lock/unlock scenario incl. Patent Pending bottom layout | connect-account | |
| M6 | Add/Import a server → Create → subdomain empty (preview shows home.…) → Next | BUG: "Enter a subdomain." although preview shows home | subdomain prefilled "home" or preview matches field | redesign/device-bugs | |
| M7 | Create → Authorize each boot + Encrypt → Phone-side backups → delivery chooser | pass (jargon: builder app, recipe, re-mint) | delivery chooser wording | redesign | |
| M8 | Burn to USB on this device (OTG stick attached) | FAIL: generic error in <3 s, no biometric, no request to .com | burn path with a fake USB device: mint succeeds and burn screen opens; errors logged + specific | coordinator investigating | |
| M9 | Returning to the app (am start) drops a half-finished create flow back to Home | BUG | process/activity recreate keeps the create draft | device-bugs | |
| M10 | Any caught exception is shown as "Something went wrong" and NOT logged | BUG (observability) | — (code rule: log class+message, no secrets) | device-bugs | |
| M11 | App in background (screen off) → open → lock screen | FAIL: stuck "Authenticating…", no prompt; needs app restart | screen-off during unlock → prompt deferred to RESUMED, Try again on failure | device-bugs | |
| M12 | Lock with biometrics ON → force-stop → launch | FAIL (SECURITY): opens straight to Home, no biometric | cold start with lock on starts locked | device-bugs | |
| M13 | Settings → Privacy wording | "your pods stay running" → servers | wording check | device-bugs | |
| M14 | Settings → Back up account key → Create backup file | FAIL: button hangs busy, no prompt, no log (same family as M8) | keyfile export with a fake biometric that never shows → times out with a sentence | device-bugs | |
