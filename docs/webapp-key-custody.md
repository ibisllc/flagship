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
