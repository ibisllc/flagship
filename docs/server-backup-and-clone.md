# Backup/clone server

> **Status: built on `main`, not yet run on a real box.** 2026-10-15.

One button on a server's page makes one file with all of its apps and their
data. The file is the user's: they download it, keep it anywhere, and later
import it from Home (**Add/Import a server → Import a backup**) onto any server
of the account. The server they import onto keeps its own name, so cloning
under a new name is: add the new server, wait for it to come online, import.

## What is in the file

Only what the owner made. Per app: its working tree (the source it was built
from), a consistent dump of each database, its files folder, its members, its
access mode and allow-list, its owner env (plain inside the sealed file), and
its signed internet access list (which becomes a draft on import). A
`manifest.json` names the apps, any apps left out and why, and what is and
isn't included.

**No images, no OS, no Flagship.** A backup never carries a container image,
a Linux userland, Docker, Postgres or the daemon. The importing box rebuilds
each app from its working tree with its own runtime catalog
(`runtimes/catalog.ts` writes the Dockerfile from the manifest's
`runtime.base`; the same sandboxed `docker build` a deploy runs), on its own
CPU architecture. An app that was installed from a public image (a name not
starting `flagship-`) is pulled by that name instead. An app with neither
(no working tree on the box, and a box-local image) can't move to another
server: the backup leaves it out and names it, and the apps show "Left out".
That is the promise: every Flagship install can import every backup, and
nobody carries their OS around.

Database dumps are `pg_dump -Fc`, which every newer Postgres restores; files
folders are plain tar.

**Saved config comes along:** each app's secrets (env), members and access,
its internet access list (as a draft for the owner to approve on the new
server), its API keys (the grant and the secret's hash, never the secret, so
clients keep working; an imported key is bound to the server it was imported
on and its owner signature is checked at every load), and the server's front
page (set on import when the importing server has none).

**Not included, on purpose:**
- the server's own keys, certificate and address: the server you import onto
  got its own when it was created (its SWK/STK from your account key and its
  name, its identity key and certificate minted on the machine), and two
  machines must never hold one server's keys;
- the dead-man switch: an owner-signed policy for one server that can lock or
  power it off; set it again on the new server;
- AI provider keys: the box only ever holds a short-lived copy for one build;
  your saved keys live on your phone;
- peer backups and the Git host.

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
POST   /api/screens/server-archive/link     → { path, fileName, bytes, sha256, expiresAt }
GET    /api/archive-download/<token>        (no session; the token is the key)
DELETE /api/screens/server-archive
POST   /api/screens/server-restore/start    { archiveId, bytes }
POST   /api/screens/server-restore/chunk?offset=N      (raw bytes, in order)
POST   /api/screens/server-restore/commit   { key }
GET    /api/screens/server-restore          → { restore: { state, received, apps: [...] } | null }
```

One backup and one import at a time. The box's copy expires after 24 h (and at
the next daemon start); the phones delete it once their download checks out,
the webapp offers "Delete from server".

**Disk.** Before a backup the box sizes it from what each part will hold: the
image (`docker image inspect`), each database (`pg_database_size`, more than
its compressed dump), the files folder (`du -sb` in the locked-down helper)
and the working tree. It needs the file, one app's scratch (parts are staged
then packed) and 1 GB of headroom free, and otherwise refuses with "needs
about X GB, has Y GB". If something can't be sized it goes ahead on a flat
1 GB minimum. An import needs about 2.2× the file.

**Download in a browser.** The link opens a page served by the box itself
(self-contained, no remote assets, `X-Frame-Options: DENY`). It shows a QR
(`https://<apex>/app/backup-download#s=<server>&a=<archive>&r=<request>`) and
a 6-digit code for a fresh request id kept in the page's URL. The Flagship app
on the owner's phone shows the same code, asks for Face ID and signs
`flagship/archive-download/v1|<server>|<archive>|<request>|<issuedAt>` with
the sensitive-order key (admin root, else IRK); the box verifies it under its
pinned authority (`authorizeSensitiveOrder`, at most 5 minutes old, for this
server and this backup) and only then serves `.../file?r=<request>` to that
request, for as long as the backup lives. The link alone never returns the
file. The webapp approves its own download the same way (it holds the
account key) and starts it directly. Vectors:
`packages/protocol/test-vectors/archive-download/vectors.json` (TS, Swift,
Kotlin, webapp).

**Download.** Nothing is held in memory. The download link is a plain HTTPS
URL on the box, streamed from disk, with `Accept-Ranges`, `206` partial
responses and an `ETag` (the file's SHA-256, also checked by `If-Range`), so
the browser saves it straight to disk and can resume it, a download manager
can fetch parts at once, and it works on another computer until it expires.
The token is 32 random bytes, compared in constant time, and dies with the
backup; the file it serves is sealed anyway. The phones fetch the
authenticated `chunk` route 4 parts at a time over the pinned session (over
the LAN when the box is on it), write each part at its offset, keep a
progress file so an interrupted download resumes, and check the SHA-256.

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

Wipe orders don't expire. `.com`'s 30-day eviction GC deletes only `keep`
orders; wipe orders stay until the box comes back, however long that takes.
That is safe because the replacement-path hand-off check now counts only
orders issued after the box's own (older rows of the same name never
confirm a hand-off), and never the unauthenticated ack-new report.

The account-death self-delete order is likewise kept (10-year TTL) and read
without being consumed by a box that names its STK (`?stk=`), so nobody can
burn it by asking first and a box that comes back late still finds it; older
boxes still use the consume-once read.

Limit (why "if possible"): a wipe runs only when the old box's daemon runs.
After take-over (or account deletion) the box can't unlock through the phone,
a lease or `.com`, so it stays sealed unless someone unlocks it locally (the
burn passphrase slot, removed at GA); the moment its daemon runs, the order
is waiting.

## Activity

Boxes keep one activity log (`<dataDir>/activity.jsonl`, `/api/screens/activity`,
`seq` cursor). It now records updates (applied / rolled back / refused), app
installs / redeploys / removals, migration take-over, decommission (released,
awaiting hand-off, wiped, stood down), backups and imports, as well as shares.
`.com` adds `server-migration-started / -taken-over / -aborted` account events.
The Activity tab of all three apps merges the two, newest first. The install
Timeline on the server page is gone.
