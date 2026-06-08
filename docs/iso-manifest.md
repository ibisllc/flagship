# ISO-manifest endpoint

The desktop burner calls this on every launch to learn whether — and from
where — to fetch its Debian base ISO. **The server decides everything; the
burner is a dumb executor.** No update logic, version comparison, or "should I
upgrade?" heuristic lives in the burner: it sends what it currently holds and
does exactly what the response tells it.

## Wire contract (locked)

`POST /api/iso-manifest` — unauthenticated, rate-limited.

### Request

```json
{
  "platform": "mac" | "linux" | "windows",
  "burnerVersion": "<semver string>",
  "current": { "version": "<string>", "sha256": "<hex64>" } | null
}
```

- `platform` MUST be one of `mac`, `linux`, `windows`.
- `burnerVersion` MUST be a non-empty string.
- `current` is `null` when the burner holds no base ISO yet, otherwise the
  `{version, sha256}` of what it has. `sha256` MUST match `/^[0-9a-f]{64}$/i`.

Malformed input ⇒ `400`.

### Response

Exactly one of:

```json
{ "download": { "url": "<https url>", "sha256": "<hex64>", "version": "<string>", "sizeBytes": <int>, "attestation": "<https url>" } }
```

...or, nothing to do:

```json
{ "download": null }
```

There are **no** `action` / `keep` / `urgent` fields on the wire. The only
signal is the presence or absence of a `download` block.

## Server logic (MVP)

The server holds a single **blessed** Debian manifest in config:

1. No blessed manifest configured ⇒ `{ "download": null }`.
2. `request.current` is non-null AND `request.current.sha256` ===
   `blessed.sha256` (case-insensitive) ⇒ `{ "download": null }` (the burner
   already has the right ISO).
3. Otherwise ⇒ `{ "download": <blessed manifest> }`.

The **"hold an old release / fast-track a new one"** lever is purely whether
the config is changed server-side. There is no per-request policy beyond the
three branches above.

## Configuration

The blessed manifest comes from a single Worker env var:

```
FLAGSHIP_ISO_MANIFEST
```

It is a JSON string of the manifest shape:

```json
{
  "version": "debian-12.7.0-amd64",
  "url": "https://<r2-host>/iso/debian-12.7.0-amd64-netinst.iso",
  "sha256": "<the value from Debian's signed SHA256SUMS>",
  "sizeBytes": 658505728,
  "attestation": "https://cdimage.debian.org/debian-cd/12.7.0/amd64/iso-cd/SHA256SUMS"
}
```

Set it with `wrangler secret put FLAGSHIP_ISO_MANIFEST` (or a `[vars]` entry
once the values are public). If the env var is **unset, unparseable, or fails
shape validation**, the server treats it as **unconfigured** — it never throws,
and the endpoint answers `{ "download": null }` so a config typo can never fail
the burner's launch.

## Verifiability — the attestation rule

The manifest's `sha256` **MUST be pinned to the value in Debian's official
signed `SHA256SUMS`** (the file the `attestation` URL points at). This is the
cryptographic root: the burner downloads the ISO from `url`, then verifies it
against `sha256`, which a human (or CI) has cross-checked against the
GPG-signed `SHA256SUMS`. We are only a pointer — we are never trusted to vouch
for ISO bytes. Do **not** publish a manifest whose `sha256` is anything other
than the official signed digest.

## Architecture

- Pure handler: `packages/control-plane/src/isoManifest.ts`
  (`handleIsoManifest(deps, body)`, `IsoManifest` interface). Runtime-agnostic;
  no I/O.
- Worker wiring: `apps/com/src/controlPlaneRoutes.ts` parses
  `FLAGSHIP_ISO_MANIFEST` into `deps.blessedManifest` (null on any failure) and
  dispatches `POST /api/iso-manifest`.
- Rate limit: the `iso-manifest` bucket in `apps/com/src/rateLimit.ts`
  (per-IP, 30/min) — applied at the edge in `apps/com/src/route.ts`.
