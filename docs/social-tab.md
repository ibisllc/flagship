# The Social tab (0.4, U2 + U3)

Status: iOS built on `0.4/social-ios` (2026-11-13), Android and the webapp to follow. Owner direction: the Messages
tab was too cumbersome; rename it **Social**, make the page editor the tab, and let the page show itself as visitors
see it. Prototype the owner approved: <https://claude.ai/artifact/ABqoHvYhdTEWaDb7cGMkLt>. Protocol and formats are
unchanged: everything below uses `docs/voici-and-messages.md` as it is. The new features in the prototype (guests,
guests-only posts, comments, who can reach you, calls) are **not built**; §3 sketches what they need.

## 1. The screen as built (iOS)

Tab: **Social**, SF Symbol `person` (the tab bar draws the filled form, like Home, Services and Settings). The teal
disc around a bubble is gone (`MessagesTabIcon.swift` deleted), on the iPhone tab bar and the iPad sidebar. The
internal destination stays `RootDestination.messages` (gym `-smoke-tab messages`, deep links `messages` and
`page-editor` unchanged). Badge: unread conversations, as before.

### 1.1 Title row (fixed, above the content)

- **"Your page"** (large title; "Messages" while the Messages side is shown) with `voi.ci/<username>` under it.
- **Public switch** with its state ("Public" / "Not public", `messages-page-status`). Same flow as before
  (`PagePublicFlow`): rules once per device, the one-time "Make your page public?" warning per account, then the
  signature; switching off asks "Remove your page from voi.ci?". Disabled on a device without the admin root, with
  "Only an admin device can publish your page." under the row (`page-admin-only`).
- **⋯ Page options** (`page-options`), a sheet:
  - Theme: Classic / Ink / Sea swatches drawn in each theme's own colours (`page-theme-<id>`). A draft.
  - While public: Copy link, Share, and the address.
  - Accept messages (a draft, as before).
  - Websites you're signed in to (`SignedInSitesScreen`, was Settings → Messages), Rotate inbox key (admin device,
    page published), Page and message rules.
  - Remove page (admin device, page public), red, last; same confirmation as switching Public off.
  Settings no longer has a Messages row; Settings → "Your page" opens the tab's Profile.

### 1.2 Profile / Messages

A two-way switch under the title row (`social-tab-profile`, `social-tab-messages`); Messages carries the number of
waiting requests.

**Profile** is the page drawn the way `apps/voici-site` draws it (tokens from `src/style.css`: canvas, surface, ink,
muted, rule, fill; `classic` and `sea` follow light/dark, `ink` is always dark), without voi.ci's footer:

- Photo with a round pencil → Add / Change photo (Photos picker) or Remove photo.
- Display name and bio as text, each with a pencil. Only after the tap does the text become a field (name:
  `page-display-name`; bio: `page-bio`, with the 280 counter), with **Done** (`page-edit-done`). Done records the
  profile draft; a refused value keeps the field open with the sentence under it. An empty bio reads "Add a short bio".
- Links as the page shows them (label, host, arrow), then **Edit links** ("Add link" when there are none): a sheet with
  the old list (reorder, swipe to delete, Add link, at most `VoiciPage.profileMaxLinks`), recorded when it closes.
- Posts under a "Posts" label with **New post** (`page-new-post-open`): a sheet with the text (2,000 characters) and
  Add post (link cards fetched as before). Each post shows its date, its text and its link cards; its **⋯**
  (`page-post-menu`) holds Edit, Remove link cards (when it has any) and Delete.
- Anything not yet published is grayed with "Not published yet" (on a non-admin device "Waiting for an admin device
  to publish").

**Messages**: reply notices ("You have a reply on voi.ci/…") at the top of Conversations, then the Conversations /
Requests segment, the rows and the thread exactly as before (`ThreadScreen`: reply, rename, accept, block, report,
delete).

### 1.3 The publish bar

A floating bar above the tab bar, **only while something is unpublished** (this device's drafts, other devices'
drafts in the lane, or a field being edited): "N changes not published" + **Publish**. Publish records the open field,
then signs (the make-public steps first when the page is not public). While it signs the button spins and the text
reads "Publishing your page…"; when nothing is left the bar goes. On a device without the admin root the bar has no
button and reads "Waiting for an admin device to publish".

### 1.4 Sample accounts

Unchanged: the read-only example page (`DemoPageHeaderView`: photo, name, address, a disabled Public switch, "View
page"). No editor, no Page options.

### 1.5 What moved where

| Before | Now |
|---|---|
| Messages tab, bubble on a teal disc | Social tab, plain `person` symbol |
| Page header card (photo, quick name edit, switch, status) + "Edit page" | Removed; the Profile is the page itself |
| Editor's form (Profile, Links, Theme, Accept messages, Posts, Publish, Copy link, Share) | Pencils on the page, Edit links, New post, post ⋯, Page options, the publish bar |
| Preview screen | Removed: the Profile is the preview |
| Settings → Messages (websites, inbox key, rules) | Page options |
| The editor's "anyone can see this page" footer | The one-time make-public warning (kept) |
| Quick name/photo edit published at once while public | A draft like every other edit, published from the bar |

## 2. Tests

`GymMessagesTests` covers the tab (rows under Messages, requests count), the thread, the Public switch and its
warning, editing the name through its pencil, the bar appearing and going after Publish, a non-admin device's post
waiting for an admin, an admin publishing another device's draft, Page options (theme as a draft, the settings rows),
Home's and Settings' pointers, sign-in approval with sign-out from Page options, and reply notices.
`test_pageScreenshots` (opt-in, `TEST_RUNNER_PAGE_SHOT_DIR`) captures every state above.

## 3. Not built: protocol sketch for the prototype's new features

Everything here changes signed formats, so it needs shared vectors (TS, Swift, Kotlin, the voi.ci renderer) and a
`.com` deploy before any client shows it.

### 3.1 Guests (the list)

A guest is a pseudonym the owner accepted (today "accepted" exists only in the sealed Messages state blob,
`MessagesState.accepted`). Guests must work while the owner's phone is off, so the list cannot live only there.

- **Guest pass** `flagship/voici-guest-pass/v1|<pageId>|<pseudonymPub>|<passId>|<issuedAt>|<expiresAt|0>`, signed by
  the page's `ownerSignPub` (any admin device holds it via the UMK; no new key). Delivered to the guest inside a
  normal reply (sealed to their thread key), so only the guest holds it.
- **Revocation**: the index gains `guestEpoch` and a `revoked` piece listing revoked `passId`s (or a bump of
  `guestEpoch` that voids every older pass and re-issues). `.com` and the renderer refuse a revoked or old-epoch pass.
- The full list (names, nicknames) stays in the sealed state blob; nothing public names who the guests are.

### 3.2 Guests-only posts

- A post gets `audience: "everyone"|"guests"`. Guest posts live in separate chunks (`gchunk-<n>`) sealed with a
  **guest content key** `GK_e` (AES-256-GCM, `flagship/voici-guest-chunk/v1|<pageId>|<n>|<guestEpoch>`).
- `GK_e` is derived from the UMK and `guestEpoch` (all owner devices get it) and handed to each guest wrapped to
  their thread key (X-Wing, `flagship/hybrid-seal/v1`) alongside their pass. Removing a guest bumps `guestEpoch`,
  re-seals the guest chunks and re-wraps the key for the remaining guests (cost grows with guests × removals).
- "Everyone else sees nothing, not even that it exists": the public index then must not reveal guest chunks by
  role or size. Options: always publish at least one padded `gchunk` (fixed buckets), or keep guest pieces out of the
  public index entirely in a second signed index `flagship/voici-guest-index/v1` served only to a request carrying a
  valid pass (`.com` checks it, so `.com` learns which pseudonym reads guest posts and when).
- The renderer needs a pass and the wrapped key in the visitor's browser: today the browser holds only P, B, T
  (`voici-and-messages.md` §6), so the sign-in must also hand it the guest material from the visitor's app.

### 3.3 Comments

- A comment is a `flagship/web-envelope/v1` from the visitor's browser key (the same delegation and attestation as a
  message), naming `pageId`, `postId`, and the text, **not sealed** (comments are public) but signed, so anyone can
  check it came from an attested pseudonym.
- Storage: a `.com` comment store per post (D1 rows + R2), shown by voi.ci after it verifies each signature. The
  owner moderates by publishing a signed `hidden` list in the index (`comments-hidden` piece) or by deleting through
  a signed owner order; `.com` drops hidden comments from what it serves.
- Owner replies: a comment signed with `ownerSignPub`, shown "as <display name>".
- Abuse: the comment carries the same sealed abuse tag; report, block (a block hides that pseudonym's comments on
  this page), the Messages rate limits per pseudonym and per account.
- A comment on a guests-only post is sealed with `GK_e` like the post.

### 3.4 Who can reach you

- The index's `acceptsMessages 0|1` becomes `reach: "none"|"guests"|"anyone"` (a new index version,
  `flagship/voici-page/v2`; `acceptsMessages` stays derivable for v1 renderers during the switch).
- `.com` enforces it at the mailbox deposit (§8.3): for `guests` the visitor's envelope must carry a valid guest
  pass for its pseudonym. The direct-to-phone path checks the same on the phone.
- The same setting governs new comments (prototype: "Comments follow Who can reach you"); comments may need their own
  switch later.

### 3.5 Calls

As `docs/voici-calls.md`: the index gains `calls: "off"|"guests"`; `.com` checks a guest pass before it rings (that
doc's decision D1, "callers whose conversation the owner accepted", becomes "guests"). The call button in a
conversation shows only while calls are on and the visitor is a guest.

### 3.6 What each part must carry

| Part | Carries |
|---|---|
| Page index (v2) | `reach`, `calls`, `guestEpoch`, revoked-pass piece, guest chunks or a pointer to the guest index, `comments-hidden` |
| Owner's devices | the guest list in the sealed state blob, `GK_e` from the UMK, pass issuing in replies, re-keying on removal |
| Visitor's app + browser | the guest pass and wrapped `GK_e`, handed to the browser at sign-in |
| `.com` | pass checks at deposit, at call set-up and (option B) at the guest index; the comment store and its limits |
| voi.ci renderer | decrypting guest chunks, verifying and showing comments, hiding hidden ones |

### 3.7 Open questions

1. Guest posts: padded chunks in the public index, or a second index behind a pass (privacy from `.com` vs. hiding
   the existence of guest posts from everyone)?
2. Removing a guest: re-key every guest chunk at once (cost) or accept that a removed guest keeps what they already
   decrypted and only stop new posts?
3. Is a guest per page or per account? (Per page matches per-page pseudonyms; per account would link them.)
4. Do comments need the owner's approval before they show (a queue, like Requests), or show at once with Hide?
5. Should comments on a public page be readable without signing in (public text) or only by signed-in visitors?
6. One "Who can reach you" for messages, comments and calls, or three settings?
7. Can a non-admin device issue guest passes (it holds the UMK-derived owner sign key only through the admin
   path today)?
8. How long does a guest pass live: until revoked, or a fixed term the owner renews?
