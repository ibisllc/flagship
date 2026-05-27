// N-BOX-9 — resale wipe verification.
//
// After RESET secure-erases the LUKS volume, the firmware reads back a
// 4-KiB chunk and confirms it decrypts to garbage (no recognizable
// plaintext). Provides a visible "wipe confirmed" verdict to the seller
// — a green LED solid 5 s + optional buzzer chime per the design.
//
// This module owns the *verdict logic*; the boot-stage script calls
// `verifyWipe()` with bytes it just read off the wiped block device and
// acts on the verdict. Hardware-side bring-up (the actual block-device
// read, the LED + chime drivers) ships under N-BOX-6 / N-HW.

import type { Bytes } from "@flagship/protocol";

/** Required minimum read length — matches the design's 4 KiB. */
export const WIPE_READ_BYTES = 4096;

/**
 * LUKS2 header magic (`LUKS\xba\xbe`). If we see this after a wipe, the
 * erase missed the header sector — refuse.
 */
const LUKS_MAGIC = new Uint8Array([0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe]);

/**
 * Block-device "looks empty" patterns the secure-erase might leave
 * behind. We tolerate full-zero and full-FF blocks because some SSDs
 * deterministically return those after TRIM. Anything else needs to
 * have low ASCII printable density to count as garbage.
 */
const ALL_ZEROS_OK = true;
const ALL_FFS_OK = true;

/**
 * Maximum fraction of bytes in the sample that may fall in the
 * printable-ASCII range (0x20-0x7e plus tab/LF/CR). 98 of the 256 byte
 * values are in that range, so uniformly-random bytes land here ~38 %
 * of the time. Real text is typically ≥ 95 %. We set the bar at 60 %
 * — comfortably above random with plenty of headroom, well below any
 * realistic plaintext.
 */
const MAX_PRINTABLE_FRACTION = 0.6;

export interface WipeVerifyResult {
  ok: boolean;
  reason?:
    | "short-read"
    | "luks-header-present"
    | "printable-density-high"
    | "recognizable-plaintext";
  /** Diagnostic: fraction of bytes that are printable ASCII. */
  printableFraction: number;
}

/**
 * Verify a post-erase read-back. Pure function — caller supplies the
 * bytes (e.g. `dd if=/dev/<wiped> bs=4096 count=1`).
 *
 * Verdict rubric (in order):
 *   1. Length < 4 KiB → short-read (caller's responsibility).
 *   2. LUKS magic present anywhere in the sample → luks-header-present
 *      (erase missed the header).
 *   3. All-zeros or all-FF buffer → ok (deterministic TRIM result).
 *   4. Printable-ASCII fraction > 60 % → printable-density-high.
 *   5. Common plaintext markers (key=value lines, JSON braces,
 *      executable shebangs) → recognizable-plaintext.
 *   6. Otherwise → ok.
 */
export function verifyWipe(sample: Bytes): WipeVerifyResult {
  if (sample.length < WIPE_READ_BYTES) {
    return { ok: false, reason: "short-read", printableFraction: 0 };
  }
  // Cap analysis at 4 KiB even when the caller hands over more, so the
  // verdict is stable across implementations.
  const view = sample.subarray(0, WIPE_READ_BYTES);

  if (containsSubsequence(view, LUKS_MAGIC)) {
    return {
      ok: false,
      reason: "luks-header-present",
      printableFraction: printableFraction(view),
    };
  }

  if (ALL_ZEROS_OK && isAllByte(view, 0x00)) {
    return { ok: true, printableFraction: 0 };
  }
  if (ALL_FFS_OK && isAllByte(view, 0xff)) {
    return { ok: true, printableFraction: 0 };
  }

  const pf = printableFraction(view);
  if (pf > MAX_PRINTABLE_FRACTION) {
    return { ok: false, reason: "printable-density-high", printableFraction: pf };
  }

  if (looksLikeStructuredPlaintext(view)) {
    return { ok: false, reason: "recognizable-plaintext", printableFraction: pf };
  }

  return { ok: true, printableFraction: pf };
}

function isAllByte(view: Bytes, b: number): boolean {
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== b) return false;
  }
  return true;
}

function printableFraction(view: Bytes): number {
  let n = 0;
  for (let i = 0; i < view.length; i++) {
    const c = view[i]!;
    // Printable ASCII (excl. control chars), plus space + tab + newline.
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) n++;
  }
  return n / view.length;
}

function containsSubsequence(haystack: Bytes, needle: Bytes): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

const STRUCTURED_MARKERS = [
  // JSON object / array openings
  new Uint8Array([0x7b, 0x22]), // {"
  new Uint8Array([0x5b, 0x7b]), // [{
  // Shebang
  new Uint8Array([0x23, 0x21, 0x2f]), // #!/
  // Common file-format magics
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), // ELF
  new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04 (zip)
  new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
] as const;

function looksLikeStructuredPlaintext(view: Bytes): boolean {
  for (const marker of STRUCTURED_MARKERS) {
    if (containsSubsequence(view, marker)) return true;
  }
  return false;
}
