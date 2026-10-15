// The webapp's hand-rolled QR encoder (/qrEncoder.js) against an independent
// one (the `qrcode` package): every version 1-40 at every error-correction
// level must give the same modules for the mask our encoder picked. This is
// what caught the swapped second format copy and the missing version blocks
// (v7+), and it lets the transfer offer (~600 bytes, v17) render as a QR.
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
// @ts-expect-error — the package's internals ship no types
import Version from "qrcode/lib/core/version.js";
// @ts-expect-error — the package's internals ship no types
import ECLevel from "qrcode/lib/core/error-correction-level.js";
// @ts-expect-error — the package's internals ship no types
import Mode from "qrcode/lib/core/mode.js";
// @ts-expect-error — plain-JS module, no types
import { encodeQr, renderQrSvg } from "../public/qrEncoder.js";

const ECLS = ["L", "M", "Q", "H"] as const;

/** The mask our encoder chose, read back from its first format copy. */
function maskOf(m: number[][]): number {
  let bits = 0;
  const at = (i: number) => (i < 6 ? m[i]![8]! : i < 8 ? m[i + 1]![8]! : i === 8 ? m[8]![7]! : m[8]![14 - i]!);
  for (let i = 0; i < 15; i++) bits |= at(i) << i;
  return ((bits ^ 0b101010000010010) >> 10) & 0b111;
}

function reference(text: string, version: number, ecl: string, mask: number): number[][] {
  const q = QRCode.create([{ data: new TextEncoder().encode(text), mode: "byte" }], {
    version,
    errorCorrectionLevel: ecl,
    maskPattern: mask,
  } as never);
  const N = q.modules.size;
  return Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => (q.modules.get(y, x) ? 1 : 0)));
}

const textOf = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join("");

describe("qrEncoder — module-for-module against the qrcode package", () => {
  for (const ecl of ECLS) {
    it(`every version 1-40 at level ${ecl}, each filled to its byte capacity`, () => {
      for (let v = 1; v <= 40; v++) {
        const n = Version.getCapacity(v, ECLevel[ecl], Mode.BYTE);
        const m: number[][] = encodeQr(textOf(n), ecl);
        expect((m.length - 17) / 4, `${n} bytes at level ${ecl}`).toBe(v);
        expect(m, `version ${v} level ${ecl}`).toEqual(reference(textOf(n), v, ecl, maskOf(m)));
      }
      const full = Version.getCapacity(40, ECLevel[ecl], Mode.BYTE);
      expect(() => encodeQr(textOf(full + 1), ecl)).toThrow(/too long/);
    });
  }

  it("renders a server transfer link (the longest QR the webapp shows)", () => {
    const link = `https://flagshipserver.com/transfer?o=${"x".repeat(560)}`;
    const svg: string = renderQrSvg(link, { size: 260 });
    expect(svg.startsWith("<svg")).toBe(true);
    const m = encodeQr(link, "L");
    expect((m.length - 17) / 4).toBeGreaterThan(10);
  });

  it("refuses text beyond version 40", () => {
    expect(() => encodeQr("x".repeat(3000), "L")).toThrow(/too long/);
  });
});
