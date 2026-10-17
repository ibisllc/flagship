# pairing-relay (paused 2026-10-16)
Goal: make "add a device with a pairing code" work between real devices: live relay clients on iOS and Android, webapp fixed, all combinations working.

## Landed on main
- nothing

## Saved, not landed
- wip/pairing-relay-2026-10-16 (b26949c02): webapp lib only (crossDevicePairing.js, keystore.js). Passes `node --check`; NOT tested. The existing webappCrossDevicePairing tests will fail until they're updated (bundles without a grant are now refused, and runIncomingJoin needs signWithDevice).

## Findings
- The webapp's RELAY transport works (two legs over /qr-pipe, proven by tools/live-e2e/device-add-relay-probe.ts). Its JOIN does not: `.com` handleVouchedDeviceAdmit (packages/control-plane/src/push.ts) has needed grant + grantSignature + a device profile since b4b8c8558 (July). The webapp sends none of them, so it gets 400 "missing device bootstrap".
- The three clients use three different wire formats. iOS and Android only have mocks; their 80-byte unsealed "hello" doesn't match the DO. Android's bundle has no irkPubHex; iOS needs it. The webapp's bundle has no grant.
- The webapp derives its device key from the UMK, so a joining browser (which has to name its key before it gets the UMK) must store the key it picked. The WIP keeps it wrapped under the UMK (keystore.js, persistAccountDeviceSeed).
- Today no client limits Add device to admin devices. The docs (`add-device` scope) say only admins add devices. Planned: show Add device only when isAdminDevice || demo, otherwise "Only an admin device of this account can add devices."

## Unified protocol (to document in docs/multi-device.md)
leg-1 sid from the QR (admin = browser, incoming = phone): hello{phonePk = incoming X25519} → admin derives the SAS and key (HKDF salt flagship/qr/v1). The incoming then sends deliver AEAD(JSON{devicePubHex, deviceId, returnSid, returnPkB64u}).
leg-2 returnSid (incoming = browser, opened BEFORE leg-1; admin = phone with a throwaway hello) carries AEAD(bundle) under the leg-1 key.
Bundle: {umkSeedHex, admit, admitSig, irkPubHex, grant{grantId, username, deviceId, devicePubHex, scopes, issuedAt, expiresAt, signerRoot}, grantSignature, wrappedAdminRoot?}.

## Remaining (in order)
1. M webapp views: add-device.js (admin gate, pass irkPubHex + signWithAdminRoot); join.js (raw-seed device key via deriveAdminRootFromSeed/signWithAdminRoot, ask for a device name, deviceSeed + signWithDevice); pairingRelay.js (error sentences, timeouts, rebind and close handling); postDeviceAdmit sends grant/grantSignature/profile with readable 401/403 messages; shell bump; update webappCrossDevicePairing + webappAdminRootPhase3 tests. Land it.
2. S vectors: packages/protocol/test-vectors/device-pairing/vectors.json (fixed X25519/IRK/nonces → SAS, frame ciphertexts, admit and grant canonical bytes plus signatures) + TS test.
3. L iOS: reshape PairingRelayClient (FlagshipCore/PairingRelay.swift) into frame-level calls; LivePairingRelayClient (URLSessionWebSocketTask); a DO-emulating mock with a simulated peer for the gym; AddDeviceViewModel/JoinAccountViewModel on the unified frames; FlagshipApp.swift activePairingRelay (coordinate with the nomock agent's UnavailablePairingRelayClient / GymLaunch.usesMocks, not landed yet); Phase3bPairingTests, AdminRootPhase3Tests, vector test, a gym UITest.
4. L Android: the same in core/DevicePairingRelay.kt (OkHttp live client), AddDevice/JoinDevice VMs and screens (stop using `remember { MockDevicePairingRelay() }`), add irkPubHex to PairingBundle, unit tests, a vector test, GymFeatureMirrorTest.
5. M live check: extend apps/web/e2e/live/device-add.spec.ts (browser↔browser through the gym relay with a real admit) + a spec for the coordinator: browser admin ↔ iOS simulator / Android emulator.
6. S docs/multi-device.md protocol section; parity/features.json; AGENTS status.

## Decisions needed
- Confirm Add device is admin-device-only (non-admin devices see the sentence above).

## Gym coverage
- Added: none. Missing: a mock scenario per app (add + join with a simulated peer), and the live pairing spec.
