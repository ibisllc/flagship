// The call screen (docs/voici-calls.md "Call screen") on a minimal fake DOM: the ringing stage and the call stage are
// full-screen modal dialogs with labelled round buttons, the call ends in Close / Call again, no Audio button shows
// where the browser can't pick an output, and the timer and the corner tile follow their rules.
import { describe, expect, it, vi } from "vitest";

// messages.js reads the built qrEncoder.js; the call screen needs only its openMessages.
vi.mock("../src/messages.js", () => ({ openMessages: () => {} }));
import { callElapsed, cornerAfterKey, nearestCorner, showIncomingRing } from "../src/call.js";

type Node = El | Txt;
class Txt {
  nodeType = 3;
  parent: El | null = null;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}
class Cls {
  set = new Set<string>();
  constructor(private el: El) {}
  sync() {
    this.el.attrs.set("class", [...this.set].join(" "));
  }
  add(...c: string[]) {
    for (const x of c) this.set.add(x);
    this.sync();
  }
  remove(...c: string[]) {
    for (const x of c) this.set.delete(x);
    this.sync();
  }
  toggle(c: string, force?: boolean) {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c);
    else this.set.delete(c);
    this.sync();
    return on;
  }
  contains(c: string) {
    return this.set.has(c);
  }
}
class El {
  nodeType = 1;
  attrs = new Map<string, string>();
  children: Node[] = [];
  parent: El | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  classList = new Cls(this);
  disabled = false;
  constructor(public tagName: string, public ownerDocument: Doc) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k === "class") this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get hidden() {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  appendChild(c: Node) {
    if (c.parent) c.parent.removeChild(c);
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: Node[]) {
    for (const c of cs) this.appendChild(c);
  }
  insertBefore(c: Node, ref: Node) {
    if (c.parent) c.parent.removeChild(c);
    c.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
  }
  removeChild(c: Node) {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
  }
  remove() {
    this.parent?.removeChild(this);
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  click() {
    for (const f of this.listeners.click ?? []) f({ target: this, preventDefault() {} });
  }
  contains(n: Node): boolean {
    return n === this || this.children.some((c) => c instanceof El && c.contains(n));
  }
  closest() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => (c instanceof El ? c.all() : []))];
  }
}
class Doc {
  activeElement: El | null = null;
  body = new El("body", this);
  createElement(t: string) {
    return new El(t, this);
  }
  createElementNS(_ns: string, t: string) {
    return new El(t, this);
  }
  createTextNode(s: string) {
    return new Txt(s);
  }
  addEventListener() {}
  removeEventListener() {}
}

const stageOf = (doc: Doc) => doc.body.children.find((c) => c instanceof El && c.classList.contains("call-stage")) as El | undefined;
const buttons = (el: El) => el.all().filter((x) => x.tagName === "button" && !x.hidden);
const labels = (el: El) => buttons(el).map((b) => b.textContent);

function ctx(win: Record<string, unknown> = {}) {
  const doc = new Doc();
  const page = { username: "ana", profile: { displayName: "Ana" }, avatarUrl: null, index: { pageId: "p1" } };
  const lib = {
    protocol: { voiciConv: () => "conv" },
    openVoiciRingHint: () => ({ pageId: "p1" }),
    threadSeedOf: () => new Uint8Array(32),
    VOICI_CALL_AUDIO: { audio: true },
  };
  const w = {
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })) } },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    ...win,
  };
  return { doc, win: w, lib, cfg: {}, page, store: null } as any;
}

describe("the call screen", () => {
  it("rings as a full-screen dialog with Decline and Answer, and Decline closes it", () => {
    const c = ctx();
    showIncomingRing(c, { pageId: "p1", pseudonymPub: "x" }, { ringId: "r", hint: "h" });
    const stage = stageOf(c.doc)!;
    expect(stage.getAttribute("role")).toBe("dialog");
    expect(stage.getAttribute("aria-modal")).toBe("true");
    expect(stage.getAttribute("aria-labelledby")).toBe("call-stage-name");
    expect(stage.all().find((x) => x.getAttribute("id") === "call-stage-name")?.textContent).toBe("Ana");
    expect(labels(stage)).toEqual(["Decline", "Answer"]);
    expect(c.doc.activeElement?.textContent).toBe("Answer");
    expect(c.doc.body.classList.contains("has-call")).toBe(true);
    buttons(stage)[0]!.click();
    expect(stageOf(c.doc)).toBeUndefined();
    expect(c.doc.body.classList.contains("has-call")).toBe(false);
  });

  it("a call the microphone refused ends on the stage with its sentence, Close and Call again", async () => {
    const c = ctx();
    const ring = { ringId: "r", hint: "h" };
    showIncomingRing(c, { pageId: "p1", pseudonymPub: "x" }, ring);
    buttons(stageOf(c.doc)!)[1]!.click();
    await new Promise((r) => setTimeout(r, 0));
    const stage = stageOf(c.doc)!;
    expect(stage.classList.contains("is-over")).toBe(true);
    expect(stage.textContent).toContain("voi.ci needs your microphone for the call.");
    expect(stage.textContent).toContain("End-to-end encrypted · quantum-safe");
    expect(labels(stage)).toEqual(["Close", "Call again"]);
    const status = stage.all().find((x) => x.classList.contains("call-status"))!;
    expect(status.getAttribute("role")).toBe("status");
    buttons(stage)[0]!.click();
    expect(stageOf(c.doc)).toBeUndefined();
  });

  it("offers Audio only where the browser can pick where the sound plays", async () => {
    const withSink = ctx();
    // The microphone stays pending, so the stage is caught mid-call with all its controls.
    withSink.win.navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    withSink.win.navigator.mediaDevices.selectAudioOutput = async () => ({ deviceId: "x" });
    const proto = (El.prototype as any);
    proto.setSinkId = async () => {};
    try {
      showIncomingRing(withSink, { pageId: "p1", pseudonymPub: "x" }, { ringId: "r", hint: "h" });
      buttons(stageOf(withSink.doc)!)[1]!.click();
      expect(labels(stageOf(withSink.doc)!)).toEqual(["Audio", "Mute", "End"]);
    } finally {
      delete proto.setSinkId;
    }
    const without = ctx();
    without.win.navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    showIncomingRing(without, { pageId: "p1", pseudonymPub: "x" }, { ringId: "r", hint: "h" });
    buttons(stageOf(without.doc)!)[1]!.click();
    const stage = stageOf(without.doc)!;
    expect(labels(stage)).toEqual(["Mute", "End"]);
    const mute = buttons(stage)[0]!;
    mute.click();
    expect(mute.textContent).toBe("Unmute");
    expect(mute.classList.contains("is-on")).toBe(true);
    expect(stage.all().find((x) => x.tagName === "video" && x.classList.contains("call-self"))?.getAttribute("aria-label")).toBe("Your camera");
    expect(stage.all().find((x) => x.tagName === "video" && x.classList.contains("call-remote"))?.getAttribute("aria-label")).toBe("Their camera");
  });

  it("times m:ss, then h:mm:ss after an hour", () => {
    expect(callElapsed(0)).toBe("0:00");
    expect(callElapsed(7_900)).toBe("0:07");
    expect(callElapsed(725_000)).toBe("12:05");
    expect(callElapsed(3_723_000)).toBe("1:02:03");
    expect(callElapsed(-1)).toBe("0:00");
  });

  it("the corner tile goes to the nearest corner, or the one an arrow key points to", () => {
    expect(nearestCorner(10, 10, 400, 800)).toBe("tl");
    expect(nearestCorner(390, 10, 400, 800)).toBe("tr");
    expect(nearestCorner(10, 790, 400, 800)).toBe("bl");
    expect(nearestCorner(390, 790, 400, 800)).toBe("br");
    expect(cornerAfterKey("tr", "ArrowLeft")).toBe("tl");
    expect(cornerAfterKey("tr", "ArrowDown")).toBe("br");
    expect(cornerAfterKey("bl", "ArrowUp")).toBe("tl");
    expect(cornerAfterKey("bl", "ArrowRight")).toBe("br");
    expect(cornerAfterKey("bl", "Enter")).toBe("bl");
  });
});
