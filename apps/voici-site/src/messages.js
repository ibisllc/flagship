// "Send me a message" (docs/voici-and-messages.md §4.3, §6, §7, §8): the sign-in sheet (QR on a computer, an
// "Open Flagship" button on a phone, the 6-digit code), then the visitor's own thread with this page and the compose
// box. Everything the thread shows passed flagship-web's verifyThreadItem first (signature chain, then decryption
// with the thread key, then the inner schema and the text rules) and is put on screen as text.

import { h, replace, svg } from "./dom.js";
import { icon } from "./icons.js";
import { avatarEl, linkedText } from "./page.js";
import { formatTime, t } from "./i18n.js";
import { closeSheet, openSheet } from "./sheet.js";
import { encodeQr } from "./qrEncoder.js";

const POLL_MS = 15_000;
const POLL_MAX_MS = 120_000;
const LIVE_TTL_MS = 60_000;

export function visitorName(lib, pseudonymPub) {
  return t("Visitor {0}", lib.protocol.voiciPseudonymCode(pseudonymPub));
}

function qrSvg(doc, text) {
  const m = encodeQr(text, "M");
  const n = m.length;
  const q = 2;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x] === 1) d += `M${x + q} ${y + q}h1v1h-1z`;
  return svg(
    doc,
    "svg",
    { viewBox: `0 0 ${n + 2 * q} ${n + 2 * q}`, width: 232, height: 232, "shape-rendering": "crispEdges", "aria-hidden": "true", class: "qr" },
    svg(doc, "path", { d, fill: "currentColor" }),
  );
}

function prefersPhoneFlow(win) {
  try {
    return win.matchMedia("(pointer: coarse)").matches && win.matchMedia("(max-width: 900px)").matches;
  } catch {
    return false;
  }
}

/** The sentence for a refusal code (codes come from `.com`, the phone or the library; never shown raw). */
export function sendRefusal(code, o = {}) {
  switch (code) {
    case "rate-limited":
      return o.retryAfterSec ? t("Too many messages. Try again in about {0} minutes.", Math.max(1, Math.ceil(o.retryAfterSec / 60))) : t("Too many messages. Try again later.");
    case "awaiting-reply":
      return t("You can send more once they reply.");
    case "page-busy":
      return t("This page is getting a lot of messages. Try again later.");
    case "not-accepting":
      return t("They aren't accepting messages right now.");
    case "unreachable":
    case "unavailable":
      return t("Couldn't reach Flagship. Check your connection and try again.");
    case "too-long":
    case "too-large":
      return t("That message is too long.");
    case "empty":
    case "too-short":
      return t("Write a message first.");
    case "control":
    case "bidi":
    case "edge-invisible":
    case "surrogate":
    case "bom":
    case "not-nfc":
      return t("This message has characters that can't be sent.");
    default:
      return t("Couldn't send. Try again.");
  }
}

function signInRefusal(code) {
  switch (code) {
    case "expired":
      return t("The sign-in timed out. Start again.");
    case "unreachable":
    case "relay":
      return t("Couldn't reach Flagship. Check your connection and try again.");
    default:
      return t("Your app's answer couldn't be checked. Try again.");
  }
}

const STATUS_RANK = { sent: 1, delivered: 2, phone: 3 };
const statusLabel = (s) => (s === "phone" ? t("Delivered to their phone") : s === "delivered" ? t("Delivered") : t("Sent"));

/**
 * ctx = {doc, win, cfg, lib (flagship-web), store, page: {username, index, profile, avatarUrl}}.
 */
export async function openMessages(ctx) {
  const session = await ctx.lib.loadVoiciSession(ctx.store, ctx.page.index.pageId, { origin: ctx.cfg.origin });
  if (session) showThread(ctx, session);
  else showSignIn(ctx);
}

function showSignIn(ctx, notice) {
  const { doc, lib, cfg, page } = ctx;
  const sheet = openSheet(doc, { title: t("Sign in with Flagship"), onClose: () => flow.cancel() });
  const phoneFirst = prefersPhoneFlow(ctx.win);
  const qrBox = h(doc, "div", { class: "qr-tile" });
  const openBtn = h(doc, "a", { class: "btn btn-primary btn-wide", target: "_blank", rel: "noopener" }, icon(doc, "phone"), h(doc, "span", {}, t("Open Flagship")));
  const codeBox = h(doc, "div", { class: "pair-code", hidden: true });
  const status = h(doc, "p", { class: "status-line", role: "status" }, h(doc, "span", { class: "spinner", "aria-hidden": "true" }), t("Waiting for your app…"));
  const qrBlock = h(doc, "div", { class: "qr-block" }, qrBox, h(doc, "p", { class: "qr-caption" }, t("Scan with your phone's camera.")));
  replace(
    sheet.body,
    notice ? h(doc, "p", { class: "callout callout-warn" }, notice) : null,
    h(doc, "p", { class: "lede" }, t("To message {0}, approve this sign-in in your Flagship app.", page.profile.displayName)),
    phoneFirst ? openBtn : qrBlock,
    phoneFirst ? h(doc, "details", { class: "alt-flow" }, h(doc, "summary", {}, t("Show a QR code instead")), qrBlock) : h(doc, "p", { class: "alt-line" }, t("On this device?"), " ", openBtn),
    codeBox,
    status,
    h(
      doc,
      "ul",
      { class: "notes" },
      h(doc, "li", {}, icon(doc, "lock", "icon icon-sm"), t("You appear as a visitor with a name made for this page. They never see your username.")),
      h(doc, "li", {}, icon(doc, "flag", "icon icon-sm"), t("Messages are private. If someone reports your message, Flagship can see which account sent it.")),
    ),
    h(doc, "p", { class: "fine" }, t("No Flagship app yet?"), " ", h(doc, "a", { class: "inline-link", href: `https://${cfg.apex}/` }, t("Get Flagship"))),
  );
  if (!phoneFirst) openBtn.className = "inline-link";
  const flow = lib.startVoiciSignIn({
    pageId: page.index.pageId,
    username: page.username,
    origin: cfg.origin,
    apex: cfg.apex,
    secure: cfg.secure,
    store: ctx.store,
    onLink: (link) => {
      replace(qrBox, qrSvg(doc, link));
      openBtn.setAttribute("href", link);
      codeBox.hidden = true;
    },
    onCode: (code) => {
      replace(
        codeBox,
        h(doc, "p", { class: "pair-code-label" }, t("Check that your app shows this code:")),
        h(doc, "p", { class: "pair-code-digits" }, `${code.slice(0, 3)} ${code.slice(3)}`),
      );
      codeBox.hidden = false;
      replace(status, h(doc, "span", { class: "spinner", "aria-hidden": "true" }), t("Approve in your app."));
    },
  });
  flow.done.then(
    (session) => showThread(ctx, session),
    (e) => {
      if (e?.code === "cancelled") return;
      replace(status, icon(doc, "alert", "icon icon-sm"), signInRefusal(e?.code));
      status.classList.add("is-error");
      sheet.body.appendChild(h(doc, "button", { class: "btn btn-secondary", type: "button", on: { click: () => showSignIn(ctx) } }, t("Start again")));
    },
  );
}

function showThread(ctx, session) {
  const { doc, win, lib, cfg, page } = ctx;
  const me = visitorName(lib, session.pseudonymPub);
  const threadCtx = {
    pageId: page.index.pageId,
    ownerSignPub: page.index.ownerSignPub,
    pseudonymPub: session.pseudonymPub,
    threadSeed: lib.threadSeedOf(session),
    origin: cfg.origin,
  };
  const items = new Map();
  let cursor = "";
  let timer = null;
  let delay = POLL_MS;
  let closed = false;
  let live = { at: 0, value: false };

  const sheet = openSheet(doc, {
    title: page.profile.displayName,
    wide: true,
    lead: avatarEl(doc, page.profile, page.avatarUrl, "sm"),
    onClose: () => {
      closed = true;
      if (timer) win.clearTimeout(timer);
    },
  });
  const list = h(doc, "div", { class: "thread", role: "log", "aria-live": "polite", "aria-label": t("Conversation") });
  const gap = h(doc, "p", { class: "callout", hidden: true }, t("Some messages haven't arrived yet."));
  const confirmBar = h(doc, "div", { class: "confirm-bar", hidden: true });
  const area = h(doc, "textarea", { class: "compose-input", rows: 2, maxlength: 4000, "aria-label": t("Message"), placeholder: t("Write a message"), enterkeyhint: "send", spellcheck: "true" });
  const counter = h(doc, "span", { class: "counter", "aria-live": "polite" });
  const sendBtn = h(doc, "button", { class: "btn btn-primary", type: "submit" }, icon(doc, "send"), h(doc, "span", {}, t("Send")));
  const error = h(doc, "p", { class: "form-error", role: "alert", hidden: true });
  const form = h(doc, "form", { class: "compose", on: { submit: (e) => (e.preventDefault(), send()) } }, area, h(doc, "div", { class: "compose-row" }, counter, sendBtn));

  replace(
    sheet.body,
    list,
    gap,
    confirmBar,
    form,
    error,
    h(
      doc,
      "ul",
      { class: "notes" },
      h(doc, "li", {}, icon(doc, "flag", "icon icon-sm"), t("Messages are private. If someone reports your message, Flagship can see which account sent it.")),
      h(doc, "li", {}, icon(doc, "lock", "icon icon-sm"), t("You appear here as {0}. They never see your username.", me)),
    ),
    h(doc, "button", { class: "btn-ghost sign-out", type: "button", on: { click: signOutHere } }, t("Sign out of this page")),
  );

  const length = () => [...area.value.normalize("NFC")].length;
  area.addEventListener("input", () => {
    const n = length();
    counter.textContent = n > 1500 ? `${n} / 2000` : "";
    counter.classList.toggle("is-over", n > 2000);
    error.hidden = true;
  });
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  function confirmOpen(e, m) {
    e.preventDefault();
    replace(
      confirmBar,
      h(doc, "p", { class: "confirm-title" }, t("Open {0}?", m.host)),
      h(doc, "p", { class: "confirm-url" }, m.url),
      h(
        doc,
        "div",
        { class: "confirm-actions" },
        h(doc, "button", { class: "btn btn-secondary", type: "button", on: { click: () => (confirmBar.hidden = true) } }, t("Cancel")),
        h(
          doc,
          "button",
          {
            class: "btn btn-primary",
            type: "button",
            on: {
              click: () => {
                confirmBar.hidden = true;
                win.open(m.url, "_blank", "noopener,noreferrer");
              },
            },
          },
          t("Open"),
        ),
      ),
    );
    confirmBar.hidden = false;
  }

  function render() {
    const all = [...items.values()].sort((a, b) => a.env.sentAt - b.env.sentAt || (a.env.msgId < b.env.msgId ? -1 : 1));
    if (!all.length) {
      replace(list, h(doc, "p", { class: "thread-empty" }, t("Say hello. {0} will see you as {1}.", page.profile.displayName, me)));
    } else {
      const lastMine = [...all].reverse().find((i) => i.mine);
      replace(
        list,
        all.map((i) =>
          h(
            doc,
            "div",
            { class: i.mine ? "bubble-row mine" : "bubble-row theirs" },
            h(doc, "div", { class: "bubble" }, h(doc, "p", { class: "bubble-text" }, linkedText(doc, i.text, lib.protocol.findVoiciLinks, confirmOpen))),
            h(
              doc,
              "p",
              { class: "bubble-meta" },
              h(doc, "time", { datetime: new Date(i.env.sentAt).toISOString() }, formatTime(i.env.sentAt)),
              i === lastMine ? h(doc, "span", { class: "receipt" }, icon(doc, "check", "icon icon-xs"), statusLabel(i.status)) : null,
            ),
          ),
        ),
      );
    }
    const bySender = new Map();
    for (const i of all) (bySender.get(i.env.from) ?? bySender.set(i.env.from, []).get(i.env.from)).push(i.env.seq);
    gap.hidden = ![...bySender.values()].some((seqs) => {
      const s = [...new Set(seqs)].sort((a, b) => a - b);
      return s.length > 0 && s[s.length - 1] - s[0] + 1 !== s.length;
    });
    list.scrollTop = list.scrollHeight;
  }

  function addVerified(raw, meta) {
    const v = lib.verifyThreadItem(raw, threadCtx);
    if (!v.ok) return;
    const prev = items.get(v.envelope.msgId);
    let status = "sent";
    if (meta.direct) status = "phone";
    else if (meta.fetchedAt) status = "delivered";
    if (prev && STATUS_RANK[prev.status] > STATUS_RANK[status]) status = prev.status;
    items.set(v.envelope.msgId, { env: v.envelope, text: v.plaintext.text, mine: v.mine, status });
  }

  async function poll() {
    if (closed) return;
    if (doc.visibilityState === "hidden") return schedule();
    const r = await lib.fetchThread(session, { apiBase: cfg.apiBase, since: cursor });
    if (closed) return;
    if (r.ok) {
      for (const it of r.items) addVerified(it.envelope, it);
      cursor = r.next;
      delay = POLL_MS;
      render();
    } else if (r.code === "revoked" || r.code === "bad-delegation" || r.code === "bad-attestation") {
      await lib.signOut(ctx.store, page.index.pageId);
      return showSignIn(ctx, t("Your sign-in for this page has ended. Sign in again."));
    } else {
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
    schedule();
  }
  function schedule() {
    if (!closed) timer = win.setTimeout(poll, delay);
  }

  async function phoneLive() {
    const now = Date.now();
    if (now - live.at > LIVE_TTL_MS) {
      live = { at: now, value: await lib.pingPhone({ username: page.username, servicesApex: cfg.services, ownerSignPub: page.index.ownerSignPub }) };
    }
    return live.value;
  }

  let sending = false;
  async function send() {
    if (sending) return;
    const prepared = lib.protocol.prepareVoiciText("messageText", area.value);
    if (!prepared.ok) return showError(sendRefusal(prepared.code));
    sending = true;
    sendBtn.disabled = true;
    try {
      const mySeqs = [...items.values()].filter((i) => i.mine).map((i) => i.env.seq);
      const seq = (mySeqs.length ? Math.max(...mySeqs) : 0) + 1;
      if (Date.now() >= session.delegation.expiresAt) {
        await lib.signOut(ctx.store, page.index.pageId);
        return showSignIn(ctx, t("Your sign-in for this page has ended. Sign in again."));
      }
      const env = await lib.buildVoiciMessage({ session, index: page.index, text: prepared.text, seq });
      const r = await lib.deliverEnvelope(env, {
        username: page.username,
        servicesApex: cfg.services,
        ownerSignPub: page.index.ownerSignPub,
        apiBase: cfg.apiBase,
        live: await phoneLive(),
      });
      if (!r.ok) {
        if (r.code === "revoked" || r.code === "bad-delegation" || r.code === "bad-attestation") {
          await lib.signOut(ctx.store, page.index.pageId);
          return showSignIn(ctx, t("Your sign-in for this page has ended. Sign in again."));
        }
        return showError(sendRefusal(r.code, r));
      }
      addVerified(env, { direct: r.via === "phone", fetchedAt: null });
      area.value = "";
      counter.textContent = "";
      render();
    } catch (e) {
      showError(sendRefusal(e?.code));
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  function showError(s) {
    error.textContent = s;
    error.hidden = false;
  }

  async function signOutHere() {
    await lib.signOut(ctx.store, page.index.pageId);
    closeSheet();
  }

  render();
  poll();
  phoneLive();
  area.focus();
}
