/**
 * Popup controller. Reads the active tab's URL, repeats the
 * detect → fetch → verify flow (cached), and renders a deeper
 * "investigate" view: full activity log + mailto:s for OOB contact.
 *
 * Everything is constructed via textContent + DOM APIs — no innerHTML
 * on user-derived strings.
 */
import { detectRepo, type RepoLocation } from "../repo-detect.js";
import { fetchMaintainers, type FetcherDeps, type KVStore } from "../fetcher.js";
import { computeOverlayState, formatDuration, type OverlayState, type PersonCard, type Alarm } from "../verifier-logic.js";

declare const chrome: any;
declare const browser: any;
const ext: any = typeof (globalThis as any).chrome !== "undefined"
  ? (globalThis as any).chrome
  : (globalThis as any).browser;

const storage: KVStore = {
  async get(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      ext.storage.local.get(key, (items: Record<string, string>) => resolve(items[key]));
    });
  },
  async set(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      ext.storage.local.set({ [key]: value }, () => resolve());
    });
  },
};

const deps: FetcherDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  storage,
  now: () => Date.now(),
};

async function activeTabUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      ext.tabs.query({ active: true, currentWindow: true }, (tabs: any[]) => {
        const url = tabs?.[0]?.url ?? null;
        resolve(typeof url === "string" ? url : null);
      });
    } catch { resolve(null); }
  });
}

async function getWhitelist(): Promise<string[]> {
  const raw = await storage.get("maintainers:whitelist");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) return parsed;
  } catch { /* fall through */ }
  return [];
}

async function render(force: boolean): Promise<void> {
  const url = await activeTabUrl();
  const main = document.getElementById("main")!;
  const repoLine = document.getElementById("repo-line")!;
  main.replaceChildren();

  if (!url) {
    repoLine.textContent = "—";
    main.appendChild(textBlock("empty", "No active tab"));
    return;
  }
  const whitelist = await getWhitelist();
  const repo = detectRepo(url, whitelist);
  if (!repo) {
    repoLine.textContent = "Not a repo page";
    main.appendChild(textBlock("empty", "Open a repo page to see verified mandates."));
    return;
  }

  repoLine.textContent = `${repo.host}/${repo.owner}/${repo.repo}`;

  if (force) {
    await storage.set(`maintainers:cache:${repo.host}/${repo.owner}/${repo.repo}`, "");
  }

  const data = await fetchMaintainers(repo, deps);
  const state = computeOverlayState({
    policy: data.policy,
    trackPolicies: data.trackPolicies,
    mandates: data.mandates,
    keys: data.keys,
    endorsements: data.endorsements,
    now: new Date(),
  });
  renderState(main, state, repo);
}

function renderState(main: HTMLElement, state: OverlayState, repo: RepoLocation): void {
  for (const a of state.alarms) main.appendChild(renderAlarm(a));

  if (!state.policyPresent) {
    main.appendChild(textBlock("empty", "No .maintainers/policy.json on this repo."));
    return;
  }
  if (state.tracks.length === 0) {
    main.appendChild(textBlock("empty", "Policy declares zero tracks."));
    return;
  }
  for (const t of state.tracks) {
    const wrap = el("div", { className: "track" });
    const h3 = el("h3");
    h3.textContent = t.track;
    wrap.appendChild(h3);

    if (!t.current) {
      wrap.appendChild(textBlock("empty", "No active mandate"));
    } else {
      wrap.appendChild(renderPerson(t.current.holder, "current"));
      const exp = el("div", { className: "muted" });
      exp.textContent = `expires in ${formatDuration(t.current.expiresInMs)} (${t.current.expiresAt})`;
      wrap.appendChild(exp);
    }

    if (t.successors.length > 0) {
      const sh = el("h3");
      sh.textContent = `successors (${t.successors.length})`;
      wrap.appendChild(sh);
      for (const s of t.successors) wrap.appendChild(renderPerson(s, "succ"));
    }

    if (t.recentMandates.length > 0) {
      const ul = el("ul", { className: "timeline" });
      for (const m of t.recentMandates) {
        const li = el("li");
        li.textContent = `${m.issuedAt.slice(0, 10)}  ${m.mandateId.slice(0, 8)}…  holder ${m.holder.slice(0, 8)}…`;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    main.appendChild(wrap);
  }

  if (state.recentEndorsements.length > 0) {
    const wrap = el("div", { className: "track" });
    const h3 = el("h3");
    h3.textContent = "recent releases";
    wrap.appendChild(h3);
    const ul = el("ul", { className: "timeline" });
    for (const r of state.recentEndorsements) {
      const li = el("li");
      li.textContent = `${r.semverTag}  ${r.commitHash.slice(0, 12)}…  ${r.issuedAt.slice(0, 10)}`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    main.appendChild(wrap);
  }

  // Footer info: which branch we fetched from
  const meta = el("div", { className: "muted" });
  meta.style.fontSize = "11px";
  meta.style.marginTop = "8px";
  meta.textContent = `verified at ${new Date(state.computedAt).toLocaleTimeString()} from ${repo.repoUrl}`;
  main.appendChild(meta);
}

function renderAlarm(a: Alarm): HTMLElement {
  const div = el("div", { className: `alarm ${a.level}` });
  const msg = el("div");
  msg.textContent = a.message;
  div.appendChild(msg);
  if (a.detail) {
    const detail = el("div", { className: "muted" });
    detail.style.fontSize = "11px";
    detail.style.marginTop = "2px";
    detail.textContent = a.detail;
    div.appendChild(detail);
  }
  if (a.contactEmails && a.contactEmails.length > 0) {
    const links = el("div");
    links.style.marginTop = "4px";
    for (const email of a.contactEmails) {
      const link = document.createElement("a");
      link.textContent = email;
      // mailto: is the only protocol we set; emails were validated as
      // not containing the canonical-bytes separator already.
      link.href = `mailto:${encodeURIComponent(email)}`;
      link.style.marginRight = "8px";
      links.appendChild(link);
    }
    div.appendChild(links);
  }
  return div;
}

function renderPerson(p: PersonCard, _role: string): HTMLElement {
  const wrap = el("div", { className: "person" });
  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.alt = "";
  avatar.referrerPolicy = "no-referrer";
  if (p.photo && /^https?:\/\//i.test(p.photo)) avatar.src = p.photo;
  wrap.appendChild(avatar);
  const meta = el("div", { className: "meta" });
  const name = el("div", { className: "name" });
  name.textContent = p.displayName;
  const email = el("div", { className: "email" });
  email.textContent = p.email;
  meta.appendChild(name);
  meta.appendChild(email);
  wrap.appendChild(meta);
  return wrap;
}

function textBlock(cls: string, content: string): HTMLElement {
  const div = el("div", { className: cls });
  div.textContent = content;
  return div;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: { className?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.className) node.className = attrs.className;
  return node;
}

document.getElementById("refresh")?.addEventListener("click", () => {
  void render(true);
});

void render(false);
