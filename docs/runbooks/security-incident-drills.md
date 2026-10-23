# Security incident drills (SEC-IR-001)

Each drill below is run on the gym (never on production), once before the 0.3 release and again after
any change to what it exercises. A drill is not done until its receipt is filled in and committed under
`docs/runbooks/receipts/` (one file per drill and date). A drill that cannot be run says so in its
receipt and why; an unrun drill is listed in `SECURITY-0.3-PROGRESS.md`, never silently dropped.

Rules for every drill: use gym accounts and gym boxes only; no production probes; no secret, token or
recovery phrase goes into a receipt (digests, ids, counts and times only); stop and escalate if a drill
touches anything outside the gym.

Receipt template:

```
drill:        <name>
date (UTC):   <date>
build:        <box release commit>, webapp shell <vNNN>
who ran it:   <role, not a name>
steps run:    <numbered, with the command or screen>
expected:     <from the table below>
observed:     <what actually happened, with times>
sliver lines: <issue keys raised and cleared>
activity log: <authority.* lines seen, ids only>
result:       pass | fail | not run (reason)
follow-up:    <issue or tracker line>
```

## 1. Creator-root compromise

A creator's publisher key is stolen and used to sign an update.

1. Install an app from a gym creator; pin its publisher key (first update from the creator).
2. Sign an update with a different key and offer it.
3. Expect: the update is refused, a `publisher-key` line appears in the security sliver, the app keeps
   running its current version, nothing changes until an admin device signs the trust statement.
4. Reject it from the phone; expect updates paused and the line to stay for its retention time.
5. Repeat with a valid rotation chain: expect a warning and a phone-signed approval before anything runs.

## 2. Companion deploy (delegated Remote build)

A Remote browser session is used to build or deploy.

1. Dock a browser through Remote; try to start a build. Expect `route-not-allowed-for-session`.
2. From an admin device, delegate build on ONE app for 30 minutes. Start a build on that app: allowed.
   Start one on another app, or a new app: refused. Try keys, backups, paired sessions: refused.
3. Revoke the delegation, and separately end the session: the build and its streams stop within the
   revocation target (5 s); an `authority.revoked` line is in the activity log.

## 3. Adapter incident

A community adapter turns out to be malicious or wrong.

1. With adapter lookups on in the gym only, import a repo through an adapter.
2. Retire the adapter (three complaints, or revoke the attestation). Expect the box to stop offering it,
   a changed digest to need manual acceptance, and an installed app to keep its signed source.
3. Expect no adapter JSON ever grants host access or reads another service's data.

## 4. Stolen box

A box is taken away powered off, or its disk copied.

1. Delete the server from the account (`Delete` on Home) and, separately, revoke it.
2. Expect: the unlock lease is no longer served; a copied sealed lease plus its key still opens a copy
   (the plan's N10 limit is stated in the app, not hidden); the account's other servers are unaffected.
3. Un-revoke a revoked box: expect one phone approval on its next boot.

## 5. Lock bypass

Someone tries to run a box past a suspension or lock.

1. Suspend a gym box (set-only boot suspension); remove local markers; replay an old lease.
2. Expect the boot worker to refuse, the generation to be monotonic, and only the owner/admin to start
   a new epoch. Record any replay that still works (the receipt lists it; do not claim hardware backing
   the box does not have).

## 6. Evil maid

Someone with brief physical access changes boot components or adds a USB device.

1. Boot a gym VM with a modified initramfs and with an extra disk.
2. Expect the unlock to need the phone, the changed measurement to be reported where measured boot is
   available, and no secret to be released to the changed environment. State plainly where it is not.

## 7. Malicious helper

The privileged helper (root helper on Studio, the box broker) is asked for something outside its list.

1. Send each helper a request outside its closed set, a path with `..`, a symlink swap, a flag that
   would give a container the host.
2. Expect refusal with an audit line without bodies, and the helper still serving later requests.

## 8. Browser escape

An app-browser page reaches for the local network, another origin or another app's context.

1. The app browser is OFF in 0.3. Confirm `appBrowserOff.test.ts` passes and the Chromium profile is
   absent. A drill of the policy layer waits for the browser to be turned on.

## 9. Root store and rogue certificate

An unexpected certificate appears for a box name.

1. Run `npm run zone-health` (read-only) with the production admin secret on the owner's machine, and
   the gym equivalent in the gym. Expect the apex CAA to list only Let's Encrypt and no record at an
   account or box name.
2. Issue a certificate outside the CAA from a gym name; expect `.com`'s CT/CAA monitor to flag it.

## 10. Release-key loss and malicious CI

A release key is lost, or CI builds something other than the source.

1. Follow `docs/runbooks/final-deploy.md` and `docs/ca-operations.md` to endorse a release with fewer
   than the full set of keys; expect the threshold to refuse below it.
2. Build the box artifact twice in clean environments; expect identical digests
   (`scripts/verify-box-artifact.test.ts`, `box-artifact.yml`). A mismatch is a failed drill.
3. Tamper with a built artifact: expect the box to refuse it and keep the running release.
4. Raise a security notice with `scripts/security-notice.mjs` (preview, then sign offline); expect the
   banner/lock on all three clients and nothing signed by `.com`.

## 11. ACME account response

The ACME account key or a certificate order is abused.

1. Rotate the box's ACME account (keyd signs by request kind); revoke the old account's certificates.
2. Expect no TLS or ACME key in the daemon process, and the box to serve again within the renewal
   window without a phone prompt beyond the documented one.

## 12. Backup deletion and cloud outage

1. Delete the newest scheduled backup on the box; expect the independent copy on the phone or peers to
   restore (`docs/server-backup-and-clone.md`), and the restore summary to list permissions awaiting
   approval, reconnects and database notes.
2. Take `.com` away from a gym box (block it): expect owner control to keep working, guest access to
   lapse after the freshness window (10 minutes), the update catalog to go stale without touching
   unrelated apps, and the CA-expiry line to appear when the lease nears its end.
3. Run `npm run rate-limits` weekly and before launch, and record the date in `AGENTS.md`.

## After each drill

Fix what failed; do not edit the receipt to say it passed. Update `SECURITY-0.3-PROGRESS.md` with what
the drill proved and what it did not.
