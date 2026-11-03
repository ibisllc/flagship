# Abuse handling: reports, notices, suspension

Owner decision 2026-11-03 (RELEASE-0.3-JOURNAL.md, B2 question 5). This extends the voi.ci abuse design
(`docs/voici-and-messages.md` §9: message and page reports, bans, takedown) to **links and apps**: anyone reports a
voi.ci link or page, or a Flagship app by its hostname; `.com` works out which account it belongs to; an operator
sends that account's admins a notice with a deadline; after the deadline the operator may suspend the account.

Code: `apps/com/src/abuseCases.ts` (routes), `packages/protocol/src/abuseNotice.ts` (categories, the signed "done"
note), migration `0130_abuse_cases.sql`, the operator script `scripts/abuse-cases.mjs` (`npm run abuse`), the public
form `apps/web/public/abuse.html` + `abuse.js`, and the clients (webapp `lib/abuseNotices.js` + `lib/abuseNoticeUi.js`,
iOS `AbuseNotices.swift`, Android `AbuseNotices.kt`).

Nothing here goes to a model: no report, notice, reason or account name is ever put in a prompt, a tool result or
anything else an AI reads (AGENTS.md "An AI never learns who or where the owner is"). `.com` never opens sealed
content to handle a report: it only reads what the reporter typed and the public routing records.

## 1. Report intake (anyone, no account)

`POST /api/abuse/reports` (same origin as `flagshipserver.com/abuse`; CORS also for the voi.ci origin):

```json
{ "kind": "link" | "app", "subject": "<what>", "reason": "<reason>", "note": "<= 2000 chars>", "contact": "<email>" | null }
```

- `kind: "link"`: a voi.ci address: `voi.ci/<name>`, `https://voi.ci/<code>`, a bare `<name>` or `<code>`, `voi.ci/@<user>`.
  Covers codes, custom link names and user pages.
- `kind: "app"`: a hostname or URL under the services apex: `<app>.<user>.flagship.services`,
  `<slug>--<author>.<user>.flagship.services`, a box name `<server>.<user>.flagship.services`, or `<user>.flagship.services`.
- `reason`: `spam | phishing | malware | csam | harassment | impersonation | copyright | illegal | other`.
- `contact`: optional email for an acknowledgement; stored with the report and deleted with it.

Answers `200 {reportId}`, `400 {code:"malformed"}`, `404 {code:"not-flagship"}` (the address is not a live voi.ci
name or a Flagship host of an existing account), `429` (bucket `abuse-report`: 10 an hour per IP, as voi.ci reports).
The reporter's IP is never stored (the rate limiter counts it in Durable Objects only).

## 2. Resolution

At intake `.com` resolves and stores:

| Reported | `target_kind` | account | target |
|---|---|---|---|
| voi.ci username (active) | `page` | the name's owner | `https://voi.ci/<name>` |
| voi.ci link or code (active or retired) | `link` | the row's owner | the stored target (the app's canonical URL); `service_id` |
| `<user>.<apex>` | `account` | `<user>` | the host |
| `<label>.<user>.<apex>` that is a registered server | `box` | the server's account | the host; `server_domain` |
| any other `<label>.<user>.<apex>` | `app` | `<user>` | the host; `service_id` from the account's alias, else derived (`slug` → `<user>--slug`, `slug--author` → `author--slug`) |

A held username resolves to its owner; a released or reserved one, an unknown account, a deeper or foreign host is
`not-flagship`.

## 3. Operator queue

`x-admin-secret` routes under `/api/admin/abuse/`, driven by `npm run abuse -- <command>`:

| Command | Route |
|---|---|
| `list [--all]` | `GET reports[?status=all]` (open first, oldest first) |
| `show <reportId>` | `GET reports/<id>` (adds the note and the contact address) |
| `dismiss <reportId>` | `POST dismiss {reportId}` |
| `notice <account> --report <id> --category <c> --action modify\|take-down --hours <n> [--detail "..."]` | `POST notice` |
| `notices [<account>]` | `GET notices[?account=]` (shows `done` and the admin's note) |
| `withdraw <noticeId>` | `POST notice-withdraw {noticeId}` (closes it; the account stops seeing it) |
| `suspend <account> --category <c> --reason "..." [--notice <id>] [--urgent]` | `POST suspend` |
| `unsuspend <account>` | `POST unsuspend {account}` |
| `stats` | `GET stats` |

## 4. Notice with an ultimatum

`POST /api/admin/abuse/notice`:
`{account, reportId?, subjectKind: app|page|link|box, subject, serviceId?, category, action: modify|take-down, detail?, deadlineHours (1..720)}`.
A notice names one thing (an app, a page, a link or a server), the reason category, what to do and the deadline. The
report (when given) moves to `noticed`. `.com` sends a content-free push, category `abuse-notice`
(`{kind: "abuse-notice"}`; APNs text "There is a notice about your Flagship account. Open Flagship to read it."), to the
account's admin devices (every device on an account that pins no admin root).

The account reads its notices with its read token (`Authorization: Bearer`, devices and the IRK only, never a
server's token): `GET /api/users/<u>/abuse-notices` →

```json
{ "notices": [{ "id", "subjectKind", "subject", "serviceId", "category", "action", "detail", "deadlineAt", "issuedAt",
                "doneAt", "doneNote" }],
  "suspension": null | { "suspendedAt", "category", "reason", "appealEmail": "abuse@flagship.services",
                          "appealUrl": "https://flagshipserver.com/abuse#appeal" } }
```

Withdrawn notices and notices older than 180 days are left out. The apps show open notices to admin devices only:
a banner on Home (what, why, what to do, the deadline, "If it is still there after the deadline, the account can be
suspended") with **I've done this** and **Appeal**.

**I've done this**: `POST /api/users/<u>/abuse-notices/<id>/done`
`{request: {username, noticeId, note, issuedAt}, signature}` where the signature is Ed25519 over
`flagship/abuse-notice-done/v1|<username>|<noticeId>|<sha256 hex of the note>|<issuedAt>` (vectors:
`packages/protocol/test-vectors/abuse-notice-done/`), signed with the sensitive-order key and checked with
`authorizeSensitiveComOp` (admin root or an admin-granted device; the IRK only when no admin root is pinned). A
non-admin device is refused `403 {code:"not-admin"}`. A withdrawn notice is `404`; a notice already done is answered
`200` with its first `doneAt`. The operator sees `doneAt`, the note and the signer in `notices`.

## 5. Suspension

`POST /api/admin/abuse/suspend {account, category, reason, noticeId?, urgent?}`:

- Refused `409 {code:"before-deadline"}` unless the account has a notice (the one named, else any) that is not
  withdrawn and whose deadline has passed, or `urgent: true` with a category in `csam | active-phishing | malware`
  (anything else urgent is `400 {code:"not-urgent-category"}`).
- Every live server of the account is revoked through the normal revoke path (`servers.revoke(domain, "suspended")`):
  the revocation log trigger tells the relays, which close the tunnels; its HELLOs are refused. Boot-unlock leases
  are kept so un-suspending restores the boxes as they were.
- The voi.ci page is taken down (`voici_takedowns`, R2 index and pieces deleted, as `takedown`) unless it already was.
- The names stay held: while suspended the account cannot delete itself, release a server name, offer a transfer,
  add a server (auth-code issue, register) or un-revoke a server (`403 {code:"account-suspended"}`; the owner's
  un-revoke refuses the reason `suspended` anyway).
- The account's devices (every device, not just admins) show **This account was suspended**: the category, the
  operator's reason, how to appeal (abuse@flagship.services, /abuse#appeal) and that the data stays on the owner's own
  server: backups and LAN rescue keep working, so the owner can move their data and start again (data sovereignty).
  The screen can be put aside to reach backups; a banner stays.

`POST /api/admin/abuse/unsuspend {account}` un-revokes exactly the servers the suspension revoked (those still marked
`suspended`), restores the page if the suspension took it down, and deletes the suspension row.

Known gap: the relay mesh's revocation state (`servingGate`) treats a box revoked at a registration generation as
revoked for good, the same as an owner's un-revoke today; on a relay that enforces the serving log an un-suspended box
needs a new registration generation before it serves again.

## 6. Retention

- Pruned whenever the operator reads the queue or the stats (no cron step). Reports: kept while open; deleted one year after they are resolved (dismissed, noticed then closed), with the
  contact address.
- Notices: deleted one year after they were withdrawn or done; kept while the account is suspended.
- Suspensions: the row lives while the account is suspended; `unsuspend` deletes it (the audit log keeps
  `account-suspended` / `account-unsuspended` rows without the reason).

## 7. Operator runbook

1. `npm run abuse -- list` daily (and when abuse@ mail arrives; copy an emailed report in with the form or note it in
   the case). CSAM, active phishing and malware first (abuse.html "Response targets").
2. `show <id>`: check the subject yourself (open the URL in a sandboxed browser). Never paste a report into an AI tool.
3. Not abuse: `dismiss`, reply to the contact if any.
4. Abuse: `notice <account> --report <id> --category <c> --action take-down --hours 72 --detail "..."`. Reply to the
   contact that the owner was asked to act.
5. Check back after the deadline (`notices <account>`): `doneAt` set and the subject gone or fixed: `withdraw`.
   Still there: `suspend <account> --notice <id> --category <c> --reason "..."`.
6. CSAM, active phishing, malware: `suspend <account> --urgent --category <c> --reason "..."` at once; report CSAM to
   NCMEC. Then send the notice for the record.
7. Appeals (abuse@, subject "Appeal"): review; `unsuspend` if it was wrong or the owner fixed it.
