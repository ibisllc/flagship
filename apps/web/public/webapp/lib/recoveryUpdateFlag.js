// SEC-REPAIR-001: whether this device already asked the owner of `username` to update a recovery
// record made before `.com` checked the passkey. Asked once per account per device, whatever the
// answer; the Settings row stays for later.

const PREFIX = "flagship.recoveryUpdateAsked.";

export function recoveryUpdateAsked(username, storage = globalThis.localStorage) {
  if (!username) return false;
  try {
    return storage?.getItem(PREFIX + String(username).toLowerCase()) === "1";
  } catch {
    return false;
  }
}

export function markRecoveryUpdateAsked(username, storage = globalThis.localStorage) {
  if (!username) return;
  try {
    storage?.setItem(PREFIX + String(username).toLowerCase(), "1");
  } catch {
    /* private window: asked again next time */
  }
}
