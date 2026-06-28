# `preseed-engine.js` — GENERATED, do not hand-edit

This is the canonical preseed / user-data generator (`src/preseedEngine.ts` +
its deps) bundled to one self-contained, **pure-ECMAScript** file (no Node, no
`require`, no `Buffer`). It is the *single implementation* of this
security-critical, signed-bootstrap path, run unchanged on every burner:

- **Node** (Linux/Windows CLI) — imports the TS directly.
- **JavaScriptCore** (macOS/iOS burner) — evaluates this bundle, calls
  `FlagshipPreseed.buildPreseedFromRecipe(recipeJson, burnOptsJson)`.
- **Rhino** (Android burner) — same, in interpreted mode.

The native burners ship a COPY of this file (iOS resource / Android asset). It
must stay in sync with source.

## Regenerate

```sh
cd packages/flagship-burner && npm run bundle:engine
```

`bundle:engine` is esbuild → **Babel (es5)**. The Babel pass (`engine.babel.json`,
preset-env `ie 11`) is REQUIRED: Rhino (the Android engine, 1.8.x–1.9.x) miscompiles
block-scoped vars inside `for`-loops — it reads the loop var as its initial value —
which corrupts the base64 encoder; older `rhino-runtime` can't even parse ES2015
default params. Lowering to es5 removes both. es5 runs identically on Node + JSC, so
the CLI + iOS/macOS are unaffected. After regenerating, copy the bundle to the native
burners' shipped copies (the per-platform drift-guard tests enforce they match):
`apps/burner-mac/Sources/FlagshipBurnerCore/Resources/preseed-engine.js` and
`apps/mobile/android/app/src/main/assets/preseed-engine.js`.

## Drift / freshness gate

`tests/preseedEngine.test.ts` evaluates THIS committed file in a bare,
Node-free `vm` context and asserts its output is byte-identical to the
in-process generator across a recipe matrix. A stale bundle fails that test.
The per-platform engine tests (Swift `swift test`, Android `:app:testDebugUnitTest`)
assert the SAME outputs against shared golden vectors, so JSC + Rhino + Node can
never diverge.

API (attached to the global scope by the bundle):

```
FlagshipPreseed.buildPreseedFromRecipe(recipeJson: string, burnOptsJson?: string): string
FlagshipPreseed.buildUserDataFromRecipe(recipeJson: string, burnOptsJson?: string): string
```

`recipeJson` = the signed recipe (the burner has already verified the phone's
signature natively — the engine does NOT re-verify). `burnOptsJson` =
`{encryptRoot?, wifiSSID?, wifiPassword?, installerGitRef?, flagshipRepoUrl?, bootHost?}`.
