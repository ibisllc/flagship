// A build chat's transcript as the page shows it, the webapp's port of iOS
// VibeTranscript.swift (Android core/VibeTranscript.kt). The AI writes whole
// files inline (`=== path ===` … `=== END ===`); shown verbatim they are
// thousands of lines that make the page crawl, and the code is on the box
// anyway. Each finished file becomes one "wrote" line, a file still being
// written shows only its last few lines, and only the newest messages stay
// on screen.

export const MAX_MESSAGES = 40;
export const LIVE_TAIL_LINES = 6;
export const JUMP_TO_LATEST = "Jump to latest";
/** How close to the bottom (px) still counts as following the newest message. */
export const FOLLOW_SLACK_PX = 48;

function boundary(line) {
  const t = line.trim();
  if (!t.startsWith("===") || !t.endsWith("===") || t.length <= 6) return null;
  const name = t.slice(3, -3).trim();
  return name || null;
}

/** Collapse file blocks. `live` keeps the tail of an unfinished block. */
export function compactTranscript(text, { live = false } = {}) {
  const out = [];
  let file = null;
  let body = [];
  const closeFile = () => {
    if (file === null) return;
    if (file !== "QUESTION") out.push(`  wrote ${file} (${body.length} line${body.length === 1 ? "" : "s"})`);
    else out.push(...body);
    file = null;
    body = [];
  };
  for (const line of String(text ?? "").split("\n")) {
    const name = boundary(line);
    if (name !== null) {
      closeFile();
      if (name !== "END") file = name;
    } else if (file !== null) {
      body.push(line);
    } else {
      out.push(line);
    }
  }
  if (file !== null) {
    if (live && file !== "QUESTION") {
      out.push(`  writing ${file}… (${body.length} lines)`);
      out.push(...body.slice(-LIVE_TAIL_LINES).map((l) => `    ${l}`));
    } else {
      closeFile();
    }
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

/** The newest messages (assistant text compacted) and how many older ones were left out. */
export function transcriptWindow(messages, max = MAX_MESSAGES) {
  const all = Array.isArray(messages) ? messages : [];
  const shown = all.slice(-max);
  return {
    hidden: all.length - shown.length,
    messages: shown.map((m) => (m?.role === "assistant" ? { ...m, text: compactTranscript(m.text) } : m)),
  };
}

/** "… 3 earlier messages not shown", or "" when nothing is left out. */
export function hiddenMessagesText(hidden) {
  if (!(hidden > 0)) return "";
  return `… ${hidden} earlier message${hidden === 1 ? "" : "s"} not shown`;
}

/** Whether a scroll box is at (or within the slack of) its bottom. */
export function isAtBottom({ scrollTop, scrollHeight, clientHeight }, slack = FOLLOW_SLACK_PX) {
  return scrollTop + clientHeight >= scrollHeight - slack;
}
