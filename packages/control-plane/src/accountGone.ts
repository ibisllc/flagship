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

import type { DemoUserRecord, DemoUsersStorage, UsernameRecord, UsernameStorage } from "@flagship/storage";
import type { HandlerResponseWithHeaders } from "./types.js";

export const ACCOUNT_NOT_FOUND_CODE = "account-not-found";

export interface AccountGoneDeps {
  usernames: UsernameStorage;
  demoUsers: DemoUsersStorage;
}

/**
 * The demo row that speaks for the account holding the name now, if any (security review M5). Demo provisioning writes
 * the account row (`isDemo: true`, account type "demo", claimed at the demo row's `createdAt`) and the demo row in one
 * batch. A row whose account row is gone never applies; neither does one older than the account row now holding the
 * name, unless that row is itself marked demo: a later, real owner of the name claims after the demo row was made.
 */
export function currentDemoRow(demo: DemoUserRecord | undefined, user: UsernameRecord | undefined): DemoUserRecord | undefined {
  if (!demo || !user) return undefined;
  if (user.isDemo === true || user.accountType === "demo") return demo;
  return user.claimedAt <= demo.createdAt ? demo : undefined;
}

export async function accountExists(deps: AccountGoneDeps, username: string): Promise<boolean> {
  const u = username.toLowerCase();
  // Both lookups always run, so an existing, a demo and a missing name cost
  // the same work before the answer.
  const [demoRow, user] = await Promise.all([deps.demoUsers.get(u), deps.usernames.get(u)]);
  const demo = currentDemoRow(demoRow, user);
  if (demo) return demo.state !== "cleanup-only";
  return !!user;
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
