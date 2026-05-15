-- Add `label` column to push_tokens so the /api/users/:u/devices listing
-- can surface a human-readable name per device ("Harry's iPhone",
-- "Pixel 8 — kitchen") instead of an opaque token-id. The phone supplies
-- the label inside the IRK-signed PushTokenRegister envelope.
--
-- Default of an empty string keeps any rows that predate this migration
-- forwards-compatible: the /devices handler renders an "Untitled <platform>"
-- fallback when the column is blank.

ALTER TABLE push_tokens ADD COLUMN label TEXT NOT NULL DEFAULT '';
