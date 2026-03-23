-- Device registry for multi-device sync
CREATE TABLE IF NOT EXISTS `device` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `type` TEXT NOT NULL DEFAULT 'unknown',
  `push_url` TEXT,
  `push_headers` TEXT,
  `push_events` TEXT NOT NULL DEFAULT '["*"]',
  `last_seen_seq` INTEGER NOT NULL DEFAULT 0,
  `last_sync_at` INTEGER,
  `capabilities` TEXT NOT NULL DEFAULT '[]',
  `time_created` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `time_updated` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS `device_name_idx` ON `device` (`name`);
