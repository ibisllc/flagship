/**
 * What a 0.2 app hears when it asks for something 0.3 no longer does its way (owner rule 2026-11-02,
 * RELEASE-0.3-JOURNAL.md F9): one sentence telling the person to update, never a bare refusal.
 *
 * The 0.2 iOS, Android and web apps show a refusal's `error` text word for word only when it reads like a
 * sentence (a capital first letter, a final `.`, `!` or `?`, a space, none of their raw-error markers), and
 * they cannot translate server text, so these stay English. `apps/com/test/client02Upgrade.test.ts` holds
 * the apps' own rule and checks every sentence here against it.
 */
import type { HandlerResponseWithHeaders } from "./types.js";

export const APP_UPDATE_REQUIRED = "app-update-required";

export const UPDATE_APP_SENTENCES = {
  shareAccept: "Accepting a shared server needs the newest version of Flagship. Update the app, then open the invitation again.",
  recoverySave: "Cloud recovery needs the newest version of Flagship. Update the app, then turn cloud recovery on again.",
  recoveryPasskey: "This account's recovery needs its passkey, which only the newest version of Flagship can use. Update the app, then try again.",
  startUp: "Approving a server's start-up needs the newest version of Flagship. Update the app, then try again.",
} as const;

export type UpdateAppSentence = keyof typeof UPDATE_APP_SENTENCES;

export function appUpdateRequired(status: number, which: UpdateAppSentence, code: string = APP_UPDATE_REQUIRED): HandlerResponseWithHeaders {
  return { status, body: { error: UPDATE_APP_SENTENCES[which], code } };
}

/** The 0.2 cloud-recovery envelope (`{request, signature}`); 0.3 sends `{claim, signature}`. */
export function isLegacyRecoveryEnvelope(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.claim === undefined && !!b.request && typeof b.request === "object";
}
