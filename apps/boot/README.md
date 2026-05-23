# `@flagship/boot` — the dedicated boot worker (boot.flagshipserver.com)

A separately-deployable Cloudflare Worker that owns Flagship's **boot
operations** — the auto-unlock lease release and the phone-gated approval
relay — split out of the identity plane so an **enterprise can clone it
and point it at its own infra**.

The identity plane (`flagshipserver.com` / `apps/com`) keeps identity and
state: push tokens, APNs/FCM/VAPID keys, the canonical id-cert directory,
and the phone-sealed LUKS key set at install. This worker keeps **only
ciphertext** (sealed leases + sealed relay responses) plus a single-use
nonce store. It never sees a plaintext disk key.

## The two boot-unlock models

1. **auto** — the LUKS disk key is stored here **sealed for the box's own
   STK**. On reboot the box fetches the sealed blob and unseals it
   itself. The worker can withhold (DoS) but never read or retarget.
2. **approve** — every boot the box announces it needs approval; the
   worker fires the **notify pipe** to wake the owner's phone, which
   posts back a sealed response the box polls for and unseals.

First-boot (auto): box `GET` lease → 404 → `POST` request (notify) →
poll `GET` response → unseal; the woken phone then deposits the lease
(`PUT`) for next time. Approve: the request → notify → response handshake
runs every boot (the box never gets a lease).

## The identity-based gate

Every request is authorized by **who signed it**, not by the verb. The
signature travels in the `Authorization` header (never the URL/query),
verified against the canonical id-cert source (the identity plane's
directory), and bound to the exact resource it touches:

- **box-STK** signatures may **read** (fetch own lease, poll for a
  response, announce a request);
- **owner-IRK** signatures may **write** (deposit a lease, revoke a
  lease, post a sealed response).

Five rules on every route: reject-if-malformed → verify Ed25519 sig →
freshness (±5 min) + single-use nonce → **authz binding** (the box STK
must equal the directory STK for that `serverDomain`; the owner IRK must
equal the account IRK that owns it — so a box can only touch its own
lease, never another account's) → `Cache-Control: no-store`.

### `Authorization` header format

```
Authorization: Flagship-Boot-v1 <base64url(JSON GateEnvelope)>
```

The JSON envelope (`GateEnvelope` in `src/gate.ts`):

```jsonc
{
  "role": "box" | "owner",
  "serverDomain": "kitchen.john.flagship.services",
  "method": "GET",                 // uppercased; bound to the route
  "path": "/api/boot/lease/kitchen.john.flagship.services",
  "pubKeyHex": "<32-byte Ed25519 pubkey hex>",  // the signer (STK or IRK)
  "nonceHex":  "<32-byte nonce hex>",            // single-use per window
  "issuedAt":  1716000000000,                    // ms; ±5 min window
  "signatureHex": "<64-byte Ed25519 sig hex>"    // over the canonical bytes
}
```

The signature covers the canonical bytes
`flagship/boot-auth/v1|role|serverDomain|METHOD|path|pubKeyHex|nonceHex|issuedAt`
(everything except the signature). Use `signBootRequest()` /
`encodeAuthHeader()` from `src/gate.ts` to build it.

## Endpoints

| Method   | Path                                          | Principal | Purpose |
|----------|-----------------------------------------------|-----------|---------|
| `PUT`    | `/api/boot/lease`                             | owner-IRK | deposit a box-sealed lease (body `{ lease, signature }`) |
| `GET`    | `/api/boot/lease/:serverDomain`               | box-STK   | fetch the sealed lease ciphertext (200 `{sealedKey,leaseId,…}` or 404) |
| `DELETE` | `/api/boot/lease/:serverDomain/:leaseId`      | owner-IRK | revoke (kill switch) |
| `POST`   | `/api/boot/request`                           | box-STK   | announce need → fire the notify pipe (deduped per nonce; idempotent) |
| `GET`    | `/api/boot/response/:serverDomain/:nonce`     | box-STK   | poll for the phone's sealed response (200 `{sealed}` or 404) |
| `POST`   | `/api/boot/response`                          | owner-IRK | post the sealed response |
| `GET`    | `/api/health`                                 | public    | liveness |

## The notify pipe

The boot worker holds **no push secrets**. On a box request it makes an
authenticated server-to-server call:

```
POST {IDENTITY_PLANE_URL}/api/internal/notify-owner
x-boot-notify-secret: <NOTIFY_SHARED_SECRET>
{ "serverDomain", "signedRequest", "purpose" }
```

`signedRequest` is the box's STK-signed `SecretRequest` verbatim. The
identity plane **re-verifies it against its own directory** (it does not
trust the worker's echo), resolves the owning account, looks up its push
tokens, and sends the RFC-8291 encrypted Web Push. This indirection is
exactly what keeps the boot worker free of push credentials → cloneable.

## Clone + deploy (for an enterprise)

```sh
# 1. Create your own D1 and apply the schema.
wrangler d1 create flagship-boot
#   → paste the database_id into wrangler.toml [[d1_databases]]
wrangler d1 execute flagship-boot --file=migrations/0001_boot_tables.sql --remote

# 2. Point at YOUR identity plane + apex (wrangler.toml [vars]).
#    IDENTITY_PLANE_URL = "https://id.your-co.example"
#    FLAGSHIP_APEX      = "boxes.your-co.example"

# 3. Set the shared secret (matches your identity plane's BOOT_NOTIFY_SECRET).
openssl rand -hex 32 | wrangler secret put NOTIFY_SHARED_SECRET

# 4. Deploy and route boot.<your-domain> at this worker.
wrangler deploy
```

On the identity plane, set the matching `BOOT_NOTIFY_SECRET` and ensure
`/api/internal/notify-owner` is reachable (it ships in `apps/com`).

## Layout

```
src/gate.ts        identity gate (parse + verify Authorization, bind to directory)
src/directory.ts   canonical id-cert reads from the identity plane (cloneable)
src/notify.ts      the notify pipe (server-to-server → identity plane)
src/nonceStore.ts  single-use nonce store (D1 + in-memory)
src/routes.ts      the 6 boot endpoints
src/index.ts       Worker entry
migrations/        the D1 schema this worker needs
```

## Tests

```sh
npx vitest run apps/boot/test
```

Covers the gate (valid box STK accepted, foreign key rejected; owner IRK
accepted on writes, box rejected on writes, phone rejected on box reads;
cross-account binding rejected; stale timestamp + replayed nonce
rejected), notify dedup per nonce, lease deposit→get→revoke round-trip,
and response post→poll round-trip. The directory + notify calls are
mocked — no network.
