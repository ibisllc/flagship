# Vendored @noble/hashes (Argon2id + Blake2b)

The recovery sub-origin's strict CSP (`script-src 'self'`) forbids
loading external scripts or CDN bundles. We vendor the minimal slice
of `@noble/hashes` needed for Argon2id and serve it from the
sub-origin itself.

These files are byte-identical to the corresponding files in
`node_modules/@noble/hashes/esm/` from version 1.5.0, except:

- `utils.js` has its `import { crypto } from '@noble/hashes/crypto'`
  rewritten to `'./crypto.js'`. The shim re-exports
  `globalThis.crypto`, which is universal in modern browsers.

Files:
- `_blake.js`     — Blake2 round constants (G1s, G2s, BSIGMA).
- `_md.js`        — Merkle-Damgard helpers used by Blake2 init.
- `_u64.js`       — Software 64-bit math used by Blake2b / Argon2.
- `blake2.js`     — Blake2b hash; the inner primitive of Argon2.
- `crypto.js`     — Shim re-exporting `globalThis.crypto`.
- `utils.js`      — Byte utilities (abytes, u32, toBytes, …).
- `argon2.js`     — Argon2d / Argon2i / Argon2id KDF (RFC 9106).

To refresh from upstream:

```sh
cp node_modules/@noble/hashes/esm/{_blake,_md,_u64,blake2,utils,argon2}.js \
   apps/web/public/recovery/vendor/noble-hashes/
# then re-apply the crypto.js import patch in utils.js:
sed -i "s|from '@noble/hashes/crypto'|from './crypto.js'|" \
   apps/web/public/recovery/vendor/noble-hashes/utils.js
```

License: MIT (Paul Miller / @noble). See https://github.com/paulmillr/noble-hashes.
