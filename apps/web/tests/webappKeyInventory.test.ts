import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SECURITY-HARDENING-PLAN.md 18.6 (N06): no private signing, identity, recovery, authorization or
 * channel-encryption key may exist in website JavaScript. The webapp predates that rule and still
 * holds the account key and admin root in the browser, so this is a RATCHET: every file that
 * generates, imports or exports key material is listed here, with the reason it still exists. A new
 * file, or a new call in a file not listed, fails the build until someone decides it belongs.
 * Removing a file from the list is the progress; adding one needs the owner's sign-off.
 */
const KNOWN: Record<string, string> = {
  "keystore.js": "account key, admin root and device key custody in the browser: to move to the phone",
  "lib/leases.js": "boot-lease keys: to move to the phone",
  "lib/bootApproval.js": "boot approval signing: to move to the phone",
  "lib/pairingRelay.js": "ephemeral pairing keys for the QR relay: native-assisted flow needed",
  "lib/buildDraft.js": "sealing a draft to the box: no signing key",
  "lib/serverShare.js": "share envelopes",
  "lib/serverShares.js": "share envelopes",
  "lib/pinLock.js": "local app-lock wrap key (never leaves the browser, signs nothing)",
  "lib/directoryKeyDelivery.js": "directory key envelopes",
  "lib/accountMetadata.js": "metadata sealing",
  "views/create-server.js": "recipe signing in the browser: to move to the phone",
  "providers.js": "AI-provider key sealing",
  "lib/x25519.js": "X25519 helper used by pairing and sealing",
  "lib/serverBackupFormat.js": "backup file wrap",
  "lib/keyfile.js": "keyfile export/import: to move to the phone",
  "lib/serviceInvite.js": "invite envelopes",
  "lib/peerBackup.js": "peer-backup key derivation",
  "lib/maintainerTrust.js": "verification keys only",
};

const ROOT = join(__dirname, "../public/webapp");
const PATTERN = /generateKey\(|exportKey\(|importKey\(|randomPrivateKey|x25519\.utils/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "vendor" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

describe("keys in website JavaScript (N06 ratchet)", () => {
  const found = walk(ROOT)
    .filter((f) => PATTERN.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f))
    .sort();

  it("no file outside the known list touches key material", () => {
    expect(found.filter((f) => !(f in KNOWN))).toEqual([]);
  });

  it("every listed file still does (delete a line when its file stops)", () => {
    expect(Object.keys(KNOWN).filter((f) => !found.includes(f))).toEqual([]);
  });
});
