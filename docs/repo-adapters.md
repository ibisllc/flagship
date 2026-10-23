# Repo adapters

How a repo written for an ordinary server comes to run on Flagship, written
down instead of done in place. Built 2026-10-11 (owner design).

## The file

An adapter is the repo's `flagship.app.json` with an `adapter` section:

```json
{
  "schema_version": 1,
  "name": "notes",
  "runtime": { "image": "x", "port": 8080 },
  "adapter": {
    "version": 1,
    "source": { "repo": "https://github.com/me/notes", "base": "<40-hex commit>", "ref": "main" },
    "add":    { "Dockerfile": ["FROM node:20-alpine", "…", ""] },
    "patch":  [{ "path": "src/db.js", "hunks": [{ "oldStart": 3, "oldLines": 7, "newStart": 3, "newLines": 7, "lines": [" …", "-…", "+…"] }] }],
    "remove": ["docker-compose.yml"]
  }
}
```

- `source.base` is the commit the edits were made against.
- Files and hunks are stored as arrays of lines, so even a big adapter diffs
  readably in git.
- There is no size limit.
- Applying it means removing files, then applying hunks, then adding files.
  The rest of the file, without `adapter`, is the manifest the box installs.

Format, derive, apply and rule checks: `packages/protocol/src/repoAdapter.ts`.
The box and flagshipserver.com both use it.

- **Apply** works like `patch`: a hunk may move if the lines around it moved,
  and up to two context lines may be trimmed. A hunk that fits nowhere names
  its file.
- **Rule checks:**
  - paths must be safe;
  - the adapter can't add, edit or remove `flagship.app.json` itself;
  - the manifest must be valid;
  - nothing it writes may look like a secret (private keys and common API
    token shapes).

## On import (the box)

`GitImporter` + `BuildOrchestrator`:

1. **The repo's own `flagship.app.json` wins.**
   - With an adapter that fits: apply it and install without AI.
   - With one that no longer fits: the AI gets it as a guide.
   - Either way, the repo is its author's: the box never looks it up in the
     public store and never sends an adaptation of it.
2. **Otherwise, look for a vetted adapter** (below, "Vetting and the signed
   index"), but only for repos on github.com, gitlab.com or codeberg.org that
   cloned without credentials, and only while the box's release pins a
   vetting key. The box takes only digests with a current, signed attestation,
   runs the same checks on what comes back and applies the first one that
   fits.
3. **Otherwise, the AI adapts it.** It is asked to change as little as
   possible, beside the author's code. Once it deploys:
   - the box derives the adapter from the clone and the deployed tree;
   - the name, address label and description are replaced by the repo's
     name, since the file is published;
   - the adapter is sent for the public store if the repo has a license
     file and the owner didn't steer the AI in their own words.

Non-text files (images, fonts) are carried to the build as bytes; the AI
can't see or edit them. Symlinks in a repo are never followed.
`FLAGSHIP_ADAPTER_INDEX=off` keeps everything on the box.

## How a repo's author controls it

**Commit a `flagship.app.json` at the repo root.** Every Flagship server uses
it, and the public store never takes adaptations of that repo.

To get one:
- write it by hand (`docs/manifest.md` plus the format above); or
- import the repo on your own Flagship server, check it runs, then use **Get
  flagship.app.json** on the import screen. That calls
  `GET /api/build/sessions/:id/adapter`.

An author who doesn't want Flagship servers to run the repo at all can email
legal@flagshipserver.com, and we add it to the do-not-adapt list. We can't
stop anyone running open-source code on their own server, but we stop keeping
adaptations of it.

## The public store

Adapters live in a public git repo, **github.com/ibisllc/flagship-adapters**,
from day one. An index only we could see would make us a hidden point of
trust: we, or anyone who broke into the Worker, could serve one person a bad
adapter and nobody would know. In the public store:
- everyone gets the same bytes;
- anyone can audit what Flagship servers will apply;
- the git history is the log.

**Layout:** for each repo, `adapters/<host>/<repo path>/index.json` lists
`{base, file, added, confirmations}`, newest first. Each adapter sits beside
it as `<sha256 of its text>.json`. `do-not-adapt.txt` lists blocked repos.

**Reading:** boxes no longer read the public repo (SEC-ADAPTER-001/002). A
mutable branch and hash-named files prove only that bytes match their names,
not that anyone vetted them; boxes read the signed index instead (next
section). The daily publish to the public repo is quarantined in code
(`communityPublish.enabled`).

**Writing:** `POST /api/adapters/submit {repo, base, licensePath, file}` on
flagshipserver.com.
- It is anonymous: no account, server, IP or precise time is taken or kept.
- It always answers 202 with the same body.
- Before keeping a submission, the Worker checks that:
  - it comes from a supported host;
  - the repo isn't on the do-not-adapt list;
  - the rule checks pass;
  - the license file at that commit is public and an OSI license, because
    public with no license means all rights reserved;
  - the repo doesn't carry its own `flagship.app.json`;
  - every edited file exists at `base` and every hunk fits it exactly, which
    shows the adapter only edits public code;
  - an optional cheap-AI review passes, when `ADAPTER_REVIEW_ANTHROPIC_KEY`
    is set.
- Accepted adapters queue up. A daily job publishes the queue in one commit
  dated to the day, so commit times can't be matched to anyone's import.
- A resubmitted adapter counts as a confirmation.

**Do-not-adapt:** `POST`/`DELETE /api/admin/adapter-blocklist`, behind the
admin secret. Adding a repo drops its queue, removes its folder at the next
publish and lists it in `do-not-adapt.txt`. Git history keeps old commits;
removal stops future use. The public copy is `apps/web/public/adapters.html`
and the privacy policy.

## Vetting and the signed index

SEC-ADAPTER-002 (`apps/com/src/adapterVetting.ts`,
`packages/protocol/src/adapterAttestation.ts`, vectors in
`packages/protocol/test-vectors/adapter-attestation/`).

1. **Deterministic checks first.** Every check above runs; a file that fails
   one never reaches a model.
2. **Model review** (`adapterReview.ts`). The model reads exactly the
   submitted file, the bytes its digest names: no repo metadata beyond what
   the file holds, nothing about who sent it or where it runs. A file longer
   than the review limit may be kept but is never attested.
3. **Attestation.** On a pass the pipeline, not the model, signs
   `flagship/adapter-attestation/v1` for that exact digest: repo, base
   commit, capability digest of its manifest, validator version, review
   policy version, reviewer model and the version that answered, evidence
   hash, `issuedAt`, `expiresAt` (90 days). The key is the Worker secret
   `ADAPTER_ATTESTATION_SIGNING_KEY`; boxes pin its public half in
   `release/adapter-vetting-keys.json`, with a validity window per key so it
   can rotate. The evidence (checks run, license, policy digest, verdict) is
   kept in D1 `adapter_attestations`.
4. **Index.** `GET /api/adapters/index` serves the latest signed
   `flagship/adapter-index/v1`: sequence, previous digest, expiry (3 days,
   re-signed daily by the cron's publish slot or on any change), every
   current attestation and every revocation, and the withdrawn digests.
   `GET /api/adapters/file/<sha256>` serves an attested file while a pass
   covers it and nothing revoked it.
5. **On the box** (`buildmodes/adapterIndex.ts`, `adapterTrust.ts`): verify
   the index and each attestation against the pinned keys, refuse a rollback
   or fork (the highest sequence seen is kept in
   `<dataDir>/data/adapter-index-highwater.json`), accept only an exact digest
   whose bytes hash to it, whose repo, base and capability digest match the
   attestation, that has not expired and that nothing withdrew. A revocation
   is final. With no pinned key, lookup is off.
6. **Revocation** is a signed `revoked` attestation. Complaints from 3
   distinct networks, a later failed review, or the repo owner's opt-out make
   one at once; the next index lists it.

The model's verdict never authorizes an adapter by itself: the owner's import
of a repo into a new service is the choice to use a vetted adapter there. A
per-service manual choice of an unvetted digest is not stored yet.

## Feedback, crashes and retirement

The loop is designed to run with nobody watching it.

- **The submitter hears why.** A box submits with `wait: true` and gets
  `kept`, `known` or `refused` with reasons, each marked fixable or not. When
  every reason is fixable, the box's own AI:
  1. gets the reasons;
  2. makes the smallest change;
  3. validates and redeploys in place;
  4. submits again.

  It does this at most twice. The owner's AI, not ours, does the work.
  Sharing is on by default; the owner can switch it off on the import
  screen.
- **Probing:** rule failures come with full reasons, since the rules are
  public anyway. AI refusals give only a category. Submissions are capped at
  6 per repo and commit per day.
- **Crashes at install:** when a published adapter fails to build or start,
  the box:
  - reports which adapter and at which stage, and nothing else
    (`POST /api/adapters/complain`);
  - never offers it on that box again;
  - hands the repo to the owner's AI, starting it at once if the build
    already has a key.

  There is no other telemetry.
- **Owner reports:** a service built from a shared adapter offers "Report a
  problem with this adaptation" on its page. A short note goes with the
  adapter's hash, and only that. The note is never published, and is
  deleted after 90 days (180 days for a retired adapter).
- **Retirement:** reports of any kind, crash or owner note, from 3 distinct
  networks (an IPv4 /24 or IPv6 /48 counts once however many addresses it
  uses) revoke an attested adapter at once, and retire it at the next publish
  of the public repo. A review failure retires one too. Retired adapters stay in D1 with their reports,
  and an identical file can't come back. The next box's AI makes a new one.
- **Budgets:** one network counts once per adapter a day, one adapter takes
  at most 10 reports an hour, and a network sends at most 10 reports and 20
  submits an hour (`apps/com/src/rateLimit.ts`). The counters hold hit times
  under a hashed id. A report keeps only a keyed hash
  (`ADAPTER_COMPLAINT_SALT`) of its network for that one adapter, so distinct
  sources can be counted but neither the network nor the same sender across
  two adapters can be recovered. Without the salt reports count toward
  nothing.
- **Learning:** once a week, with the review key set, the Worker asks a cheap
  model what went wrong across new retirements and how the harness (adapt
  prompt, build tools, manifest contract) could prevent it. Answers are kept
  privately at `GET /api/admin/adapter-insights`, behind the admin secret;
  read them when improving the harness.

## Not yet

- **No sandbox evidence:** an attestation records the deterministic checks
  and the model review, not an isolated build and test run.
- **No per-service manual acceptance:** a box applies only vetted adapters;
  choosing an unvetted digest by hand (with its diff shown) is not built.
- **No upstream pull request:** the app doesn't offer one yet. The author
  commits the exported file themselves.
- **Restarts:** git and IDE builds are saved under `<dataDir>/data/builds/`
  (`buildmodes/buildStore.ts`) and come back after a restart, kept a month
  after their last change. One the AI was adapting, or the box was putting
  live, comes back failed with a sentence; its files are kept.
