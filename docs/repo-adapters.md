# Repo adapters: `flagship.app.json` as a recipe, not a rewrite

Status: **design, not built** (owner idea, 2026-10-11). Today's git import
adapts a repo by having the AI write files into the box's copy (a manifest,
a Dockerfile, edits to the source). The copy then drifts from upstream, and
the next import starts from nothing.

## The idea

`flagship.app.json` should tell a machine how to turn a repo written for an
ordinary server into a Flagship app. The author keeps developing the app the
usual way and touches the file only when something structural changes. Then:

1. **One API creates the file and updates it.** It takes the repo at HEAD
   and, when the file exists, the commit it was written against
   (`adapter.base`). It reads the changes since then and edits the file only
   if they matter (a new env var, a new port, a new database). Any Flagship
   server can run it, with its owner's AI key. Git import calls it today.
2. **The file goes back upstream.** After an adapt, the app offers a pull
   request that adds the file, naming the commit it was made from, so the
   next import starts from there.

## Changing as little as possible

The schema should let the adapter *describe* the changes rather than *make*
them, in this order of preference:

- **Build recipe:** a Dockerfile path, or language, install and start
  commands, so no Dockerfile has to be added.
- **Env remapping:** `DATABASE_URL ← FLAGSHIP_PG_URL`, `PORT ← runtime.port`.
  This covers most persistence "rewrites" with no code edit.
- **Identity mapping:** many apps already trust a proxy header for the user
  (Grafana's `X-WEBAUTH-USER`, oauth2-proxy setups). Mapping
  `X-Flagship-User` onto it replaces "remove the app's login" for those apps.
- **Patches, last:** unified diffs against named files, each recorded against
  `adapter.base`. On import they are applied first; only a patch that no
  longer applies goes back to the AI to be rebased. A patch that fails is a
  loud signal, unlike a silently stale copy.

The adapt prompt already asks for the fewest edits, kept beside the author's
code (`buildAgent.ts`).

## Problem 1: a malicious adapter

An adapter runs on the importer's own box, inside the same container rules as
any app: no `FLAGSHIP_*` variables, only the app's own data stores, behind
the membership gate. It cannot do more than the repo's own code, which the
importer already trusts by importing it. The new risk is a **third party's**
adapter for someone else's repo, presented as if it were vetted.

Proposed answer: a review service checks a proposed adapter and **signs its
hash** with a key under the maintainers chain we already run. The signature
goes in the PR description and in the file. Importers verify it and show
"checked by Flagship" or "unchecked". This is the same service as the
marketplace security scanner (open item 8).

Prefer the **owner** opening the PR from their own GitHub account (the app
prepares the branch) over a Flagship bot account. Unsolicited bot PRs to
strangers' repos read as spam and get accounts flagged. It also keeps us from
speaking for code we didn't write. Sending the adapter to the review service
is opt-in and only for public repos, since `.services`/`.com` otherwise never
see user content.

## Problem 2: a repo that needs a substantial rewrite

The platform runs any container, so the language itself is rarely the
obstacle. The rules are: one port, no local disk, no login of its own.

Two things shrink the rewrite cases:
- a persistent-volume data store, for apps that write to disk;
- identity mapping, for apps with their own login.

What still needs a rewrite is a **fork**, not an adapter. A "fat" file of
whole-file replacements would conflict with every upstream change and can't
be reviewed meaningfully. That code belongs in the owner's Forgejo copy, or a
fork, with an ordinary adapter of its own.

## Open questions

- The schema: `adapter: { base, build, env, identity, patches }` inside
  `flagship.app.json`, or a sibling `flagship.adapter.json` so the app
  manifest stays the box's contract. Leaning to the sibling file.
- Should the box re-run the adapter on a schedule (pull upstream, re-apply,
  redeploy on green), or only on the owner's "Update from the repo"?
