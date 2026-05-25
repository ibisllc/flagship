// "I hold a trademark to this name" — prefilled mailto builder.
//
// Shown in the account-creation "name taken" state. A user who holds a
// registered trademark to a name that's already claimed can email the
// flagship trademarks desk to start a claim. We pre-fill the requested
// name + a short template (with a placeholder for their trademark
// registration details) so the desk gets a structured request.
//
// Single source of truth for the to/subject/body so the iOS + Android
// "name taken" states can mirror the exact same message.

/** Where trademark claims go. */
export const TRADEMARK_CLAIM_EMAIL = "trademarks@flagshipserver.com";

/** Subject line for a trademark claim on `username`. */
export function trademarkClaimSubject(username) {
  return `Trademark claim for the name "${username}"`;
}

/** Plain-text body template. Leaves bracketed placeholders for the user
 *  to fill in. Kept short and explicit so the desk can triage fast. */
export function trademarkClaimBody(username) {
  return [
    `Hello,`,
    ``,
    `I'm requesting the Flagship account name "${username}" on the basis`,
    `that I hold a registered trademark covering it.`,
    ``,
    `Trademark holder / company: [your name or company]`,
    `Trademark registration number: [registration number]`,
    `Jurisdiction / registry: [e.g. USPTO, EUIPO]`,
    `Goods/services class(es): [class numbers]`,
    `Link or attachment to the registration: [URL or note that it's attached]`,
    ``,
    `Requested name: ${username}`,
    ``,
    `Thank you.`,
  ].join("\n");
}

/** Build the full `mailto:` URL (subject + body URL-encoded). */
export function trademarkClaimMailto(username) {
  const subject = encodeURIComponent(trademarkClaimSubject(username));
  const body = encodeURIComponent(trademarkClaimBody(username));
  return `mailto:${TRADEMARK_CLAIM_EMAIL}?subject=${subject}&body=${body}`;
}
