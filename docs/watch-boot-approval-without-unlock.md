# Approving a start-up from the watch while the phone is locked

Status: design for the owner's decision. Nothing here is built. It answers the "flagship UX" session's
question (can "Approve from watch" work with the phone locked in a pocket?). Read with
`docs/watch-delegate-key-design.md` and SECURITY-HARDENING-PLAN.md 18.10 (N10) and 18.5 (N05).

## The gap

The watch-delegate key signs a boot response without Face ID. But answering a start-up request also means
opening the box's sealed unlock request, and that needs the account's UMK. The phone keeps the UMK in
memory only while the app session is unlocked (it is dropped on background or re-lock), so with the app
lock on, the watch can approve only while Flagship is open in front.

## Options

a) **A boot-only decryption delegate (recommended).** At enrolment the phone also makes an X25519 key
   beside the signing delegate: Secure Enclave or Keystore, user-presence required, this device only,
   same scope (boot approval), same TTL (7 days), attested by the account key in the same statement. A
   box that allows watch approval seals its unlock request to the account's key AND to the delegate's. The
   phone (or the watch itself) can answer a start-up request without the UMK, and nothing else becomes
   readable: the delegate key opens only boot requests for servers that listed it.
b) **A watch-approval window.** Keep the boot-approval material (not the UMK) for N hours after an unlock,
   even backgrounded, cleared on reboot. Weaker: a stolen unlocked-then-locked phone holds usable material
   for the window.
c) **Keep today's behaviour and say so.** No new risk, but the feature does not do what it promises.

## What option (a) needs, and what must still hold

- A new signed enrolment statement `flagship/watch-boot-delegate/v1` naming the signing key, the
  decryption key, the scope, the expiry and the device, signed by the account key (admin root where
  pinned). Revoking the delegate revokes both keys.
- The box lists delegate keys it accepts in its own signed settings (owner opt-in per server, off by
  default, with the share-start warning the owner already sees). A request is sealed to each listed key.
- The decryption key never leaves the secure hardware and needs user presence per use (the watch
  gesture), so a stolen locked phone cannot answer on its own.
- A lost watch: the 7-day TTL ends it, and the owner can revoke it from any admin device at once.
- **The boot-suspension lock wins.** The boot service refuses to release anything for a suspended server
  whoever approves; a delegate approval is an approval like any other and is checked against the lock
  at the boot service, not at the phone.
- Out of scope, as in N10: it does not revoke anything already copied from a running server.

## Cost

New protocol envelope with vectors on four ports (TS, Swift, Kotlin, JS), a box-side seal-to-many change
in the unlock request, a watch and phone enrolment screen, and a real-hardware run (Secure Enclave and
Keystore user-presence behaviour cannot be proven in a simulator). Order: protocol and box first, then iOS
and the watch, then Android and Wear OS.

## Decision needed

Pick (a), (b) or (c). Until then nothing changes and the setting keeps saying the phone must be unlocked.
