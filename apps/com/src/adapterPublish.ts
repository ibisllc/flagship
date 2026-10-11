/**
 * The daily publish of the repo adapter index to the public GitHub repo
 * (ADAPTERS_REPO, ibisllc/flagship-adapters). Everything queued since the
 * last publish lands in ONE commit whose author and committer dates are the
 * UTC day at 00:00:00Z, so the public history says which day a batch went
 * out and nothing finer. D1 is the source of truth: every index.json and
 * do-not-adapt.txt is rendered from it, never read back from GitHub.
 *
 * Layout (boxes read it straight from raw.githubusercontent.com):
 *   adapters/<host>/<repo path>/index.json         {repo, license, adapters:[{base, file, added, confirmations, complaints}]}
 *   adapters/<host>/<repo path>/<file_sha256>.json the exact submitted file
 *   do-not-adapt.txt                               one repo URL per line
 *   README.md                                      written only if missing
 */

import type { D1Database } from "@flagship/storage";
import { splitAdapterFile } from "@flagship/protocol";
import { aiReview, utcDay, type AdapterBucketLike } from "./adapterIndex.js";

export interface AdapterPublishEnv {
  DB?: D1Database;
  ADAPTERS_BUCKET?: AdapterBucketLike;
  /** Fine-grained PAT, contents:write on ADAPTERS_REPO only. Unset ⇒ no publish. */
  ADAPTERS_GITHUB_TOKEN?: string;
  /** "owner/name" of the public index repo. Unset ⇒ no publish. */
  ADAPTERS_REPO?: string;
  /**
   * Unset: adapters are published after the rule checks alone, and owners'
   * reports are only stored. Once set, each publish also reviews what went
   * out without it and every adapter reported since its last review, and
   * withdraws what fails.
   */
  ADAPTER_REVIEW_ANTHROPIC_KEY?: string;
}

export type PublishResult =
  | { published: false; reason: string }
  | { published: true; commit: string; added: number; confirmed: number; removedRepos: number; withdrawn: number };

// One R2 read and one blob per new file, inside the subrequest budget the
// scheduled invocation shares with the backup and the other 6-hourly tasks.
// Anything past this waits for the next day's publish.
export const MAX_NEW_PER_PUBLISH = 100;
// AI reviews per publish, new and catch-up together, for the same budget.
export const MAX_REVIEWS_PER_PUBLISH = 40;

const GITHUB_API = "https://api.github.com";
const AUTHOR_NAME = "Flagship adapters";
const AUTHOR_EMAIL = "adapters@flagshipserver.com";

interface Row {
  file_sha256: string;
  repo: string;
  base: string;
  license: string;
  r2_key: string | null;
  review: string;
  confirmations: number;
  pending_confirmations: number;
  published_day: string | null;
  retired_day?: string | null;
}

/** `adapters/<host>/<repo path>` for a normalized repo URL. */
export function repoDir(repo: string): string {
  const u = new URL(repo);
  return `adapters/${u.hostname}${u.pathname}`;
}

const DAY_MS = 86_400_000;
// Complaints of any kind (build, start, report) that retire an adapter.
export const RETIRE_AT_COMPLAINTS = 3;
// A live adapter's complaints expire after this; a retired adapter keeps its
// own until the adapter itself is pruned, RETIRED_TTL_DAYS after retirement.
const COMPLAINT_TTL_DAYS = 90;
export const RETIRED_TTL_DAYS = 180;
const ATTEMPT_TTL_DAYS = 7;
const LIVE = "published_day IS NOT NULL AND retired_day IS NULL";
const RETIRED_FILES = "SELECT file_sha256 FROM repo_adapters WHERE retired_day IS NOT NULL";

/** Delete what has outlived its use: old attempt counters, retired adapters. */
async function pruneOld(db: D1Database, bucket: AdapterBucketLike | undefined, now: Date): Promise<void> {
  await db
    .prepare("DELETE FROM adapter_attempts WHERE day < ?")
    .bind(utcDay(new Date(now.getTime() - ATTEMPT_TTL_DAYS * DAY_MS)))
    .run();
  const cutoff = utcDay(new Date(now.getTime() - RETIRED_TTL_DAYS * DAY_MS));
  const old = (
    await db
      .prepare("SELECT file_sha256 FROM repo_adapters WHERE retired_day IS NOT NULL AND retired_day < ?")
      .bind(cutoff)
      .all<{ file_sha256: string }>()
  ).results.map((r) => r.file_sha256);
  if (!old.length) return;
  await db.batch(
    old.flatMap((sha) => [
      db.prepare("DELETE FROM adapter_complaints WHERE file_sha256 = ?").bind(sha),
      db.prepare("DELETE FROM repo_adapters WHERE file_sha256 = ?").bind(sha),
    ]),
  );
  if (bucket) await bucket.delete(old.map((sha) => `retired/${sha}.json`));
}

export async function runAdapterPublish(env: AdapterPublishEnv, now: Date): Promise<PublishResult> {
  const { DB: db, ADAPTERS_BUCKET: bucket, ADAPTERS_GITHUB_TOKEN: token, ADAPTERS_REPO: repoName } = env;
  if (!db) return { published: false, reason: "not configured" };
  const day = utcDay(now);
  const complaintCutoff = utcDay(new Date(now.getTime() - COMPLAINT_TTL_DAYS * DAY_MS));
  await pruneOld(db, bucket, now);
  const pruneStmt = () =>
    db
      .prepare(`DELETE FROM adapter_complaints WHERE day < ? AND file_sha256 NOT IN (${RETIRED_FILES})`)
      .bind(complaintCutoff);
  const pruneComplaints = () => pruneStmt().run();
  if (!bucket || !token || !repoName) {
    // Nothing goes public, but owners' notes still expire on time.
    await pruneComplaints();
    return { published: false, reason: "not configured" };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoName)) return { published: false, reason: "bad ADAPTERS_REPO" };

  const all = async <T>(sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<T>()).results;

  const fresh = await all<Row>(
    `SELECT * FROM repo_adapters WHERE published_day IS NULL ORDER BY created_day, file_sha256 LIMIT ${MAX_NEW_PER_PUBLISH}`,
  );
  const bumped = await all<Row>(`SELECT * FROM repo_adapters WHERE ${LIVE} AND pending_confirmations > 0`);
  const listChanges = await all<{ repo: string; state: string }>(
    "SELECT repo, state FROM adapter_blocklist WHERE state IN ('pending', 'unlisting')",
  );
  const reviewKey = env.ADAPTER_REVIEW_ANTHROPIC_KEY;
  // Published before there was a key to review them with: review them now.
  const unreviewed = reviewKey
    ? await all<Row>(
        `SELECT * FROM repo_adapters WHERE ${LIVE} AND review = 'rules'
         ORDER BY published_day, file_sha256 LIMIT ${MAX_REVIEWS_PER_PUBLISH}`,
      )
    : [];

  // Complaints, as of this snapshot (later ones wait for the next publish).
  const maxComplaint =
    (await db.prepare("SELECT max(id) AS m FROM adapter_complaints").bind().first<{ m: number | null }>())?.m ?? 0;
  const complaintCounts = new Map(
    (
      await all<{ file_sha256: string; n: number }>(
        `SELECT file_sha256, count(*) AS n FROM adapter_complaints
         WHERE stage IN ('build', 'start') AND day >= ? AND id <= ? GROUP BY file_sha256`,
        complaintCutoff,
        maxComplaint,
      )
    ).map((r) => [r.file_sha256, r.n]),
  );
  // Repos whose published counts change: new build/start complaints, or old
  // ones expiring.
  const recount = (
    await all<{ repo: string }>(
      `SELECT DISTINCT r.repo FROM adapter_complaints c JOIN repo_adapters r ON r.file_sha256 = c.file_sha256
       WHERE c.stage IN ('build', 'start') AND c.id <= ? AND (c.counted = 0 OR c.day < ?)
         AND r.published_day IS NOT NULL AND r.retired_day IS NULL`,
      maxComplaint,
      complaintCutoff,
    )
  ).map((r) => r.repo);
  // Three problems of any kind, from installs or owners, retire an adapter.
  const broken = await all<Row>(
    `SELECT * FROM repo_adapters WHERE ${LIVE} AND file_sha256 IN (
       SELECT file_sha256 FROM adapter_complaints WHERE day >= ? AND id <= ?
       GROUP BY file_sha256 HAVING count(*) >= ?)`,
    complaintCutoff,
    maxComplaint,
    RETIRE_AT_COMPLAINTS,
  );
  const reported = reviewKey
    ? await all<Row>(
        `SELECT * FROM repo_adapters WHERE ${LIVE} AND file_sha256 IN (
           SELECT file_sha256 FROM adapter_complaints WHERE stage = 'report' AND reviewed = 0 AND id <= ?)
         ORDER BY published_day, file_sha256`,
        maxComplaint,
      )
    : [];
  const expiring = await db
    .prepare(`SELECT 1 AS x FROM adapter_complaints WHERE day < ? AND file_sha256 NOT IN (${RETIRED_FILES}) LIMIT 1`)
    .bind(complaintCutoff)
    .first();

  if (
    !fresh.length && !bumped.length && !listChanges.length && !unreviewed.length &&
    !recount.length && !broken.length && !reported.length
  ) {
    if (expiring) await pruneComplaints();
    return { published: false, reason: "nothing to publish" };
  }

  const blocked = new Set(
    (await all<{ repo: string }>("SELECT repo FROM adapter_blocklist WHERE state != 'unlisting'")).map((r) =>
      r.repo.toLowerCase(),
    ),
  );
  const isBlocked = (repo: string) => blocked.has(repo.toLowerCase());
  const newlyBlocked = listChanges.filter((c) => c.state === "pending").map((c) => c.repo);

  // Published files of newly listed repos come out of the tree; what we kept
  // of their retired adapters goes too.
  const removed: Row[] = [];
  const forgotten: Row[] = [];
  for (const repo of newlyBlocked) {
    removed.push(...(await all<Row>(`SELECT * FROM repo_adapters WHERE lower(repo) = lower(?) AND ${LIVE}`, repo)));
    forgotten.push(...(await all<Row>("SELECT * FROM repo_adapters WHERE lower(repo) = lower(?) AND retired_day IS NOT NULL", repo)));
  }

  const bodies = new Map<string, string>();
  const dropped: Row[] = [];
  for (const row of fresh) {
    if (isBlocked(row.repo)) continue;
    const obj = row.r2_key ? await bucket.get(row.r2_key) : null;
    if (obj) bodies.set(row.file_sha256, await obj.text());
    else dropped.push(row);
  }

  // Retired in this commit (out of the tree, kept in D1), for problem
  // reports or a failed review.
  const withdrawn = new Map<string, Row>();
  const retireReason = new Map<string, "reports" | "review">();
  const retire = (row: Row, why: "reports" | "review") => {
    withdrawn.set(row.file_sha256, row);
    retireReason.set(row.file_sha256, why);
  };
  for (const row of broken) if (!isBlocked(row.repo)) retire(row, "reports");

  // With a key, nothing goes out unreviewed: reported adapters are reviewed
  // again (once per report), then the queue, then what went out before the
  // key existed. A review that can't run leaves things as they are.
  let reviewBudget = MAX_REVIEWS_PER_PUBLISH;
  const deferred = new Set<string>();
  const reviewedNow: string[] = [];
  const rereviewed: string[] = [];
  const review = async (row: Row, body: string, reports: string[] = []) => {
    const split = splitAdapterFile(body);
    if (!split.ok || !split.adapter) return { kind: "fail" } as const;
    return aiReview(reviewKey!, row.repo, split.manifestJson, split.adapter, reports);
  };
  const reviewedBodies = new Map<string, string>();
  const publishedBody = async (row: Row): Promise<string | null> => {
    const res = await fetch(`https://raw.githubusercontent.com/${repoName}/main/${repoDir(row.repo)}/${row.file_sha256}.json`, {
      redirect: "manual",
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return res.text();
  };
  if (reviewKey) {
    for (const row of reported) {
      if (reviewBudget <= 0) break;
      if (isBlocked(row.repo) || withdrawn.has(row.file_sha256)) continue;
      const body = await publishedBody(row);
      if (body == null) continue;
      reviewedBodies.set(row.file_sha256, body);
      const reports = (
        await all<{ detail: string | null }>(
          `SELECT detail FROM adapter_complaints WHERE file_sha256 = ? AND stage = 'report' AND reviewed = 0 AND id <= ?
           ORDER BY id DESC`,
          row.file_sha256,
          maxComplaint,
        )
      ).flatMap((r) => (r.detail ? [r.detail] : []));
      reviewBudget--;
      const v = await review(row, body, reports);
      if (v.kind === "pass") rereviewed.push(row.file_sha256);
      else if (v.kind === "fail") retire(row, "review");
    }
    for (const row of fresh) {
      const body = bodies.get(row.file_sha256);
      if (!body || row.review !== "rules") continue;
      if (reviewBudget <= 0) {
        deferred.add(row.file_sha256);
        continue;
      }
      reviewBudget--;
      const v = await review(row, body);
      if (v.kind === "pass") reviewedNow.push(row.file_sha256);
      else if (v.kind === "unavailable") deferred.add(row.file_sha256);
      else {
        bodies.delete(row.file_sha256);
        dropped.push(row);
      }
    }
    for (const row of unreviewed) {
      if (reviewBudget <= 0) break;
      if (isBlocked(row.repo) || withdrawn.has(row.file_sha256) || rereviewed.includes(row.file_sha256)) continue;
      const body = await publishedBody(row);
      if (body == null) continue;
      reviewedBodies.set(row.file_sha256, body);
      reviewBudget--;
      const v = await review(row, body);
      if (v.kind === "pass") reviewedNow.push(row.file_sha256);
      else if (v.kind === "fail") retire(row, "review");
    }
  }
  const added = fresh.filter((r) => bodies.has(r.file_sha256) && !deferred.has(r.file_sha256));
  const confirmed = bumped.filter((r) => !isBlocked(r.repo) && !withdrawn.has(r.file_sha256));

  // Each touched repo's index.json, rendered from every published row plus
  // this batch, with the counts this commit makes true.
  const touched = new Set(
    [...added.map((r) => r.repo), ...confirmed.map((r) => r.repo), ...[...withdrawn.values()].map((r) => r.repo), ...recount].filter(
      (repo) => !isBlocked(repo),
    ),
  );
  const emptied: string[] = [];
  const indexes = new Map<string, string>();
  for (const repo of touched) {
    const rows = await all<Row>(`SELECT * FROM repo_adapters WHERE repo = ? AND ${LIVE}`, repo);
    const entries = [
      ...rows
        .filter((r) => !withdrawn.has(r.file_sha256))
        .map((r) => ({ row: r, added: r.published_day!, confirmations: r.confirmations + r.pending_confirmations })),
      ...added.filter((r) => r.repo === repo).map((r) => ({ row: r, added: day, confirmations: r.pending_confirmations })),
    ]
      .map((e) => ({ ...e, complaints: complaintCounts.get(e.row.file_sha256) ?? 0 }))
      .sort(
        (a, b) =>
          Number(a.complaints > a.confirmations) - Number(b.complaints > b.confirmations) ||
          b.added.localeCompare(a.added) ||
          b.confirmations - a.confirmations ||
          a.row.file_sha256.localeCompare(b.row.file_sha256),
      );
    if (entries.length === 0) {
      emptied.push(repo);
      continue;
    }
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
            complaints: e.complaints,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  }

  const listed = (await all<{ repo: string }>("SELECT repo FROM adapter_blocklist WHERE state != 'unlisting' ORDER BY rowid")).map(
    (r) => r.repo,
  );
  const doNotAdapt = listed.map((r) => `${r}\n`).join("");

  // What the weekly insight learns from, once the file is out of the tree.
  const retiredBodies = new Map<string, string>();
  for (const row of withdrawn.values()) {
    const body = reviewedBodies.get(row.file_sha256) ?? (await publishedBody(row));
    if (body != null) retiredBodies.set(row.file_sha256, body);
  }

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
  for (const row of withdrawn.values()) {
    tree.push({ path: `${repoDir(row.repo)}/${row.file_sha256}.json`, mode: "100644", type: "blob", sha: null });
  }
  for (const repo of emptied) {
    if (!removedDirs.has(repoDir(repo))) tree.push({ path: `${repoDir(repo)}/index.json`, mode: "100644", type: "blob", sha: null });
  }
  tree.push({ path: "do-not-adapt.txt", mode: "100644", type: "blob", content: doNotAdapt });
  if (!hasReadme) tree.push({ path: "README.md", mode: "100644", type: "blob", content: README });

  const newTree = (await gh("POST", "/git/trees", { base_tree: headCommit.tree.sha, tree })) as { sha: string };
  // A queue change that alters no file (say, unlisting a repo that was never
  // listed) settles without an empty commit.
  let commitSha = head.object.sha;
  if (newTree.sha !== headCommit.tree.sha) {
    const stamp = { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: `${day}T00:00:00Z` };
    const commit = (await gh("POST", "/git/commits", {
      message: `Adapters for ${day} (${added.length} new, ${confirmed.length} confirmed${withdrawn.size ? `, ${withdrawn.size} withdrawn` : ""})`,
      tree: newTree.sha,
      parents: [head.object.sha],
      author: stamp,
      committer: stamp,
    })) as { sha: string };
    await gh("PATCH", "/git/refs/heads/main", { sha: commit.sha, force: false });
    commitSha = commit.sha;
  }

  // Only now is the batch public; settle the queue to match.
  const gone = [...removed, ...forgotten, ...dropped];
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
    ...gone.map((r) => db.prepare("DELETE FROM repo_adapters WHERE file_sha256 = ?").bind(r.file_sha256)),
    ...gone.map((r) => db.prepare("DELETE FROM adapter_complaints WHERE file_sha256 = ?").bind(r.file_sha256)),
    ...[...withdrawn.values()].map((r) =>
      db
        .prepare("UPDATE repo_adapters SET retired_day = ?, retired_reason = ?, pending_confirmations = 0 WHERE file_sha256 = ?")
        .bind(day, retireReason.get(r.file_sha256)!, r.file_sha256),
    ),
    ...[...reviewedNow, ...rereviewed].map((sha) =>
      db.prepare("UPDATE repo_adapters SET review = 'rules+ai' WHERE file_sha256 = ?").bind(sha),
    ),
    ...rereviewed.map((sha) =>
      db
        .prepare("UPDATE adapter_complaints SET reviewed = 1 WHERE file_sha256 = ? AND stage = 'report' AND id <= ?")
        .bind(sha, maxComplaint),
    ),
    db.prepare("UPDATE adapter_complaints SET counted = 1 WHERE counted = 0 AND id <= ?").bind(maxComplaint),
    pruneStmt(),
    ...listChanges.map((c) =>
      c.state === "unlisting"
        ? db.prepare("DELETE FROM adapter_blocklist WHERE repo = ? AND state = 'unlisting'").bind(c.repo)
        : db.prepare("UPDATE adapter_blocklist SET state = 'published' WHERE repo = ? AND state = 'pending'").bind(c.repo),
    ),
  ];
  await db.batch(stmts);
  const keys = [...added, ...dropped.filter((r) => fresh.includes(r))].flatMap((r) => (r.r2_key ? [r.r2_key] : []));
  keys.push(...forgotten.map((r) => `retired/${r.file_sha256}.json`));
  if (keys.length) await bucket.delete(keys);
  for (const [sha, body] of retiredBodies) {
    await bucket.put(`retired/${sha}.json`, body, { httpMetadata: { contentType: "application/json" } });
  }

  return {
    published: true,
    commit: commitSha,
    added: added.length,
    confirmed: confirmed.length,
    removedRepos: removedDirs.size,
    withdrawn: withdrawn.size,
  };
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
against (\`base\`), its file, the day it was added, how many servers sent the
identical file (\`confirmations\`) and how many installs of it failed to build
or start (\`complaints\`). Adapters that fail more often than they are
confirmed sort last, and are withdrawn once that happens three times. It also
records the repo's license.

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
