// What this build is, for the security notice (docs/security-notices.md): a
// notice names the oldest build and protocol level it still accepts, and the
// app compares them with these.
//
// WEB_BUILD is the shell version number in service-worker.js (SHELL_VERSION
// "v145" is 145); a test fails when they drift, so bump both together.
// PROTOCOL_LEVEL mirrors CLIENT_PROTOCOL_LEVEL in packages/protocol: raise it
// only when a breaking change to a signed message or wire contract ships.

export const PLATFORM = "web";
export const WEB_BUILD = 145;
export const PROTOCOL_LEVEL = 1;

export function clientIdentity() {
  return { platform: PLATFORM, build: WEB_BUILD, protocol: PROTOCOL_LEVEL };
}
