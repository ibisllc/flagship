# Publishing and mirroring

Nothing here is on npm or in its own GitHub repository yet. Both need the
owner's approval; this is the checklist for when they are given.

## Layout

`billing/` is self-contained: its own `package.json` (an npm workspace root
over `packages/*`), `package-lock.json`, `tsconfig.base.json`, vitest config,
LICENSE and docs. No file in it refers to anything outside it, and its CI
(`.github/workflows/billing.yml` in the host repository) proves that by
copying `billing/` to an empty directory before installing, building and
testing it.

## 1. Mirror to github.com/ibisllc/billing

1. Create the empty repository `ibisllc/billing` (public, no README).
2. Create an SSH deploy key with write access on it; store the private half
   as the secret `BILLING_MIRROR_DEPLOY_KEY` in the host repository.
3. In the host repository's `.github/workflows/billing-mirror.yml`, remove
   the `if: false` guard. Each push to `main` that touches `billing/**` then
   runs `git subtree split --prefix=billing` and pushes the result to
   `ibisllc/billing` `main`, so the mirror's history holds only billing
   commits and its root is this folder.
4. In the mirror, copy `.github/workflows/billing.yml`'s job into
   `.github/workflows/ci.yml` with the `working-directory` and the
   copy-to-a-temp-dir step removed. (Or keep CI in the host only.)

The mirror is downstream: changes land here and flow out. If outside
contributions are accepted on the mirror, apply them here (`git am` the
patch under `billing/`) rather than merging the mirror back.

## 2. Publish to npm

1. Make sure the `@ibisllc` npm organisation exists and the publisher is a
   member with 2FA.
2. From a clean checkout of `billing/`:

   ```sh
   npm ci
   npm run build
   npm test
   npm run pack:check          # lists exactly what each tarball will contain
   npm publish --workspaces --access public
   ```

   Packages are published together at one version; bump all four
   `package.json` versions (and the `^` ranges between them if the minor
   changes) and move the CHANGELOG's Unreleased section under the new
   version first. Tag the commit `billing-v<version>`.
3. Optional: publish from CI with `npm publish --provenance` (needs an
   `NPM_TOKEN` secret and `id-token: write`), so each tarball links to the
   commit and workflow that built it.

## 3. After the first publish

The host project can switch from workspaces to the registry like it did for
`@ibisllc/maintainers`: pin exact versions in the consuming packages, drop
`billing/packages/*` from the root workspaces, and keep `billing/` only as
the development home (or remove it once the mirror is canonical).
