# Store review notes (App Store and Google Play)

What to paste into App Store Connect and Play Console when a build goes to review, and the answers the consoles ask
for. `final-deploy.md` step 11 points here. Draft written for 0.3 (voi.ci pages and Messages,
`docs/voici-and-messages.md` §9.7); the owner checks it before each submission.

## Before you submit (owner)

1. **Messages must be on in production during review.** `.com` answers every voi.ci route with 404 while
   `VOICI_ENABLED` is `"off"` (`apps/com/wrangler.toml`), so a reviewer opening the Messages tab would see only
   errors. Either switch it on before submitting (the routes are safe with old store builds: they never call them),
   or hold the submission until it is on.
2. **The review login shows an example page, not Messages.** `playstore-test-0725` is a sample (demo) account. Its
   page is an example the operator publishes: run `node scripts/sample-user.mjs example-page playstore-test-0725`
   (needs only `FLAGSHIP_ADMIN_SECRET`) before submitting and check https://voi.ci/playstore-test-0725 shows it. In
   the app the Messages tab shows that page read-only: the Public switch is disabled and the app says "This is a
   sample account. Its page is an example, so you can't change it."; View page opens it on voi.ci. Its conversations
   can't be reviewed from it (it accepts no messages, and nobody but the operator can sign its page). A real account
   lives in the keys of the phone that made it, so a reviewer can't sign in to one of ours; they create their own in
   a minute.
   The notes' main path needs nothing from us: the reviewer makes two accounts on two devices (iPhone + iPad), one
   publishes a page, the other messages it, and the first sees Report and Block (owner, 2026-11-07). A second Messages
   account on a device that already used Messages this month goes on the slow tier instead of being refused
   (429ea977b), so shared review devices work. We don't run a review page or answer reviewers' messages (owner,
   2026-11-07): the two-device test is the only Messages path in the notes.
3. The `abuse@flagship.services` mailbox must be read daily, and `npm run ops -- voici` checked for reports older
   than 24 hours (Apple expects action on reports within 24 hours).
4. The DMCA designated agent must be filled in `apps/web/public/terms.html` §9 (`npm run release-manifest` fails
   until it is).

## App Store Connect: App Review Information, Notes

Paste as is:

```
Flagship lets you run your own server at home and manage it from this app. We provide a live demo server for review.

Sign-in: Flagship has no passwords. On the first screen tap "Connect to an existing account", type playstore-test-0725 and tap Continue. You land on Home with the demo server online. Tap it for live status and its certificate; the Services, Activity and Settings tabs are live.

User-generated content (Guideline 1.2): Flagship 0.3 adds voi.ci pages and Messages. A user can publish a public profile page (photo, name, bio, links, posts) at voi.ci/<username> and receive end-to-end encrypted messages from other Flagship users through it. The demo account's page is a read-only example (https://voi.ci/playstore-test-0725); it can't send or receive messages.

To test pages and Messages, use two new accounts on two devices (for example the iPhone and the iPad). Each account takes about a minute.
1. Device 1: first screen > "Create your account". Then Messages tab > "Set up your page": add a name or a post, turn on "Accept messages", tap "Publish your page", and turn on "Public" ("Make it public"). The page's address, voi.ci/<username>, is shown there ("View page" opens it).
2. Device 2: create a second account the same way. Open Safari at https://voi.ci/<username from step 1>, tap "Send me a message", approve "Sign in to voi.ci" in the Flagship app when it opens, go back to Safari and write a message.
3. Device 1: the message arrives in the Messages tab. Open it: reply, and use the ••• menu for Report and Block (long-press a message to report that message).

- Rules: before a user first publishes a page or approves a sign-in to message someone, the app shows the "Page and message rules" sheet (no illegal content, harassment, threats, spam or impersonation) and the user must tap "I agree". Full terms: https://flagshipserver.com/terms#messages
- Report: every message has Report, with reasons Spam, Harassment, Pretending to be someone, Illegal content, Something else. Every public page has "Report this page" at the bottom.
- Block: every conversation has Block (the ••• menu). A blocked sender isn't told; their messages stop arriving.
- Moderation: a person at Flagship reviews every report within 24 hours. We remove pages that break the rules and ban accounts from Messages (a ban also covers the device, using DeviceCheck / App Attest). Banned users can appeal.
- Abuse contact: abuse@flagship.services, https://flagshipserver.com/abuse
- New accounts can start only 3 new conversations a day, and a sender can send only 3 messages until the page owner replies.

DeviceCheck and App Attest are used only to cap Messages sign-ups per device and to enforce bans; no device identifier is stored.

Face ID is used only to confirm sensitive actions (for example approving a server's start). The camera is used only to scan a pairing QR code. Local network access lets the app reach the user's own server on the same Wi-Fi.

Account deletion: Settings > Delete account permanently deletes an account created in the app. The demo account is managed by us, so for it the same button explains this and removes it from the device.
```

## Google Play Console

- **Policy, User-generated content:** the same features as above. Play wants in-app terms accepted before posting
  (the rules sheet), in-app reporting (Report on messages, Report this page on pages), blocking (Block), and
  moderation; paste the "User-generated content" paragraph above into the review notes of the release
  (Publishing overview > the release > notes for review), or into App content > App access with the login.
- **App access:** "All or some functionality is restricted": give the demo login, plus the two-device Messages test
  (point 2 above), with the same steps.
- **Data safety (draft, the owner confirms):** messages are end-to-end encrypted and Flagship can't read them, so
  their content is not "collected". Declare: User IDs (username, already declared); Photos and Other user-generated
  content (the public page: collected, shared publicly by the user's choice, not optional for a page, used for app
  functionality); Device or other IDs: no (on Android `.com` keeps only the Play Integrity verdict token for 30 days; the
  per-device bits live at Google, not with us). Purpose of the integrity check: fraud prevention,
  security and compliance.
- **Content rating questionnaire:** answer yes to "users can interact or exchange content" (Messages, public pages).
- **Play Integrity:** the Google Cloud project must be linked (`final-deploy.md` step about Android device caps).

## Apple privacy label (draft, the owner confirms)

Add for 0.3: Photos and Other User Content (the public page; linked to the user; not used for tracking; app
functionality). Messages' content is end-to-end encrypted and not readable by us, so it is not declared as
collected. DeviceCheck and App Attest store no identifier; declare nothing new for them unless App Review asks.
