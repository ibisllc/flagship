# Manifest reference — `flagship.app.json`

Every Flagship app has a `flagship.app.json` at the root of its git
repo. The LLM emits it; the platform validates it on install. It is
the single source of truth for how the app is deployed, what it
exposes, who can access it, and whether it can be migrated.

This page is a field-by-field reference. For workflow + how-to, see
[the app developer guide](app-developer-guide.md).

## Top-level shape

```json
{
  "schema_version": 1,
  "name": "habits",
  "description": "A small habits tracker.",
  "version": "0.1.0",

  "runtime":  { … },
  "data":     { … },
  "network":  { … },
  "access":   { … },
  "migration":{ … },

  "browser":      { … },   // optional
  "distribution": { … }    // optional
}
```

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Must be `1`. |
| `name` | yes | DNS label (lowercase, 1-63 chars, `[a-z0-9-]`, no leading hyphen). |
| `description` | no | Free text. |
| `version` | yes | Semver. `1.2.3` or `1.2.3-beta.4`. |
| `runtime` | yes | Container image + port + env. |
| `data` | yes | Persistence (Postgres / objects / kv) + scratch path. |
| `network` | yes | Subdomain under `<user>.flagship.services`. |
| `access` | yes | Identity gate + roles + public routes + sister-app allowlist. |
| `migration` | yes | "standard" (biometric only) or "elevated" (biometric + 2FA). |
| `browser` | no | Pod-resident-browser entitlement. |
| `distribution` | no | Update-pack distribution policy. |

## `runtime`

```json
"runtime": {
  "image": "ghcr.io/alice/habits:0.1.0",
  "port": 8080,
  "env": { "LOG_LEVEL": "info" }
}
```

| Field | Required | Notes |
|---|---|---|
| `image` | yes | OCI ref the daemon can pull. |
| `port` | yes | Container's listening port. |
| `env` | no | Plain string→string. **Reserved**: keys starting with `FLAGSHIP_` are managed by the runtime — apps cannot set them. The runtime injects `FLAGSHIP_APP_ID`, `FLAGSHIP_APP_TOKEN`, and any data-store URLs (see `data.stores`). |

## `data`

```json
"data": {
  "path": "/scratch",
  "stores": {
    "postgres": true,
    "objects":  ["uploads", "thumbnails"],
    "kv":       false
  }
}
```

`path` is an *ephemeral* in-container scratch path — survives nothing.
For durable state use `stores`:

| Store | Single instance | Multiple instances |
|---|---|---|
| `postgres` | `FLAGSHIP_PG_URL` | `FLAGSHIP_PG_URL_<INSTANCE>` |
| `objects` (MinIO) | `FLAGSHIP_S3_URL`, `FLAGSHIP_S3_BUCKET`, `FLAGSHIP_S3_KEY`, `FLAGSHIP_S3_SECRET` | `FLAGSHIP_S3_URL_<INSTANCE>`, etc. |
| `kv` (Redis) | `FLAGSHIP_REDIS_URL` | `FLAGSHIP_REDIS_URL_<INSTANCE>` |

Set a flag to `true` for a single default instance; to a string list
for named instances; to `false`/omit if the store is unused. Instance
names are RFC 1035 labels (lowercase, 1-32 chars, `[a-z0-9-]`).

Names are scoped to `<username>_<appname>` so the data layer is
portable: `pg_dump` filtered on the prefix is the migration unit.

## `network`

```json
"network": { "subdomain": "habits" }
```

The app is served at `<subdomain>.<server>.<user>.flagship.services`.
Cross-creator installs get a `-creator` suffix automatically:
`habits-alice.<server>.<user>.flagship.services`.

The user-zone alias `<subdomain>.<user>.flagship.services` is NOT
auto-claimed; an app must explicitly claim it via `/api/url/claim` (with
a phone-issued capability). See [docs/multiplexing.md](multiplexing.md).

## `access`

```json
"access": {
  "enabled": true,
  "default_role": "owner",
  "custom_roles": ["editor", "reader"],
  "public_routes": ["/", "/about"],
  "queryable_by":  ["alice--journal"]
}
```

| Field | Required | Notes |
|---|---|---|
| `enabled` | yes | Must be `true`. Apps cannot opt out of identity injection. |
| `default_role` | yes | One of `owner` / `admin` / `member` / `viewer`. |
| `custom_roles` | no | App-specific role labels. The platform passes them through unchanged in `X-Flagship-Role`. |
| `public_routes` | no | Routes anonymous visitors can hit (`X-Flagship-User: anonymous`). Default empty — every route is membership-gated. |
| `queryable_by` | no | Sister-app allowlist. Listed app ids may call `GET /.flagship/peers/<this-app-id>/installed` and learn whether this app is installed. Apps NOT listed always see `installed: false`. |

## `migration`

```json
"migration": { "verification": "standard" }
```

| Value | Means |
|---|---|
| `standard` | Biometric only on both ends. |
| `elevated` | Biometric + 2FA (TOTP or WebAuthn) on both ends. |

Default to `elevated` for apps holding financial, medical, or password
material.

## `browser` (optional)

```json
"browser": {
  "domains": ["accounts.google.com", "*.amazon.com"],
  "login_required": true
}
```

Apps that drive the pod-resident Chromium declare which web hosts they
may navigate to. The user reviews + approves at install time; the
daemon hard-blocks any navigation outside the set. Apps without a
`browser` block cannot use the browser API at all.

| Domain entry | Matches |
|---|---|
| `example.com` | exactly `example.com` |
| `*.example.com` | any single-label-deep subdomain (matches `accounts.example.com`, NOT `example.com` itself) |

`login_required: true` is a UX hint — the install screen tells the
user "this app needs you to log in to its declared domains." It
doesn't change daemon behavior.

## `distribution` (optional)

```json
"distribution": { "public": true }
```

When `public: true`, any signed puller can fetch update packs from the
canonical-home pod without being on the subscriber list. Useful for
open-source apps that want anyone hosting the app to receive updates.
The puller's identity is still verified (sig auth on every request).
Default `false` (subscriber-list-gated).

## Validation

The daemon runs `parseManifest` (in `@flagship/protocol`) on every
install. Validation errors are surfaced to the user as install
rejections. Common causes:

- `version` not semver
- `runtime.env` containing a `FLAGSHIP_*` key
- `access.default_role` not one of the four built-ins
- `browser.domains` containing a literal single-label host
- `data.stores.<store>` with duplicate instance names

## Minimal example

```json
{
  "schema_version": 1,
  "name": "habits",
  "version": "0.1.0",
  "description": "Daily habit tracker.",
  "runtime": {
    "image": "ghcr.io/alice/habits:0.1.0",
    "port": 8080
  },
  "data": {
    "stores": { "postgres": true }
  },
  "network": { "subdomain": "habits" },
  "access": { "enabled": true, "default_role": "owner" },
  "migration": { "verification": "standard" }
}
```
