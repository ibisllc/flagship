# When an update rolls back: what owners see, and what to tell them

For support and for owners. It covers what happens when a server update does not start cleanly, how
each Flagship app shows it, and what the owner should do. The operator side (cohorts, receipts, the
stop rule) is in `docs/runbooks/canary.md`.

## 1. What happens on the server

1. The owner presses **Update** (or the server takes a release on its first start). The server
   checks that Flagship's maintainers signed the release, that the release catalog allows it for
   this server yet, and that it is newer than what runs.
2. The server installs the new release beside the old one and restarts into it.
3. On each start the new release has to prove it is healthy: its connection to the relay is up, it
   has sent a signed status report, and its Rust components (on servers built after 0.3) still run.
   It gets three starts to do so.
4. Then one of three things happens:
   - **Installed.** The release passed and stays.
   - **Rolled back.** The release failed three starts, or the server lost power while installing.
     The server switches back to the release it ran before, by itself. Apps, data, keys and settings
     are never touched by an update or a rollback, because the switch only replaces the program.
   - **Kept in recovery (rare).** The release failed, but the one before it is too old to go back to
     safely: it is below the security floor Flagship's maintainers signed. The server stays on the new
     release in a restricted recovery mode and waits for a fixed release. Apps and data are kept.

An update can also be **refused** before anything changes, for example when the request was not
signed by the account's admin key or the release is not endorsed. A refusal changes nothing.

## 2. What each app shows

| Where | Installed | Rolled back | Refused |
|---|---|---|---|
| **Webapp**: Servers › the server › Update card, the line under "Running" | "Last update: `abc12345` installed and running." | "The last update to `abc12345` didn't start cleanly, so the server went back to `def67890` on its own." Kept in recovery: "The update to `abc12345` didn't start cleanly, and the version before it is too old to go back to safely. The server stays on `abc12345` in recovery mode until a fixed update arrives: install it from this card when it's offered. Your apps and data are kept." | "The server refused the last update: …", one whole sentence per reason |
| **iPhone / iPad**: the server's page › Update (the line is red unless it installed; the webapp marks recovery and refusals as a warning) | same sentence | same sentence | same sentence |
| **Android**: the server's page › Update | same sentence | same sentence | same sentence |
| **Activity** (all three apps, the server's events) | "Updated to `abc12345`." | ⚠️ "Update rolled back": "The update to `abc12345` failed its boot check and was rolled back." Kept in recovery: "The update to `abc12345` didn't start cleanly, and the version before it is too old to go back to safely. The server stays on `abc12345` in recovery mode until a fixed update arrives. Your apps and data are kept." | "An update order was refused (…)." |
| **A server shared with you** (co-manager at "Can manage") | the same line on the shared server's page | same | same |

"Running" on the Update card always shows the release the server runs now. After a rollback, it
shows the old release again.

Translations: the webapp, iOS and Android show these sentences in the owner's language
(`docs/i18n.md`). Each case, every refusal reason included, is one whole translatable sentence.

## 3. What to tell the owner

- **Rolled back:** Nothing is lost and nothing needs doing. The server is running the version it ran
  before. That release is usually paused for everyone while Flagship looks into it, and a fixed
  release will be offered on the Update card. Pressing Update again for the same release is safe:
  the server either takes it or goes back again.
- **Kept in recovery:** Apps and data are kept. The server waits for a fixed release, which it will
  take when one is offered. Only an owner who sees something else wrong (the server does not answer,
  apps do not open) needs to contact support.
  The apps show it from the server's record (`lastUpdate.rollbackRefused`): "… The server stays on
  `abc12345` in recovery mode until a fixed update arrives …". "Running" still shows the new release.
  (Apps from before 0.3 show this case with the "went back on its own" sentence.)
- **Refused:** Follow the reason shown. "Send it again" reasons can simply be retried. "Not endorsed"
  means the maintainers have not signed that release, so wait for one they have.

## 4. Helping Flagship catch bad releases (sharing update results)

A server can send Flagship one anonymous note per update: which release, whether it passed its health
check, whether it rolled back, its processor type, and which of the two container setups it uses.
It never sends the server's name, the account, an address or anything about apps. Flagship counts
these notes per release, never per server, and uses them to pause a release before it reaches more
servers (`docs/runbooks/canary.md` §2). Sharing is off until the owner turns it on.

The switch is **Share update results** on the server's page, in the Software update card (webapp,
iPhone/iPad, Android), under: "Send Flagship an anonymous note after each update: the release,
whether it started cleanly and whether it went back. Never your server's name, your account or
anything about your apps." It sets the server's `/api/update-reports` choice and shows only to the
owner's own devices (the server refuses Remote and co-manager sessions, and the switch then stays
hidden). Turning it off also drops any note not yet sent.

## 5. Client wording (done in 0.3)

All three clients carry the switch and the sentences above (parity row `update-results`; mock-gym
scenarios `web-ux-update-results`, `ios-total-update-kept-in-recovery`,
`ios-total-update-refusal-sentence`, `android-ux-update-kept-in-recovery`,
`android-ux-update-refusal-sentence`). The box's Activity line for a rollback kept in recovery is
its own sentence (above), under the same "Update rolled back" event; like every Activity detail the
box writes, it is English.
