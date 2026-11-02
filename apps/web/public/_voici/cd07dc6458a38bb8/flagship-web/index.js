// flagship-web: the browser primitives a website uses to talk to Flagship APIs (docs/voici-and-messages.md §6-§8,
// O9). Plain ES modules, no bundler, no dependency outside this folder: a site serves `src/` as it is (voi.ci does,
// apps/voici-site/build.mjs) and imports this file.
//
//   signIn.js    Sign in with Flagship over /qr-pipe: a non-extractable P-256 browser key in IndexedDB, the
//                delegation from the visitor's app, sign out
//   envelope.js  the signed web envelope from the browser: B, messages, thread fetches, page reports
//   deliver.js   direct to the owner's phone when it is live, else the `.com` mailbox; acks; the thread fetch
//   verify.js    verify the admin-signed page index, its pieces and the thread's envelopes BEFORE parsing further
//   store.js     IndexedDB key-value store (memory fallback)
//   proto/       the protocol port (byte-identical copy of apps/web/public/webapp/lib/voici*.js and its vendored
//                noble bundle; scripts/sync-protocol.mjs keeps it in step, tests fail on drift)
//
// Tested in vitest with Node's WebCrypto against packages/protocol/test-vectors/{voici,messages}
// (packages/flagship-web/tests/).

export * from "./signIn.js";
export * from "./envelope.js";
export * from "./deliver.js";
export * from "./verify.js";
export * from "./store.js";
export * as protocol from "./proto/lib/voiciProtocol.js";
