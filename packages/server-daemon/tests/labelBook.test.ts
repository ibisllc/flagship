import { describe, expect, it } from "vitest";
import {
  addLabel,
  deserialize,
  emptyLabelBook,
  entriesForApp,
  lookup,
  removeLabel,
  serialize,
  type LabelBook,
  type LabelEntry,
} from "../src/labelBook.js";

const APP_A = "alice--chat";
const APP_B = "alice--photos";
const TAG_1 = "00112233445566778899aabbccddeeff";
const TAG_2 = "ffeeddccbbaa99887766554433221100";

function entry(over: Partial<LabelEntry> = {}): LabelEntry {
  return {
    displayName: "John (work)",
    channel: "imessage",
    sentTo: "+1***5309",
    sentAt: 1715000000000,
    notes: "office onboarding",
    ...over,
  };
}

describe("labelBook helpers", () => {
  it("addLabel + lookup happy path", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_1, entry({ displayName: "John (work)" }));
    expect(lookup(book, APP_A, TAG_1)?.displayName).toBe("John (work)");
    expect(lookup(book, APP_A, "deadbeef".repeat(4))).toBeUndefined();
    expect(lookup(book, APP_B, TAG_1)).toBeUndefined();
  });

  it("addLabel is immutable — original book is unchanged", () => {
    const original = emptyLabelBook();
    const updated = addLabel(original, APP_A, TAG_1, entry());
    expect(original.size).toBe(0);
    expect(updated.size).toBe(1);
    expect(lookup(updated, APP_A, TAG_1)).not.toBeUndefined();
  });

  it("addLabel normalizes hex case (callers can pass uppercase)", () => {
    let book = emptyLabelBook();
    const TAG_UPPER = TAG_1.toUpperCase();
    book = addLabel(book, APP_A, TAG_UPPER, entry({ displayName: "Jane" }));
    expect(lookup(book, APP_A, TAG_UPPER)?.displayName).toBe("Jane");
    expect(lookup(book, APP_A, TAG_1)?.displayName).toBe("Jane");
  });

  it("addLabel overwrites existing entry", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_1, entry({ displayName: "v1" }));
    book = addLabel(book, APP_A, TAG_1, entry({ displayName: "v2" }));
    expect(entriesForApp(book, APP_A)).toHaveLength(1);
    expect(lookup(book, APP_A, TAG_1)?.displayName).toBe("v2");
  });

  it("removeLabel deletes and is idempotent", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_1, entry({ displayName: "John" }));
    book = addLabel(book, APP_A, TAG_2, entry({ displayName: "Jane" }));
    book = removeLabel(book, APP_A, TAG_1);
    expect(lookup(book, APP_A, TAG_1)).toBeUndefined();
    expect(lookup(book, APP_A, TAG_2)).not.toBeUndefined();
    // removing the same tag again is a no-op
    book = removeLabel(book, APP_A, TAG_1);
    expect(entriesForApp(book, APP_A)).toHaveLength(1);
    // removing the LAST tag of an app drops the appId key
    book = removeLabel(book, APP_A, TAG_2);
    expect(book.has(APP_A)).toBe(false);
  });

  it("serialize → deserialize roundtrip preserves every field", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_1, {
      displayName: "John (work)",
      channel: "imessage",
      sentTo: "imsg-only",
      sentAt: 1715000000000,
      notes: "onboarding note",
    });
    book = addLabel(book, APP_B, TAG_2, {
      displayName: "Jane (qr scan)",
      channel: "qr",
      sentTo: "",
      sentAt: 1715000001000,
      notes: "",
    });
    const bytes = serialize(book);
    const restored = deserialize(bytes);
    expect(lookup(restored, APP_A, TAG_1)).toEqual({
      displayName: "John (work)",
      channel: "imessage",
      sentTo: "imsg-only",
      sentAt: 1715000000000,
      notes: "onboarding note",
    });
    expect(lookup(restored, APP_B, TAG_2)).toEqual({
      displayName: "Jane (qr scan)",
      channel: "qr",
      sentTo: "",
      sentAt: 1715000001000,
      notes: "",
    });
  });

  it("serialize is deterministic across logically-equal books", () => {
    let bookA: LabelBook = emptyLabelBook();
    let bookB: LabelBook = emptyLabelBook();
    // Insert in different orders.
    bookA = addLabel(bookA, APP_B, TAG_2, entry({ displayName: "Jane" }));
    bookA = addLabel(bookA, APP_A, TAG_1, entry({ displayName: "John" }));
    bookB = addLabel(bookB, APP_A, TAG_1, entry({ displayName: "John" }));
    bookB = addLabel(bookB, APP_B, TAG_2, entry({ displayName: "Jane" }));
    const ba = serialize(bookA);
    const bb = serialize(bookB);
    expect(ba).toEqual(bb);
  });

  it("additive updates: adding entries to a serialized book and re-serializing produces a stable suffix", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_1, entry({ displayName: "John" }));
    const b1 = serialize(book);
    const restored = deserialize(b1);
    const augmented = addLabel(restored, APP_A, TAG_2, entry({ displayName: "Jane" }));
    const b2 = serialize(augmented);
    const restored2 = deserialize(b2);
    expect(lookup(restored2, APP_A, TAG_1)?.displayName).toBe("John");
    expect(lookup(restored2, APP_A, TAG_2)?.displayName).toBe("Jane");
  });

  it("deserialize of garbage returns an empty book (graceful)", () => {
    expect(deserialize(new Uint8Array([0, 1, 2, 3])).size).toBe(0);
    expect(deserialize(new TextEncoder().encode("not json")).size).toBe(0);
    expect(deserialize(new Uint8Array(0)).size).toBe(0);
  });

  it("deserialize rejects unknown version field gracefully", () => {
    const fake = new TextEncoder().encode(
      "flagship/label-book/v1\n" + JSON.stringify({ v: 99, apps: [] }),
    );
    expect(deserialize(fake).size).toBe(0);
  });

  it("deserialize drops malformed tag hex entries", () => {
    const fake = new TextEncoder().encode(
      "flagship/label-book/v1\n" +
        JSON.stringify({
          v: 1,
          apps: [
            {
              appId: APP_A,
              entries: [
                { tag: "not-hex", entry: entry({ displayName: "should drop" }) },
                { tag: TAG_1, entry: entry({ displayName: "should keep" }) },
              ],
            },
          ],
        }),
    );
    const book = deserialize(fake);
    expect(entriesForApp(book, APP_A)).toHaveLength(1);
    expect(lookup(book, APP_A, TAG_1)?.displayName).toBe("should keep");
  });

  it("addLabel clamps overlong fields (bounded sizes)", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_1, {
      displayName: "x".repeat(500),
      channel: "imessage",
      sentTo: "y".repeat(500),
      sentAt: 1,
      notes: "z".repeat(5000),
    });
    const e = lookup(book, APP_A, TAG_1)!;
    expect(e.displayName.length).toBe(200);
    expect(e.sentTo.length).toBe(280);
    expect(e.notes.length).toBe(2000);
  });

  it("invalid appId / tag are rejected on write", () => {
    expect(() => addLabel(emptyLabelBook(), "\x00bad", TAG_1, entry())).toThrow();
    expect(() => addLabel(emptyLabelBook(), APP_A, "zzzz", entry())).toThrow();
    expect(() => addLabel(emptyLabelBook(), APP_A, "abcd", entry())).toThrow();
  });

  it("invalid channel is coerced to 'other'", () => {
    let book = emptyLabelBook();
    // @ts-expect-error — deliberately wrong channel
    book = addLabel(book, APP_A, TAG_1, entry({ channel: "telex" }));
    expect(lookup(book, APP_A, TAG_1)?.channel).toBe("other");
  });

  it("entriesForApp returns a sorted, mutation-isolated snapshot", () => {
    let book = emptyLabelBook();
    book = addLabel(book, APP_A, TAG_2, entry({ displayName: "Jane" }));
    book = addLabel(book, APP_A, TAG_1, entry({ displayName: "John" }));
    const list = entriesForApp(book, APP_A);
    expect(list.map((e) => e.opaqueTag)).toEqual([TAG_1, TAG_2]);
    list[0]!.entry.displayName = "MUTATED";
    expect(lookup(book, APP_A, TAG_1)?.displayName).toBe("John");
  });
});
