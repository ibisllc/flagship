// The power key on a retail box (docs/retail-box-setup.md §7.5): logind ignores it (the drop-in
// below), and this service reads KEY_POWER from evdev and counts bursts of short presses. A burst
// of 1 answers the claim's timed press, 3 shows the setup code on a monitor, 5 opens the reset
// window. A hold of about 4 s is a firmware hard off the OS never sees.

import { existsSync } from "node:fs";
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import {
  POWER_KEY_BOOT_IGNORE_MS,
  POWER_KEY_BURST_END_MS,
  POWER_KEY_BURST_GAP_MS,
  POWER_KEY_SHORT_PRESS_MS,
} from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";
import type { CommandRunner } from "../serviceRunner.js";

export interface PowerKeyBurst {
  count: number;
  /** A press in the burst was held longer than a short press. */
  long: boolean;
  /** When the first press went down. */
  startedAt: number;
  /** When the last press came up. */
  endedAt: number;
}

/**
 * Pure burst counter. Feed it key edges and `tick` it; it calls `onBurst` once a burst has been
 * quiet for `POWER_KEY_BURST_END_MS`. Presses that go down within the first
 * `POWER_KEY_BOOT_IGNORE_MS` after `startedAt` are bounce from power-on and never counted.
 */
export class PowerKeyBursts {
  private down: number | null = null;
  private burst: PowerKeyBurst | null = null;

  constructor(
    private readonly startedAt: number,
    private readonly onBurst: (b: PowerKeyBurst) => void,
  ) {}

  keyDown(at: number): void {
    if (this.down !== null) return;
    if (at - this.startedAt < POWER_KEY_BOOT_IGNORE_MS) return;
    if (this.burst && at - this.burst.endedAt >= POWER_KEY_BURST_GAP_MS) this.flush();
    this.down = at;
  }

  keyUp(at: number): void {
    if (this.down === null) return;
    const long = at - this.down > POWER_KEY_SHORT_PRESS_MS;
    if (this.burst) {
      this.burst.count++;
      this.burst.long ||= long;
      this.burst.endedAt = at;
    } else {
      this.burst = { count: 1, long, startedAt: this.down, endedAt: at };
    }
    this.down = null;
  }

  tick(now: number): void {
    if (this.down === null && this.burst && now - this.burst.endedAt >= POWER_KEY_BURST_END_MS) this.flush();
  }

  private flush(): void {
    const b = this.burst;
    this.burst = null;
    if (b) this.onBurst(b);
  }
}

/** Where key edges come from: evdev on a box, a script in tests. */
export interface PowerKeySource {
  start(edge: (kind: "down" | "up") => void): Promise<void>;
  stop(): Promise<void>;
}

/** A source tests drive by hand. */
export class FakePowerKeySource implements PowerKeySource {
  private edge: ((kind: "down" | "up") => void) | null = null;
  async start(edge: (kind: "down" | "up") => void): Promise<void> {
    this.edge = edge;
  }
  async stop(): Promise<void> {
    this.edge = null;
  }
  down(): void {
    this.edge?.("down");
  }
  up(): void {
    this.edge?.("up");
  }
}

export const EV_KEY = 1;
export const KEY_POWER = 116;
/** `struct input_event` on 64-bit Linux: timeval (16), type u16, code u16, value s32. */
export const INPUT_EVENT_SIZE = 24;

/** Key edges for KEY_POWER in a chunk of evdev bytes (whole events only; repeats dropped). */
export function parsePowerKeyEvents(buf: Uint8Array, eventSize = INPUT_EVENT_SIZE): Array<"down" | "up"> {
  const out: Array<"down" | "up"> = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const off = eventSize - 8;
  for (let o = 0; o + eventSize <= buf.length; o += eventSize) {
    const type = view.getUint16(o + off, true);
    const code = view.getUint16(o + off + 2, true);
    const value = view.getInt32(o + off + 4, true);
    if (type !== EV_KEY || code !== KEY_POWER) continue;
    if (value === 1) out.push("down");
    else if (value === 0) out.push("up");
  }
  return out;
}

const POWER_BUTTON_NAMES = new Set(["Power Button", "pwr_button"]);

/** Event nodes of the ACPI "Power Button" devices (or the Pi 5's `pwr_button`) in /proc/bus/input/devices. */
export function findPowerButtonEvents(procDevices: string): string[] {
  const out: string[] = [];
  for (const block of procDevices.split(/\n\s*\n/)) {
    const name = /^N: Name="([^"]*)"/m.exec(block)?.[1];
    if (!name || !POWER_BUTTON_NAMES.has(name)) continue;
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1] ?? "";
    for (const h of handlers.split(/\s+/)) if (/^event\d+$/.test(h)) out.push(`/dev/input/${h}`);
  }
  return out;
}

/**
 * Reads every power button node. ACPI boards often list two ("Power Button" for PNP0C0C and the
 * fixed-feature LNXPWRBN); a down while one is already down is the same press.
 */
export class EvdevPowerKeySource implements PowerKeySource {
  private handles: FileHandle[] = [];
  private running = false;
  private isDown = false;

  constructor(private readonly opts: { procPath?: string; log?: (m: string) => void } = {}) {}

  async start(edge: (kind: "down" | "up") => void): Promise<void> {
    const procPath = this.opts.procPath ?? "/proc/bus/input/devices";
    const nodes = existsSync(procPath) ? findPowerButtonEvents(await readFile(procPath, "utf-8")) : [];
    if (nodes.length === 0) {
      this.opts.log?.("[retail] no power button input device found; button gestures are off");
      return;
    }
    this.running = true;
    for (const node of nodes) {
      const fh = await open(node, "r");
      this.handles.push(fh);
      void this.pump(fh, edge);
    }
  }

  private async pump(fh: FileHandle, edge: (kind: "down" | "up") => void): Promise<void> {
    const buf = new Uint8Array(INPUT_EVENT_SIZE * 16);
    while (this.running) {
      let n: number;
      try {
        ({ bytesRead: n } = await fh.read(buf, 0, buf.length, null));
      } catch {
        return;
      }
      if (n === 0) return;
      for (const e of parsePowerKeyEvents(buf.subarray(0, n))) {
        if (e === "down" && this.isDown) continue;
        if (e === "up" && !this.isDown) continue;
        this.isDown = e === "down";
        edge(e);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.handles.map((h) => h.close().catch(() => {})));
    this.handles = [];
  }
}

export const LOGIND_DROP_IN_PATH = "/etc/systemd/logind.conf.d/50-flagship-power-key.conf";

/**
 * In the retail metal image from the first boot, so a short press never shuts the box down,
 * claimed or not. Never on a VM appliance: Studio stops a VM gracefully through the ACPI power
 * button, and ignoring it would leave only the forced stop that once corrupted a box mid-update.
 */
export const LOGIND_DROP_IN = `[Login]
HandlePowerKey=ignore
HandlePowerKeyLongPress=ignore
HandleRebootKey=ignore
HandleRebootKeyLongPress=ignore
HandleSuspendKey=ignore
HandleSuspendKeyLongPress=ignore
HandleHibernateKey=ignore
HandleHibernateKeyLongPress=ignore
`;

/** Writes the drop-in on a box whose image predates it and has logind reread its settings. */
export async function ensureLogindPowerKeyIgnored(
  cmd: CommandRunner,
  opts: { path?: string; log?: (m: string) => void } = {},
): Promise<"written" | "present" | "skipped"> {
  const path = opts.path ?? LOGIND_DROP_IN_PATH;
  const current = await readFile(path, "utf-8").catch(() => null);
  if (current === LOGIND_DROP_IN) return "present";
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFileDurable(path, LOGIND_DROP_IN, 0o644);
    await cmd.run("systemctl", ["kill", "-s", "HUP", "systemd-logind.service"]).catch(() => {});
    opts.log?.("[retail] the power key is now left to Flagship (logind ignores short presses)");
    return "written";
  } catch (e) {
    opts.log?.(`[retail] could not write ${path}: ${(e as Error).message}`);
    return "skipped";
  }
}
