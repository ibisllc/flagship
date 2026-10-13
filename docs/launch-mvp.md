# Launch MVP

Owner decisions, 2026-10-13. "Launch" = the store apps are live and the
site's coming-soon gate comes off. **Date: to be set later.** This file is
the scope; `AGENTS.md` tracks progress.

## Principle

The product must work end to end with no payment option at all
(`monetization-free-tier-first.md`). **Nothing is sold at launch**, which is
also what we told Apple during review. Payments are the first update after
launch (`anonymous-vouchers.md`).

## In

1. **The core loop:** create an account on the phone; host a server (Studio
   on a Mac, or a USB stick on a spare PC); unlock from the phone and get the
   green padlock; the AI builds apps on a staging copy, then they go live;
   updates, backups, recovery and Delete.
2. **Apps:** iOS and Android through store review, the webapp, and the
   notarized Mac Studio. **Windows and Linux Studio ship marked "preview"**
   (not yet run on a real PC).
3. **Free tier: 25 GB/month, slowed down (not cut off) when exceeded.**
4. **Free AI credits** so people can try building apps without their own AI
   key: on by default for new users, with a clear "used / remaining" line and
   a pointer to bring-your-own-key when they run out (no purchase wording).
   Metered by the same metering core as data flow.
5. **The GA close-out list** in `AGENTS.md` (prod-wipe script, build-time
   disk passphrase, demo switches, debug endpoints, quiet console).
6. **CA endorsement lease renewed** (due 2026-11-05 regardless).

## Proven on real hardware before launch

- A phone-created box on current code: phone unlock, pairing, update from
  all three apps, then Delete.
- Losing a phone and recovering the account.
- The Postgres data layer on a real box, including a backup restore.
- VM appliances republished with the container networking fix.
- A diagnosis of the guest memory corruption seen in home2's VM (hosting in
  Studio on a Mac will be most people's path).

## Not at launch (kept off `main`, each on its branch)

In order after launch:

1. **Payments:** $1 anonymous vouchers (Monero page, then App Store and
   Play), Pro and Pro Max.
2. **Custom domains** (Pro). Hidden from the service pages on `main`.
3. **Name change and dibs, together.** The dibs year starts when paid name
   change ships, not in October 2026 (supersedes the earlier window).
4. **Marketplace:** free apps first; paid apps after the security scanner.
5. Later: retail NFC boxes, the browser extension, LAN-direct, phone USB
   burning, Bluetooth, the Mac App Store edition of Studio.

## Consequences

- No commercial launch yet, so obligations that fall due "at commercial
  launch" don't fall due at this launch.
- What we tell Apple and Google stays "nothing is sold".
