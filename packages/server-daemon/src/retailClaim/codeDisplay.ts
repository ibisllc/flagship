// The setup code on an attached monitor (docs/retail-box-setup.md §15.1, the sharing method).
// Nothing is on screen until someone presses the power button 3 times; the screen clears after a
// few minutes. No monitor: nothing happens.

import { open } from "node:fs/promises";
import { formatSetupCode, setupCodeLink } from "@flagship/protocol";
import { t } from "../i18n/index.js";
import { encodeQr } from "../qrSvg.js";

export interface CodeDisplay {
  show(code: string, expiresAt: number): Promise<void>;
  clear(): Promise<void>;
}

/** The QR as Unicode half blocks: two module rows per text line, with a 2-module quiet zone. */
export function qrToText(matrix: number[][]): string {
  const n = matrix.length;
  const q = 2;
  const at = (r: number, c: number) => (r >= 0 && c >= 0 && r < n && c < n ? matrix[r]![c] === 1 : false);
  const lines: string[] = [];
  for (let r = -q; r < n + q; r += 2) {
    let line = "";
    for (let c = -q; c < n + q; c++) {
      const top = at(r, c);
      const bottom = at(r + 1, c);
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function codeScreen(code: string, expiresAt: number, lang = "en", apex = "flagshipserver.com"): string {
  const qr = qrToText(encodeQr(setupCodeLink(code, apex), "M"));
  const until = new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ");
  return [
    t(lang, "Flagship setup code"),
    "",
    qr,
    "",
    formatSetupCode(code),
    "",
    t(lang, "Scan this code with the Flagship app on the phone of whoever will own this box."),
    t(lang, "Anyone who sees this code can set up this box. It works once, until {0} UTC.", until),
    t(lang, "Keep the box on a network cable until it is set up."),
    "",
  ].join("\n");
}

/** Writes to the first virtual console. */
export class ConsoleCodeDisplay implements CodeDisplay {
  constructor(private readonly opts: { tty?: string; lang?: string; apex?: string } = {}) {}

  private async write(text: string): Promise<void> {
    const fh = await open(this.opts.tty ?? "/dev/tty1", "w").catch(() => null);
    if (!fh) return;
    try {
      await fh.write(text);
    } finally {
      await fh.close();
    }
  }

  async show(code: string, expiresAt: number): Promise<void> {
    await this.write("\x1b[2J\x1b[H" + codeScreen(code, expiresAt, this.opts.lang, this.opts.apex));
  }

  async clear(): Promise<void> {
    await this.write("\x1b[2J\x1b[H");
  }
}
