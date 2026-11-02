# Store review notes (App Store and Google Play)

What to paste into App Store Connect and Play Console when a build goes to review, and the answers the consoles ask
for. `final-deploy.md` step 11 points here. Draft written for 0.3 (voi.ci pages and Messages,
`docs/voici-and-messages.md` §9.7); the owner checks it before each submission.

## Before you submit (owner)

1. **Messages must be on in production during review.** `.com` answers every voi.ci route with 404 while
   `VOICI_ENABLED` is `"off"` (`apps/com/wrangler.toml`), so a reviewer opening the Messages tab would see only
   errors. Either switch it on before submitting (the routes are safe with old store builds: they never call them),
   or hold the submission until it is on.
2. **The review login can't show Messages.** `playstore-test-0725` is a demo account, and demo accounts can't have a
   page ("Messages need your own Flagship account. Sample accounts can't have a page."). A real account lives in the
   keys of the phone that made it, so a reviewer can't sign in to one of ours; they create their own in a minute.
   Publish a review page from a real account on a spare phone (a photo, one post, Accept messages on), so the
   reviewer can message it from their new account, and answer what arrives during the review (Apple tests Report
   and Block on a real conversation). Put its username in the notes below. Never delete it while a review is open.
3. The `abuse@flagship.services` mailbox must be read daily, and `npm run ops -- voici` checked for reports older
   than 24 hours (Apple expects action on reports within 24 hours).
4. The DMCA designated agent must be filled in `apps/web/public/terms.html` §9 (`npm run release-manifest` fails
   until it is).

## App Store Connect: App Review Information, Notes

Paste, with the bracketed parts filled in:

```
Flagship lets you run your own server at home and manage it from this app.

Sign-in: Flagship has no passwords. Use the demo test-account entry on the first screen with the account
playstore-test-0725. It shows a server and its apps.

User-generated content (Guideline 1.2): Flagship 0.3 adds voi.ci pages and Messages.
- A user can publish a public profile page (photo, name, bio, links, posts) at voi.ci/<username>, and receive
  end-to-end encrypted messages from other Flagship users through it.
- Demo accounts can't have a page. To review Messages, create a new account in the app (first screen > Create your
  account; it takes a minute), then:
  - your own page: Messages tab > Your page > edit > Publish;
  - a conversation: open https://voi.ci/[REVIEW PAGE USERNAME] in Safari, tap "Send me a message", approve the
    sign-in in the app, and write. We answer during the review. The conversation then shows Report and Block on
    the page owner's side; on your side, "Report this page" is at the bottom of the page.
- Rules: before a user first publishes a page or approves a sign-in to message someone, the app shows the
  "Page and message rules" sheet (no illegal content, harassment, threats, spam or impersonation) and the user must
  tap "I agree". The full terms are at https://flagshipserver.com/terms#messages.
- Report: every message has Report (Messages > a conversation > the ••• menu > Report, or long-press a message), with reasons Spam, Harassment,
  Pretending to be someone, Illegal content, Something else. Every public page has "Report this page" at the bottom.
- Block: every conversation has Block (the ••• menu > Block). A blocked sender isn't told; their messages stop arriving.
- Moderation: a person at Flagship reviews every report. We act within 24 hours: we remove pages that break the
  rules and ban accounts from Messages (a ban also covers the device, using DeviceCheck / App Attest). Banned users
  can appeal.
- Contact for abuse: abuse@flagship.services, https://flagshipserver.com/abuse
- New accounts can start only 3 new conversations a day, and a sender can send only 3 messages until the page owner
  replies or accepts, to limit spam.

DeviceCheck and App Attest are used only to cap Messages sign-ups per device and to enforce bans; no device
identifier is stored.
```

## Google Play Console

- **Policy, User-generated content:** the same features as above. Play wants in-app terms accepted before posting
  (the rules sheet), in-app reporting (Report on messages, Report this page on pages), blocking (Block), and
  moderation; paste the "User-generated content" paragraph above into the review notes of the release
  (Publishing overview > the release > notes for review), or into App content > App access with the login.
- **App access:** "All or some functionality is restricted": give the demo login, plus the real review account for
  Messages (point 2 above), with the same steps.
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
