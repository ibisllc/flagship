-- Flagship Inference's server-side settings (packages/control-plane/src/
-- inferenceSettings.ts): which models are on, the default, multipliers,
-- descriptions and the promotion's allowance, set by the owner through
-- PUT /api/admin/inference-settings. One row per change; the latest is in
-- force and the rest are its history. No rows = the shipped defaults.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS inference_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settings TEXT NOT NULL,
  note TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
