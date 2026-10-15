# Backup/clone server

> **Status: built on `main`, not yet run on a real box.** 2026-10-15.

One button on a server's page makes one file with all of its apps and their
data. The file is the user's: they download it, keep it anywhere, and later
import it from Home (**Add/Import a server → Import a backup**) onto any server
of the account. The server they import onto keeps its own name, so cloning
under a new name is: add the new server, wait for it to come online, import.

## What is in the file

Per installed app (the same units an app copy moves, `docs/app-placement.md`
§5): its image, a consistent dump of each database, its files folder, the
working tree of an app built on the box, its members, its access mode and
allow-list, its owner env (plain inside the sealed file), and its signed
internet access list (which becomes a draft on import). A `manifest.json`
names the apps and lists what is and isn't included.

Not included: API keys, the server's identity / name / certificate, peer
backups, the Git host. (Each is regenerated, deliberately not carried, or
not built yet.)

## Format (`packages/server-daemon/src/serverArchive/format.ts`)

`<JSON header line>\n` then AES-256-GCM frames of the tar stream. The header
(`magic`, `v`, `archiveId`, `createdAt`, `sourceServer`, `apps`) is readable
without the key so the importer can derive the key and show what is inside.
Every frame is bound to the header (SHA-256 as AAD) and to its position (the
nonce is the frame index), and the AAD carries a last-frame flag, so a
reordered, edited, or truncated file fails to open.

## Keys

`deriveServerArchiveKey(UMK, archiveId)` = HKDF-SHA256(UMK seed, empty salt,
`flagship/server-archive/v1|<archiveId>`). It depends on the UMK and the
archive id only (no server id), so any device of the account can open an
archive and import it onto a server with a different name. The phone derives
it and hands it to the box over the pinned session, once to seal and once to
open; the box wipes it from memory after use and never stores it. Vectors:
`packages/protocol/test-vectors/server-archive/vectors.json` (TS, Swift,
Kotlin, webapp all pass).

## Routes (owner sessions only; companions and shares are refused)

```
POST   /api/screens/server-archive/start    { archiveId, key }
GET    /api/screens/server-archive          → { archive: { state: building|ready|failed, progress, bytes, ... } | null }
GET    /api/screens/server-archive/chunk?offset=N      (≤ 4 MiB)
DELETE /api/screens/server-archive
POST   /api/screens/server-restore/start    { archiveId, bytes }
POST   /api/screens/server-restore/chunk?offset=N      (raw bytes, in order)
POST   /api/screens/server-restore/commit   { key }
GET    /api/screens/server-restore          → { restore: { state, received, apps: [...] } | null }
```

One backup and one import at a time. The client deletes the box's copy once
downloaded; otherwise it expires after 24 h and at the next daemon start. Disk
is checked before either starts. Scratch space is one app at a time on backup;
about 2.2× the file on import.

## Import

The importing box unpacks into a scratch folder (every entry name checked
against a fixed pattern), verifies each part's SHA-256, then installs the apps
one by one the way an app copy installs one: image loaded, env written, fresh
stores restored before first start, members and working tree brought over. An
app already on the server is skipped and reported; an app that fails leaves
nothing behind and the rest go on. Apps are installed under the importing
server's own name.

## Migrate always retires and wipes the old server

The migrate flow no longer offers "keep the old disk" (Replace is gone; use
Backup/clone + Migrate). After a confirmed take-over:

- `.com` has already rebound the directory identity, so the old box's STK is
  refused by the unlock relay, the lease path, and the hub; take-over now also
  deletes the old box's boot-unlock leases (`serverMigration.ts`).
- The old box finishes the signed `wipe-after-handoff` order. Previously a
  timeout wrote the final marker and the box was never wiped; now it writes an
  `awaiting-confirm` stage, powers off, and on its next start re-checks the
  hand-off and wipes (`decommissionConsumer.ts`). If the order is gone (the
  migration was aborted) it stands down.

Limit: after take-over an old box can't unlock via phone or `.com`, so a late
wipe needs the daemon to run (a local passphrase unlock).

## Activity

Boxes keep one activity log (`<dataDir>/activity.jsonl`, `/api/screens/activity`,
`seq` cursor). It now records updates (applied / rolled back / refused), app
installs / redeploys / removals, migration take-over, decommission (released,
awaiting hand-off, wiped, stood down), backups and imports, as well as shares.
`.com` adds `server-migration-started / -taken-over / -aborted` account events.
The Activity tab of all three apps merges the two, newest first. The install
Timeline on the server page is gone.
