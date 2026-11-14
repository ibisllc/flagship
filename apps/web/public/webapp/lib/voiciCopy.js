// The sentences the voi.ci page editor, Messages and the sign-in approval show (docs/voici-and-messages.md §9.7,
// §11). `.com` answers codes only; the apps write the words. Functions, so a sentence is looked up in the language
// active when it is shown.

import { formatWhen } from "./dateFormat.js";
import { tr, trn } from "./i18n.js";

/** O1: next to the profile fields and in the confirm before the first publish. */
export const VOICI_PAGE_WARNING = () => tr("Anyone can see this page. It shares your username with your apps and servers, so people can connect them.");

export const VOICI_RULES_TITLE = () => tr("Page and message rules");
export const VOICI_RULES_TEXT = () =>
  tr("Don't post or send anything illegal, threatening or hateful, nudity or sexual content, or graphic real-world violence, and don't use your page or messages to harass or deceive people. Flagship removes pages and stops accounts from sending messages when they break these rules.");

export const VOICI_ACCEPT_NOTE = () => tr("People with a Flagship account can write to you. They appear as visitors, not by name.");
export const VOICI_SIGN_IN_PRIVATE = () => tr("Messages are private. If someone reports your message, Flagship can see which account sent it.");
export const VOICI_WAITING_ADMIN = () => tr("Waiting for an admin device to publish");
export const VOICI_NOT_PUBLISHED = () => tr("Not published yet");

/** The Public switch (§3.3, §11.1): the one-time warning before it first goes on, and the confirm to turn it off. */
export const VOICI_PUBLIC_WARNING_TITLE = () => tr("Make your page public?");
export const VOICI_PUBLIC_WARNING = () =>
  tr("Everything you put on your page is public. Anyone can see it, and it shows your username, which your apps and servers also use, so people can connect them.");
export const VOICI_REMOVE_TITLE = () => tr("Remove your page from voi.ci?");
export const VOICI_REMOVE_TEXT = () =>
  tr("Visitors will see \"There's no page here.\" Your posts and profile stay on your devices, so you can turn it on again.");
export const VOICI_PUBLISH_ADMIN_ONLY = () => tr("Only an admin device can publish your page.");

/** The sentence for a VoiciError (or anything else thrown). */
export function voiciErrorText(e) {
  const code = e?.code ?? "";
  const when = typeof e?.retryAfterSec === "number" ? formatWhen(Date.now() + e.retryAfterSec * 1000) : "";
  switch (code) {
    case "locked":
      return tr("Unlock Flagship first.");
    case "not-admin":
      return tr("Only an admin device can publish your page.");
    case "seq-conflict":
    case "publish-conflict":
    case "wrong-page":
      return tr("Couldn't publish. Try again.");
    case "wrong-signer":
    case "not-sensitive-key":
    case "bad-signature":
      return tr("This device can't sign your page. Use an admin device of your account.");
    case "page-unverified":
      return tr("This page couldn't be checked.");
    case "no-page":
      return tr("This page isn't published.");
    case "not-accepting":
      return tr("This page doesn't accept messages right now.");
    case "taken-down":
      return tr("Your page was removed by Flagship. You can appeal from the abuse page.");
    case "banned":
      return tr("Your account can't send messages. If you think this is a mistake, tell us.");
    case "first-contact-limit":
      if (typeof e?.limit === "number" && when) return trn(e.limit, "You can start {0} new conversation a day. Try again {1}.", "You can start {0} new conversations a day. Try again {1}.", when);
      return when ? tr("You've started as many new conversations as you can today. Try again {0}.", when) : tr("You've started as many new conversations as you can today.");
    case "device-limit":
      return tr("This device already started Messages for another account this month.");
    case "unattested-too-new":
      return tr("New accounts can start conversations from the web after 7 days.");
    case "rate-limited":
      return when ? tr("Too many tries. Try again {0}.", when) : tr("Too many tries. Try again later.");
    case "awaiting-reply":
      return tr("Wait for a reply before sending more.");
    case "missing-image":
      return tr("The photo isn't on this device. Pick it again.");
    case "no-device-key":
    case "no-device-grant":
      return tr("This device can't sign for the account. Remove it and add it again from an admin device.");
    case "bad-request":
    case "bad-attestation":
      return tr("The website's request didn't check out. Start again on voi.ci.");
    case "expired":
    case "pipe-timeout":
      return tr("The sign-in timed out. Start again on voi.ci.");
    case "peer-missing":
      return tr("The voi.ci tab isn't connected any more. Start again on voi.ci.");
    case "state-unreadable":
      return tr("Your Messages settings couldn't be opened on this device.");
    case "too-large":
      return tr("That's too big to publish.");
    case "sign-out-failed":
      return tr("Couldn't sign out of that website. Try again.");
    default:
      return tr("Something went wrong. Try again.");
  }
}

/** A refused text field (prepareVoiciText codes). */
export function voiciTextProblem(code, max) {
  switch (code) {
    case "too-short":
      return tr("Write something first.");
    case "too-long":
      return tr("Keep it to {0} characters.", max);
    case "bidi":
    case "control":
    case "bom":
    case "edge-invisible":
    case "surrogate":
      return tr("Remove the invisible or control characters.");
    default:
      return tr("That text can't be used.");
  }
}
