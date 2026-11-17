// The Calls page, behind the Social page's round call button (docs/voici-calls.md "Calling from the app",
// docs/social-tabs.md): "Who to call" on top (a voi.ci username or link today, phone numbers later), then the call
// history: calls this browser placed and the page's missed calls, newest first. A page this account knows can be called again from its row (a voi.ci tab takes the call); a
// visitor's missed call opens their conversation (calling a visitor back waits on the owner's decision).

import { $, registerView, show } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { formatWhen } from "../lib/dateFormat.js";
import { refreshWorld, visitorName, world } from "../lib/voiciWorld.js";
import { voiciErrorText } from "../lib/voiciCopy.js";
import { callHistory, callTargetUsername, isCallablePeer, resolveCallTarget, startHandoffCall } from "../lib/voiciCallOut.js";
import { markCallsSeen } from "../lib/socialCounts.js";
import { postAnonBlock, voiciWebOrigin } from "../lib/voiciOwner.js";
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

/** The text typed into Who to call survives a redraw of the page. */
let target = "";

const TARGET_PROBLEM = {
  "bad-target": () => tr("Enter a voi.ci username, like voi.ci/alex."),
  "no-page": (u) => tr("There's no page at voi.ci/{0}.", u),
  "calls-off": (u) => tr("voi.ci/{0} doesn't take calls.", u),
};

/** "Who to call" with Call and Video call. The voi.ci tab is opened on the tap (a browser allows a new tab only then);
 *  the page is checked under its account's key meanwhile, and the tab closes again if it can't be called. */
function whoToCall(doc = document) {
  const card = doc.createElement("div");
  card.className = "card stack-sm";
  card.setAttribute("data-testid", "calls-who");
  const label = doc.createElement("label");
  label.className = "field-label";
  label.htmlFor = "calls-target";
  label.textContent = tr("Who to call");
  const input = doc.createElement("input");
  input.type = "text";
  input.id = "calls-target";
  input.setAttribute("data-testid", "calls-target");
  input.autocomplete = "off";
  input.autocapitalize = "none";
  input.spellcheck = false;
  input.placeholder = tr("Username or voi.ci link");
  input.value = target;
  const problem = doc.createElement("p");
  problem.className = "note err hidden";
  problem.setAttribute("role", "alert");
  problem.setAttribute("data-testid", "calls-target-problem");
  const row = doc.createElement("div");
  row.className = "row-2";
  const buttons = [];
  for (const [media, text, cls] of [
    ["audio", tr("Call"), "primary"],
    ["audio,video", tr("Video call"), "secondary"],
  ]) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.setAttribute("data-testid", media === "audio" ? "calls-target-audio" : "calls-target-video");
    b.addEventListener("click", () => void call(media));
    buttons.push(b);
    row.appendChild(b);
  }
  const sync = () => buttons.forEach((b) => (b.disabled = !input.value.trim()));
  input.addEventListener("input", () => {
    target = input.value;
    problem.classList.add("hidden");
    sync();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void call("audio");
    }
  });
  sync();
  const say = (text) => {
    problem.textContent = text;
    problem.classList.toggle("hidden", !text);
  };
  async function call(media) {
    if (!input.value.trim()) return;
    if (!callTargetUsername(input.value, new URL(voiciWebOrigin()).host)) {
      say(TARGET_PROBLEM["bad-target"]());
      return;
    }
    const win = globalThis.open("", "_blank");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const r = await resolveCallTarget(input.value);
      if (!r.ok) {
        win?.close();
        say(TARGET_PROBLEM[r.code](r.username ?? ""));
        return;
      }
      say("");
      await startHandoffCall(r.page, media, { open: () => win });
      toast(tr("The call continues in the voi.ci tab."));
    } catch (e) {
      win?.close();
      toast(e?.code === "popup-blocked" ? tr("Allow pop-ups for Flagship to make calls from here.") : voiciErrorText(e), "err");
    } finally {
      sync();
    }
  }
  card.append(label, input, row, problem);
  return card;
}

export function renderCalls() {
  const root = $("calls-content");
  if (!root) return;
  const typing = document.activeElement?.id === "calls-target";
  root.replaceChildren(whoToCall());
  if (typing) $("calls-target")?.focus({ preventScroll: true });
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
  // Every missed call so far counts as seen once this page is open (the Social call button's count).
  markCallsSeen();
  renderCalls();
  try {
    await refreshWorld();
  } catch {
    /* the local history still shows */
  }
  markCallsSeen();
  renderCalls();
}

export function initCallsView() {
  $("calls-back")?.addEventListener("click", () => {
    markCallsSeen();
    void import("./messages.js").then((m) => m.enterMessages());
  });
}
