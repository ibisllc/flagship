// Paid name change — move this account to a new name
// (docs/naming-recovery-and-name-change.md §5–6).
//
// Canonical bytes mirror packages/protocol/src/nameDibs.ts `canonicalNameChange`
// byte-for-byte (pinned by the shared vectors). The envelope is bound to the
// account's stable AID so it can't be replayed against another account.

const TAG_NAME_CHANGE = "flagship/name-change/v1";

/** @param {{aidPubHex:string,oldUsername:string,newUsername:string,issuedAt:number}} r */
export function canonicalNameChangeBytes({ aidPubHex, oldUsername, newUsername, issuedAt }) {
  return new TextEncoder().encode([TAG_NAME_CHANGE, aidPubHex, oldUsername, newUsername, issuedAt].join("|"));
}
