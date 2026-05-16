/**
 * Minimal browser-global surface used ONLY inside `page.evaluate()` /
 * `locator.evaluate()` callbacks (s14/s15 CSS-token readback).
 *
 * Deliberately NOT `lib: ["DOM"]` / `/// <reference lib="dom" />`:
 * lib.dom's strict `BufferSource` regresses TS 5.7
 * `Uint8Array<ArrayBufferLike>` assignability in imported workspace
 * packages (e.g. `@flagship/protocol` auth.ts `crypto.subtle.digest`),
 * which would be a cross-package blast radius from an e2e-only need.
 * These specs touch a tiny, closed CSS surface, so a narrow ambient
 * shim is the correct scope. Keep it as tight as the real usage so a
 * drift in what the specs read still trips tsc.
 */

interface E2EComputedStyle {
  getPropertyValue(prop: string): string;
  readonly fontFamily: string;
  readonly backgroundColor: string;
  readonly borderTopLeftRadius: string;
  readonly borderTopWidth: string;
  readonly letterSpacing: string;
  readonly textTransform: string;
}

declare function getComputedStyle(el: unknown): E2EComputedStyle;

declare const document: {
  readonly body: unknown;
  readonly documentElement: unknown;
};

interface HTMLAnchorElement {
  getAttribute(name: string): string | null;
}
