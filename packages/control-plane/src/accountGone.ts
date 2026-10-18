// The "account no longer exists" answer (docs/account-gone.md).
//
// A device that is already signed in keeps calling its account's routes. When
// the account has been deleted (a reset, a pre-launch wipe) each of those
// calls answers one stable 404 instead of a 401, a 403, an empty 200 or a 400
// that depends on which route it was. The client turns that into a plain
// "This account was removed" screen and stops polling.
//
// Existence here is exactly what the public `account/resolve` lookup already
// reveals, so the answer tells a caller nothing new. A demo account counts as
// existing, except one that is being cleaned up (resolve calls that unknown).

import type { DemoUsersStorage, UsernameStorage } from "@flagship/storage";
import type { HandlerResponseWithHeaders } from "./types.js";

export const ACCOUNT_NOT_FOUND_CODE = "account-not-found";

export interface AccountGoneDeps {
  usernames: UsernameStorage;
  demoUsers: DemoUsersStorage;
}

export async function accountExists(deps: AccountGoneDeps, username: string): Promise<boolean> {
  const u = username.toLowerCase();
  const demo = await deps.demoUsers.get(u);
  if (demo) return demo.state !== "cleanup-only";
  return !!(await deps.usernames.get(u));
}

export const accountNotFoundResponse = (): HandlerResponseWithHeaders => ({
  status: 404,
  body: { error: ACCOUNT_NOT_FOUND_CODE, code: ACCOUNT_NOT_FOUND_CODE },
  headers: { "cache-control": "private, no-store", vary: "authorization" },
});

/** Null when the account exists; the 404 answer when it does not. */
export async function checkAccountExists(
  deps: AccountGoneDeps,
  username: string,
): Promise<HandlerResponseWithHeaders | null> {
  return (await accountExists(deps, username)) ? null : accountNotFoundResponse();
}
