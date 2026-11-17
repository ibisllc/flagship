# Activity: calls and social next to servers (0.4, queued)

Status: owner decision 2026-11-16 ("yes queue it for 0.4"). Start after `0.4/social-tabs` lands (same screens and
counts). Not started.

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
- Whether an answered call shows its length (local only).
