# Should the webapp hold signing keys? (debate)

Status: for the owner (2026-11-15). The owner's position is "the webapp is an app, and could be the best solution one
has. Open to debate." Today it holds a personal account's admin root (a browser admin device), but no org seat keys,
no ML-DSA (quantum-safe) half and no hardware binding. The enterprise design (`enterprise-accounts.md` §18, E4) made
the web view-and-collect only. Each point below is a real risk; each also has a mitigation.

## Why it was kept out

1. **The code arrives fresh on every load.** A phone app is a signed store release: an update takes review, takes
   days to reach people, and a bad release can be held back. The webapp runs whatever JavaScript our servers
   served on that load. If someone took over our deploy (a stolen Cloudflare token, a malicious commit that got
   through), one deploy could ship key-stealing code to every browser at once. Phones would not be exposed that way.
2. **Keys are software keys.** WebCrypto's non-extractable keys live in the browser profile. Malware with access to
   the profile, or a malicious extension with broad rights, can use them. Nothing binds them to the Secure Enclave
   or StrongBox the way the phones' keys are.
3. **No quantum-safe half.** WebCrypto has no ML-DSA today, so the webapp signs classically, and strict servers
   refuse it (already true for Release this box and restore). A WebAssembly ML-DSA would work, but only as a
   software key.
4. **Script injection has a bigger blast radius.** One XSS bug in a page that has a key unlocked lets the attacker
   sign anything while the page is open.

## Why it should hold keys anyway

1. **It's the only client on many machines:** Linux and ChromeOS desktops, locked-down company laptops, and the
   data-centre "command centre" laptop the owner described. Making those view-only makes the enterprise offer
   weaker exactly where enterprises live.
2. **It already holds a personal admin root.** Refusing org seats while allowing a personal admin root is not a
   consistent line.
3. **The browser sandbox is strong**, and passkeys (WebAuthn with the PRF extension) can wrap the key so that each
   unlock needs the platform authenticator: Touch ID, Windows Hello, or a security key. That gives hardware-backed
   unlock even though the key itself is software.

## Proposal: allow it, labelled and fenced

1. **The webapp can be a full seat device** (sign approvals, rotate keys), and a personal admin device as today.
   Its custody label reads "Browser: software key, unlocked with a passkey". The label is in the seat grant, so
   every box and admin sees it.
2. **Passkey wrapping is required** for any webapp-held signing key: no key unlocks from a typed passcode alone.
   (`docs/` already has passkey PRF for cloud recovery; reuse it.)
3. **Org bylaws decide:** a bylaw may require hardware custody for admin seats, or require that each k-of-n quorum
   includes at least one hardware-custody approval. The default is to allow browser seats, with at least one
   hardware approval in a quorum of two or more.
4. **Quantum-safe signing with an ML-DSA WebAssembly module** (the same mldsa-native code the iOS C target uses,
   compiled to WASM, with checksums pinned in the shell), so the webapp can sign hybrid and strict servers stop
   refusing it. Custody stays "software".
5. **Close risk 1 before GA: a verifiable shell.** The service worker installs only a shell whose manifest
   (file hashes, version) is signed by the release key. An update that isn't signed is refused, and the user sees
   "This version of the webapp isn't signed by Flagship." That turns one deploy compromise into one that also needs
   the offline release key. A browser extension that checks the same signature can be offered to cautious
   organisations.
6. **Lock unused keys:** a key is unwrapped only for the action being signed and dropped right after, which narrows
   risk 4.

## Decision needed
- Accept the proposal (1-6)? Do items 4 and 5 in 0.4 or right after?

## Decision and build status (2026-11-15, branch `0.4/webapp-custody`, shell v218)

Owner: proposal 1-6 accepted, all in 0.4. Not deployed; not run in a real browser against a real box.

- **Item 2 and 6, passkey custody (`lib/keyCustody.js`).** The admin root and a fresh ML-DSA-65 seed are sealed
  together in the admin-root record (version 2). The AES-GCM key is HKDF over a passkey's PRF output AND a key
  derived from the account key, so neither the passphrase nor the passkey alone opens it. The session holds a
  handle (public keys and `open`), never the seed: each signature asks for the passkey (user verification
  required), signs, and wipes. A version 1 record (passphrase only) moves under a passkey on its first use, or from
  Settings, Account security, "Protect with a passkey"; a rotated root reuses the same passkey. Raw copies leave
  only where the flow hands the seed on (recovery escrow, promoting a device: `exportAdminRootSeed`). The passphrase
  re-prompt before admin orders is skipped when the passkey asks instead. Custody label: "Browser: software key,
  unlocked with a passkey" (Settings shows it).
- **Item 4, ML-DSA in WebAssembly.** `tools/mldsa-wasm/build.sh` builds the iOS target's mldsa-native v2.0.0
  freestanding for wasm32 (no imports; `--check` compares with the committed file and the pin); the shell pins the
  SHA-256 (`lib/mldsaWasm.js`) and refuses another file. `lib/pqSign.js` ports `hybridSign` and
  `signPqKeyBinding` and matches the `pq-hybrid` and `pq-binding` vectors byte for byte. When the ML-DSA half is
  made, its `admin-root` binding goes to `.com`; `.com` keeps the first ML-DSA key per Ed25519 key, so a root a
  phone bound first stays classical in this browser (Settings says so). `lib/adminSigning.js` adds `pqSignature` to
  Release this box and the restore orders. Not yet hybrid from the web: the other sensitive orders (server order,
  direct access, update, policy changes); the strict opt-in stays phone-only.
- **Item 5, verifiable shell (`lib/shellTrust.js`, `scripts/webapp-shell.ts`).** The webapp build writes
  `/shell-manifest.json` (SHA-256 of every file the worker installs, at its version). A new worker refuses to
  install files that don't match it. The page checks `/shell-signature.json` (the ca-track maintainer key over
  `flagship/webapp-shell/v1|<version>|<manifestSha256>|<issuedAt>|<signedBy>`, plus the release key's PQ half while
  `RELEASE_PQ_KEY_IDS` is set) before it offers an update. `SHELL_SIGNATURE_REQUIRED` is `false`: until the owner
  signs a release shell, an unsigned update is still offered. Turned on, the page refuses an unsigned update ("This
  version of the webapp isn't signed by Flagship."), keys won't open under an unsigned shell, and the webapp build
  refuses to produce an unsigned deploy. Limit: the browser fetches `service-worker.js` itself, so a deploy
  compromise can still replace the worker for browsers whose tabs all close; the signature makes it visible to
  open signed shells, and the verifying browser extension (not built) closes it.
- **Items 1 and 3 in the protocol (`orgAuthority.ts`, `.com` `orgs.ts`).** An org admin entry, a seat accept and a
  seat grant may carry `custody: "browser"` (encoded only when browser, so existing records keep their bytes);
  `.com` refuses a grant whose custody differs from the accept. Bylaws gain `adminCustody: "hardware"` (no browser
  admin keys, in the record or in admin-role grants) and `quorumHardware` (default on: a threshold of two or more
  needs at least one hardware-custody approval; checked in OAR transitions, seat grants and `authorizeOrgOrder`,
  so boxes and `.com` both enforce it). Still open: the Swift and Kotlin ports of these fields (no browser seat can
  exist until the next item lands, so phones verify every record that exists today), and the webapp as an org seat
  (join with SAS, approvals, rotations: today `lib/orgJoin.js` still hands the invitation to the phone).

### Signing a release shell

After the release's webapp is final on `main`: `npx tsx scripts/webapp-shell.ts sign` previews (version, file
count, manifest digest, the signing key against the ca-track authority, the PQ half); `--sign` signs with the
ca-track YubiKey (and the release ML-DSA key, PIN and touch) and writes `release/webapp-shell/<version>.json`.
Commit it on `main`; the webapp deploy copies it to `/shell-signature.json` only when it signs exactly that build.
Any later change to a shell file needs a new signature. Once a signed shell is live, set
`SHELL_SIGNATURE_REQUIRED = true` in `lib/shellTrust.js` (a shell change, so sign again).
