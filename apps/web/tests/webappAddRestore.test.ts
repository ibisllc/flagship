// Home's "Add/Restore server" menu (Create a server, Co-manage a running
// server, Restore from backup), the restore chooser's sources, and the lock
// sweep that keeps every menu, dialog and sheet off the lock screen.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCK_VIEW_IDS, dismissOverlays, isLockView } from "../public/webapp/lib/lockSweep.js";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (...p: string[]) => readFileSync(resolve(WEBAPP, ...p), "utf8");
const IMPORT_SRC = read("views", "import-backup.js");

describe("the Add/Restore server menu", () => {
  const menu = IMPORT_SRC.slice(IMPORT_SRC.indexOf("export function openAddOrRestore"), IMPORT_SRC.indexOf("export const RESTORE_SOURCES"));

  it("is titled Add/Restore server and offers exactly three choices in order", () => {
    expect(IMPORT_SRC).toContain('export const ADD_IMPORT_LABEL = "+ Add/Restore server";');
    expect(menu).toContain('"Add or restore a server"');
    expect(menu).toContain('<h3 class="modal-title">${tr("Add/Restore server")}</h3>');
    const labels = [...menu.matchAll(/data-choice-(add|co-manage|restore)>([^<]+)</g)].map((m) => [m[1], m[2].replace(/^\$\{tr\("|"\)\}$/g, "")]);
    expect(labels).toEqual([
      ["add", "Create a server"],
      ["co-manage", "Co-manage a running server"],
      ["restore", "Restore from backup"],
    ]);
    expect(menu).not.toContain("data-choice-import");
    expect(menu).not.toContain("data-choice-peers");
  });

  it("the restore chooser has the file and other-servers sources, one line each, and no device copy in a browser", () => {
    expect(IMPORT_SRC).toContain('file: { title: tr("From a file"), description: tr("Pick a .flagship backup file.") }');
    expect(IMPORT_SRC).toContain('peers: { title: tr("From other servers"), description: tr("Rebuild a lost server from pieces other servers keep.") }');
    expect(IMPORT_SRC).toContain('"Restore from backup"');
    expect(IMPORT_SRC).not.toContain(`title: tr("From this device")`);
    expect(IMPORT_SRC).toMatch(/data-restore-file[\s\S]*openImportBackup\(\)/);
    expect(IMPORT_SRC).toMatch(/data-restore-peers[\s\S]*openRestoreFromPeers\(\)/);
  });

  it("keeps the admin-only gate on the chooser and on both flows", () => {
    const chooser = IMPORT_SRC.slice(IMPORT_SRC.indexOf("export function openRestoreChooser"));
    expect(chooser.slice(0, 200)).toContain("if (!canAddServers(getSession())) return refuseAddServer();");
    expect(IMPORT_SRC).toMatch(/export async function openImportBackup[\s\S]*?canAddServers\(session\)\) return refuseAddServer\(\)/);
    expect(IMPORT_SRC).toMatch(/export async function openRestoreFromPeers[\s\S]*?canAddServers\(session\)\) return refuseAddServer\(\)/);
  });
});

function fakeDoc(dialogs: number, overlays: number) {
  const removed: string[] = [];
  const mk = (name: string, open: boolean) => {
    const el = {
      open,
      closed: false,
      listeners: [] as string[],
      dispatchEvent(ev: { type: string }) { this.listeners.push(ev.type); return true; },
      close() { this.open = false; this.closed = true; },
      remove() { removed.push(name); },
    };
    return el;
  };
  const dlgs = Array.from({ length: dialogs }, (_, i) => mk(`dialog${i}`, true));
  const ovs = Array.from({ length: overlays }, (_, i) => mk(`overlay${i}`, true));
  const classes = new Set(["modal-open"]);
  const doc = {
    dispatched: [] as string[],
    dispatchEvent(ev: { type: string; key?: string }) { this.dispatched.push(`${ev.type}:${ev.key}`); return true; },
    querySelectorAll(sel: string) { return sel === "dialog" ? dlgs : sel === ".modal-overlay" ? ovs : []; },
    body: { classList: { remove: (c: string) => classes.delete(c), has: (c: string) => classes.has(c) } },
    activeElement: null,
  };
  return { doc, dlgs, ovs, removed, classes };
}

describe("the lock sweep", () => {
  it("names the lock surfaces", () => {
    expect([...LOCK_VIEW_IDS]).toEqual(["view-unlock", "view-pin-unlock", "view-bootstrap"]);
    expect(isLockView("view-unlock")).toBe(true);
    expect(isLockView("view-home")).toBe(false);
  });

  it("closes and removes every dialog and overlay and lets the prompts cancel", () => {
    const f = fakeDoc(2, 1);
    (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent = class { type = "keydown"; key: string; constructor(t: string, i: { key: string }) { this.type = t; this.key = i.key; } };
    dismissOverlays(f.doc as unknown as Document);
    expect(f.doc.dispatched).toEqual(["keydown:Escape"]);
    expect(f.dlgs.every((d) => d.closed && !d.open && d.listeners.includes("cancel"))).toBe(true);
    expect(f.removed.sort()).toEqual(["dialog0", "dialog1", "overlay0"]);
    expect(f.classes.has("modal-open")).toBe(false);
  });

  it("does nothing, and does not throw, with no document", () => {
    expect(() => dismissOverlays(null as unknown as Document)).not.toThrow();
    expect(() => dismissOverlays({} as unknown as Document)).not.toThrow();
  });

  it("the router sweeps before it shows a lock surface", () => {
    const router = read("lib", "router.js");
    expect(router).toContain('import { dismissOverlays, isLockView } from "./lockSweep.js";');
    expect(router).toMatch(/export function show\(id\) \{\s*\/\/[^\n]*\n\s*if \(isLockView\(id\)\) dismissOverlays\(\);\s*currentView = id;/);
  });

  it("is precached", () => {
    expect(read("service-worker.js")).toContain('"/lib/lockSweep.js"');
  });
});
