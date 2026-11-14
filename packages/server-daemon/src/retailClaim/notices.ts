// What the owner hears from a claimed retail box (docs/retail-box-setup.md §7.5): an Activity entry,
// a phone alert and a content-free push when someone opens the reset window. The phones word it
// from the Activity kind and the alert kind, in the owner's language; the box's detail line is the
// log's English, as for every Activity entry.

import { BOX_CLAIM_RESET_WINDOW_MS } from "@flagship/protocol";
import type { ClaimEvent } from "./claimService.js";

export const RESET_WINDOW_OPENED = "server.retail.reset-window-opened";
export const RESET_WINDOW_CLOSED = "server.retail.reset-window-closed";
export const RETAIL_WIPE_STARTED = "server.retail.wipe-started";

export interface RetailNoticeDeps {
  note: (kind: string, detail: string, opts: { ok?: boolean }) => void;
  alert?: (a: { kind: "reset-window-opened"; serviceId: ""; at: number; until: number }) => void;
  wake?: () => Promise<unknown>;
  now?: () => number;
}

export function retailNotices(d: RetailNoticeDeps): (e: ClaimEvent) => void {
  const now = d.now ?? Date.now;
  return (e) => {
    switch (e) {
      case "reset-window-opened": {
        const at = now();
        d.note(RESET_WINDOW_OPENED, "The power button was pressed 5 times: the reset window is open for 10 minutes. Nothing changes unless someone sets the server up in that time.", { ok: false });
        d.alert?.({ kind: "reset-window-opened", serviceId: "", at, until: at + BOX_CLAIM_RESET_WINDOW_MS });
        void d.wake?.().catch(() => {});
        return;
      }
      case "reset-window-closed":
        d.note(RESET_WINDOW_CLOSED, "The reset window closed with no new setup. Nothing changed.", {});
        return;
      case "locked":
        d.note(RETAIL_WIPE_STARTED, "The server is being wiped for a new owner.", { ok: false });
        return;
      default:
        return;
    }
  };
}
