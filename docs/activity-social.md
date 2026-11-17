# Activity: calls and social next to servers (0.4, queued)

Status: owner decision 2026-11-16 ("yes queue it for 0.4"). Built on branch `0.4/activity-social` (see "As built").

## What
Activity becomes the one history of what happened; badges stay "what needs you" (`docs/social-tabs.md`).
- **Servers (exists):** the box activity log already merges updates, apps, migration, decommission, backups and
  restores into all three Activity tabs. Check and fill gaps: "server created/deployed" as its own entry, "service
  updated", a finished scheduled backup.
- **Calls (new):** missed, answered and placed calls.
- **Social (new):** new conversations, message requests, page published or updated, new comments and reactions.

## Rules
1. **Social and call entries stay on the phone.** `.com` keeps no call or message log (docs/voici-calls.md, delete =
   forget). Entries are built from what the device already holds (MessagesStore, call history, page state). Showing
   them on the owner's other devices uses the same end-to-end encrypted sync as call hours; never through `.com` in
   the clear.
2. **Deleting forgets.** Deleting a conversation removes its calls and messages from Activity too, on every device.
3. **Filter** at the top: All / Servers / Social. Each entry opens its conversation, call, post or server.
4. Every string through i18n; iOS first, then Android, then the webapp (social parts only where the webapp has them).

## Open
- Retention for local social entries (proposal: 90 days, same as rate-limit logs; or until deleted).
- ~~Whether an answered call shows its length (local only).~~ Decided (owner, 2026-11-16): yes; see "As built".

## As built (2026-11-16, `0.4/activity-social`)

### What each client shows
- **Filter** at the top of Activity: All / Servers / Social (iOS segmented `activity-filter`, Android segmented row
  `activity-filter-<all|servers|social>`, webapp chips `data-activity-filter`). **All** is today's sections plus a
  **Calls and messages** section under Server approvals; **Servers** is today's screen unchanged; **Social** is the calls
  and social list on its own. A boot-approval push or link switches Social back to All so the approvals open.
- **Entries** (same kinds on every client; parity row `activity-social`):

  | Kind | Title | Built from | Opens |
  |---|---|---|---|
  | `call.missed` | Missed call from {name} | an incoming record or a missed call from `.com` | its conversation, else Calls |
  | `call.declined` | Declined a call from {name} | an incoming record (phones only) | its conversation, else Calls |
  | `call.answered` | Call with {name} | an incoming record (phones only) | its conversation, else Calls |
  | `call.placed` | You called {name} | an outgoing record (any outcome) | Calls |
  | `conversation.new` | New conversation with {name} | an accepted conversation, at its first visitor message | the thread |
  | `conversation.request` | Message request from {name} | a request, at its first message | the thread |
  | `page.published` / `page.updated` | Your page went public / was updated | the published index (seq 1 / later), at its `issuedAt` | the page (Social, Profile) |
  | `post.published` | You posted on your page (first line under it) | each post of the published page, at `createdAt` | the page |

  A video call says "Video call" under the title; a missed call is drawn as a warning. **An answered call shows its
  length** (owner, 2026-11-16), placed or received: "Answered · 4:32" under the title ("Video call · 4:32" for video),
  h:mm:ss over an hour, from the record's `durationMs` (nothing shows when none was recorded). The Calls list adds the
  same length to an answered row ("Incoming call · {date} · 4:32"). Formatted by the platform, so digits follow the
  locale: iOS `DateComponentsFormatter` positional (`SocialActivity.callLength`), Android
  `DateUtils.formatElapsedTime` (`SocialActivity.callLength`). The webapp shows no length: its call records (placed
  calls only) keep none. Names are the nickname, else the
  visitor name; a page's username for calls to pages; "Anonymous caller" on the webapp for anonymous missed calls.
- **Comments and reactions:** not built (docs/social-tab.md §3.3). The hook is a marked spot in each `Kind` list
  (`comment.new`, `reaction.new`), fed from the same data `SocialBadges.profile` will count.
- **Server entries:** a box log row now opens its server (iOS/Android: the server picked in the switcher, else the
  current one; webapp: the server the row came from, `boxEntryRow(..., fqdn)`). Account events (`.com` audit) stay
  untappable. Gaps checked against the box log: "server created" and "came online" already come from `.com`'s audit
  (`server-created`, `server-online`, the Your account section), "service updated" is the box's `app.updated` ("App
  redeployed"). The one gap was the scheduled backup: the box now notes **`server.backup.scheduled`** ("Scheduled
  backup finished") when the schedule ran it, `server.backup.created` still for a backup asked for by hand
  (`serverArchive/service.ts`; needs an endorsed box release; older clients show it humanized).

### Where it lives
- iOS: `Services/SocialActivity.swift` (`SocialActivity.build`, `MessagesStore.socialActivity`), `Screens/ActivityScreen.swift`
  (`ActivityFilter`, the section, `socialRow`), `Shell/ActivityTab.swift` (`ActivityRoute.conversation`, `.calls` in
  `FlagshipCore/Routes.swift`; the page through `DeepLink.pageEditor`, a server through `.serverDetail`).
- Android: `core/voici/SocialActivity.kt`, `VoiciCenter.socialActivity()`, `rememberSocialActivity` (SocialScreens.kt),
  `ui/screens/ActivityScreen.kt` (`ActivityFilter`, `SocialList`), `ActivityTab.kt` gains `thread/{conv}` and `calls`
  (the Social tab's route names, so the Calls page's own links work inside Activity).
- Webapp: `lib/socialActivity.js`, `views/activity.js` (`renderFilter`, `renderSocialSection`, `currentSocialEntries`),
  `#activity-filter-slot` and `#activity-social` in `index.html`. Shell **v228**.

### Rules, as built
- **Nothing new leaves the device.** The entries are computed on each draw from data the device already holds and are
  never stored, so there is no new local log either. No `.com` route, migration or field was added.
- **Deleting forgets** by construction: a delete already drops the conversation, its missed calls and its call records
  on every device (`0.4/conv-forget`, §10.1.1 of voici-and-messages.md); with nothing of its own kept, Activity loses
  its entries the same moment. Tested: iOS `MessagesForgetTests` (the entry shows on both devices, then is gone on both
  after the delete), `SocialActivityTests`; Android `SocialActivityTest`; webapp `webappSocialActivity.test.ts`.
- **Multi-device.** Conversations, requests, missed calls (sealed to the inbox key on `.com`) and the page are already
  shared by every owner device, so those entries appear on all of them. **Answered, declined and placed calls are each
  device's own** (the call list was never synced). The only end-to-end encrypted owner-device sync for calls is the
  call-hours blob (`flagship/voici-call-settings/v1`), which holds settings, not history; putting call records there
  would be a server-held (if sealed) log of calls, which this spec rules out. So each device shows its own calls.
  **Decided (owner, 2026-11-16): each device keeps its own.** Call history is not synced.
- **Retention:** whatever the sources keep: the call list's 200 records per device, conversations until deleted, the
  current page. No separate cap.

### Checked
- iOS: the `FlagshipApp` app built for the simulator (Xcode 27.1 RC); `FlagshipMobile-Package` unit tests
  `SocialActivityTests`, `MessagesForgetTests`, `ActivityViewModelTests`, `ServerArchiveViewModelTests`,
  `VoiciOutgoingCallTests` (39 + the scheduled-backup label) green on an iPhone 17 Pro simulator.
- Android: `:app:compileDebugKotlin` and the full `:app:testDebugUnitTest` (3082 tests, 0 failures).
- Box: `packages/server-daemon/tests/serverArchive` (179 tests). Webapp: all of `apps/web/tests` (333 files).
  `npm run i18n` and `npm run parity` pass.
- Call length (`0.4/call-length`, 2026-11-16): the `FlagshipApp` app built for the simulator (Xcode 27.1 RC);
  `SocialActivityTests` 6/6 (two new: the entry's length and the locale's clock, Eastern Arabic digits included) on an
  iPhone 17 Pro simulator; Android `SocialActivityTest` 5/5 and `SocialActivityCallLengthTest` 2/2 (Robolectric, for
  `DateUtils`). `npm run i18n` and `npm run parity` pass.
- Not run: the gym UI specs (`GymEveryMergeTests` / Activity, `GymActivityTest`, `gym-activity.spec.ts`); the new
  section sits second in the accordion and the filter adds a row above it, which a spec counting sections may notice.

### Open
1. ~~Calls on the owner's other devices.~~ Decided (owner, 2026-11-16): each device keeps its own; answered, declined
   and placed calls show only where they happened, and call history is never synced.
2. ~~Whether an answered call shows its length.~~ Decided (owner, 2026-11-16): yes, built (`0.4/call-length`).
3. Comments and reactions entries, when those exist.
4. The page entry shows only the latest publish (the index carries no history); earlier "updated" entries are not kept.
5. Native review of the new strings (machine drafts, `i18n/REVIEW.md`).
6. Shell v228: renumber on merge if another branch took it.
