/**
 * The daily publish of the repo adapter index to the public GitHub repo
 * (ADAPTERS_REPO, ibisllc/flagship-adapters). Everything queued since the
 * last publish lands in ONE commit whose author and committer dates are the
 * UTC day at 00:00:00Z, so the public history says which day a batch went
 * out and nothing finer. D1 is the source of truth: every index.json and
 * do-not-adapt.txt is rendered from it, never read back from GitHub.
 *
 * Layout (boxes read it straight from raw.githubusercontent.com):
 *   adapters/<host>/<repo path>/index.json         {repo, license, adapters:[...]}
 *   adapters/<host>/<repo path>/<file_sha256>.json the exact submitted file
 *   do-not-adapt.txt                               one repo URL per line
 *   README.md                                      written only if missing
 */

import type { D1Database } from "@flagship/storage";
import { utcDay, type AdapterBucketLike } from "./adapterIndex.js";

export interface AdapterPublishEnv {
  DB?: D1Database;
  ADAPTERS_BUCKET?: AdapterBucketLike;
  /** Fine-grained PAT, contents:write on ADAPTERS_REPO only. Unset ⇒ no publish. */
  ADAPTERS_GITHUB_TOKEN?: string;
  /** "owner/name" of the public index repo. Unset ⇒ no publish. */
  ADAPTERS_REPO?: string;
}

export type PublishResult =
  | { published: false; reason: string }
  | { published: true; commit: string; added: number; confirmed: number; removedRepos: number };

// One R2 read and one blob per new file, inside the subrequest budget the
// scheduled invocation shares with the backup and the other 6-hourly tasks.
// Anything past this waits for the next day's publish.
export const MAX_NEW_PER_PUBLISH = 100;

const GITHUB_API = "https://api.github.com";
const AUTHOR_NAME = "Flagship adapters";
const AUTHOR_EMAIL = "adapters@flagshipserver.com";

interface Row {
  file_sha256: string;
  repo: string;
  base: string;
  license: string;
  r2_key: string | null;
  confirmations: number;
  pending_confirmations: number;
  published_day: string | null;
}

/** `adapters/<host>/<repo path>` for a normalized repo URL. */
export function repoDir(repo: string): string {
  const u = new URL(repo);
  return `adapters/${u.hostname}${u.pathname}`;
}

export async function runAdapterPublish(env: AdapterPublishEnv, now: Date): Promise<PublishResult> {
  const { DB: db, ADAPTERS_BUCKET: bucket, ADAPTERS_GITHUB_TOKEN: token, ADAPTERS_REPO: repoName } = env;
  if (!db || !bucket || !token || !repoName) return { published: false, reason: "not configured" };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoName)) return { published: false, reason: "bad ADAPTERS_REPO" };
  const day = utcDay(now);

  const fresh = (
    await db
      .prepare(`SELECT * FROM repo_adapters WHERE published_day IS NULL ORDER BY created_day, file_sha256 LIMIT ${MAX_NEW_PER_PUBLISH}`)
      .bind()
      .all<Row>()
  ).results;
  const bumped = (
    await db
      .prepare("SELECT * FROM repo_adapters WHERE published_day IS NOT NULL AND pending_confirmations > 0")
      .bind()
      .all<Row>()
  ).results;
  const listChanges = (
    await db
      .prepare("SELECT repo, state FROM adapter_blocklist WHERE state IN ('pending', 'unlisting')")
      .bind()
      .all<{ repo: string; state: string }>()
  ).results;
  if (!fresh.length && !bumped.length && !listChanges.length) return { published: false, reason: "nothing to publish" };

  const blocked = new Set(
    (
      await db
        .prepare("SELECT repo FROM adapter_blocklist WHERE state != 'unlisting'")
        .bind()
        .all<{ repo: string }>()
    ).results.map((r) => r.repo.toLowerCase()),
  );
  const isBlocked = (repo: string) => blocked.has(repo.toLowerCase());
  const newlyBlocked = listChanges.filter((c) => c.state === "pending").map((c) => c.repo);

  // Published files of newly listed repos come out of the tree.
  const removed: Row[] = [];
  for (const repo of newlyBlocked) {
    const r = await db
      .prepare("SELECT * FROM repo_adapters WHERE lower(repo) = lower(?) AND published_day IS NOT NULL")
      .bind(repo)
      .all<Row>();
    removed.push(...r.results);
  }

  const bodies = new Map<string, string>();
  const dropped: Row[] = [];
  for (const row of fresh) {
    if (isBlocked(row.repo)) continue;
    const obj = row.r2_key ? await bucket.get(row.r2_key) : null;
    if (obj) bodies.set(row.file_sha256, await obj.text());
    else dropped.push(row);
  }
  const added = fresh.filter((r) => bodies.has(r.file_sha256));
  const confirmed = bumped.filter((r) => !isBlocked(r.repo));

  // Each touched repo's index.json, rendered from every published row plus
  // this batch, with the counts this commit makes true.
  const touched = new Set([...added, ...confirmed].map((r) => r.repo));
  const indexes = new Map<string, string>();
  for (const repo of touched) {
    const all = (
      await db
        .prepare("SELECT * FROM repo_adapters WHERE repo = ? AND published_day IS NOT NULL")
        .bind(repo)
        .all<Row>()
    ).results;
    const entries = [
      ...all.map((r) => ({ row: r, added: r.published_day!, confirmations: r.confirmations + r.pending_confirmations })),
      ...added.filter((r) => r.repo === repo).map((r) => ({ row: r, added: day, confirmations: r.pending_confirmations })),
    ].sort(
      (a, b) =>
        b.added.localeCompare(a.added) ||
        b.confirmations - a.confirmations ||
        a.row.file_sha256.localeCompare(b.row.file_sha256),
    );
    indexes.set(
      repo,
      JSON.stringify(
        {
          repo,
          license: entries[0]!.row.license,
          adapters: entries.map((e) => ({
            base: e.row.base,
            file: `${e.row.file_sha256}.json`,
            added: e.added,
            confirmations: e.confirmations,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  }

  const listed = (
    await db
      .prepare("SELECT repo FROM adapter_blocklist WHERE state != 'unlisting' ORDER BY rowid")
      .bind()
      .all<{ repo: string }>()
  ).results.map((r) => r.repo);
  const doNotAdapt = listed.map((r) => `${r}\n`).join("");

  const gh = github(token, repoName);
  const head = (await gh("GET", "/git/ref/heads/main")) as { object: { sha: string } };
  const headCommit = (await gh("GET", `/git/commits/${head.object.sha}`)) as { tree: { sha: string } };
  const hasReadme = await gh("GET", `/contents/README.md?ref=${head.object.sha}`, undefined, true);

  type Entry = { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string };
  const tree: Entry[] = [];
  for (const row of added) {
    const blob = (await gh("POST", "/git/blobs", { content: bodies.get(row.file_sha256)!, encoding: "utf-8" })) as { sha: string };
    tree.push({ path: `${repoDir(row.repo)}/${row.file_sha256}.json`, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const [repo, text] of indexes) tree.push({ path: `${repoDir(repo)}/index.json`, mode: "100644", type: "blob", content: text });
  const removedDirs = new Set<string>();
  for (const row of removed) {
    tree.push({ path: `${repoDir(row.repo)}/${row.file_sha256}.json`, mode: "100644", type: "blob", sha: null });
    removedDirs.add(repoDir(row.repo));
  }
  for (const dir of removedDirs) tree.push({ path: `${dir}/index.json`, mode: "100644", type: "blob", sha: null });
  tree.push({ path: "do-not-adapt.txt", mode: "100644", type: "blob", content: doNotAdapt });
  if (!hasReadme) tree.push({ path: "README.md", mode: "100644", type: "blob", content: README });

  const newTree = (await gh("POST", "/git/trees", { base_tree: headCommit.tree.sha, tree })) as { sha: string };
  // A queue change that alters no file (say, unlisting a repo that was never
  // listed) settles without an empty commit.
  let commitSha = head.object.sha;
  if (newTree.sha !== headCommit.tree.sha) {
    const stamp = { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: `${day}T00:00:00Z` };
    const commit = (await gh("POST", "/git/commits", {
      message: `Adapters for ${day} (${added.length} new, ${confirmed.length} confirmed)`,
      tree: newTree.sha,
      parents: [head.object.sha],
      author: stamp,
      committer: stamp,
    })) as { sha: string };
    await gh("PATCH", "/git/refs/heads/main", { sha: commit.sha, force: false });
    commitSha = commit.sha;
  }

  // Only now is the batch public; settle the queue to match.
  const stmts = [
    ...added.map((r) =>
      db
        .prepare(
          `UPDATE repo_adapters SET published_day = ?, r2_key = NULL,
             confirmations = confirmations + ?, pending_confirmations = pending_confirmations - ?
           WHERE file_sha256 = ?`,
        )
        .bind(day, r.pending_confirmations, r.pending_confirmations, r.file_sha256),
    ),
    ...confirmed.map((r) =>
      db
        .prepare(
          `UPDATE repo_adapters SET confirmations = confirmations + ?, pending_confirmations = pending_confirmations - ?
           WHERE file_sha256 = ?`,
        )
        .bind(r.pending_confirmations, r.pending_confirmations, r.file_sha256),
    ),
    ...[...removed, ...dropped].map((r) => db.prepare("DELETE FROM repo_adapters WHERE file_sha256 = ?").bind(r.file_sha256)),
    ...listChanges.map((c) =>
      c.state === "unlisting"
        ? db.prepare("DELETE FROM adapter_blocklist WHERE repo = ? AND state = 'unlisting'").bind(c.repo)
        : db.prepare("UPDATE adapter_blocklist SET state = 'published' WHERE repo = ? AND state = 'pending'").bind(c.repo),
    ),
  ];
  if (stmts.length) await db.batch(stmts);
  const keys = added.flatMap((r) => (r.r2_key ? [r.r2_key] : []));
  if (keys.length) await bucket.delete(keys);

  return { published: true, commit: commitSha, added: added.length, confirmed: confirmed.length, removedRepos: removedDirs.size };
}

function github(token: string, repoName: string) {
  return async (method: string, path: string, body?: unknown, probe = false): Promise<unknown> => {
    const res = await fetch(`${GITHUB_API}/repos/${repoName}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "flagship-adapters-publisher",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (probe) {
      await res.body?.cancel();
      if (res.status === 200) return true;
      if (res.status === 404) return false;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`github ${method} ${path.split("?")[0]}: ${res.status}`);
    }
    return res.json();
  };
}

export const README = `# Flagship repo adapters

This repository is the public index of **repo adapters** for
[Flagship](https://flagshipserver.com), a personal cloud you run on your own
hardware. Read more at <https://flagshipserver.com/adapters>.

A repo adapter is the set of changes a Flagship server makes so an
open-source app runs on Flagship: a \`flagship.app.json\` manifest, plus any
small edits the app needs, written against one commit of the app's repo. The
app's own repo is never changed.

When a Flagship server adapts a public open-source repo, it shares the
adaptation so the next server can install that repo without needing AI. The
adaptations are published here, in the open, so anyone can see exactly what
Flagship servers will apply, and every server gets the same bytes.

## Layout

    adapters/<host>/<repo path>/index.json
    adapters/<host>/<repo path>/<sha256 of the file>.json
    do-not-adapt.txt

\`index.json\` lists a repo's adapters, newest first: the commit each was made
against (\`base\`), its file, the day it was added and how many servers sent
the identical file (\`confirmations\`). It also records the repo's license.

## Licensing

Each adapter is a derivative of its upstream repo and is under that repo's
license, recorded in the repo's \`index.json\`. We only keep adaptations of
public repos under an OSI open-source license, after checking that every
change applies exactly to public code at the named commit.

## Anonymous

Submissions are anonymous. No account, server, IP address or other detail
about who sent an adaptation is attached to it or stored with it, here or on
our side. Adaptations are published in one commit per day, dated to that day.

## Removal

Repo owners: commit your own \`flagship.app.json\` to your repo and Flagship
servers will use yours instead, and we never keep adaptations of a repo that
has one. Or email legal@flagshipserver.com and we'll add your repo to
\`do-not-adapt.txt\`, which removes its directory at the next publish and keeps
it out from then on. Flagship servers check \`do-not-adapt.txt\` too.

Git history keeps earlier commits, so a removed adapter can still be found in
history; removal stops Flagship servers from using it.
`;
