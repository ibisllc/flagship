/**
 * Headers on every HTML page the box serves itself (invite, sign-in, request
 * access, its landing and 404 pages). None is meant to sit in a frame, and a
 * framed sign-in or invite page could have its clicks steered by an overlay.
 * An app's own responses are the app's business and don't get these.
 */
export const NO_FRAME_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
} as const;
