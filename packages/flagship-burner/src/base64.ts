/**
 * Engine-portable UTF-8 → base64.
 *
 * The preseed/user-data generator must run UNCHANGED in three places:
 *   - Node (the Linux/Windows CLI burner) — has Buffer,
 *   - JavaScriptCore (the macOS/iOS burner) — pure ECMAScript, NO Buffer/btoa/TextEncoder,
 *   - Rhino (the Android burner) — pure ECMAScript, same lack.
 *
 * So the ONE Node-only call the generator used (`Buffer.from(s,"utf-8")
 * .toString("base64")`) is replaced by this pure-ECMAScript implementation,
 * letting the identical generator source bundle + run on every engine. It is
 * byte-for-byte equal to the Buffer form (asserted in tests/base64.test.ts),
 * so existing burns + the sha-pinned bootstrap stay identical.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** UTF-8 encode a JS string to a byte array, without TextEncoder. */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/** Standard base64 (with `=` padding) of the UTF-8 bytes of `s`. */
export function utf8ToBase64(s: string): string {
  const bytes = utf8Bytes(s);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1]! : 0;
    const b2 = has2 ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += has1 ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += has2 ? B64[b2 & 0x3f] : "=";
  }
  return out;
}
