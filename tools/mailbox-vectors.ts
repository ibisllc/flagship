#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the hub's peer-backup mailboxes: mailbox ids, announcement canonical bytes and the announcement verdicts
 * (`apps/web/src/tunnel/mailboxRelay.ts` `verifyMailboxAnnouncements`). The TypeScript functions produce them; the Rust relay
 * (`flagship-relay` `mailbox`) must agree.
 *
 * Run:          npx tsx tools/mailbox-vectors.ts
 * CI freshness: npx tsx tools/mailbox-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalPbMailboxAnnounce, ed, pbMailboxEpoch, pbMailboxId } from "@flagship/protocol";
import { verifyMailboxAnnouncements } from "../apps/web/src/tunnel/mailboxRelay.js";

const OUT = resolve(import.meta.dirname, "..", "packages/tunnel-protocol/test-vectors/mailbox.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const seed = (v: number): Uint8Array => new Uint8Array(32).fill(v);
const NOW = 1_760_000_000_000;
const EPOCH = pbMailboxEpoch(NOW);

const pik = hex(ed.getPublicKey(seed(0x41)));
const other = hex(ed.getPublicKey(seed(0x42)));
const sign = (p: string, epoch: number, by: Uint8Array): string => hex(ed.sign(canonicalPbMailboxAnnounce(p, epoch), by));
const flip = (h: string): string => h.slice(0, -2) + (h.slice(-2) === "00" ? "01" : "00");

type Ann = { pikPubHex: string; epoch: number; sigHex: string };
const good = (epoch: number): Ann => ({ pikPubHex: pik, epoch, sigHex: sign(pik, epoch, seed(0x41)) });
const lists: Array<{ name: string; list: Ann[] }> = [
  { name: "the current epoch", list: [good(EPOCH)] },
  { name: "the previous epoch", list: [good(EPOCH - 1)] },
  { name: "the next epoch", list: [good(EPOCH + 1)] },
  { name: "two epochs old", list: [good(EPOCH - 2)] },
  { name: "two epochs ahead", list: [good(EPOCH + 2)] },
  { name: "two entries, both good", list: [good(EPOCH), good(EPOCH - 1)] },
  { name: "two entries, the second stale", list: [good(EPOCH), good(EPOCH - 5)] },
  { name: "a signature by another key", list: [{ pikPubHex: pik, epoch: EPOCH, sigHex: sign(pik, EPOCH, seed(0x42)) }] },
  { name: "a flipped signature bit", list: [{ ...good(EPOCH), sigHex: flip(good(EPOCH).sigHex) }] },
  { name: "a signature over another epoch", list: [{ pikPubHex: pik, epoch: EPOCH, sigHex: sign(pik, EPOCH - 1, seed(0x41)) }] },
  { name: "a different key claiming the first's signature", list: [{ pikPubHex: other, epoch: EPOCH, sigHex: good(EPOCH).sigHex }] },
  { name: "an empty list", list: [] },
];
const out = {
  schema: 1,
  now: NOW,
  epoch: EPOCH,
  piks: { pik, other },
  ids: [0, 1, 2, EPOCH, EPOCH + 1].map((e) => ({ pik, epoch: e, id: pbMailboxId(pik, e), canonical: Buffer.from(canonicalPbMailboxAnnounce(pik, e)).toString() })),
  lists: lists.map((l) => ({ ...l, ids: verifyMailboxAnnouncements(l.list as never, NOW) })),
};
const body = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== body) {
    console.error("mailbox vectors are stale: run npx tsx tools/mailbox-vectors.ts");
    process.exit(1);
  }
  console.log("mailbox vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
}
