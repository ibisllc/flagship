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
2. **Otherwise, look in the public store** (below), but only for repos on github.com,
   gitlab.com or codeberg.org that cloned without credentials. The box runs
   the same checks on what comes back and applies the first one that fits.
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

**Reading:** boxes read the store directly over raw.githubusercontent.com,
with no API of ours involved. They:
- try an exact `base` match first, then the newest others, at most 3;
- check each file against the hash in its name;
- skip blocked repos.

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

## Not yet

- **No signature:** there is none on adapters. The repo's own file carries
  its author's authority, and the public store is the same for everyone.
- **No upstream pull request:** the app doesn't offer one yet. The author
  commits the exported file themselves.
- **Lost on restart:** git and IDE builds live only in daemon memory, so a
  restart forgets them, and with them the export. Their journals survive.
