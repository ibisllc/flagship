# Lead reply to the Windows 0.3 acceptance (2026-11-07)

Answers WINDOWS-TO-LEAD-2026-11-06.md up to 780ff031e.

## Failure 5: not a deploy regression. The test account hit .com's own certificate limit

Production's certificate orders for the test account, 2026-11-06 (read-only D1 query):
- home2 to home5 (05:12Z to 06:44Z) each got their certificates. But on the way, each new box replaced its first order
  with a second one (the daemon restarts during first boot, your "restarted 3x/5x (exit 0)"). Several of those replaced
  orders had already reached Let's Encrypt.
- `.com` refuses every new order from an account for 24 hours once it has **5 orders in a day that reached the CA and
  ended without a certificate** (`perAccountAbandonedOrdersPerDay`, `apps/com/src/certificateIssuance.ts` `limits()`).
  The account was at 5 at 14:50Z, so `home` got one order, which never advanced (timed out 15:30Z). After that, the two
  later servers' orders were refused before being stored (`issuance-rate-limited`, retry after 24 h). With no
  certificate, the box answers every handshake with alert 49 `access_denied`. That's why the old Studio failed the
  same way.
- Recomputed now (07:00Z on 11-07): the account is at 1 abandoned order of 5, so a **new server should come online
  again**. Please rerun W6 (and W8 if you have time) now, then delete the stuck servers. They retry only when the
  24-hour refusal expires (around 15:30Z today), so don't wait for them.
- Hosting more than about 3 new servers a day on one account will hit this again. If a day needs more, use a second
  throwaway account. On the product side I'm proposing that an order replaced by the same box, which then gets its
  certificate, no longer counts against the account. That needs the owner's OK and a `.com` deploy. I'll note it here
  when it's live.

## Your other questions
1. Trusted devices 403 on the Android admin device, and 2. the browser's three 403s after joining: not looked at yet.
   Please capture the request URLs (logcat line with the path, the browser's Network tab) on the next pass, so I can
   tell whether they come from the IRK change or are a new bug.
3. W14: test it with a W18 join with "Also make this device an admin" on. If the review window refuses the approval,
   record the exact sentence. That counts as a finding, not a blocker.
4. The "restarted N× (exit 0)" lines: these restarts are what replace the certificate orders above. I'm looking at it
   on the box side. Record the counts, but no extra investigation is needed from you.
5. W19 (lands on an empty Home after approval): still open. Noted.

## Update (later on 2026-11-07): the certificate-limit fix is on main, not deployed yet
- main `e5d2b4e7b`: a certificate now forgives up to the 3 orders the same box made
  just before it, within the hour before. Against yesterday's real orders, your account would have stood at 2 of 5
  abandoned orders instead of 5 of 5, so every server would have got its certificate.
- It goes live with the owner's next `.com` deploy (release.sh step 41). I'll add a line here when it's live.
- Until then, the rule from reply 5 still applies: about 3 new servers a day per account. Rerun W6 now; it should pass.
