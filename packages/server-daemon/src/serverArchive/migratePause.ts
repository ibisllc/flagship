/**
 * Migrate's pause (docs/server-migration.md, "Data path"): while a server
 * moves to new hardware its apps are paused (`docker pause`, so nothing
 * writes after the backup is made; Postgres and the files folders stay
 * readable), and every app URL answers with a calm "moving" page instead of
 * a 502. A marker on disk keeps the pause across a daemon restart; Resume
 * (an abort) or 24 hours without a freeze lifts it.
 */
import { readFile } from "node:fs/promises";
import { removeDurable, writeFileDurable } from "../durableFile.js";
import type { HttpResponse } from "../runtime.js";

export const PAUSE_MAX_MS = 24 * 60 * 60_000;

export interface MigratePauseMarker {
  pausedAt: number;
  /** The backup made for the move (pinned until the move ends). */
  archiveId: string | null;
  containers: string[];
}

export interface MigratePauseOptions {
  path: string;
  /** Running app containers to pause. */
  containers: () => Promise<string[]> | string[];
  run: (args: string[]) => Promise<void>;
  /** True once the old box is being retired (frozen + handed off): the pause then never lifts by itself. */
  frozen?: () => boolean;
  note?: (kind: string, detail: string, ok?: boolean) => void;
  now?: () => number;
  log?: (m: string) => void;
}

export function movingPage(): HttpResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Moving to a new server</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a}
@media (prefers-color-scheme: dark){body{background:#0b1220;color:#e2e8f0}}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#64748b}</style>
<meta http-equiv="refresh" content="30"></head>
<body><main><h1>This app is moving to a new server</h1><p>It will be back shortly. This page checks again on its own.</p></main></body></html>`;
  return {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60", "cache-control": "no-store", "x-frame-options": "DENY" },
    body,
  };
}

export function buildMigratePause(opts: MigratePauseOptions) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let marker: MigratePauseMarker | null = null;

  async function save(): Promise<void> {
    if (marker) await writeFileDurable(opts.path, JSON.stringify(marker));
    else await removeDurable(opts.path).catch(() => {});
  }

  return {
    async load(): Promise<void> {
      try {
        const raw = JSON.parse(await readFile(opts.path, "utf8")) as MigratePauseMarker;
        if (typeof raw.pausedAt === "number" && Array.isArray(raw.containers)) marker = raw;
      } catch {
        marker = null;
      }
    },
    paused(): boolean {
      return marker !== null;
    },
    current(): MigratePauseMarker | null {
      return marker;
    },
    pinnedArchiveId(): string | null {
      return marker?.archiveId ?? null;
    },
    /** Pause every running app. Idempotent. */
    async pause(): Promise<void> {
      if (marker) return;
      const containers = [...(await opts.containers())];
      const paused: string[] = [];
      for (const c of containers) {
        try {
          await opts.run(["pause", c]);
          paused.push(c);
        } catch (e) {
          log(`[migrate] couldn't pause ${c}: ${(e as Error).message}`);
        }
      }
      marker = { pausedAt: now(), archiveId: null, containers: paused };
      await save();
      opts.note?.("server.migration.paused", "This server's apps are paused while it moves to a new server.");
    },
    async setArchive(archiveId: string): Promise<void> {
      if (!marker) return;
      marker.archiveId = archiveId;
      await save();
    },
    /** Unpause the apps and drop the marker (abort, or the move never froze). */
    async resume(reason: string): Promise<void> {
      if (!marker) return;
      for (const c of marker.containers) await opts.run(["unpause", c]).catch(() => {});
      marker = null;
      await save();
      opts.note?.("server.migration.resumed", reason);
    },
    /** The safety net: a pause that never reached the freeze lifts after a day. */
    async sweep(): Promise<void> {
      if (marker && !opts.frozen?.() && now() - marker.pausedAt > PAUSE_MAX_MS) {
        await this.resume("The move didn't finish within a day, so this server's apps are running again.");
      }
    },
  };
}

export type MigratePause = ReturnType<typeof buildMigratePause>;
