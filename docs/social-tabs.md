# Social page: Profile, Inbox, Requests, the call button and the counts

Owner request for 0.4 (2026-11-16). Builds on `docs/social-tab.md` (the page editor) and `docs/voici-calls.md`
(calling from the app). Built on iOS (the reference), Android and the webapp, branch `0.4/social-tabs`.

## What changed

- **Three tabs instead of two.** Profile / Inbox / Requests under the title row. Inbox is what was Messages >
  Conversations, plus the reply notices from pages this account wrote to and (Android) "My conversations". Requests
  is what was Messages > Requests. The title reads "Your page", "Inbox" or "Requests". The `messages` deep link opens
  Inbox (iOS opens Requests when only requests wait).
- **The call button.** The Calls row is gone. A round phone button floats in the bottom-right corner over the whole
  Social page, above the publish bar when that shows, and opens Calls. iOS: an overlay on the tab's root; Android:
  `FSScreen`'s floating action button; webapp: `#social-call-button`, `position: fixed`.
- **Who to call.** Calls starts with a field ("Who to call", placeholder "Username or voi.ci link") and Call / Video
  call. It takes `alex`, `@alex`, `voi.ci/alex` or `https://voi.ci/alex` (iOS `VoiciCallTarget`, Android
  `VoiciCallTargetInput`, webapp `callTargetUsername`). Phone numbers are for later, so nothing in the UI says
  "username" except the placeholder. The page is fetched and checked under its account's key (as the call itself
  checks it), refused with "There's no page at voi.ci/alex." or "voi.ci/alex doesn't take calls.", then the existing
  flow runs: the call-back question and `VoiciOutgoingCall` / `VoiciOutgoingCallScreen` (iOS), `VoiciOutgoingCalls.start`
  (Android), `startHandoffCall` (webapp; the voi.ci tab is opened on the tap and closed again on a refusal, because
  browsers only allow a new tab during the click).
- **Red counts** on each tab and on the call button; the Social tab in the tab bar (iPad sidebar too) shows their total.
- **Profile layout.** The profile box and the posts are two separate themed boxes. Once the profile box scrolls away,
  a compact header with the page photo and name pins at the top (iOS `onScrollGeometryChange` +
  `onGeometryChange`; Android `onGloballyPositioned` against the tab switch; webapp an `IntersectionObserver` on
  `.vp-head`).
- **Edit icons.** Photo, name, bio and Edit links use a pencil inside a circle outline (iOS `pencil.circle`; Android
  and webapp draw the circle around their pencil). Accessibility labels are unchanged.
- **First post.** The first publish of a page that was never published (nor removed) also adds one ordinary post,
  "Hello. I am using the Flagship app, from flagshipserver.com", translated into the publishing device's language,
  plain text with no link or card, dated just before the page's other new posts. It is part of the page, not a draft,
  and the owner edits or deletes it like any post. Pages that exist get nothing; a seq conflict that shows the page
  already exists drops it. iOS `MessagesStore.welcomePostOp`, Android `VoiciCenter.firstPostOp`, webapp
  `voiciOwner.firstPostOp` (passed as `firstPost` by `publishPending` only).

## Where the counts come from

| Count | Source | Seen marker |
|---|---|---|
| Profile | New comments and reactions on the owner's posts. **Stubbed at 0**: comments and reactions are not built (`docs/social-tab.md` §3.3). | The marker is kept already (`profileSeenAt`), set whenever the Profile tab shows, so the count can start from it. |
| Inbox | Accepted conversations with an unread message (`isUnread`, the synced read marks), plus reply notices waiting on pages this account wrote to. | The existing read marks; opening a thread clears it. |
| Requests | Message requests (not replied to, not accepted). | None needed: a request leaves when answered or accepted. |
| Call button | Missed incoming calls (this device's records and the page's missed calls from `.com`) newer than the marker. | `callsSeenAt`, set when Calls opens and when it closes. |

Markers are this device's own and are never sent anywhere: iOS `UserDefaults` (`flagship.social.*SeenAt.<user>`,
cleared with the account in `MessagesStore.forgetLocal`), Android the encrypted local copy (`VoiciLocal.callsSeenAt`,
`profileSeenAt`), webapp `localStorage` per account (`lib/socialCounts.js`). A device that never opened Calls counts
every missed call it knows until the first visit.

Code: iOS `Services/SocialBadges.swift`, Android `core/voici/SocialCounts.kt` (+ `VoiciCenter.socialCounts`,
`rememberSocialCounts`), webapp `lib/socialCounts.js` (+ `views/messages.js currentCounts`).

## Tests and checks run

- iOS: the `FlagshipUI` scheme compiled for the simulator (Xcode 27.1 RC). Unit tests were written
  (`PageControlsTests` first-post cases, `SocialTabsLogicTests`) and the gym UI tests updated, but not run (disk).
- Android: `:app:compileDebugKotlin` and the full `:app:testDebugUnitTest` (3077 tests; the only failure is
  `MaintainersConformanceTest`, which needs a root `node_modules` the fresh worktree didn't have when it ran).
  The last change (reply notices in Inbox's count) was not recompiled: the disk was under 5 GB.
- Webapp: all of `apps/web/tests` (332 files) including the new `webappSocialTabs.test.ts`; `npm run i18n`;
  `npm run parity` (new row `social-tabs`). The Playwright gym spec `gym-messages.spec.ts` was updated, not run.

## Open items

1. Comments and reactions: when they land, count them in `SocialBadges.profile` / `SocialCounts.profile` /
   `socialCounts().profile` from the existing `profileSeenAt` marker.
2. Run the iOS unit tests and the iOS / Android / webapp gym specs (`GymMessagesTests`, `GymMessagesTest`,
   `gym-messages.spec.ts`); they now tap `social-tab-inbox`, `social-tab-requests`, `social-call-button`.
3. Who to call takes voi.ci pages only. Phone numbers need a resolver and a call path of their own.
4. The webapp has no call-back question (it never had: the voi.ci tab places the call), unlike the phones.
5. Shell v227 was taken on this branch; if another branch also bumped to v227, take the next number on merge.
6. Native review of the new translations (machine drafts, as `i18n/REVIEW.md` says).
