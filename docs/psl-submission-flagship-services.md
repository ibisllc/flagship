# Public Suffix List submission — `flagship.services`

**Status:** ready-to-act. OWNER ACTION, owner-gated. No code, no tests — this
is an external-process runbook.

**Source:** the CRITICAL "PSL ceiling (scaling blocker)" finding in
[`docs/per-user-cert-worklist.md`](./per-user-cert-worklist.md) (red-team
2026-06-01, §"Pressure-test findings"). Design context lives in
[`docs/per-user-cert-and-addressing.md`](./per-user-cert-and-addressing.md).

---

## TL;DR

Add `flagship.services` to the **PRIVATE** section of the Public Suffix List
(PSL). Once browsers and — critically — **Let's Encrypt** pick up the new
list, each `<user>.flagship.services` becomes its own *registered domain*
instead of all users sharing the single registered domain `flagship.services`.

**Start now.** Browser/library propagation of a PSL change takes **weeks to
months** (it ships embedded in browser releases, Go's `golang.org/x/net/publicsuffix`,
the `psl` npm/python packages, etc.). This is on the critical path for scaling
past a few thousand users and cannot be expedited after the fact.

---

## 1. Why this gates scale

Let's Encrypt's primary rate limit — **"Certificates per Registered Domain"
(50 / week**, with a hard-to-get override to ~3,000–5,000/week) — keys on the
**public-suffix + 1 label** (the "registered domain"). The public suffix is
whatever the PSL says it is.

- **Today**, `services` is the public suffix (it is an ICANN gTLD on the PSL),
  so the registered domain of *every* user name is `flagship.services`. **All
  users' cert issuances count against ONE 50/week bucket.** That is a hard
  ceiling of a few-thousand users *total*, no matter how few certs each user
  needs. Per-user certs (the worklist's main change) *reduce the count* (one
  cert per user instead of one per box) but **do not remove the shared bucket** —
  only the PSL entry does that.
- **After** `flagship.services` lands in the PSL PRIVATE section, `flagship.services`
  itself becomes a public suffix. The registered domain of `alice.flagship.services`
  becomes `alice.flagship.services`, of `bob.flagship.services` becomes
  `bob.flagship.services`, etc. — **each user gets their own independent 50/week
  registered-domain budget.** This is the standard multi-tenant pattern (Heroku's
  `herokuapp.com`, GitHub Pages' `github.io`, Vercel, Netlify, etc. all do exactly
  this).

Secondary note: the **5-duplicate-certs / identical-SAN-set / 7 days** limit is
already per-user once we move to per-user SAN sets (`[<user>.flagship.services,
*.<user>.flagship.services]` is unique per user), so the PSL entry is specifically
about the *registered-domain* limit, not the duplicate limit.

---

## 2. The exact PSL entry to add

Repository: <https://github.com/publicsuffix/list>
File: `public_suffix_list.dat`
Section: **`// ===BEGIN PRIVATE DOMAINS===`** (NOT the ICANN section).

Insert the following block in the PRIVATE DOMAINS section, **alphabetized by the
entry that follows the comment** (the maintainers keep the private section
roughly sorted; place it among the other `// <Company>:` blocks near other
`f…`/`flagship` entries — the bot will tell you if ordering needs a nudge).

```
// IBIS LLC: https://github.com/ibisllc
// Submitted by Harry Winner <kamdemharry@gmail.com>
flagship.services
```

Format notes (from the PSL `CONTRIBUTING.md` / the PR template — match these
exactly or the validation bot rejects the PR):

- **Two comment lines, then the suffix line(s).** Line 1 is
  `// <Organization>: <URL>` — the org name and a working https URL the
  maintainers can use to confirm you control the domain. Line 2 `// Submitted by
  <Name> <email>` is conventional and recommended.
- **One suffix per line, no leading/trailing whitespace, no wildcard.** We need
  exactly `flagship.services`. (Do **not** add `*.flagship.services` — a bare
  entry already makes every direct child its own registered domain, which is all
  we want.)
- **Lower-case, IDNA/punycode form** — `flagship.services` is already ASCII, so
  no `xn--` encoding needed.
- **Do not add a blank line inside the block.** Blank lines separate
  organizations; keep the two `//` lines immediately above the suffix line.
- The PSL is **UTF-8, LF line endings**. Don't let an editor rewrite to CRLF.

> If we later decide each `<user>` zone should itself carry sub-labels that are
> *also* independent registered domains, that is a *different* and much larger
> ask (it would be `*.flagship.services` semantics) and is explicitly **out of
> scope** here — see the "delegated per-user DNS zones" note in the spec.

---

## 3. The required `_psl` DNS TXT record

The PSL maintainers' **automated validation** requires proof that the PR author
controls the domain being submitted. For a domain submission they check for a
TXT record at the `_psl` subdomain whose value is the URL of the submitting pull
request.

Create this record in the `flagship.services` zone (Cloudflare DNS, the
`flagship.services` zone the Worker/`.com` controls):

| Field | Value |
| --- | --- |
| **Type** | `TXT` |
| **Name / host** | `_psl.flagship.services` (in Cloudflare: name `_psl`) |
| **Value** | `https://github.com/publicsuffix/list/pull/<PR_NUMBER>` |
| **TTL** | a low value (e.g. 300s / "Auto") so the validator sees it promptly |

Canonical full record (fill in `<PR_NUMBER>` once the PR exists):

```
_psl.flagship.services.  300  IN  TXT  "https://github.com/publicsuffix/list/pull/<PR_NUMBER>"
```

Gotchas:

- The value is the **PR URL**, not the issue URL, not a bare number. It must be
  the exact `https://github.com/publicsuffix/list/pull/<N>` of *our* PR.
- This is a **chicken-and-egg**: you can't know the PR number until the PR is
  opened, and the bot wants the TXT to exist. The practical sequence (see §4) is:
  open the PR, read its number, add/repoint the TXT to that PR URL, then comment
  on the PR (or push an empty commit) so the bot re-runs validation. The bot
  re-checks on PR updates.
- Quote the value in the zone file / leave Cloudflare to quote it; a TXT value
  with `://` must be a single string.
- **Keep the record in place** until the PR merges and the change has propagated;
  removing it early can fail a re-validation.

---

## 4. Step-by-step checklist (owner)

> The whole flow lives on the public `publicsuffix/list` repo + our Cloudflare
> DNS. Nothing here touches the Flagship codebase.

- [ ] **(Optional but recommended) Open a tracking issue first.**
      On <https://github.com/publicsuffix/list/issues>, open an issue titled
      e.g. *"Add flagship.services (IBIS LLC) to PRIVATE section"*. Briefly state:
      who we are (IBIS LLC, <https://github.com/ibisllc>), what the domain is used
      for (multi-tenant personal-cloud — each `<user>.flagship.services` is an
      independent customer namespace), and that a PR + `_psl` TXT will follow.
      Note the issue number; reference it in the PR description.
- [ ] **Fork `publicsuffix/list`** and create a branch, e.g.
      `add-flagship-services`.
- [ ] **Edit `public_suffix_list.dat`** — add the block from §2 to the PRIVATE
      DOMAINS section, alphabetized/grouped per the maintainers' convention.
      Make a single, minimal diff (only the three added lines). Do not reformat
      surrounding entries.
- [ ] **Open the pull request** against `publicsuffix/list:master`. In the PR
      body: link the tracking issue, restate org + contact URL, and explicitly
      say you will set `_psl.flagship.services` TXT to this PR's URL. Fill out the
      PR template checkboxes honestly.
- [ ] **Read the assigned PR number** from the new PR URL.
- [ ] **Add the `_psl` DNS TXT record** (§3) in Cloudflare with value
      `https://github.com/publicsuffix/list/pull/<PR_NUMBER>`. Verify it resolves:
      `dig +short TXT _psl.flagship.services` should return the PR URL.
- [ ] **Trigger re-validation** — comment on the PR (e.g. "`_psl` TXT now points
      to this PR; please re-run validation") or push a trivial commit so the
      validation bot re-checks. Confirm the bot's checks go green.
- [ ] **Respond to maintainer feedback** promptly (sorting, comment format, proof
      of control). Turnaround can be slow; keep the TXT record live throughout.
- [ ] **On merge:** the entry is in the canonical list. **Do not assume immediate
      effect.** Track propagation (§5). Leave the `_psl` TXT in place at least
      until Let's Encrypt's bundled PSL is observed to include `flagship.services`.
- [ ] **Verify the end state** once propagated: confirm Let's Encrypt now treats
      `<user>.flagship.services` as its own registered domain (the staging-CA
      rate-limit headers / behavior, or simply that two different users can each
      issue >50 certs/week without colliding). Update the worklist to mark the
      PSL ceiling resolved.

---

## 5. Expected propagation timeline

- **PR review + merge:** days to a few weeks, depending on maintainer load and
  how fast we satisfy the `_psl`/proof-of-control checks. The list is volunteer-
  maintained — be patient and responsive.
- **Downstream propagation:** **weeks to months.** The PSL is *embedded* in
  consumers, not fetched live by most of them:
  - Browsers ship it inside release binaries (Chromium, Firefox, Safari/WebKit) —
    you inherit their release cadence.
  - Let's Encrypt / Boulder refreshes its bundled copy periodically (not instant);
    **this is the consumer we actually care about** for the rate-limit fix.
  - Libraries (`golang.org/x/net/publicsuffix`, the `psl` npm + PyPI packages,
    `libpsl`) update on their own schedules and then each *dependent* must upgrade.
- **Net:** assume the rate-limit benefit is **not** available for **1–3 months**
  after merge. This is precisely why it must be started **now**, well ahead of the
  scaling need, rather than reactively when we hit the ceiling.

---

## 6. Why this is a doc-only deliverable

This change happens entirely in an **external repository** (`publicsuffix/list`)
plus **DNS** (Cloudflare zone for `flagship.services`). There is nothing to build
or test in the Flagship codebase: no protocol envelope, no Worker route, no
schema. The deliverable is this runbook so the owner can execute the submission
with the exact entry, the exact DNS record, and the exact order of operations in
hand.

When the entry merges and propagates, the only in-repo follow-up is a note in
[`docs/per-user-cert-worklist.md`](./per-user-cert-worklist.md) marking the
"PSL ceiling" finding resolved — and re-confirming the Let's Encrypt
registered-domain limit is now per-user in practice.
