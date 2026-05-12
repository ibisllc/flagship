# @maintainers/web-ui

The public-facing browser UI for the maintainers protocol.

A single, framework-free TypeScript module that knows how to:

- onboard a new project (Yubikey enrollment → genesis mandate),
- show a health dashboard for an existing project,
- renew a mandate before expiry,
- accept a takeover after expiry,
- read and write `.maintainers/` folders through a pluggable adapter.

No React, no Vue, no Svelte — just DOM. The whole module is ~2,300 lines
of TypeScript including the wizard, the dashboards, a tiny CBOR decoder,
a STORE-only ZIP writer, and the WebAuthn-PRF glue. Zero runtime
dependencies beyond `@maintainers/protocol`.

## Quick start

```ts
import { mountApp, staticAdapter } from "@maintainers/web-ui";

mountApp(document.body, {
  adapter: staticAdapter(),       // Model B: pure-static page
  rpId: location.hostname,        // WebAuthn relying-party id
  rpName: "Your maintainers UI",
});
```

That's it. The UI handles its own routing (hash-based), styles
(injected on mount), and adapter selection.

## Two deployment models

The protocol spec, §6, defines a `StorageAdapter` interface; this
package lifts that into the UI as `AdapterClient`. The UI never knows
which model it's running under.

### Model A — server-side push

A small backend holds a Personal Access Token (or GitHub App
installation) for the repo and accepts envelopes from the UI via
HTTPS. The server-side adapter validates each envelope against the
protocol verifier before committing.

```ts
import { mountApp, serverAdapter } from "@maintainers/web-ui";

mountApp(document.body, {
  adapter: serverAdapter({
    baseUrl: "/api/maintainers",      // your endpoint
    bearer: getSessionToken(),        // your auth
  }),
});
```

The server adapter is implemented separately (task #64 in the
maintainers plan); this package only ships the client-side stub +
contract.

### Model B — purely static page

The page reads `.maintainers/` directly from the repo's raw-content
endpoint and writes by either:
- using a GitHub OAuth device-flow token the user logged in with
  (`staticAdapter({ oauthToken })`), or
- bundling the new envelopes into a downloadable ZIP for the user to
  `git add` and commit themselves.

```ts
import { mountApp, staticAdapter } from "@maintainers/web-ui";

mountApp(document.body, {
  adapter: staticAdapter({
    oauthToken: tokenFromOauthFlow,  // optional; omit to fall back to ZIP
  }),
});
```

The same page can host both flows if you check for an OAuth token at
runtime and pass it through; the UI is unaware either way.

## WebAuthn model — why PRF?

The protocol's verifier accepts only Ed25519 signatures, and only over
its canonical-bytes form. WebAuthn authenticators, however, sign over
`authenticatorData || sha256(clientDataJSON)` — not over our canonical
bytes. Verifying that shape would require teaching the protocol library
a second message format, which we don't want.

The clean way out: the WebAuthn PRF extension. PRF returns a
deterministic 32-byte secret bound to the credential, surfaced only on
user-verified assertions. We use that secret as the Ed25519 seed; the
keypair lives only in page memory for the duration of the signing
operation; canonical bytes are signed by `@maintainers/protocol`'s
ordinary `sign()`. The Yubikey serves as a tamper-resistant
key-derivation oracle.

Hard requirement: a FIDO2 authenticator that supports the PRF
extension. Recent YubiKey 5 firmware, NitroKey 3, Solo 2, and most
recent Apple/Microsoft platform authenticators do.

## Supported repo providers

The static adapter knows about:

| Host          | Read | Write (via OAuth) |
|---------------|------|-------------------|
| github.com    | yes  | yes               |
| codeberg.org  | yes  | manual / ZIP only |
| gitlab.com    | yes  | manual / ZIP only |
| `*.forgejo.org` | yes | manual / ZIP only |

To support a custom provider, define a `RepoProvider` and pass it via
`staticAdapter({ providers: [yours, ...BUILTIN_PROVIDERS] })`.

## Internal layout

```
src/
├── index.ts            barrel
├── app.ts              mountApp + hash routing
├── state.ts            AppState + StateStore
├── dom.ts              el(), mount(), short-helpers
├── styles.ts           one big CSS string + injector
├── adapter.ts          AdapterClient + staticAdapter + serverAdapter
├── parse-folder.ts     bytes → ParsedFolder
├── envelopes.ts        wrappers around @maintainers/protocol's sign* + path helpers
├── repo-provider.ts    parseRepoUrl + BUILTIN_PROVIDERS + raw URL builders
├── webauthn.ts         enrollMaintainerIdentity + assertAndDerive (PRF-based)
├── cbor.ts             minimal CBOR decoder for attestationObject / COSE_Key
├── zip.ts              STORE-only ZIP writer
└── views/
    ├── home.ts
    ├── onboard.ts      7-step wizard
    ├── project.ts      health / roster / activity tabs
    ├── renew.ts
    └── takeover.ts
```

## Testing

```sh
cd maintainers
npx vitest run packages/web-ui/tests/
```

Tests cover the deterministic logic — CBOR decode, repo-URL parse, ZIP
build, envelope assembly through the real protocol verifier, adapter
fetch contracts — but skip DOM rendering. The wizard, renew, takeover,
and project views are exercised manually in a browser; future work
should add Playwright coverage.

## Status

- 50 unit tests, all green.
- `npx tsc -b` clean.
- WebAuthn integration tested manually with a YubiKey 5C; PRF derivation
  works on Chrome 125+ and Safari TP 18.
- The renew/takeover views currently expect the user to paste their
  credential id; a forthcoming change will discover it automatically
  via passkey discovery.

## License

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0. Same terms as the rest
of the maintainers tree.
