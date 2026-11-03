/**
 * What a 0.2 phone shows for a refusal (iOS `UserErrorText.boxSentence`, Android `UserErrorText.boxSentence`, at
 * e9155777e): the body's `error` or `message` word for word only when it reads as a sentence, else its own
 * generic line ("We couldn't complete that"). Same rule as apps/com/test/client02Upgrade.test.ts.
 */
const KNOWN_REASONS = [/subdomain already controlled by a different rck/i, /^stale request/i, /^invalid signature/i, /^not authorized/i];
const IOS_RAW =
  /(^HTTP\s*\d{3}|\bexception\b|nsurlerrordomain|nsposixerrordomain|kcferror|error domain=|\buserinfo=|\bcode=-?\d+|\bswift\.|\boptional\(|\bhandshake|\berrno|\beconn|\bsocket\b|unexpected end of stream|\bEOF\b|broken pipe|error code:? ?\d+|^[[{<]|unexpected json|could not parse|stacktrace|\bnil\b|\(null\)|couldn.t be completed|\bdecodingerror|\bkeynotfound)/i;
const ANDROID_RAW =
  /(^HTTP\s*\d{3}|\bexception\b|\bjava\.|\bkotlin|\bokhttp|\bokio|\bjavax|\bssl\b|handshake|\berrno|\beconn|\bsocket\b|unexpected end of stream|\bEOF\b|broken pipe|software caused|error code:? ?\d+|^[[{<]|unexpected json|could not parse|stacktrace|\bnull\b|standalonecoroutine|jobcancellation|no value passed|illegalargument|illegalstate)/i;
const LINE_NUMBER = /\s*[([]?\b(at )?lines? ?\d+[)\]]?/i;

export function shownBy02Phone(body: unknown): string | null {
  const o = (body ?? {}) as Record<string, unknown>;
  const text = [o.error, o.message].find((v): v is string => typeof v === "string");
  if (!text?.trim()) return null;
  if (KNOWN_REASONS.some((r) => r.test(text))) return null;
  const first = text[0]!;
  const readable =
    first === first.toUpperCase() && first !== first.toLowerCase() && /[.!?]$/.test(text) &&
    text.length >= 4 && text.includes(" ") && !IOS_RAW.test(text) && !ANDROID_RAW.test(text) && !LINE_NUMBER.test(text);
  return readable ? text : null;
}

export const SAYS_UPDATE = /\b(update|download the new one)\b/i;
