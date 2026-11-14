// The box's setup code (docs/retail-box-setup.md §15.1). It exists only once someone asks for it
// (3 presses with a monitor plugged in); the box shows it and keeps two hashes, never the code:
// one keys the claim handshake, the other names the `.com` mailbox. So the box cannot show the
// same code twice: asking again draws a new one, which also kills the old.
//
// The code ratchets: a claim, a reset, a key change, a wipe or its expiry throws it away. It is
// single use: the claim it opens ratchets it.

import {
  BOX_SETUP_CODE_TTL_MS,
  generateSetupCode,
  setupCodeKey,
  setupCodeMailboxId,
} from "@flagship/protocol";
import { readStateFile, removeDurable, writeFileDurable } from "../durableFile.js";

export type SetupCodeRatchet = "shown-again" | "claim" | "reset" | "key-change" | "wipe" | "expired";

export interface LiveSetupCode {
  codeKey: Uint8Array;
  mailboxId: string;
  shownAt: number;
  expiresAt: number;
}

interface Stored {
  v: 1;
  codeKeyHex: string;
  mailboxId: string;
  shownAt: number;
  expiresAt: number;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class SetupCodeStore {
  constructor(
    private readonly path: string,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** The live code's hashes, or null. An expired or unreadable code is thrown away. */
  async current(now: number): Promise<LiveSetupCode | null> {
    const r = await readStateFile(this.path);
    if (r.kind === "missing") return null;
    let s: Stored | null = null;
    if (r.kind === "ok") {
      try {
        const o = JSON.parse(r.text) as Stored;
        if (o.v === 1 && /^[0-9a-f]{64}$/.test(o.codeKeyHex) && /^[0-9a-f]{64}$/.test(o.mailboxId) && Number.isSafeInteger(o.expiresAt)) s = o;
      } catch {
        s = null;
      }
    }
    if (!s || now >= s.expiresAt) {
      await this.ratchet(s ? "expired" : "wipe");
      return null;
    }
    return { codeKey: Uint8Array.from(Buffer.from(s.codeKeyHex, "hex")), mailboxId: s.mailboxId, shownAt: s.shownAt, expiresAt: s.expiresAt };
  }

  /** Draws a fresh code, keeps its hashes and returns the code itself for the screen only. */
  async issue(now: number): Promise<{ code: string; live: LiveSetupCode }> {
    const code = generateSetupCode();
    const live: LiveSetupCode = { codeKey: setupCodeKey(code), mailboxId: setupCodeMailboxId(code), shownAt: now, expiresAt: now + BOX_SETUP_CODE_TTL_MS };
    const s: Stored = { v: 1, codeKeyHex: hex(live.codeKey), mailboxId: live.mailboxId, shownAt: now, expiresAt: live.expiresAt };
    await writeFileDurable(this.path, JSON.stringify(s));
    return { code, live };
  }

  async ratchet(why: SetupCodeRatchet): Promise<void> {
    await removeDurable(this.path);
    this.log(`[retail] setup code thrown away (${why})`);
  }
}
