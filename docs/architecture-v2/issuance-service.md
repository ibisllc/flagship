# The certificate issuance service on `.com` (plan H1, H9, H7)

Status: built on `release/0.3` (2026-11-01), not deployed. Records: `issuance-and-lease-records.md`
(`flagship/certificate-order/v1`, `packages/protocol/src/servingAuthority.ts`). Requirements: journal Appendix H
"Issuance boundary" and Appendix I sections 2, 5, 6 and 10.

`.com` owns the one ACME account every Flagship certificate under the services apex is ordered with. A device (a box
or an admin phone) makes its own key and a PKCS#10 request, signs a `certificate-order/v1` with its identity key, and
polls until the chain is ready. `.com` decides the names from its own records, checks the request asks for exactly
those, publishes only the DNS-01 records of the order it created, finalizes with that request and checks the chain
before handing it out. No private key ever leaves the device; no device can write a DNS record.

## 1. Classes and names

`<apex>` is the services apex (`flagship.services`; the gym `gym.flagship.services`).

| Class | Who orders | Names (exactly) | Needs |
|---|---|---|---|
| `control` | a box | `<server>.<user>.<apex>` | a registered, unrevoked box at the current registration generation. Allowed after the app lease lapsed (recovery). |
| `apps` | a box | `*.<server>.<user>.<apex>`, plus `*.<user>.<apex>` when the request carries the admin's `server-wildcard-grant/v1` for this box | as control, AND `servingDecision(...).apps === true` now, re-checked before the challenges are answered and before finalizing |
| `phone` | an admin phone | `<user>.<apex>` | the device key belongs to a live admin device of the account (an admin-root-signed `admin` grant); the account pins an admin root |

The bare `<user>.<apex>` is never issued to a box: a box's request is refused if its CSR names it, alone or with
other names (`issuance-csr-names`), whatever grant it carries. Any extra, missing or IP name is refused the same way.
The CSR's own subject CN, if any, must be one of the names.

## 2. Routes

All JSON, `no-store`. Errors are `{ "error": "<sentence>", "code": "<code>" }` (plus the fields named below).

### `POST /api/certificates/orders`

```json
{
  "account": "harry",
  "server": "home.harry.flagship.services",
  "order": {
    "class": "control",
    "device": "<64 hex: the box's identity key, or the phone's account device key>",
    "regGen": 1,
    "csrSha256": "<64 hex: SHA-256 of the DER CSR>",
    "requestId": "<32 hex, random per request>",
    "issuedAt": 1761955200000
  },
  "signature": "<128 hex: Ed25519 by `device` over canonicalCertificateOrder(order)>",
  "csr": "<base64url DER PKCS#10>",
  "serverWildcardGrant": { "issuedAt": 1761000000000, "signature": "<128 hex>" }
}
```

- `server` is required for `control` and `apps` (the box's registered name) and absent for `phone`.
- `regGen` is the box's registration generation (the heartbeat reply's `serving.regGen`; 1 for a box that never
  re-registered). A phone sends 0.
- `serverWildcardGrant` (apps only, optional) is the grant the box already holds (`serverWildcardGrant.ts`). It must
  verify under the account's admin root (else IRK) for this server and this box key; an invalid one is refused, not
  ignored.
- `issuedAt` within 5 minutes of `.com`'s clock. A repeated `requestId` from the same device returns the existing
  order (safe to retry a lost answer); a different body under a used `requestId` is refused.
- CSR keys: ECDSA P-256 or P-384, or RSA of 2048 to 4096 bits. Signature checked.

Answer `202`:

```json
{ "orderId": "<32 hex>", "status": "pending", "class": "control", "names": ["home.harry.flagship.services"], "pollAfterMs": 5000 }
```

### `GET /api/certificates/orders/:orderId`

Each poll advances the order one step (create the ACME order, publish its DNS-01 records, answer the challenges,
finalize, download, check). The order id is the only key: the chain is public (CT logs) and nothing else is returned.

```json
{ "orderId": "...", "status": "pending", "step": "validating", "names": [...], "pollAfterMs": 5000 }
{ "orderId": "...", "status": "issued", "names": [...], "chainPem": "-----BEGIN CERTIFICATE-----...", "notBefore": 1761955200000, "notAfter": 1769731200000 }
{ "orderId": "...", "status": "failed", "names": [...], "code": "issuance-acme-failed", "error": "<sentence>" }
```

Poll every `pollAfterMs` (5 s). An order not finished within 15 minutes fails (`issuance-timeout`); its DNS records
are removed and its pending ACME authorizations deactivated. Polling an issued order keeps answering its chain.

### `GET /api/certificates/status?account=<u>&device=<hex>` is not provided

A device keeps its own certificate and asks for a new one only when it is due (section 3). Nothing lists another
device's orders.

## 3. When a device may order (H7)

- **Due.** A device may order a class only when the newest certificate the service delivered to it for that class
  and name set has less than a third of its lifetime left (Let's Encrypt's 90-day certificates: from day 60). Earlier
  orders are refused `429 issuance-not-due` with `dueAt` (epoch ms). The first order of a class through this service,
  a changed name set (a box that got its account wildcard grant), and one new key per class per 30 days (a box whose
  key store was reset) are let through.
- **Reuse.** A phone keeps its certificate across route hand-overs and relay reconnects; a box keeps its two across
  restarts. Never order per connection.
- **Limits the service enforces before Let's Encrypt would** (`429 issuance-rate-limited` with `retryAfterMs`):
  4 certificates per exact name set per 7 days (LE: 5), 40 per account zone `<user>.<apex>` per 7 days (LE: 50 per
  registered domain; the apex is a public suffix), 250 new orders per 3 hours for the service (LE: 300 per account),
  20 orders per Flagship account per day, 3 failed validations per name set per hour (LE: 5). A `rateLimited` answer
  from the CA stops every order for the time it names (its `Retry-After`, at least 1 hour).
- **Back-off on the device.** On 429 wait `retryAfterMs` (or until `dueAt`); on 5xx or a failed order back off
  exponentially from 15 minutes to 6 hours with jitter. Keep serving the certificate you have meanwhile.

## 4. Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `issuance-malformed` | the body, the order record or the CSR could not be read |
| 403 | `issuance-clock` | `issuedAt` more than 5 minutes off |
| 403 | `issuance-signature` | the order's signature does not verify under `device` |
| 403 | `issuance-unknown-device` | `device` is not this account's box at `server` / not one of its devices |
| 403 | `issuance-revoked` | the box (or device) was revoked |
| 409 | `issuance-reg-gen` | `regGen` is not the box's current registration generation |
| 403 | `issuance-not-admin` | phone class: the device is not an admin device, or the account pins no admin root |
| 403 | `issuance-no-serving` | apps class: no live serving permission (`servingDecision` refuses apps; its reason is in `reason`) |
| 403 | `issuance-wildcard-grant` | the `serverWildcardGrant` does not verify for this server and key |
| 403 | `issuance-csr-signature` | the CSR's own signature does not verify, or `csrSha256` is not its digest |
| 403 | `issuance-csr-key` | an unsupported CSR key |
| 403 | `issuance-csr-names` | the CSR's names are not exactly the class's names (bare user name for a box, extra, missing or IP names) |
| 409 | `issuance-request-reused` | a used `requestId` with a different order |
| 429 | `issuance-not-due` | too early; `dueAt` says when |
| 429 | `issuance-rate-limited` | a CA limit would be hit; `retryAfterMs` |
| 503 | `issuance-not-configured` | the service has no ACME account key or DNS writer |
| order `failed` | `issuance-acme-failed`, `issuance-timeout`, `issuance-revoked-during-order`, `issuance-no-serving`, `issuance-chain-mismatch` | the order ended without a certificate; a certificate issued after a revocation won the race is revoked at the CA and not delivered |

## 5. What the service checks on the chain

The leaf's SANs equal the order's names exactly, its public key equals the CSR's, it is in date, and every
certificate in the chain is signed by the next one (ECDSA P-256/P-384 or RSA, through WebCrypto). Anything else is
`issuance-chain-mismatch`, and the certificate is revoked at the CA.

## 6. Configuration (owner)

- Worker secret `ISSUANCE_ACME_ACCOUNT_KEY`: the service's ACME account key, a PKCS#8 PEM ECDSA P-256 key
  (`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`). Separate keys for the gym and production.
- Var `ISSUANCE_ACME_DIRECTORY` (default Let's Encrypt production); `ISSUANCE_ACME_CONTACT` (optional mailto).
- DNS: the existing `CLOUDFLARE_DNS_API_TOKEN` + `CLOUDFLARE_SERVICES_ZONE_ID`. The service does not run through the
  dns-broker Worker.
- `GET /api/certificates/account` answers `{ directory, accountUri }` once the account exists: the value for the apex
  CAA `accounturi=` (docs/runbooks/final-deploy.md, "Certificate issuance").

### `POST /api/certificates/admin/revoke` (header `x-admin-secret`)

`{ "certificatePem": "...", "reason": 1 }`: revoke a certificate another ACME account holds for names under the apex
(residual authority from before this service). The service authorizes the leaf's names itself and revokes
(RFC 8555 §7.6). Used by `scripts/issuance-inventory.mjs --revoke`.

### Revocation of a removed device's certificates

When a box is revoked, deleted or re-registered with another key or generation (or a phone's device is removed),
the service revokes at the CA every unexpired certificate it delivered to it (a sweep that runs with later orders;
reason 5). The relay's revocation already ended its routes; this ends its Web PKI authority too. The box's own
`revokeCurrentCert` is gone: the box holds no ACME account.

## 7. Retired

`POST /api/dns-01/publish` and `/api/dns-01/delete` answer `410 dns01-retired`: no device writes a challenge record any
more. Boxes no longer hold ACME account keys for the services apex. Migration of what earlier boxes hold:
`docs/runbooks/issuance-migration.md`.

## 8. The box side and what is open

- Box: `packages/server-daemon/src/acme/serviceIssuer.ts` (key + CSR locally, or in flagship-keyd via `tls.createKey` +
  `tls.csr`; signs the order with the custodian; polls) and `acme/boxCertificates.ts` (two certificates, renewal in the
  last third plus up to 3 days of jitter, back-off, reuse across restarts). Classic stack: `CertManager` serves the
  control certificate for exactly the box's name and the app certificate for every other name.
- **Open (arch-v2):** keyd and the Rust ingress serve ONE active certificate. The box activates its app certificate when
  it also covers its own name (`*.<user>`, with the admin's grant), else its control certificate (its own name always
  answers; app names then fail TLS until the ingress picks a keyd key per SNI).
- **Open (relay):** `AppUserAllocator.reserveControlNames` takes the registered control names from `.com`; connected
  boxes' own names are reserved already. Feeding the list belongs to the relay work (H3).
- **Phone (H2):** sign `certificate-order/v1` with the phone's account device key (`device`), `regGen` 0, no `server`;
  CSR for exactly `<user>.<apex>`; keep the certificate until its last third (never per hand-over or reconnect).
