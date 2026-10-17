# Release readiness loop

One command tells you how far `main` is from a release candidate, and what
changed since the last time you asked.

## The loop

1. `npm run ready` (needs Chromium for Playwright and a free port 8787, or a
   `wrangler dev` already serving there).
2. Read `gym-results/ready-<timestamp>/report.md`. The table at the end of
   the run is the same summary, with a delta against the previous report.
3. Triage each red into one fix (see "Who fixes what" below).
4. Fix, then land on `main` in small commits.
5. Re-run. Use `--only` for the phases you touched:
   `npm run ready -- --only parity,branches`.

Before calling a build a release candidate, run everything, on a Mac with the
simulators and the gym environment:

```sh
npm run ready -- --native --live
```

Flags: `--only a,b`, `--skip a,b`, `--native` (gym on iOS and Android too),
`--live` (add the live gym), `--no-fetch` (skip `git fetch origin`). The run
exits 1 when any phase is red; amber is a warning.

## Phases

| Phase | What it runs | Red means |
|---|---|---|
| `branches` | For every feature branch in AGENTS.md, ahead/behind its parent and `git merge-tree` conflicts. Amber when a branch is only behind. | The branch no longer merges cleanly; it will rot further with each `main` commit. |
| `tsc` | `npx tsc -b` | The tree doesn't typecheck. |
| `vitest` | `npx vitest run` (counts in `vitest.json`) | A unit test fails. |
| `e2e` | The webapp's Playwright flows against pod-sim and a local `wrangler dev` (as `.github/workflows/e2e.yml` does) | A browser flow broke. |
| `gym` | `npm run gym:locked -- --surface web` (`web,ios,android` with `--native`) | A mock-only gym scenario fails on that surface. |
| `parity` | `npm run parity -- --json` (`parity.md` in the report folder has the detail) | The apps disagree on a mirror, or a feature anchor in `parity/features.json` stopped matching. |
| `ios-release` | Only with `--native`: `node scripts/ios-release-clean.mjs --build` (a Release build for a generic iOS device, scanned for mocks, gym seams and developer mode), under the native-build lock | A Release binary or source carries a gym or mock symbol, or the Release build fails (also what breaks the watch and 32-bit targets). |
| `live` | `scripts/gym-refresh.sh`, then `npm run gym:live` (only with `--live`; "not available" until those exist) | A real-backend scenario fails. |

## Who fixes what

- **Branch conflicts:** whoever owns that feature branch rebases it on its
  parent (`feat/custom-*` go on `feat/marketplace`). `alpine` is parked: note
  its conflicts, fix them only when reviving it.
- **tsc / vitest / e2e:** the author of the commit that broke it; `git log`
  on the failing file usually names it.
- **gym:** a scenario failing on one surface is a client bug on that surface;
  failing everywhere is usually the server or the scenario.
- **parity, derived checks** (link paths, push categories, in-app links,
  signed tags, BFF fields, test vectors): fix the client that's behind, or,
  when the difference is on purpose, add an entry to `parity/allowlist.json`
  with the reason. Stale allowlist entries are listed; delete them.
- **parity, feature anchors:** a broken anchor means the code moved or the
  feature regressed. Re-point the anchor, or change the surface's status, in
  the same commit. A "missing" surface whose anchors now match is a warning:
  check it and mark it present.
- `npm run parity -- --since <ref>` lists commits since `<ref>` that touched
  only one client tree: ask of each whether the other apps need the same
  change.

`parity/features.json` is the feature matrix (`npm run parity -- --report`
prints it). Keep it current: when a feature lands on a surface, flip its
status and give it an anchor in the same commit.
