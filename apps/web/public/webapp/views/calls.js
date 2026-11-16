// The call history (docs/voici-calls.md "Calling from the app"): calls this browser placed and the page's missed
// calls, newest first. A page this account knows can be called again from its row (a voi.ci tab takes the call); a
// visitor's missed call opens their conversation (calling a visitor back waits on the owner's decision).

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { formatWhen } from "../lib/dateFormat.js";
import { refreshWorld, visitorName, world } from "../lib/voiciWorld.js";
import { voiciErrorText } from "../lib/voiciCopy.js";
import { callHistory, isCallablePeer, startHandoffCall } from "../lib/voiciCallOut.js";
import { postAnonBlock } from "../lib/voiciOwner.js";
import { tr } from "../lib/i18n.js";

registerView("view-calls", { tab: "messages" });

function outcomeLine(r) {
  if (r.direction === "in") return r.video ? tr("Missed video call") : tr("Missed call");
  return r.video ? tr("Outgoing video call") : tr("Outgoing call");
}

/** A Call / Video call pair for a page this account knows. */
export function callButtons(page, doc = document) {
  const wrap = doc.createElement("span");
  wrap.className = "row-actions";
  for (const [media, label] of [
    ["audio", tr("Call")],
    ["audio,video", tr("Video call")],
  ]) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "secondary";
    b.textContent = label;
    b.setAttribute("data-call-page", page.username);
    b.setAttribute("data-call-media", media);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      startHandoffCall(page, media)
        .then(() => toast(tr("The call continues in the voi.ci tab.")))
        .catch((e) => toast(e?.code === "popup-blocked" ? tr("Allow pop-ups for Flagship to make calls from here.") : voiciErrorText(e), "err"));
    });
    wrap.appendChild(b);
  }
  return wrap;
}

export function renderCalls() {
  const root = $("calls-content");
  if (!root) return;
  root.replaceChildren();
  const rows = callHistory(world.missedCalls);
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = tr("No calls yet.");
    root.appendChild(p);
    return;
  }
  const card = document.createElement("div");
  card.className = "card stack-sm";
  card.setAttribute("data-testid", "calls-history");
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("data-call-row", r.id);
    const body = document.createElement("span");
    body.className = "fs-row-body";
    const title = document.createElement("span");
    title.className = "fs-row-title";
    title.textContent = r.peer.kind === "page" ? `voi.ci/${r.peer.username}` : r.peer.anonymous ? tr("Anonymous caller") : visitorName(r.peer.pseudonymPub);
    const sub = document.createElement("span");
    sub.className = "fs-row-sub";
    sub.textContent = tr("{0} · {1}", outcomeLine(r), formatWhen(r.at));
    body.append(title, sub);
    row.appendChild(body);
    if (isCallablePeer(r.peer)) row.appendChild(callButtons(r.peer));
    else if (r.peer.anonymous) {
      // An anonymous caller: the owner can block its conversation (its browser key) until unblocking it.
      const blocked = world.anonBlocks.includes(r.peer.conv);
      const b = document.createElement("button");
      b.type = "button";
      b.className = blocked ? "secondary" : "danger";
      b.setAttribute("data-anon-block", r.peer.conv);
      b.textContent = blocked ? tr("Unblock") : tr("Block");
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await postAnonBlock(world.page, r.peer.conv, blocked ? "unblock" : "block");
          world.anonBlocks = blocked ? world.anonBlocks.filter((c) => c !== r.peer.conv) : [...world.anonBlocks, r.peer.conv];
          renderCalls();
        } catch (e) {
          b.disabled = false;
          toast(voiciErrorText(e), "err");
        }
      });
      row.appendChild(b);
    } else if (r.peer.kind === "visitor") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "secondary";
      open.textContent = tr("Open conversation");
      open.addEventListener("click", () => void import("./thread.js").then((m) => m.enterThread(r.peer.conv)));
      row.appendChild(open);
    }
    card.appendChild(row);
  }
  root.appendChild(card);
}

export async function enterCalls() {
  show("view-calls");
  renderCalls();
  try {
    await refreshWorld();
  } catch {
    /* the local history still shows */
  }
  renderCalls();
}

export function initCallsView() {
  $("calls-back")?.addEventListener("click", () => void import("./messages.js").then((m) => m.enterMessages()));
}
