/**
 * The public community-adapter directory (SECURITY-HARDENING-PLAN.md 18.12): one searchable file,
 * `directory.json`, published to the same public repo as the adapters. Per project: where it lives, its
 * license, each adapter's digest and the upstream commit it was made against, how the project can adopt
 * the adapter as its own, and an honest status. It carries no install counts, no private repo details
 * and nothing about who submitted or who installed: the adapters are anonymous by design.
 *
 * Status is what the record shows, never a safety claim: "published" is only "an adapter that has not
 * been withdrawn or complained about more than confirmed", "disputed" means complaints outnumber
 * confirmations (boxes rank it last), and a repo that opted out is not listed at all.
 */

export interface DirectoryRow {
  repo: string;
  license: string;
  base: string;
  file_sha256: string;
  added: string;
  confirmations: number;
  complaints: number;
}

export interface DirectoryAdapter {
  digest: string;
  base: string;
  added: string;
  status: "published" | "disputed";
}

export interface DirectoryProject {
  repo: string;
  host: string;
  license: string;
  /** The project's own way to make an adapter unnecessary: commit a flagship.app.json. */
  adopt: string;
  adapters: DirectoryAdapter[];
}

export const DIRECTORY_ADOPT_NOTE =
  "The maintainers can commit their own flagship.app.json: a repo's own file always wins and its adapter is no longer used.";

export function renderDirectory(rows: DirectoryRow[], blocked: ReadonlySet<string>, generatedDay: string): string {
  const byRepo = new Map<string, DirectoryRow[]>();
  for (const r of rows) {
    if (blocked.has(r.repo)) continue;
    const list = byRepo.get(r.repo) ?? [];
    list.push(r);
    byRepo.set(r.repo, list);
  }
  const projects: DirectoryProject[] = [...byRepo.entries()]
    .map(([repo, list]) => ({
      repo,
      host: new URL(repo).hostname,
      license: list[0]!.license,
      adopt: DIRECTORY_ADOPT_NOTE,
      adapters: list
        .map((r) => ({
          digest: r.file_sha256,
          base: r.base,
          added: r.added,
          status: (r.complaints > r.confirmations ? "disputed" : "published") as DirectoryAdapter["status"],
        }))
        .sort((a, b) => Number(a.status === "disputed") - Number(b.status === "disputed") || b.added.localeCompare(a.added) || a.digest.localeCompare(b.digest)),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
  return JSON.stringify({ version: 1, generated: generatedDay, projects }, null, 2) + "\n";
}
