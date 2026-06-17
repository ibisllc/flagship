// L7 — the toast surface is QUEUED + DEDUPED (was single-slot: a second toast
// clobbered the first). Mirrors iOS/Android ToastCenter: append to a queue,
// drop a publish whose (kind,message) already sits in the queue. Pins the pure
// queue core (enqueueToast) — the DOM render is the thin half.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadToast() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "toast.js");
  return import(pathToFileURL(path).href);
}

describe("toast — queue + dedupe (L7)", () => {
  it("queues distinct toasts instead of clobbering (the bug)", async () => {
    const { enqueueToast } = await loadToast();
    const q: Array<{ text: string; kind?: string }> = [];
    expect(enqueueToast(q, "first", "ok")).toBe(true);
    expect(enqueueToast(q, "second", "err")).toBe(true);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ text: "first", kind: "ok" });
    expect(q[1]).toMatchObject({ text: "second", kind: "err" });
  });

  it("dedupes an identical (text,kind) publish (ToastCenter parity)", async () => {
    const { enqueueToast } = await loadToast();
    const q: Array<{ text: string; kind?: string }> = [];
    expect(enqueueToast(q, "saving…", "ok")).toBe(true);
    // Same text + same kind already queued → dropped.
    expect(enqueueToast(q, "saving…", "ok")).toBe(false);
    expect(q).toHaveLength(1);
  });

  it("the SAME text with a DIFFERENT kind is not a duplicate", async () => {
    const { enqueueToast } = await loadToast();
    const q: Array<{ text: string; kind?: string }> = [];
    enqueueToast(q, "done", "ok");
    expect(enqueueToast(q, "done", "err")).toBe(true);
    expect(q).toHaveLength(2);
  });

  it("normalizes an absent kind so undefined-vs-missing still dedupes", async () => {
    const { enqueueToast } = await loadToast();
    const q: Array<{ text: string; kind?: string }> = [];
    expect(enqueueToast(q, "plain")).toBe(true);
    expect(enqueueToast(q, "plain")).toBe(false);
    expect(q).toHaveLength(1);
  });

  it("exports a live toastQueue starting empty", async () => {
    const { toastQueue } = await loadToast();
    expect(Array.isArray(toastQueue)).toBe(true);
    expect(toastQueue).toHaveLength(0);
  });

  it("toast() is a no-op without a document (SSR/test safety), API unchanged", async () => {
    const { toast } = await loadToast();
    // document is undefined in this node env — toast must not throw.
    expect(() => toast("hi", "ok")).not.toThrow();
  });
});
