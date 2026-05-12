/**
 * Stylesheet. One string, injected on mount; no external CSS file.
 *
 * Visual goals: looks like a clean utility, not a marketing site.
 * Big touch targets (44px+), generous line-height, no animation,
 * dark/light via prefers-color-scheme, monospace for pubkeys.
 */

export const STYLES = `
:root {
  --bg: #fafafa;
  --fg: #1a1a1a;
  --muted: #5a5a5a;
  --line: #e0e0e0;
  --accent: #006666;
  --accent-fg: #ffffff;
  --warn-bg: #fff7e0;
  --warn-fg: #6b4f00;
  --error-bg: #ffefef;
  --error-fg: #7a1a1a;
  --ok-bg: #ecf8ec;
  --ok-fg: #155a15;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121212;
    --fg: #e8e8e8;
    --muted: #999;
    --line: #2a2a2a;
    --accent: #5fbfbf;
    --accent-fg: #001818;
    --warn-bg: #2a230a;
    --warn-fg: #f0d680;
    --error-bg: #2a1010;
    --error-fg: #ff9080;
    --ok-bg: #0e2a0e;
    --ok-fg: #8be08b;
  }
}
.maintainers-ui {
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 20px 80px;
}
.maintainers-ui h1 { font-size: 28px; margin: 0 0 8px; }
.maintainers-ui h2 { font-size: 20px; margin: 24px 0 8px; }
.maintainers-ui h3 { font-size: 16px; margin: 16px 0 4px; color: var(--muted); font-weight: 500; }
.maintainers-ui p { margin: 8px 0; }
.maintainers-ui .muted { color: var(--muted); font-size: 14px; }
.maintainers-ui .panel {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px;
  margin: 16px 0;
  background: var(--bg);
}
.maintainers-ui input[type=text],
.maintainers-ui input[type=email],
.maintainers-ui input[type=url],
.maintainers-ui textarea {
  width: 100%;
  font: inherit;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  box-sizing: border-box;
  min-height: 44px;
}
.maintainers-ui textarea {
  min-height: 96px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
}
.maintainers-ui label { display: block; font-size: 14px; color: var(--muted); margin: 12px 0 4px; }
.maintainers-ui button {
  font: inherit;
  padding: 12px 20px;
  min-height: 44px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
}
.maintainers-ui button:hover:not(:disabled) { background: var(--line); }
.maintainers-ui button:disabled { opacity: 0.4; cursor: not-allowed; }
.maintainers-ui button.primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
  font-weight: 600;
}
.maintainers-ui button.primary:hover:not(:disabled) {
  filter: brightness(1.07);
  background: var(--accent);
}
.maintainers-ui .row { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; align-items: center; }
.maintainers-ui .row.end { justify-content: flex-end; }
.maintainers-ui .grow { flex: 1 1 auto; }
.maintainers-ui .pubkey {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--muted);
  word-break: break-all;
}
.maintainers-ui .badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  margin-right: 6px;
}
.maintainers-ui .badge.ok { background: var(--ok-bg); color: var(--ok-fg); }
.maintainers-ui .badge.warn { background: var(--warn-bg); color: var(--warn-fg); }
.maintainers-ui .badge.err { background: var(--error-bg); color: var(--error-fg); }
.maintainers-ui .alert.warn { padding: 12px 16px; background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px; margin: 12px 0; }
.maintainers-ui .alert.err { padding: 12px 16px; background: var(--error-bg); color: var(--error-fg); border-radius: 8px; margin: 12px 0; }
.maintainers-ui .alert.ok { padding: 12px 16px; background: var(--ok-bg); color: var(--ok-fg); border-radius: 8px; margin: 12px 0; }
.maintainers-ui .stepper {
  display: flex;
  gap: 4px;
  margin: 0 0 24px;
  font-size: 12px;
  color: var(--muted);
}
.maintainers-ui .stepper .step {
  flex: 1;
  padding: 6px 4px;
  text-align: center;
  border-bottom: 2px solid var(--line);
}
.maintainers-ui .stepper .step.active { border-bottom-color: var(--accent); color: var(--fg); font-weight: 600; }
.maintainers-ui .stepper .step.done { border-bottom-color: var(--accent); }
.maintainers-ui .cadence-options { display: flex; gap: 8px; }
.maintainers-ui .cadence-options button { flex: 1; }
.maintainers-ui .cadence-options button.selected { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.maintainers-ui table { width: 100%; border-collapse: collapse; margin: 12px 0; }
.maintainers-ui th, .maintainers-ui td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
.maintainers-ui th { font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.maintainers-ui details { margin: 8px 0; }
.maintainers-ui details summary { cursor: pointer; color: var(--muted); font-size: 14px; }
.maintainers-ui nav.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.maintainers-ui nav.tabs a {
  padding: 10px 14px;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.maintainers-ui nav.tabs a.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
.maintainers-ui .hint { font-size: 13px; color: var(--muted); margin-top: 4px; }
.maintainers-ui .avatar {
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--accent); color: var(--accent-fg);
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 14px; vertical-align: middle; margin-right: 8px;
}
.maintainers-ui footer { color: var(--muted); font-size: 12px; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); }
`;

export const STYLE_ELEMENT_ID = "maintainers-ui-styles";

export function ensureStylesInjected(doc: Document = document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}
